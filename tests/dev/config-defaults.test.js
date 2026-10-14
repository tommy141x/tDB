/**
 * config.example.lua and the loader's defaults are one setting each, not two.
 *
 * They used to be two, and they disagreed: ExposeAdmin was false in the loader
 * and true in the file, AutoUpdate false and true, Migrations.Dir
 * "pb_migrations" and ".runtime/pb_migrations", SMTP.Host "" and
 * "smtp.gmail.com". Nobody noticed because the shipped config.lua always set
 * every key, so the loader's half only surfaced for an operator who commented
 * one out - who then silently got a different product.
 *
 * buildDefaults() is now the source of truth and this suite is what stops the
 * example drifting away from it again: it parses config.example.lua through the
 * real loader and requires the result to equal the defaults exactly.
 *
 * Also covers the parser itself - quote styles, unreadable values, the renamed
 * Backup key - and the first-run bootstrap copy.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = require("./fivem-require.js");
const configLoader = require(path.join(ROOT, "server/utils/config-loader.js"));

const { ConfigLoader, buildDefaults } = configLoader;

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

/** Parse an arbitrary config.lua body through the real loader. */
function parse(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-config-"));
  fs.writeFileSync(path.join(dir, "config.lua"), body, "utf8");
  const loader = new ConfigLoader();
  const config = loader.load(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { config, warnings: loader.getWarnings() };
}

function diff(actual, expected, prefix = "") {
  const out = [];
  for (const key of Object.keys(expected)) {
    const a = actual ? actual[key] : undefined;
    const e = expected[key];
    if (e && typeof e === "object" && !Array.isArray(e)) {
      out.push(...diff(a, e, `${prefix}${key}.`));
    } else if (a !== e) {
      out.push(`${prefix}${key}: example gives ${JSON.stringify(a)}, defaults say ${JSON.stringify(e)}`);
    }
  }
  return out;
}

const EXAMPLE_PATH = path.join(ROOT, "config.example.lua");
const EXAMPLE = fs.readFileSync(EXAMPLE_PATH, "utf8");

section("config.example.lua ships exactly the loader's defaults");

const { config: fromExample, warnings: exampleWarnings } = parse(EXAMPLE);
const drift = diff(fromExample, buildDefaults());

ok(
  drift.length === 0,
  "every value in config.example.lua matches buildDefaults()",
  drift.join("\n      "),
);

ok(
  exampleWarnings.length === 0,
  "and the shipped example parses without a single warning",
  exampleWarnings.join("\n      "),
);

// A key that is absent from the example still parses to its default, so the
// deep-compare above cannot catch an option nobody documented. Check the names
// are actually in the file.
const UNDOCUMENTED_ON_PURPOSE = new Set([
  // Resolved at runtime by resolveInternalPort(); honouring a stale value in
  // the file is the collision that resolution exists to avoid.
  "Port",
]);

const missing = [];
(function walk(node, trail) {
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      walk(value, `${trail}${key}.`);
      continue;
    }
    if (UNDOCUMENTED_ON_PURPOSE.has(key) && trail === "") continue;
    // Top-level keys are written `Config.X =`; nested ones are bare.
    if (!new RegExp(`^[^\\S\\n]*(?:Config\\.)?${key}\\s*=`, "m").test(EXAMPLE)) {
      missing.push(`${trail}${key}`);
    }
  }
})(buildDefaults(), "");

ok(
  missing.length === 0,
  "every option the loader knows about is written out in the example",
  missing.join(", "),
);

section("The four defaults that used to disagree");

const defaults = buildDefaults();
ok(defaults.ExposeAdmin === true, "ExposeAdmin defaults true (the docs' value)");
ok(
  defaults.AutoUpdate === false,
  "AutoUpdate defaults false - it would replace a checksum-verified binary",
);
ok(
  defaults.Migrations.Dir === ".runtime/pb_migrations",
  "Migrations.Dir defaults beside pb_data",
);
ok(
  defaults.Advanced.SMTP === undefined,
  "there is no SMTP block: mail is the admin UI's, and a config copy of it was read and then not applied",
);

section("Quote styles");

const singleQuoted = parse(`
Config = {}
Config.Sql = {
    Dir = 'sql-from-single-quotes',
    OnChanged = 'apply',
}
`);
ok(
  singleQuoted.config.Sql.Dir === "sql-from-single-quotes",
  "a single-quoted Lua string is read, not silently ignored",
  JSON.stringify(singleQuoted.config.Sql.Dir),
);
ok(
  singleQuoted.config.Sql.OnChanged === "apply",
  "including for an enum value",
);
ok(
  singleQuoted.warnings.length === 0,
  "and legal Lua produces no warning",
  singleQuoted.warnings.join("; "),
);

section("A value that cannot be read says so");

const broken = parse(`
Config = {}
Config.ExposeAdmin = "true"
Config.Backup = {
    Enabled = true,
    KeepLast = "seven",
}
Config.Sql = {
    OnChanged = "sometimes",
}
`);

ok(
  broken.config.ExposeAdmin === true,
  'a quoted "true" falls back to the default rather than being truthy',
);
ok(
  broken.warnings.some(
    (w) => /Config\.ExposeAdmin/.test(w) && /true or false/.test(w) && /"true"/.test(w),
  ),
  "and the warning names the key, what was expected and what was found",
  broken.warnings.join("\n      "),
);
ok(
  broken.warnings.some((w) => /Config\.Backup\.KeepLast/.test(w) && /whole number/.test(w)),
  "a non-numeric number warns too",
  broken.warnings.join("\n      "),
);
ok(
  broken.warnings.some(
    (w) => /Config\.Sql\.OnChanged/.test(w) && /"warn", "error", "apply"/.test(w),
  ),
  "an out-of-range enum lists the values it would have accepted",
  broken.warnings.join("\n      "),
);
ok(
  broken.warnings.every((w) => /config\.lua/.test(w) && /Fix|fix|restart/.test(w)),
  "every warning names the file and says what to do",
  broken.warnings.join("\n      "),
);

section("Backup.Schedule -> Backup.ScheduleSeconds");

const legacy = parse(`
Config = {}
Config.Backup = {
    Enabled = true,
    Schedule = 3600,
    KeepLast = 7,
}
`);
ok(
  legacy.config.Backup.ScheduleSeconds === 3600,
  "the old key is still honoured, not dropped",
  JSON.stringify(legacy.config.Backup),
);
ok(
  legacy.warnings.some(
    (w) =>
      /Config\.Backup\.Schedule is deprecated/.test(w) &&
      /ScheduleSeconds/.test(w) &&
      /2\.0/.test(w),
  ),
  "with one deprecation warning naming the replacement and the removal version",
  legacy.warnings.join("\n      "),
);

const both = parse(`
Config = {}
Config.Backup = {
    Schedule = 60,
    ScheduleSeconds = 120,
}
`);
ok(
  both.config.Backup.ScheduleSeconds === 120,
  "the new key wins when both are present",
);
ok(
  !both.warnings.some((w) => /deprecated/.test(w)),
  "and the deprecation notice is not repeated at someone already migrated",
);

section("Superuser is read from its own block");

// The old whole-file regex took the first Password in the file, which was the
// superuser's only by luck of ordering. Any other block carrying a
// credential-shaped key ahead of Config.Superuser reproduces it.
const scoped = parse(`
Config = {}
Config.Advanced = {
    S3 = {
        SecretKey = "the-s3-one",
        Password = "not-a-real-key-but-first-in-the-file",
    },
}
Config.Superuser = {
    Email = "admin@example.com",
    Password = "the-superuser-one",
}
`);
ok(
  scoped.config.Superuser.Password === "the-superuser-one",
  "the superuser password comes from Config.Superuser even when another is first in the file",
  JSON.stringify(scoped.config.Superuser.Password),
);
ok(
  scoped.config.Advanced.S3.SecretKey === "the-s3-one",
  "and S3 keeps its own secret",
);

section("Commented-out keys stay commented out");

const commented = parse(`
Config = {}
-- Config.ExposeAdmin = false
-- Example: Endpoint = "s3.example.com"
Config.Advanced = {
    -- RemoteHost = "db.example.com",
    RemoteHost = "",
    RemotePort = "",
    S3 = {
        Endpoint = "",
    },
}
`);
ok(commented.config.ExposeAdmin === true, "a commented Config line is not read");
ok(
  commented.config.Advanced.RemoteHost === "",
  "a commented RemoteHost does not switch the resource into remote mode",
);
ok(
  commented.config.Advanced.S3.Endpoint === "",
  "an example endpoint inside a comment is not adopted as the endpoint",
);
ok(commented.warnings.length === 0, "and none of it warns", commented.warnings.join("; "));

section("First run creates config.lua from the example");

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-bootstrap-"));
fs.copyFileSync(EXAMPLE_PATH, path.join(fresh, "config.example.lua"));

const bootLoader = new ConfigLoader();
const booted = bootLoader.load(fresh);

ok(
  fs.existsSync(path.join(fresh, "config.lua")),
  "config.lua is created when it is missing",
);
ok(
  fs.readFileSync(path.join(fresh, "config.lua"), "utf8") === EXAMPLE,
  "byte-for-byte from config.example.lua, comments and all",
);
ok(
  diff(booted, buildDefaults()).length === 0,
  "and the fresh install runs on the documented defaults",
);

// Second load must not clobber an edited file.
fs.writeFileSync(
  path.join(fresh, "config.lua"),
  "Config = {}\nConfig.ExposeAdmin = false\n",
  "utf8",
);
const second = new ConfigLoader().load(fresh);
ok(
  second.ExposeAdmin === false,
  "a later start reads the operator's edits instead of overwriting them",
);

fs.rmSync(fresh, { recursive: true, force: true });

section("config.lua is not in the manifest and not in git");

const manifest = fs.readFileSync(path.join(ROOT, "fxmanifest.lua"), "utf8");
ok(
  !/^\s*'config\.lua',/m.test(manifest),
  "fxmanifest does not list config.lua - it may not exist yet on a fresh install",
);

const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
ok(
  /^config\.lua$/m.test(gitignore),
  "config.lua is gitignored; tDB writes the superuser password into it",
);

const prodSrc = fs.readFileSync(path.join(ROOT, "scripts/prod.ts"), "utf8");
ok(
  /"config\.example\.lua"/.test(prodSrc) && !/"config\.lua"/.test(prodSrc),
  "the release ships the template, never this machine's config.lua",
);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => {
    console.log(`  - ${f}`);
  });
}
process.exitCode = fail === 0 ? 0 : 1;
