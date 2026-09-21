/**
 * Settings reconciliation: config.lua -> PocketBase, and never the other way.
 *
 * Run against a real PocketBase, because the whole reason this code changed is
 * a property of the real one: it will not hand back `smtp.password` or
 * `s3.secret`. A mock that returned them would test a server that does not
 * exist and would have passed against the broken implementation too.
 *
 * The secrets are therefore checked by reading PocketBase's own `_params` blob
 * off disk - the only place they can be observed.
 *
 * Dev harness. Run from the resource root: node .dev/settings.test.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = require("./fivem-require.js");
const settings = require(path.join(ROOT, "server/utils/settings.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux",
);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-settings-"));
const PORT = 8093;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "probe@example.com";
const PASSWORD = "probe-password-123";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
    return;
  }
  fail++;
  failures.push(`${label}${detail ? `\n      ${detail}` : ""}`);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

function section(name) {
  console.log(`\n=== ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function collectingLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level}: ${msg}`);
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
  };
}

/** Read the settings PocketBase actually persisted, secrets included. */
function storedSettings() {
  const db = new DatabaseSync(path.join(DATA_DIR, "data.db"), { readOnly: true });
  const row = db.prepare("SELECT value FROM _params WHERE id='settings'").get();
  db.close();
  const buf = Buffer.isBuffer(row.value)
    ? row.value
    : Buffer.from(String(row.value).split(",").map(Number));
  return JSON.parse(buf.toString("utf8"));
}

function smtpBlock(overrides = {}) {
  return {
    Manage: false,
    Enabled: false,
    Host: "smtp.example.com",
    Port: 587,
    Username: "mailer",
    Password: "smtp-secret",
    LocalName: "",
    TLS: true,
    ...overrides,
  };
}

function s3Block(overrides = {}) {
  return {
    Manage: false,
    Enabled: false,
    Bucket: "bucket-a",
    Region: "us-east-1",
    Endpoint: "https://s3.example.com",
    AccessKey: "AKIA-A",
    SecretKey: "s3-secret",
    ForcePathStyle: false,
    ...overrides,
  };
}

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
  // ------------------------------------------------------------------
  // Pure logic first - no server needed.
  section("What gets built from config.lua");

  const enabledSmtp = settings.desiredSmtp(smtpBlock({ Enabled: true }));
  ok(
    enabledSmtp.password === "smtp-secret",
    "an enabled SMTP block carries the password",
    JSON.stringify(enabledSmtp),
  );
  ok(
    enabledSmtp.localName === "localhost",
    "an empty LocalName becomes localhost, not an empty string",
    JSON.stringify(enabledSmtp),
  );
  ok(
    settings.desiredSmtp(smtpBlock({ Enabled: false })).enabled === false,
    "a disabled SMTP block asserts enabled:false rather than nothing",
  );
  ok(
    settings.desiredS3(s3Block({ Enabled: true })).secret === "s3-secret",
    "an enabled S3 block carries the secret key",
  );
  ok(
    settings.desiredS3(s3Block({ Enabled: false })).enabled === false,
    "a disabled S3 block asserts enabled:false",
  );

  section("Drift description");

  const drift = settings.describeDrift(
    "smtp",
    { enabled: true, host: "changed-in-ui.example.com", port: 25, username: "mailer" },
    settings.desiredSmtp(smtpBlock({ Enabled: true })),
  );
  ok(drift.length === 2, "two changed fields are reported", JSON.stringify(drift));
  ok(
    drift.some((d) => d.includes("changed-in-ui.example.com")),
    "the report names the value being overwritten",
    JSON.stringify(drift),
  );
  ok(
    !drift.some((d) => d.startsWith("password")),
    "the password is never reported as drift - it cannot be read, so it is never 'different'",
    JSON.stringify(drift),
  );
  ok(
    settings.describeDrift("smtp", undefined, settings.desiredSmtp(smtpBlock({ Enabled: true })))
      .length === 0,
    "an instance with no settings yet reports no drift",
  );

  // ------------------------------------------------------------------
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

    const api = {
      getSettings: () =>
        fetch(`${URL}/api/settings`, { headers: { Authorization: auth.token } }).then((r) =>
          r.json(),
        ),
      updateSettings: async (patch) => {
        const res = await fetch(`${URL}/api/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: auth.token },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return res.json();
      },
    };

    // ----------------------------------------------------------------
    section("The platform fact this design rests on");

    await api.updateSettings({
      smtp: {
        enabled: true,
        host: "seed.example.com",
        port: 2525,
        username: "seeded",
        password: "SEEDED-PW",
        authMethod: "PLAIN",
        tls: true,
        localName: "localhost",
      },
    });
    const readBack = await api.getSettings();
    ok(
      readBack.smtp.password === undefined,
      "PocketBase does not return smtp.password - so it can never be synced back to config.lua",
      JSON.stringify(readBack.smtp),
    );
    ok(
      storedSettings().smtp.password === "SEEDED-PW",
      "...even though it is genuinely stored",
    );

    // ----------------------------------------------------------------
    section("Manage = false leaves the instance alone");

    const untouched = await settings.reconcile(
      api,
      { SMTP: smtpBlock({ Manage: false, Enabled: true }), S3: s3Block({ Manage: false }) },
      quietLogger,
    );
    const afterUnmanaged = storedSettings();
    ok(
      afterUnmanaged.smtp.host === "seed.example.com",
      "the admin UI's host survives a restart",
      afterUnmanaged.smtp.host,
    );
    ok(
      afterUnmanaged.smtp.password === "SEEDED-PW",
      "the admin UI's password survives a restart - the bug that motivated this",
    );
    ok(untouched.managed.length === 0, "nothing was managed");

    const noisy = collectingLogger();
    await settings.reconcile(
      api,
      { SMTP: smtpBlock({ Manage: false, Enabled: true }), S3: s3Block({ Manage: false }) },
      noisy,
    );
    ok(
      noisy.lines.some((l) => l.includes("not applied") && l.includes("SMTP")),
      "a filled-in but unmanaged block is called out, not silently ignored",
      JSON.stringify(noisy.lines),
    );

    // ----------------------------------------------------------------
    section("Manage = true makes config.lua the truth");

    const logged = collectingLogger();
    const applied = await settings.reconcile(
      api,
      {
        SMTP: smtpBlock({ Manage: true, Enabled: true, Host: "from-config.example.com" }),
        S3: s3Block({ Manage: true, Enabled: true }),
      },
      logged,
    );

    const afterManaged = storedSettings();
    ok(
      afterManaged.smtp.host === "from-config.example.com",
      "config.lua's host replaced the admin UI's",
      afterManaged.smtp.host,
    );
    ok(
      afterManaged.smtp.password === "smtp-secret",
      "config.lua's password was asserted, secrets and all",
      afterManaged.smtp.password,
    );
    ok(afterManaged.s3.secret === "s3-secret", "config.lua's S3 secret was asserted");
    ok(
      applied.drift.length > 0 && logged.lines.some((l) => l.startsWith("warn:")),
      "the overwrite was reported rather than done silently",
      JSON.stringify(logged.lines),
    );

    // The old code compared only bucket/region/endpoint, so a rotated key was
    // never pushed - it kept using a credential already replaced in config.lua.
    section("A rotated secret is pushed even when nothing visible changed");

    await settings.reconcile(
      api,
      {
        SMTP: smtpBlock({ Manage: false }),
        S3: s3Block({ Manage: true, Enabled: true, SecretKey: "ROTATED-KEY" }),
      },
      quietLogger,
    );
    ok(
      storedSettings().s3.secret === "ROTATED-KEY",
      "the new secret reached the instance with bucket/region/endpoint unchanged",
      storedSettings().s3.secret,
    );

    // ----------------------------------------------------------------
    section("Manage = true, Enabled = false actually disables");

    await settings.reconcile(
      api,
      {
        SMTP: smtpBlock({ Manage: true, Enabled: false }),
        S3: s3Block({ Manage: true, Enabled: false }),
      },
      quietLogger,
    );
    const afterDisable = storedSettings();
    ok(
      afterDisable.smtp.enabled === false,
      "SMTP is off on the instance, which the old code could never express",
      JSON.stringify(afterDisable.smtp),
    );
    ok(afterDisable.s3.enabled === false, "S3 is off on the instance");

    // ----------------------------------------------------------------
    section("Failures are reported, never thrown");

    const brokenLogger = collectingLogger();
    const broken = await settings.reconcile(
      {
        getSettings: () => Promise.reject(new Error("instance unreachable")),
        updateSettings: () => Promise.reject(new Error("instance unreachable")),
      },
      { SMTP: smtpBlock({ Manage: true, Enabled: true }), S3: s3Block() },
      brokenLogger,
    );
    ok(
      broken.warnings.length === 1 && broken.warnings[0].includes("instance unreachable"),
      "an unreachable instance is a warning, not an exception that fails startup",
      JSON.stringify(broken.warnings),
    );
  } finally {
    server.kill();
    await sleep(300);
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  section("Nothing writes settings back into config.lua");

  const serverSrc = fs.readFileSync(path.join(ROOT, "server/utils/server.js"), "utf8");
  const loaderSrc = fs.readFileSync(path.join(ROOT, "server/utils/config-loader.js"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(ROOT, "server/utils/settings.js"), "utf8");

  ok(
    !/syncSettingsToConfig/.test(serverSrc),
    "the shutdown sync is gone from server.js",
  );
  ok(
    !/updateAdvancedSettings/.test(loaderSrc) && !/updateAdvancedSettings/.test(serverSrc),
    "the config.lua settings writer is gone entirely",
  );
  ok(
    !/writeFileSync/.test(settingsSrc),
    "utils/settings.js writes no files at all",
  );
  // Normalised: this file is CRLF on disk, so a \n literal matches nothing.
  const serverLf = serverSrc.replace(/\r\n/g, "\n");
  const reconcileAt = serverLf.indexOf("await reconcileSettings();");
  const boxAfter = serverLf.indexOf("displayStartupStatus();", reconcileAt);
  ok(
    reconcileAt !== -1 && boxAfter !== -1,
    "startup awaits reconcileSettings() and then prints the status box",
  );
  ok(
    reconcileAt !== -1 &&
      !/setTimeout\([^)]*reconcileSettings/.test(serverLf) &&
      !/reconcileSettings\(\)[\s\S]{0,40}\}, \d+\);/.test(serverLf),
    "it is awaited inline, not left in a floating timer whose warnings land after the box",
  );
  ok(
    /Re-read rather than editing the copy taken at load\(\)/.test(loaderSrc) &&
      /readFileSync\(this\.configPath, "utf8"\)/.test(
        loaderSrc.slice(loaderSrc.indexOf("updateSuperuserCredentials")),
      ),
    "the remaining config.lua writer re-reads from disk instead of replaying a boot snapshot",
  );

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
