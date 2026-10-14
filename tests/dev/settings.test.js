// Settings reconciliation: config.lua -> PocketBase, and never the other way.
//
// Runs against a real PocketBase, because it will not hand `s3.secret` back
// and a mock that returned it would pass against a broken implementation.
// Secrets are read out of PocketBase's own `_params` blob.
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

// The settings PocketBase actually persisted, secrets included.
function storedSettings() {
  const db = new DatabaseSync(path.join(DATA_DIR, "data.db"), { readOnly: true });
  const row = db.prepare("SELECT value FROM _params WHERE id='settings'").get();
  db.close();
  const buf = Buffer.isBuffer(row.value)
    ? row.value
    : Buffer.from(String(row.value).split(",").map(Number));
  return JSON.parse(buf.toString("utf8"));
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
  // Pure logic first, no server needed.
  section("What gets built from config.lua");

  ok(
    settings.desiredSmtp === undefined,
    "there is no SMTP builder: mail belongs to the admin UI, not to config.lua",
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
    "s3",
    {
      enabled: true,
      bucket: "changed-in-ui",
      region: "eu-west-1",
      endpoint: "https://s3.example.com",
    },
    settings.desiredS3(s3Block({ Enabled: true })),
  );
  ok(drift.length === 2, "two changed fields are reported", JSON.stringify(drift));
  ok(
    drift.some((d) => d.includes("changed-in-ui")),
    "the report names the value being overwritten",
    JSON.stringify(drift),
  );
  ok(
    !drift.some((d) => d.startsWith("secret")),
    "the secret is never reported as drift; it cannot be read",
    JSON.stringify(drift),
  );
  ok(
    settings.describeDrift("s3", undefined, settings.desiredS3(s3Block({ Enabled: true })))
      .length === 0,
    "an instance with no settings yet reports no drift",
  );

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

    section("The platform fact this design rests on");

    await api.updateSettings({
      s3: {
        enabled: true,
        bucket: "seeded-bucket",
        region: "ap-south-1",
        endpoint: "https://seed.example.com",
        accessKey: "AKIA-SEEDED",
        secret: "SEEDED-SECRET",
        forcePathStyle: false,
      },
    });
    const readBack = await api.getSettings();
    ok(
      readBack.s3.secret === undefined,
      "PocketBase does not return s3.secret",
      JSON.stringify(readBack.s3),
    );
    ok(
      storedSettings().s3.secret === "SEEDED-SECRET",
      "...even though it is genuinely stored",
    );

    section("Manage = false leaves the instance alone");

    const untouched = await settings.reconcile(
      api,
      { S3: s3Block({ Manage: false }) },
      quietLogger,
    );
    const afterUnmanaged = storedSettings();
    ok(
      afterUnmanaged.s3.bucket === "seeded-bucket",
      "the admin UI's bucket survives a restart",
      afterUnmanaged.s3.bucket,
    );
    ok(
      afterUnmanaged.s3.secret === "SEEDED-SECRET",
      "the admin UI's secret survives a restart",
    );
    ok(untouched.managed.length === 0, "nothing was managed");

    // Asserted on the RETURNED warnings, not on log lines: the message is a
    // banner row now, and reconcileSettings() drains result.warnings into it.
    const noisy = collectingLogger();
    const unmanaged = await settings.reconcile(
      api,
      { S3: s3Block({ Manage: false, Enabled: true }) },
      noisy,
    );
    ok(
      unmanaged.warnings.some((l) => l.includes("not applied") && l.includes("S3")),
      "an enabled but unmanaged block is called out, not silently ignored",
      JSON.stringify(unmanaged.warnings),
    );
    ok(
      !noisy.lines.some((l) => l.includes("not applied")),
      "and is NOT also printed as a loose line above the banner",
      JSON.stringify(noisy.lines),
    );

    // The negative half. Without this the rule above passes just as well when
    // it fires on every install that never touched the block, which is the
    // state it was actually in: a stock config.lua carrying a template value
    // warned on every boot and put a permanent yellow Status on a healthy
    // server.
    const quiet = collectingLogger();
    const disabled = await settings.reconcile(
      api,
      { S3: s3Block({ Manage: false, Enabled: false }) },
      quiet,
    );
    ok(
      disabled.warnings.length === 0 && disabled.ignored.length === 0,
      "a DISABLED block with fields still in it says nothing - there is nothing to apply",
      JSON.stringify(disabled.warnings),
    );

    section("Manage = true makes config.lua the truth");

    const logged = collectingLogger();
    const applied = await settings.reconcile(
      api,
      { S3: s3Block({ Manage: true, Enabled: true, Bucket: "from-config" }) },
      logged,
    );

    const afterManaged = storedSettings();
    ok(
      afterManaged.s3.bucket === "from-config",
      "config.lua's bucket replaced the admin UI's",
      afterManaged.s3.bucket,
    );
    ok(
      afterManaged.s3.secret === "s3-secret",
      "config.lua's secret was asserted, secrets and all",
      afterManaged.s3.secret,
    );
    ok(
      applied.drift.length > 0 && applied.warnings.some((l) => l.includes("overwritten")),
      "the overwrite was reported rather than done silently",
      JSON.stringify(applied.warnings),
    );
    ok(
      !logged.lines.some((l) => l.startsWith("warn:")),
      "and reported as a banner row, not also as a loose line",
      JSON.stringify(logged.lines),
    );

    section("A rotated secret is pushed even when nothing visible changed");

    await settings.reconcile(
      api,
      { S3: s3Block({ Manage: true, Enabled: true, SecretKey: "ROTATED-KEY" }) },
      quietLogger,
    );
    ok(
      storedSettings().s3.secret === "ROTATED-KEY",
      "the new secret reached the instance with bucket/region/endpoint unchanged",
      storedSettings().s3.secret,
    );

    section("Manage = true, Enabled = false actually disables");

    await settings.reconcile(
      api,
      { S3: s3Block({ Manage: true, Enabled: false }) },
      quietLogger,
    );
    ok(storedSettings().s3.enabled === false, "S3 is off on the instance");

    section("Failures are reported, never thrown");

    const brokenLogger = collectingLogger();
    const broken = await settings.reconcile(
      {
        getSettings: () => Promise.reject(new Error("instance unreachable")),
        updateSettings: () => Promise.reject(new Error("instance unreachable")),
      },
      { S3: s3Block({ Manage: true, Enabled: true }) },
      brokenLogger,
    );
    ok(
      broken.warnings.length === 1 && broken.warnings[0].includes("instance unreachable"),
      "an unreachable instance is a warning, not a failed startup",
      JSON.stringify(broken.warnings),
    );
  } finally {
    server.kill();
    await sleep(300);
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch (_) {}
  }

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
    "it is awaited inline, not left in a timer whose warnings land after the box",
  );
  const writerSrc = loaderSrc.slice(loaderSrc.indexOf("updateSuperuserCredentials"));
  ok(
    /Re-read rather than editing the copy taken at load\(\)/.test(loaderSrc) &&
      /readFileSync\(this\.localPath, "utf8"\)/.test(writerSrc),
    "the one remaining config writer re-reads from disk",
  );
  ok(
    /writeFileSync\(this\.localPath,/.test(writerSrc) &&
      !/writeFileSync\(this\.configPath/.test(loaderSrc),
    "and it writes the gitignored sidecar, never the tracked config.lua",
  );

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => {
      console.log(`  - ${f}`);
    });
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
