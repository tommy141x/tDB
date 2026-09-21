/**
 * Concurrent calls to the same export must not cancel each other.
 *
 * The PocketBase JS SDK defaults to `autoCancellation(true)`: every request
 * gets a key derived from its method and path, and issuing a second request
 * with the same key ABORTS the first. That is a browser feature - a search box
 * superseding its own in-flight request - and it is actively wrong on a game
 * server, where two players hitting the same code path at the same moment is
 * the normal case, not a race to be resolved.
 *
 * Only one of the ~31 SDK call sites in adapters/pocketbase.js passed
 * `requestKey: null`, so the rest were cancelling each other. The failure
 * looks like an intermittent "The request was autocancelled" thrown at
 * whichever player got there first.
 *
 * Dev harness. Run from the resource root: node .dev/autocancel.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const PocketBaseAdapter = require(path.join(ROOT, "server/adapters/pocketbase.js"));
const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux",
);
const PORT = 8181;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "autocancel@example.com";
const PASSWORD = "autocancel-password-123";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => JSON.stringify(v);

const isAutocancel = (e) =>
  /autocancel|aborted/i.test((e && e.message) || "") || e?.isAbort === true;

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-autocancel-"));
  const hooksDir = `${dataDir}-hooks`;
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, "pb_hooks"))) {
    fs.copyFileSync(path.join(ROOT, "pb_hooks", file), path.join(hooksDir, file));
  }

  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", dataDir], {
    encoding: "utf8",
  });

  const server = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      dataDir,
      "--hooksDir",
      hooksDir,
      "--migrationsDir",
      path.join(dataDir, "migrations"),
    ],
    { stdio: "ignore" },
  );

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${URL}/api/health`)).ok) break;
      } catch (_) {}
      await sleep(200);
    }

    // --------------------------------------------------------------------
    console.log("\n=== The SDK's default, for the record");

    const bare = new PocketBase(URL);
    await bare
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    ok(
      bare.enableAutoCancellation === true,
      "a fresh SDK client has autoCancellation ON",
    );

    const bareResults = await Promise.allSettled(
      Array.from({ length: 6 }, () => bare.collections.getFullList()),
    );
    const bareCancelled = bareResults.filter(
      (r) => r.status === "rejected" && isAutocancel(r.reason),
    ).length;
    ok(
      bareCancelled > 0,
      `with it on, ${bareCancelled}/6 concurrent identical calls are cancelled`,
      show(bareResults.map((r) => r.status)),
    );

    // --------------------------------------------------------------------
    console.log("\n=== The client tDB actually hands to the adapters");

    // This harness builds its own client, so it would happily pass while the
    // resource shipped without the call. Pin the resource itself.
    const clientSource = fs.readFileSync(
      path.join(ROOT, "server/utils/client.js"),
      "utf8",
    );
    ok(
      /pb\.autoCancellation\(false\)/.test(clientSource),
      "server/utils/client.js disables autoCancellation on the client it hands out",
    );

    const pb = new PocketBase(URL);
    pb.autoCancellation(false);
    await pb
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    ok(pb.enableAutoCancellation === false, "tDB disables autoCancellation");

    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const pbAdapter = new PocketBaseAdapter(pb, (fn) => fn, logger);
    const oxAdapter = new OxMySQLAdapter(pb, (fn) => fn, logger);
    const pbCall = (name, ...args) => pbAdapter.handle(name, args);
    const oxCall = (name, ...args) => oxAdapter.handle(name, args);

    await oxCall(
      "update",
      `CREATE TABLE IF NOT EXISTS players (
         id INT NOT NULL AUTO_INCREMENT,
         citizenid VARCHAR(50),
         money INT DEFAULT 0,
         PRIMARY KEY (id)
       )`,
    );
    for (let i = 0; i < 5; i++) {
      await oxCall("insert", "INSERT INTO players (citizenid, money) VALUES (?, ?)", [
        `CID${i}`,
        i * 100,
      ]);
    }

    // --------------------------------------------------------------------
    console.log("\n=== Concurrent identical queries all resolve");

    // The shape of a full server: many players, one code path, same instant.
    const many = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) =>
        oxCall("single", "SELECT * FROM players WHERE citizenid = ?", [
          `CID${i % 5}`,
        ]),
      ),
    );
    const rejected = many.filter((r) => r.status === "rejected");
    ok(
      rejected.length === 0,
      "24 concurrent single() calls on the same statement all resolve",
      show(rejected.slice(0, 2).map((r) => r.reason && r.reason.message)),
    );
    ok(
      many.every((r) => r.value && typeof r.value.money === "number"),
      "each one got its own row back",
      show(many.slice(0, 3).map((r) => r.value)),
    );

    // Same path, through the PocketBase adapter's collection API.
    const lists = await Promise.allSettled(
      Array.from({ length: 12 }, () => pbCall("getCollections")),
    );
    const listRejected = lists.filter((r) => r.status === "rejected");
    ok(
      listRejected.length === 0,
      "12 concurrent getCollections() calls all resolve",
      show(listRejected.slice(0, 2).map((r) => r.reason && r.reason.message)),
    );

    // A mixed burst, which is what a busy server actually produces.
    const mixed = await Promise.allSettled([
      ...Array.from({ length: 8 }, () => oxCall("query", "SELECT * FROM players")),
      ...Array.from({ length: 8 }, () =>
        oxCall("scalar", "SELECT COUNT(*) FROM players"),
      ),
      ...Array.from({ length: 8 }, () =>
        oxCall("update", "UPDATE players SET money = money + ? WHERE citizenid = ?", [
          1,
          "CID0",
        ]),
      ),
    ]);
    const mixedRejected = mixed.filter((r) => r.status === "rejected");
    ok(
      mixedRejected.length === 0,
      "a mixed burst of 24 reads and writes all resolve",
      show(mixedRejected.slice(0, 2).map((r) => r.reason && r.reason.message)),
    );

    const finalMoney = await oxCall(
      "scalar",
      "SELECT money FROM players WHERE citizenid = ?",
      ["CID0"],
    );
    ok(
      finalMoney === 8,
      "all 8 concurrent increments were applied - none was cancelled mid-flight",
      show(finalMoney),
    );
  } finally {
    server.kill();
    await sleep(500);
    for (const d of [dataDir, hooksDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
});
