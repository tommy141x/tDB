/**
 * Proves the resource can provision and repair a PocketBase instance headlessly.
 *
 * The resource must never leave a server owner on PocketBase's web installer:
 * the admin UI is optional, so setup has to happen without it. That guarantee
 * rests on two claims made in utils/server.js, both checked here against a real
 * instance:
 *
 *   1. Provisioning a superuser before `serve` suppresses the installer banner
 *      entirely (PocketBase only prints it when no superuser exists).
 *   2. `superuser upsert` against an ALREADY RUNNING instance takes effect
 *      immediately - no restart - which is what makes live repair possible.
 *
 * Dev harness. Run from the resource root: node .dev/setup-repair.test.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux",
);
const EMAIL = "setup@example.com";
const PASSWORD = "setup-password-123";

let pass = 0;
let fail = 0;

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pb(args, dir) {
  return spawnSync(PB_BIN, [...args, "--dir", dir], { encoding: "utf8" });
}

async function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return true;
    } catch (_) {}
    await sleep(200);
  }
  return false;
}

async function authenticate(url) {
  try {
    const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: EMAIL, password: PASSWORD }),
    });
    return res.status;
  } catch (e) {
    return 0;
  }
}

/**
 * Start `serve` and capture stdout, so the installer banner can be detected the
 * same way utils/server.js detects it.
 */
function serve(dir, port) {
  const proc = spawn(
    PB_BIN,
    // --migrationsDir inside the throwaway dir: PocketBase defaults it to
    // `<dataDir>/../pb_migrations`, which every temp dir here would share.
    [
      "serve",
      `--http=127.0.0.1:${port}`,
      "--dir",
      dir,
      "--migrationsDir",
      path.join(dir, "migrations"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = { text: "" };
  proc.stdout.on("data", (d) => (output.text += d.toString()));
  proc.stderr.on("data", (d) => (output.text += d.toString()));
  return { proc, output };
}

const bannerSeen = (text) =>
  text.includes("/_/#/pbinstall/") ||
  text.includes("create your first superuser account");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-setup-"));
  const port = 8141;
  const url = `http://127.0.0.1:${port}`;
  let running = null;

  try {
    // ----------------------------------------------------------------
    console.log("\n=== A fresh instance provisioned before serve never shows the installer");

    const created = pb(["superuser", "upsert", EMAIL, PASSWORD], dir);
    ok(
      created.status === 0 && /Successfully saved superuser/i.test(created.stdout),
      "superuser upsert reports success on a fresh data dir",
      `${created.status}: ${(created.stderr || created.stdout || "").trim()}`,
    );

    running = serve(dir, port);
    ok(await waitForHealth(url), "server became healthy");
    await sleep(1000);

    ok(
      !bannerSeen(running.output.text),
      "no installer banner - the web UI is genuinely optional",
      running.output.text.slice(0, 200),
    );
    ok((await authenticate(url)) === 200, "superuser can authenticate");

    // ----------------------------------------------------------------
    console.log("\n=== A broken instance is repairable live, without a restart");

    // PocketBase refuses to delete the only superuser, so stand up a decoy
    // first. The end state - the configured account no longer exists - is what
    // a wiped pb_data or a hand-edited config.lua produces in practice.
    pb(["superuser", "upsert", "decoy@example.com", "decoy-password-123"], dir);
    const deleted = pb(["superuser", "delete", EMAIL], dir);
    ok(
      deleted.status === 0,
      "configured superuser removed to simulate a broken pb_data",
      (deleted.stderr || deleted.stdout || "").trim(),
    );

    const brokenStatus = await authenticate(url);
    ok(
      brokenStatus !== 200,
      `authentication now fails (status ${brokenStatus}) - the state that caused the installer`,
    );

    // This is the claim repairSuperuser() depends on.
    const repaired = pb(["superuser", "upsert", EMAIL, PASSWORD], dir);
    ok(
      repaired.status === 0 && /Successfully saved superuser/i.test(repaired.stdout),
      "upsert repairs the account while the server is still running",
      `${repaired.status}: ${(repaired.stderr || repaired.stdout || "").trim()}`,
    );

    ok(
      (await authenticate(url)) === 200,
      "authentication works again WITHOUT restarting PocketBase",
    );
  } finally {
    if (running) running.proc.kill();
    await sleep(500);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
});
