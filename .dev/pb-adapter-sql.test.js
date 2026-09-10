/**
 * The PocketBase adapter's sql* exports, against a real instance.
 *
 * These used to call /api/sql/* and ask the caller to declare the result
 * shape, falling back to a guess parsed out of the SELECT list and finally to
 * a hardcoded { id, name, value }. They now go through /api/tdb/*, which
 * discovers the shape itself. The checks below are the behaviours that guess
 * got wrong.
 *
 * Dev harness. Run from the resource root: node .dev/pb-adapter-sql.test.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// FiveM resolves require() from the resource root; plain Node does not.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/^\.\/(utils|bin|adapters)\//.test(request)) {
    return originalResolve.call(this, path.join(ROOT, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

const PocketBaseAdapter = require(path.join(ROOT, "adapters/pocketbase.js"));
const PocketBase = require(path.join(ROOT, "bin/pocketbase.cjs.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const PORT = 8171;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "pbadapter@example.com";
const PASSWORD = "pbadapter-password-123";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-pbadapter-"));
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
    ["serve", `--http=127.0.0.1:${PORT}`, "--dir", dataDir, "--hooksDir", hooksDir],
    { stdio: "ignore" },
  );

  try {
    if (!(await waitForHealth())) throw new Error("server never became healthy");

    const pb = new PocketBase(URL);
    await pb.collection("_superusers").authWithPassword(EMAIL, PASSWORD, {
      requestKey: null,
    });

    const adapter = new PocketBaseAdapter(pb, (fn) => fn, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    const call = (name, ...args) => adapter.handle(name, args);

    await call(
      "sqlExecute",
      `CREATE TABLE players (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         citizenid TEXT,
         nickname TEXT,
         money REAL,
         note TEXT
       )`,
    );

    // ----------------------------------------------------------------
    console.log("\n=== sqlExecute");

    const first = await call(
      "sqlExecute",
      "INSERT INTO players (citizenid, nickname, money) VALUES ({:a}, {:b}, {:c})",
      { a: "ABC123", b: "Tommy", c: 1500.5 },
    );
    ok(first === 1, "sqlExecute returns a real insertId, not 0", show(first));

    const second = await call(
      "sqlExecute",
      "INSERT INTO players (citizenid, money) VALUES ({:a}, {:b})",
      { a: "XYZ789", b: null },
    );
    ok(second === 2, "insertId advances", show(second));

    // ----------------------------------------------------------------
    console.log("\n=== sqlQuery");

    const all = await call("sqlQuery", "SELECT * FROM players ORDER BY id");
    ok(Array.isArray(all) && all.length === 2, "sqlQuery returns rows", show(all));
    ok(
      all[0].citizenid === "ABC123" && all[0].money === 1500.5,
      "types survive: TEXT stays text, REAL keeps its fraction",
      show(all[0]),
    );

    // SELECT * previously fell through every guess to { id, name, value },
    // so a table without those columns came back as empty strings.
    ok(
      Object.keys(all[0]).length === 5 && all[0].nickname === "Tommy",
      "SELECT * returns the table's real columns, not a hardcoded id/name/value",
      show(Object.keys(all[0])),
    );
    ok(all[1].nickname === null, "NULL arrives as null", show(all[1]));

    const joined = await call(
      "sqlQuery",
      "SELECT p.citizenid, COUNT(*) AS n FROM players p GROUP BY p.citizenid ORDER BY p.citizenid",
    );
    ok(
      joined.length === 2 && joined[0].n === 1,
      "an aliased aggregate keeps its name and stays numeric",
      show(joined),
    );

    // ----------------------------------------------------------------
    console.log("\n=== sqlSingle");

    const one = await call(
      "sqlSingle",
      "SELECT * FROM players WHERE citizenid = {:a}",
      { a: "ABC123" },
    );
    ok(one && one.nickname === "Tommy", "sqlSingle returns one row object", show(one));

    const none = await call(
      "sqlSingle",
      "SELECT * FROM players WHERE citizenid = {:a}",
      { a: "nope" },
    );
    ok(none === null, "sqlSingle returns null when nothing matches", show(none));

    // ----------------------------------------------------------------
    console.log("\n=== sqlScalar");

    // The old default column name was "value", which only worked for a caller
    // that happened to alias its column that way.
    const money = await call(
      "sqlScalar",
      "SELECT money FROM players WHERE citizenid = {:a}",
      { a: "ABC123" },
    );
    ok(money === 1500.5, "sqlScalar defaults to the first selected column", show(money));

    const count = await call("sqlScalar", "SELECT COUNT(*) FROM players");
    ok(count === 2, "sqlScalar works on an unaliased aggregate", show(count));

    const named = await call(
      "sqlScalar",
      "SELECT citizenid, nickname FROM players WHERE id = 1",
      {},
      "nickname",
    );
    ok(named === "Tommy", "an explicit column name still wins", show(named));

    const noRows = await call("sqlScalar", "SELECT money FROM players WHERE id = 999");
    ok(noRows === null, "sqlScalar returns null when nothing matches", show(noRows));

    // A numeric-looking string used to be coerced to a number by the old route.
    await call("sqlExecute", "UPDATE players SET note = '007' WHERE id = 1");
    const note = await call("sqlScalar", "SELECT note FROM players WHERE id = 1");
    ok(
      note === "007",
      "a numeric-looking string stays a string (leading zeros intact)",
      show(note),
    );

    // ----------------------------------------------------------------
    console.log("\n=== sqlTransaction");

    const before = await call("sqlScalar", "SELECT COUNT(*) FROM players");

    const good = await call("sqlTransaction", [
      { sql: "INSERT INTO players (citizenid) VALUES ('TX1')" },
      { sql: "INSERT INTO players (citizenid) VALUES ('TX2')" },
    ]);
    ok(good === true, "a successful transaction reports true", show(good));
    ok(
      (await call("sqlScalar", "SELECT COUNT(*) FROM players")) === before + 2,
      "both statements committed",
    );

    const mid = await call("sqlScalar", "SELECT COUNT(*) FROM players");
    let txError = null;
    try {
      await call("sqlTransaction", [
        { sql: "INSERT INTO players (citizenid) VALUES ('TX3')" },
        { sql: "INSERT INTO nonexistent_table (a) VALUES (1)" },
      ]);
    } catch (e) {
      txError = e.message;
    }
    ok(txError !== null, "a failing transaction throws for this export", txError);
    ok(
      (await call("sqlScalar", "SELECT COUNT(*) FROM players")) === mid,
      "the failed transaction rolled back completely",
    );

    // ----------------------------------------------------------------
    console.log("\n=== Errors and concurrency");

    let err = null;
    try {
      await call("sqlQuery", "SELECT * FROM not_a_table");
    } catch (e) {
      err = e.message;
    }
    ok(err !== null && /not_a_table/.test(err), "an error names the real problem", err);

    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("sqlScalar", "SELECT COUNT(*) FROM players"),
      ),
    );
    ok(
      concurrent.every((v) => v === concurrent[0] && typeof v === "number"),
      "ten concurrent queries all resolve (no request auto-cancellation)",
      show(concurrent),
    );
  } finally {
    server.kill();
    await sleep(500);
    for (const dir of [dataDir, hooksDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
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
