/**
 * Make plain Node resolve require() the way citizen-scripting-node does, so
 * the harnesses load the resource's real sources unmodified.
 *
 * The rule is not "FiveM resolves from the resource root". It is narrower, and
 * the difference is load-bearing:
 *
 *   - A script listed in fxmanifest's server_scripts is evaluated against a
 *     synthetic `<resource>//dummy.js`, so ITS requires resolve from the
 *     resource root: "./utils/config-loader.js".
 *   - Anything those scripts pull in is an ordinary CommonJS module and
 *     resolves from its own directory: a file in utils/ says "./x.js", and a
 *     file in adapters/ says "../utils/x.js".
 *
 * An earlier version of this shim rewrote "./utils/..." to the resource root
 * for every requiring file, which quietly made both spellings work here. That
 * is why utils/auth-manager.js shipped with require("./utils/process-utils.js")
 * - green in every harness, and a hard load failure on the server:
 *
 *     Error loading script utils/client.js in resource tDB:
 *     Cannot find module './utils/process-utils.js'
 *
 * So the rewrite is applied ONLY to the manifest scripts. A nested module that
 * gets the base wrong now fails here exactly as it would in game.
 *
 * Usage, before requiring anything from the resource:
 *   const ROOT = require("./fivem-require.js");
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");

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
  const rootBased =
    // A manifest script: resolves from the resource root.
    (from && SERVER_SCRIPTS.has(path.resolve(from))) ||
    // The harness itself, standing in for the manifest.
    (from && path.dirname(path.resolve(from)) === path.join(ROOT, ".dev"));

  if (rootBased && /^\.\/(utils|bin|adapters)\//.test(request)) {
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
