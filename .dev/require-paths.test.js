/**
 * Every relative require() in the resource resolves to a file that exists,
 * using the base citizen-scripting-node would actually use.
 *
 * This exists because that base is not uniform, and getting it wrong is a hard
 * load failure at server start with no warning anywhere before it:
 *
 *     Error loading script utils/client.js in resource tDB:
 *     Cannot find module './utils/process-utils.js'
 *     Require stack:
 *       - .../tDB/utils/auth-manager.js
 *       - .../tDB//dummy.js
 *
 * The rule, visible in that stack:
 *
 *   - A script listed in fxmanifest's server_scripts is evaluated against a
 *     synthetic `<resource>//dummy.js`, so its requires resolve from the
 *     RESOURCE ROOT. utils/client.js says "./utils/auth-manager.js".
 *   - Anything it pulls in is an ordinary CommonJS module and resolves from
 *     its OWN DIRECTORY. utils/auth-manager.js says "./process-utils.js",
 *     and adapters/oxmysql.js says "../utils/sql-translator.js".
 *
 * Static: nothing is executed, so this covers files no other harness loads and
 * runs in milliseconds.
 *
 * Dev harness. Run from the resource root: node .dev/require-paths.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

// The scripts FiveM loads directly, read from the manifest.
function manifestServerScripts() {
  const manifest = fs.readFileSync(path.join(ROOT, "fxmanifest.lua"), "utf8");
  const scripts = new Set();

  const block = manifest.match(/server_scripts\s*\{([\s\S]*?)\}/);
  if (block) {
    for (const m of block[1].matchAll(/['"]([^'"]+\.js)['"]/g)) {
      scripts.add(path.resolve(ROOT, m[1]));
    }
  }
  for (const m of manifest.matchAll(/^\s*server_script\s+['"]([^'"]+\.js)['"]/gm)) {
    scripts.add(path.resolve(ROOT, m[1]));
  }
  return scripts;
}

// The resource's own sources. bin/ is vendored - third-party bundles resolve
// among themselves and are not ours to police.
function ownSources() {
  const files = [];
  for (const dir of ["utils", "adapters"]) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith(".js")) files.push(path.join(full, name));
    }
  }
  return files;
}

// Strip line and block comments so a require() shown in a comment - this file
// is full of them, and so are the modules - is not treated as a real one.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function resolvesTo(specifier, baseDir) {
  const target = path.resolve(baseDir, specifier);
  for (const candidate of [target, `${target}.js`, path.join(target, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const SERVER_SCRIPTS = manifestServerScripts();
const sources = ownSources();

console.log("\n=== Manifest");
ok(SERVER_SCRIPTS.size > 0, `fxmanifest lists ${SERVER_SCRIPTS.size} server script(s)`);
for (const script of SERVER_SCRIPTS) {
  ok(
    fs.existsSync(script),
    `server_script exists: ${path.relative(ROOT, script).replace(/\\/g, "/")}`,
  );
}

console.log("\n=== Relative requires resolve from the base FiveM would use");
let checked = 0;
for (const file of sources) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const isServerScript = SERVER_SCRIPTS.has(file);

  // A manifest script resolves from the root; a plain module from its own dir.
  const base = isServerScript ? ROOT : path.dirname(file);

  const source = stripComments(fs.readFileSync(file, "utf8"));
  for (const m of source.matchAll(/require\(\s*["'](\.[^"']*)["']\s*\)/g)) {
    const specifier = m[1];
    checked++;
    ok(
      resolvesTo(specifier, base) !== null,
      `${rel} -> ${specifier}`,
      `${isServerScript ? "manifest script, base = resource root" : "module, base = its own directory"}: ` +
        `${path.relative(ROOT, path.resolve(base, specifier)).replace(/\\/g, "/")} does not exist`,
    );
  }
}
ok(checked > 0, `${checked} relative require(s) inspected`);

// The specific shape of the bug that shipped: a non-manifest module reaching
// for a path that only makes sense from the resource root. It resolves nowhere
// on the server, but it looks right, and it used to pass every harness here.
console.log("\n=== No module uses a manifest script's base");
for (const file of sources) {
  if (SERVER_SCRIPTS.has(file)) continue;

  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const source = stripComments(fs.readFileSync(file, "utf8"));
  const rootBased = [...source.matchAll(/require\(\s*["'](\.\/(?:utils|bin|adapters)\/[^"']*)["']\s*\)/g)]
    .map((m) => m[1]);

  ok(
    rootBased.length === 0,
    `${rel} does not require "./utils/..." style paths`,
    rootBased.join(", "),
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exitCode = fail === 0 ? 0 : 1;
