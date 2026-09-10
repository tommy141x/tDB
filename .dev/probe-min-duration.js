// Throwaway: what is the accepted range for _superusers authToken.duration?
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const PORT = 8232;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "probe@example.com";
const PASSWORD = "probe-password-123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-probe2-"));
  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", dir], {
    encoding: "utf8",
  });
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

    for (const d of [1, 5, 8, 10, 15, 30, 60, 300]) {
      const res = await fetch(`${URL}/api/collections/_superusers`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: auth.token,
        },
        body: JSON.stringify({ authToken: { duration: d } }),
      });
      const body = await res.json();
      console.log(
        `duration=${d}: ${res.status} ${
          res.ok ? "OK" : JSON.stringify(body.data)
        }`,
      );
      if (res.ok) break;
    }
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
