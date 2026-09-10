// Throwaway: what IS the default _superusers authToken.duration on a virgin
// 0.40.3 data dir? Run: node .dev/probe-duration.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const PORT = 8231;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "probe@example.com";
const PASSWORD = "probe-password-123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-probe-"));
  const ver = spawnSync(PB_BIN, ["--version"], { encoding: "utf8" });
  console.log("binary:", (ver.stdout || ver.stderr).trim());
  console.log("data dir:", dir, "(virgin)");

  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", dir], {
    encoding: "utf8",
  });
  // --migrationsDir inside the throwaway dir. Without it PocketBase uses
  // `<dataDir>/../pb_migrations` = %TEMP%/pb_migrations, shared with every
  // other harness here - and "virgin" stops meaning virgin.
  const server = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      dir,
      "--migrationsDir",
      path.join(dir, "migrations"),
    ],
    { stdio: "ignore" },
  );

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${URL}/api/health`)).ok) break;
      } catch (_) {}
      await sleep(200);
    }

    const auth = await (
      await fetch(`${URL}/api/collections/_superusers/auth-with-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: EMAIL, password: PASSWORD }),
      })
    ).json();

    const claims = JSON.parse(
      Buffer.from(auth.token.split(".")[1], "base64").toString("utf8"),
    );
    console.log("token claims:", JSON.stringify(claims));
    console.log("issued lifetime:", claims.exp - Math.floor(Date.now() / 1000), "s");

    const col = await (
      await fetch(`${URL}/api/collections/_superusers`, {
        headers: { authorization: auth.token },
      })
    ).json();
    console.log("_superusers.authToken:", JSON.stringify(col.authToken));

    const users = await (
      await fetch(`${URL}/api/collections/users`, {
        headers: { authorization: auth.token },
      })
    ).json();
    console.log("users.authToken:", JSON.stringify(users.authToken || users.message));
  } finally {
    server.kill();
    await sleep(400);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
