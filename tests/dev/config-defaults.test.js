/**
 * The shipped config.lua and the loader's defaults are one setting each, not
 * two.
 *
 * They used to be two, and they disagreed: ExposeAdmin was false in the loader
 * and true in the file, AutoUpdate false and true, Migrations.Dir
 * "pb_migrations" and ".runtime/pb_migrations", SMTP.Host "" and
 * "smtp.gmail.com". Nobody noticed because the shipped config.lua always set
 * every key, so the loader's half only surfaced for an operator who commented
 * one out - who then silently got a different product.
 *
 * buildDefaults() is now the source of truth and this suite is what stops the
 * shipped file drifting away from it again: it parses config.lua through the
 * real loader and requires the result to equal the defaults exactly.
 *
 * Also covers the parser itself - quote styles, unreadable values, the renamed
 * Backup key - and the credential tiers: convar > config.local.lua > config.lua.
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

/**
 * Parse an arbitrary config.lua body through the real loader, optionally with a
 * config.local.lua sidecar beside it and a set of convars in scope.
 *
 * GetConvar is a FiveM global the loader reads through `typeof`, so standing one
 * up here is how the top tier gets exercised at all outside the game.
 */
function parse(body, { sidecar, convars } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-config-"));
  fs.writeFileSync(path.join(dir, "config.lua"), body, "utf8");
  if (sidecar !== undefined) {
    fs.writeFileSync(path.join(dir, "config.local.lua"), sidecar, "utf8");
  }
  if (convars) {
    global.GetConvar = (name, fallback) =>
      Object.hasOwn(convars, name) ? convars[name] : fallback;
  }

  const loader = new ConfigLoader();
  const config = loader.load(dir);

  if (convars) delete global.GetConvar;
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

const SHIPPED_PATH = path.join(ROOT, "config.lua");
const SHIPPED = fs.readFileSync(SHIPPED_PATH, "utf8");

section("config.lua ships exactly the loader's defaults");

const { config: fromShipped, warnings: shippedWarnings } = parse(SHIPPED);
const drift = diff(fromShipped, buildDefaults());

ok(
  drift.length === 0,
  "every value in config.lua matches buildDefaults()",
  drift.join("\n      "),
);

ok(
  shippedWarnings.length === 0,
  "and the shipped file parses without a single warning",
  shippedWarnings.join("\n      "),
);

// A key that is absent from the file still parses to its default, so the
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
    if (!new RegExp(`^[^\\S\\n]*(?:Config\\.)?${key}\\s*=`, "m").test(SHIPPED)) {
      missing.push(`${trail}${key}`);
    }
  }
})(buildDefaults(), "");

ok(
  missing.length === 0,
  "every option the loader knows about is written out in config.lua",
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

section("config.local.lua overlays config.lua");

const overlaid = parse(
  `
Config = {}
Config.ExposeAdmin = false
Config.Superuser = {
    Email = "",
    Password = "",
}
`,
  {
    sidecar: `
Config = Config or {}
Config.Superuser = {
    Email = "sidecar@example.com",
    Password = "from-the-sidecar",
}
`,
  },
);
ok(
  overlaid.config.Superuser.Password === "from-the-sidecar",
  "a credential in the sidecar replaces the blank in config.lua",
  JSON.stringify(overlaid.config.Superuser),
);
ok(
  overlaid.config.ExposeAdmin === false,
  "and a key the sidecar never mentions keeps config.lua's value",
);
ok(
  overlaid.warnings.length === 0,
  "a partial sidecar is not a file full of missing keys",
  overlaid.warnings.join("\n      "),
);

const noSidecar = parse(SHIPPED);
ok(
  noSidecar.warnings.length === 0,
  "and having no sidecar at all is the normal case, so it says nothing",
  noSidecar.warnings.join("\n      "),
);

section("A convar outranks both files");

const convarWins = parse(SHIPPED, {
  sidecar: `Config.Superuser = {\n    Password = "from-the-sidecar",\n}\n`,
  convars: { tdb_superuser_password: "from-the-convar" },
});
ok(
  convarWins.config.Superuser.Password === "from-the-convar",
  "an operator's convar beats a password tDB generated into the sidecar",
  JSON.stringify(convarWins.config.Superuser.Password),
);

const emptyConvar = parse(SHIPPED, {
  sidecar: `Config.Superuser = {\n    Password = "from-the-sidecar",\n}\n`,
  convars: { tdb_superuser_password: "" },
});
ok(
  emptyConvar.config.Superuser.Password === "from-the-sidecar",
  "an unset convar is not an override that blanks the value",
  JSON.stringify(emptyConvar.config.Superuser.Password),
);

// The pattern list the secret gate derives its key set from, in the terms this
// file can check: a credential-shaped default with no convar is a key an
// operator can only set by writing it into a file.
const SECRET_WORDS = ["password", "secret", "accesskey", "token"];
const names = new Set(configLoader.CONVAR_KEYS.map(configLoader.convarName));
const uncovered = [];
(function walk(node, trail) {
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      walk(value, [...trail, key]);
      continue;
    }
    const lower = key.toLowerCase();
    if (!SECRET_WORDS.some((word) => lower.includes(word))) continue;
    if (!names.has(configLoader.convarName([...trail, key]))) {
      uncovered.push([...trail, key].join("."));
    }
  }
})(buildDefaults(), []);

ok(
  uncovered.length === 0,
  "every credential-shaped default can be set by convar",
  uncovered.join(", "),
);
ok(
  names.has("tdb_superuser_password") && names.has("tdb_advanced_s3_secretkey"),
  "and the names follow tLib's rule: tdb_ plus the dotted path, underscored",
  [...names].join(", "),
);

section("A generated password is written to the sidecar, never to config.lua");

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-firstrun-"));
fs.copyFileSync(SHIPPED_PATH, path.join(fresh, "config.lua"));

const bootLoader = new ConfigLoader();
const booted = bootLoader.load(fresh);
ok(
  diff(booted, buildDefaults()).length === 0,
  "a fresh install with no sidecar runs on the documented defaults",
);
ok(
  booted.Superuser.Password === "",
  "with no superuser yet, which is what makes tDB generate one",
);

const saved = bootLoader.updateSuperuserCredentials(
  "admin@localhost.local",
  "GENERATED-PASSWORD",
);
const sidecarPath = path.join(fresh, "config.local.lua");

ok(saved === true, "the write reports success");
ok(fs.existsSync(sidecarPath), "config.local.lua is created for it");
ok(
  /GENERATED-PASSWORD/.test(fs.readFileSync(sidecarPath, "utf8")),
  "and holds the generated password",
);
ok(
  fs.readFileSync(path.join(fresh, "config.lua"), "utf8") === SHIPPED,
  "while config.lua is byte-for-byte what shipped - this is the whole point",
);

const restarted = new ConfigLoader().load(fresh);
ok(
  restarted.Superuser.Password === "GENERATED-PASSWORD",
  "the next start reads it back, so the admin login survives a restart",
  JSON.stringify(restarted.Superuser.Password),
);

// A second generation (the superuser repair path) rewrites the block rather
// than appending a second one.
bootLoader.updateSuperuserCredentials("admin@localhost.local", "ROTATED");
const rewritten = fs.readFileSync(sidecarPath, "utf8");
ok(
  rewritten.match(/Config\.Superuser\s*=/g).length === 1,
  "a later write replaces the Config.Superuser block instead of adding one",
  rewritten,
);
ok(
  new ConfigLoader().load(fresh).Superuser.Password === "ROTATED",
  "and the rotated password is what loads",
);

fs.rmSync(fresh, { recursive: true, force: true });

section("config.lua is tracked and blank; config.local.lua is neither");

const manifest = fs.readFileSync(path.join(ROOT, "fxmanifest.lua"), "utf8");
ok(
  !/^\s*'config\.lua',/m.test(manifest),
  "fxmanifest does not list config.lua - nothing in tDB's Lua reads it",
);

const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
ok(
  !/^config\.lua$/m.test(gitignore),
  "config.lua is NOT gitignored - it ships blank, so it is tracked",
);
ok(
  /^config\.local\.lua$/m.test(gitignore),
  "config.local.lua is gitignored; the generated password goes there",
);

const prodSrc = fs.readFileSync(path.join(ROOT, "scripts/prod.ts"), "utf8");
ok(
  /"config\.lua"/.test(prodSrc) && !/"config\.local\.lua"/.test(prodSrc),
  "the release ships config.lua and never the sidecar",
);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => {
    console.log(`  - ${f}`);
  });
}
process.exitCode = fail === 0 ? 0 : 1;
