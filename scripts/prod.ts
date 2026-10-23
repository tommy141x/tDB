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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  // The IBM Plex faces are compiled into the PocketBase binaries, and OFL 1.1
  // condition 2 wants the licence to travel with a bundled copy. The faces'
  // own name tables carry no nameID 13, only a nameID 14 pointing at
  // scripts.sil.org/OFL, so the archive is the only place the text can be.
  "OFL-IBMPlex.txt",

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
  //
  // THE README ONLY, NEVER THE DIRECTORY. Staging `sql` wholesale shipped
  // `sql/01-lb-phone.sql` to every customer: 53 KB of a paid third-party resource's
  // schema, 75 CREATE TABLEs, committed as a test fixture in 2d10162 and never meant
  // to leave this machine. `Config.Sql.Enabled` defaults true and this folder is
  // applied at startup, so every install was creating those 75 tables in the
  // operator's own database on first boot. A directory entry here means "and whatever
  // anyone ever drops in it", which for a drop folder is precisely the wrong default.
  "sql/README.md",

  ".runtime/pocketbase-linux",
  ".runtime/pocketbase-win.exe",
];

// Both directions. stageFiles throws on an included path that has stopped
// existing; this throws on a path fxmanifest.lua declares that nobody added to
// INCLUDE — a release that builds clean and fails at start on someone's server.
assertManifestStaged(readFileSync(join(ROOT, "fxmanifest.lua"), "utf8"), INCLUDE);

stageFiles(ROOT, DIST, INCLUDE);

// ── Every redistributed component must be named in the notices ─────────────
//
// The three licence files reach the archive only because someone wrote them
// into INCLUDE above, and `assertManifestStaged` cannot help: it checks INCLUDE
// against fxmanifest.lua, which declares no licence file because none is a
// script. So the one condition MIT and OFL both impose was enforced by nobody.
//
// The second half is the part that does not rot: a vendored library or a second
// runtime binary added later is a component whose notice has to travel too, and
// the check measures the staged tree rather than a list kept here. Five
// components today — the two PocketBase binaries, eventsource, the js-sdk and
// polyglot.
step("Checking licence coverage of the staged tree");
const notices = readFileSync(join(DIST, "THIRD-PARTY-NOTICES.md"), "utf8");
for (const file of ["LICENSE.md", "THIRD-PARTY-NOTICES.md", "OFL-IBMPlex.txt"]) {
  if (!existsSync(join(DIST, file)) || statSync(join(DIST, file)).size === 0) {
    console.error(`${file} is missing from the staged tree — put it back in INCLUDE.`);
    process.exit(1);
  }
}
const components = [
  ...readdirSync(join(DIST, "server", "vendor")),
  ...readdirSync(join(DIST, ".runtime")),
];
const unnamed = components.filter((c) => !notices.includes(c));
if (unnamed.length > 0) {
  console.error(
    `THIRD-PARTY-NOTICES.md names none of: ${unnamed.join(", ")}.\n` +
      "  Every redistributed component needs its notice in the archive."
  );
  process.exit(1);
}
console.log(`  ${components.length} redistributed component(s), all named in the notices`);

// ── The two binaries must be the version everything else claims ─────────────
//
// `fetch-runtime.ts` returns early on an already-present file — "already
// present (use --force to replace)" — so the checksum it exists to enforce is
// never applied to a binary that someone dropped into `.runtime/` by hand. That
// is how this release came to carry PocketBase 0.40.5 for Windows and 0.40.4
// for Linux while the pin, fxmanifest.lua and THIRD-PARTY-NOTICES.md all said
// 0.40.4: the fetcher printed two green lines and verified nothing. The
// comment at the top of fetch-runtime.ts names platform drift as the reason the
// binaries are not committed, and the drift happened anyway.
//
// A Go binary records its own module graph, so the shipped file can be asked
// what it is instead of being trusted. The pin is read out of the fetcher's
// source rather than copied here: importing it would run it, and a second copy
// of the version number is the thing this check is about.
step("Checking the staged PocketBase binaries");
const fetcher = readFileSync(join(ROOT, "scripts", "fetch-runtime.ts"), "utf8");
const pin = fetcher.match(/PB_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!pin) {
  console.error("could not read PB_VERSION out of scripts/fetch-runtime.ts");
  process.exit(1);
}
for (const binary of [".runtime/pocketbase-linux", ".runtime/pocketbase-win.exe"]) {
  const bytes = readFileSync(join(DIST, binary));
  const stamped = bytes
    .toString("latin1")
    .match(/mod\tgithub\.com\/pocketbase\/pocketbase\tv([0-9][^\t]*)\t/)?.[1];
  if (stamped !== pin) {
    console.error(
      `${binary} is PocketBase ${stamped ?? "an unreadable version"}, not the pinned ${pin}.\n` +
        "  Run `bun scripts/fetch-runtime.ts --all --force`, or bump PB_VERSION and the notices."
    );
    process.exit(1);
  }
  console.log(`  ${binary} — PocketBase ${stamped}`);
}

step("Packaging");
createZip(new AdmZip(), DIST, join(ROOT, ".build", "tDB.zip"), "tDB");
