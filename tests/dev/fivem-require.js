/**
 * Make plain Node resolve require() the way citizen-scripting-node does, so the
 * harnesses load the resource's real sources unmodified.
 *
 * The rule is narrower than "FiveM resolves from the resource root". A script
 * listed in fxmanifest's server_scripts is evaluated against a synthetic
 * `<resource>//dummy.js`, so its requires resolve from the resource root;
 * anything those scripts pull in is an ordinary CommonJS module and resolves
 * from its own directory. So the rewrite below is applied ONLY to the manifest
 * scripts, and a nested module that gets the base wrong fails here exactly as
 * it would in game.
 *
 * Usage, before requiring anything from the resource:
 *   const ROOT = require("./fivem-require.js");
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..", "..");

// The files FiveM loads as server_scripts, read from the manifest rather than
// hardcoded, so adding one to fxmanifest.lua does not silently change how the
// harnesses resolve.
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

const SERVER_SCRIPTS = manifestServerScripts();

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const from = parent && parent.filename;
  const rootBased = Boolean(from) && SERVER_SCRIPTS.has(path.resolve(from));

  // Every relative specifier, not a list of directory names. The list used to
  // read `utils|bin|adapters`, which were the top-level directories before the
  // sources moved under `server/` -- after the move nothing matched, so this
  // rewrite silently did nothing at all.
  if (rootBased && request.startsWith("./")) {
    return originalResolve.call(
      this,
      path.join(ROOT, request.slice(2)),
      parent,
      ...rest,
    );
  }

  return originalResolve.call(this, request, parent, ...rest);
};

module.exports = ROOT;
module.exports.ROOT = ROOT;
module.exports.SERVER_SCRIPTS = SERVER_SCRIPTS;
