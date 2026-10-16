/**
 * `bun run prod` — cut the release zip.
 *
 * Until this existed, tDB's releases were assembled by hand, which is why the
 * README could promise "a release download already contains the PocketBase
 * binary" with nothing checking that it did.
 *
 * Unlike the other resources here, tDB is MIT and unescrowed: there is nothing
 * to obfuscate and no provenance token to arm. What is left is the part that
 * actually goes wrong — deciding what ships.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";
import {
  assertManifestStaged,
  createZip,
  stageFiles,
  step,
} from "../../tLib/shared/ts/build/index.ts";

const ROOT = resolve(join(import.meta.dir, ".."));
// Everything generated lands under one root, so .gitignore needs a single rule.
const DIST = join(ROOT, ".build", "dist");

// An allowlist, not a list of things to leave out. A denylist ships anything
// nobody thought to name; naming what ships means a new directory is absent
// until someone adds it here, and `stageFiles` throws on a path that has
// stopped existing rather than quietly dropping it.
//
// `.runtime/` is the interesting case. It is gitignored as a whole — it holds
// both the PocketBase binaries (fetched and checksummed by fetch-runtime.ts)
// and `pb_data/`, which is the live database. The two binaries are named
// individually rather than shipping the tree, because staging `.runtime` whole
// would put whatever this machine's server happens to have stored in it into a
// public download.
//
// Both platforms' binaries ship, deliberately: one zip serves every customer
// and the resource cannot know which OS will run it — server.js picks the name
// from the host at start. Shipping one would leave half of all installs with
// "PocketBase executable not found".
//
// Deliberately absent: `tests/`, `scripts/` (fetch-runtime.ts is the git-clone
// path; a release already has what it fetches), `node_modules/`, and the
// repo's own tooling — package.json, bun.lock, biome.json, .gitattributes.
const INCLUDE = [
  "fxmanifest.lua",
  "README.md",
  "LICENSE.md",
  // MIT requires the copyright and permission notice to travel with every
  // copy. The release carries 63MB of PocketBase binaries plus three vendored
  // libraries, so this file is a licence condition, not documentation.
  "THIRD-PARTY-NOTICES.md",

  // Every credential-shaped key in it is blank, permanently and by
  // construction, so this machine's copy IS the shippable one — there is no
  // template to keep separately and nothing to strip on the way out. Real
  // values live in `config.local.lua`, which is gitignored and is not listed
  // here. It stays at the root rather than moving into a config/ directory:
  // consumers and docs have named that path since 1.0.
  "config.lua",

  // Named as '@tDB/lib/MySQL.lua' by every consumer's manifest — the oxmysql
  // drop-in shim. tDB never loads it itself, which is exactly why it is easy to
  // forget it has to ship.
  "lib/MySQL.lua",

  "server/adapters",
  "server/utils",
  "server/vendor",

  // PocketBase reads hooks from a directory of this name at the resource root.
  "pb_hooks",

  // A drop folder for the customer's own .sql files, applied at startup. Ships
  // with its README, which is the only instructions they get.
  "sql",

  ".runtime/pocketbase-linux",
  ".runtime/pocketbase-win.exe",
];

// Both directions. stageFiles throws on an included path that has stopped
// existing; this throws on a path fxmanifest.lua declares that nobody added to
// INCLUDE — a release that builds clean and fails at start on someone's server.
assertManifestStaged(readFileSync(join(ROOT, "fxmanifest.lua"), "utf8"), INCLUDE);

stageFiles(ROOT, DIST, INCLUDE);

step("Packaging");
createZip(new AdmZip(), DIST, join(ROOT, ".build", "tDB.zip"), "tDB");
