/**
 * End-to-end check for the superuser token lifecycle against a real
 * PocketBase instance.
 *
 * Run from the resource root with plain Node:
 *   node .dev/auth-manager.test.js
 *
 * This is a dev harness, not part of the shipped resource.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// FiveM resolves require() paths from the resource root; plain Node resolves
// them relative to the requiring file. Rewrite the resource's own "./utils/..."
// and "./bin/..." specifiers so the same sources load unmodified here.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/^\.\/(utils|bin|adapters)\//.test(request)) {
    return originalResolve.call(this, path.join(ROOT, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

const PocketBase = require(path.join(ROOT, "bin/pocketbase.cjs.js"));
const { AuthManager, getTokenExpiryMs } = require(
  path.join(ROOT, "utils/auth-manager.js"),
);

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-authtest-"));
const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "authtest@example.com";
const PASSWORD = "authtest-password-123";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = {
  step: (m) => console.log(`\n=== ${m}`),
  ok: (m) => console.log(`  PASS  ${m}`),
  fail: (m) => console.log(`  FAIL  ${m}`),
  info: (m) => console.log(`        ${m}`),
};

let failures = 0;
function assert(cond, message) {
  if (cond) log.ok(message);
  else {
    failures++;
    log.fail(message);
  }
}

// Silence the manager's own chatter except for what we explicitly surface.
const quietLogger = {
  info: (m) => log.info(`[mgr] ${m}`),
  warn: (m) => log.info(`[mgr] ${m}`),
  error: (m) => log.info(`[mgr] ${m}`),
  debug: (m) => log.info(`[mgr] ${m}`),
};

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return true;
    } catch (_) {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

async function main() {
  log.step("Provisioning a throwaway PocketBase instance");
  log.info(`data dir: ${DATA_DIR}`);

  const upsert = spawnSync(
    PB_BIN,
    ["superuser", "upsert", EMAIL, PASSWORD, "--dir", DATA_DIR],
    { encoding: "utf8" },
  );
  if (upsert.status !== 0) {
    console.error(upsert.stdout, upsert.stderr);
    throw new Error("superuser upsert failed");
  }
  log.info("superuser created");

  const server = spawn(
    PB_BIN,
    ["serve", `--http=127.0.0.1:${PORT}`, "--dir", DATA_DIR],
    { stdio: "ignore" },
  );

  try {
    if (!(await waitForHealth())) throw new Error("PocketBase never became healthy");
    log.info("server healthy");

    // ----------------------------------------------------------------------
    log.step("Baseline: default superuser token lifetime");

    const probe = new PocketBase(URL);
    await probe
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    const expMs = getTokenExpiryMs(probe.authStore.token);
    assert(expMs !== null, "getTokenExpiryMs() decodes the exp claim");

    const lifetimeSec = Math.round((expMs - Date.now()) / 1000);
    log.info(`issued token lifetime: ~${lifetimeSec}s`);
    assert(
      lifetimeSec > 86000 && lifetimeSec <= 86400,
      `superuser token really is ~1 day (measured ${lifetimeSec}s) - the documented cause of the spam`,
    );

    // Shrink the lifetime so expiry is observable in seconds, not a day.
    const SHORT = 10; // PocketBase enforces a 10s minimum
    const superusers = await probe.collections.getOne("_superusers");
    await probe.collections.update(superusers.id, {
      authToken: { duration: SHORT },
    });
    log.info(`_superusers authToken.duration set to ${SHORT}s for the test`);

    // ----------------------------------------------------------------------
    log.step("Reproducing the original bug (authenticate once, never refresh)");

    const naive = new PocketBase(URL);
    await naive
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    assert(
      (await naive.collections.getFullList().then(() => true, () => false)),
      "naive client works immediately after login",
    );

    await sleep((SHORT + 3) * 1000);

    let naiveErr = null;
    try {
      await naive.collections.getFullList();
    } catch (e) {
      naiveErr = e;
    }
    assert(
      naiveErr !== null,
      `naive client FAILS after token expiry: ${naiveErr && naiveErr.message}`,
    );
    assert(
      naiveErr && (naiveErr.status === 401 || naiveErr.status === 403),
      `failure is a ${naiveErr && naiveErr.status} - the console-spam error`,
    );

    // ----------------------------------------------------------------------
    log.step("AuthManager: reactive recovery after expiry");

    const managed = new PocketBase(URL);
    const mgr = new AuthManager(
      managed,
      { Email: EMAIL, Password: PASSWORD },
      quietLogger,
    );

    const started = await mgr.start();
    assert(started === true, "AuthManager.start() authenticates");

    await sleep((SHORT + 3) * 1000);

    // This is what wrapAsync does on a 401/403.
    let recoveredCall = false;
    try {
      await managed.collections.getFullList();
      recoveredCall = true; // token somehow still fine
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        const ok = await mgr.ensureAuthenticated(true);
        assert(ok === true, "ensureAuthenticated(true) re-establishes the session");
        await managed.collections.getFullList();
        recoveredCall = true;
      } else {
        throw e;
      }
    }
    assert(recoveredCall, "the replayed call succeeds after recovery");
    assert(mgr.isAuthenticated === true, "manager reports itself authenticated");

    // ----------------------------------------------------------------------
    log.step("AuthManager: concurrent failures cause ONE re-authentication");

    await sleep((SHORT + 3) * 1000);

    let authCalls = 0;
    const realAuth = mgr._authWithPassword.bind(mgr);
    mgr._authWithPassword = () => {
      authCalls++;
      return realAuth();
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => mgr.ensureAuthenticated(true)),
    );
    assert(
      results.every((r) => r === true),
      "all 8 concurrent callers get a valid session",
    );
    assert(
      authCalls === 1,
      `single-flight held: ${authCalls} password login(s) for 8 concurrent callers`,
    );

    // ----------------------------------------------------------------------
    log.step("AuthManager: proactive refresh happens without any caller");

    mgr._authWithPassword = realAuth;
    await mgr.ensureAuthenticated(true);

    const tokenBefore = managed.authStore.token;

    // Timer is clamped to a 30s floor, so wait past it.
    log.info("waiting 35s for the scheduled refresh to fire...");
    await sleep(35000);

    const tokenAfter = managed.authStore.token;
    assert(
      tokenAfter && tokenAfter !== tokenBefore,
      "token was rotated by the background timer with no export calls made",
    );
    assert(
      (await managed.collections.getFullList().then(() => true, () => false)),
      "client is usable straight after the proactive refresh",
    );

    mgr.stop();
    assert(mgr.refreshTimer === null, "stop() clears the refresh timer");
  } finally {
    server.kill();
    await sleep(500);
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }

  console.log(
    failures === 0
      ? "\nALL CHECKS PASSED\n"
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHARNESS ERROR:", err);
  process.exit(1);
});
