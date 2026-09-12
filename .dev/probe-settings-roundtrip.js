/**
 * Does PocketBase hand secrets back out of GET /api/settings, or mask them?
 *
 * This decides whether syncSettingsToConfig() preserves an SMTP password / S3
 * secret when it writes PocketBase's settings back into config.lua, or whether
 * it overwrites the real credential in config.lua with a mask.
 *
 * Also checks the inverse: does PATCHing a masked value back clear the stored
 * secret, or does PocketBase treat the mask as "leave it alone"?
 *
 * Dev harness, throwaway instance. Run from the resource root:
 *   node .dev/probe-settings-roundtrip.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-settings-"));
const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "probe@example.com";
const PASSWORD = "probe-password-123";

const SMTP_PASSWORD = "super-secret-smtp-pw";
const S3_SECRET = "super-secret-s3-key";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${URL}/api/health`)).ok) return true;
    } catch (_) {}
    await sleep(200);
  }
  return false;
}

async function main() {
  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", DATA_DIR], {
    encoding: "utf8",
  });

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

    const auth = await fetch(`${URL}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: EMAIL, password: PASSWORD }),
    }).then((r) => r.json());
    if (!auth.token) throw new Error("could not authenticate");

    const api = async (method, body) => {
      const res = await fetch(`${URL}/api/settings`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: auth.token,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
      return json;
    };

    // 1. Write real secrets, exactly as configureSettings() does.
    console.log("=== writing settings with real secrets");
    await api("PATCH", {
      smtp: {
        enabled: true,
        host: "smtp.example.com",
        port: 587,
        username: "mailer",
        password: SMTP_PASSWORD,
        authMethod: "PLAIN",
        tls: true,
        localName: "localhost",
      },
      s3: {
        enabled: true,
        bucket: "my-bucket",
        region: "us-east-1",
        endpoint: "https://s3.example.com",
        accessKey: "AKIAEXAMPLE",
        secret: S3_SECRET,
        forcePathStyle: false,
      },
    });

    // 2. Read them back, exactly as syncSettingsToConfig() does.
    console.log("=== reading them back");
    const got = await api("GET");
    console.log("  smtp:", JSON.stringify(got.smtp));
    console.log("  s3  :", JSON.stringify(got.s3));

    const smtpPw = got.smtp?.password;
    const s3Secret = got.s3?.secret;

    console.log("");
    console.log(`  smtp.password returned : ${JSON.stringify(smtpPw)}`);
    console.log(`  smtp.password is real  : ${smtpPw === SMTP_PASSWORD}`);
    console.log(`  s3.secret returned     : ${JSON.stringify(s3Secret)}`);
    console.log(`  s3.secret is real      : ${s3Secret === S3_SECRET}`);

    // 3. The inverse: feed what we read straight back, as a restart would.
    //    If the mask is stored verbatim, the real credential is destroyed.
    console.log("");
    console.log("=== PATCHing the read-back value straight back");
    await api("PATCH", { smtp: got.smtp, s3: got.s3 });
    const after = await api("GET");
    console.log("  smtp after:", JSON.stringify(after.smtp));
    console.log("  s3   after:", JSON.stringify(after.s3));

    // Does mail still work? The only way to know whether the stored secret
    // survived is to ask PocketBase to use it.
    const test = await fetch(`${URL}/api/settings/test/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth.token },
      body: JSON.stringify({ email: "nobody@example.com", template: "verification" }),
    });
    console.log(
      `  test-email status ${test.status} (connection error = settings still live;` +
        ` 400 validation = fields were cleared)`,
    );
    console.log("  body:", (await test.text()).slice(0, 200));
  } finally {
    server.kill();
    await sleep(300);
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  process.exit(1);
});
