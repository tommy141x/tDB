/**
 * The superuser token lifecycle against a real PocketBase instance.
 *
 * Provisions a throwaway data dir and then SHORTENS the token lifetime on
 * purpose, so a token can be watched expiring inside a run. That shortening is
 * a fixture; the stock duration is 86400. See .dev/probe-duration.js for a
 * clean reading.
 *
 * Dev harness. Run from the resource root: node .dev/auth-manager.test.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const {
  AuthManager,
  getTokenExpiryMs,
  ensureSuperuserTokenDuration,
  MANAGED_TOKEN_DURATION_SECONDS,
} = require(path.join(ROOT, "server/utils/auth-manager.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux",
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

  // --migrationsDir inside the throwaway dir, not next to it. PocketBase's
  // default is `<dataDir>/../pb_migrations`, which every dir under %TEMP%
  // shares, so one harness's fixture replays into the next "virgin" instance.
  const server = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      DATA_DIR,
      "--migrationsDir",
      path.join(DATA_DIR, "migrations"),
    ],
    { stdio: "ignore" },
  );

  try {
    if (!(await waitForHealth())) throw new Error("PocketBase never became healthy");
    log.info("server healthy");

    log.step("Baseline: default superuser token lifetime");

    const probe = new PocketBase(URL);
    await probe
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    const expMs = getTokenExpiryMs(probe.authStore.token);
    assert(expMs !== null, "getTokenExpiryMs() decodes the exp claim");

    const superusers = await probe.collections.getOne("_superusers");
    const stockDuration = superusers.authToken.duration;

    const lifetimeSec = Math.round((expMs - Date.now()) / 1000);
    log.info(
      `_superusers authToken.duration = ${stockDuration}s; issued token ~${lifetimeSec}s`,
    );

    // Recorded, not relied on: on a virgin 0.40.3 dir this is 86400. The bug
    // was authenticating once and never replacing the token.
    assert(
      Math.abs(lifetimeSec - stockDuration) <= 2,
      `the issued token matches the collection's configured lifetime (${stockDuration}s)`,
    );

    // A day is too long to watch expire, so shorten it. 10 is not a preference,
    // it is the smallest value PocketBase accepts ("Must be no less than 10.").
    const SHORT = 10;
    await probe.collections.update("_superusers", {
      authToken: { duration: SHORT },
    });
    log.info(`fixture: _superusers token lifetime shortened to ${SHORT}s`);

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

    log.step("AuthManager: proactive refresh beats a short token to expiry");

    mgr._authWithPassword = realAuth;
    await mgr.ensureAuthenticated(true);

    const tokenBefore = managed.authStore.token;

    // The refresh fires at 75% of the token's own lifetime, so it has to land
    // before SHORT elapses; a floor larger than the lifetime would not.
    log.info(`waiting ${SHORT}s, during which the refresh should fire...`);
    await sleep(SHORT * 1000);

    const tokenAfter = managed.authStore.token;
    assert(
      tokenAfter && tokenAfter !== tokenBefore,
      "token was rotated by the background timer with no export calls made",
    );
    assert(
      (await managed.collections.getFullList().then(() => true, () => false)),
      "the client stayed usable across expiry with no caller-side recovery",
    );

    // Several lifetimes back to back: the steady state must be silent, not a
    // repeating cycle of expire, 403, recover.
    log.info(`holding for ${SHORT * 3}s to watch the steady state...`);
    let unrecoveredFailure = null;
    for (let i = 0; i < 3; i++) {
      await sleep(SHORT * 1000);
      try {
        await managed.collections.getFullList();
      } catch (e) {
        unrecoveredFailure = `${e.status} ${e.message}`;
        break;
      }
    }
    assert(
      unrecoveredFailure === null,
      `no call failed across ${SHORT * 3}s of unattended running (${unrecoveredFailure})`,
    );

    mgr.stop();
    assert(mgr.refreshTimer === null, "stop() clears the refresh timer");

    log.step("Local mode restores a lifetime that has been left too short");

    // The probe's own token expired many lifetimes ago, which is the race the
    // reauth hook exists for - so exercise it rather than log in afresh.
    const reauth = () =>
      probe
        .collection("_superusers")
        .authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    const changed = await ensureSuperuserTokenDuration(
      probe,
      quietLogger,
      reauth,
    );
    assert(
      changed === true,
      `${SHORT}s is raised back to the floor, recovering from the expired token en route`,
    );

    const after = await probe.collections.getOne("_superusers");
    assert(
      after.authToken.duration === MANAGED_TOKEN_DURATION_SECONDS,
      `duration is now ${after.authToken.duration}s`,
    );

    const fresh = new PocketBase(URL);
    await fresh
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });
    const freshLifetime = Math.round(
      (getTokenExpiryMs(fresh.authStore.token) - Date.now()) / 1000,
    );
    assert(
      Math.abs(freshLifetime - MANAGED_TOKEN_DURATION_SECONDS) <= 5,
      `a newly issued token now lasts ~${freshLifetime}s`,
    );

    assert(
      (await ensureSuperuserTokenDuration(probe, quietLogger, reauth)) === false,
      "re-running it is a no-op - no needless write on every restart",
    );

    // A manager starting against the widened instance must schedule its
    // refresh from the new lifetime, not re-apply an old floor.
    const widenedMgr = new AuthManager(
      new PocketBase(URL),
      { Email: EMAIL, Password: PASSWORD },
      quietLogger,
    );
    await widenedMgr.start();
    const scheduledMs = widenedMgr.refreshTimer
      ? Number(widenedMgr.refreshTimer._idleTimeout)
      : -1;
    assert(
      scheduledMs > SHORT * 1000 && scheduledMs <= 6 * 60 * 60 * 1000,
      `next refresh scheduled in ${Math.round(scheduledMs / 1000)}s, capped at 6h`,
    );
    widenedMgr.stop();
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
