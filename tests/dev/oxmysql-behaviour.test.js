/**
 * Return-value parity with oxmysql, against a real PocketBase.
 *
 * The contract is oxmysql's src/utils/parseResponse.ts @ bae715c2:
 *
 *   insert  -> result.insertId     ?? null
 *   update  -> result.affectedRows ?? null
 *   single  -> result[0]           ?? null
 *   scalar  -> Object.values(result[0])[0] ?? null
 *   default -> result              ?? null      (query / execute / fetch)
 *
 * Every miss is null, never undefined or an empty table - a script doing
 * `if not row then` depends on that. JS null and undefined both cross into Lua
 * as nil, so the assertions below accept either for the "miss" cases and are
 * strict about the value cases.
 *
 * Run from the resource root: node tests/dev/oxmysql-behaviour.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux"
);
const PORT = 8193;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "behaviour@example.com";
const PASSWORD = "behaviour-password-123";

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
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

const nil = (v) => v === null || v === undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function section(name) {
  console.log(`\n=== ${name}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-behaviour-"));
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
    { stdio: "ignore" }
  );

  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${URL_BASE}/api/health`)).ok) break;
      } catch (_) {}
      await sleep(200);
    }

    const pb = new PocketBase(URL_BASE);
    pb.autoCancellation(false);
    await pb.collection("_superusers").authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const adapter = new OxMySQLAdapter(pb, (fn) => fn, quiet);
    const call = (name, ...args) => adapter.handle(name, args);

    await call(
      "update",
      "CREATE TABLE IF NOT EXISTS people (id INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(40), score INT, note VARCHAR(40), PRIMARY KEY (id))"
    );

    section("insert -> insertId");

    const id1 = await call("insert", "INSERT INTO people (name, score) VALUES (?, ?)", ["Ada", 10]);
    ok(typeof id1 === "number" && id1 > 0, "insert returns a numeric id", JSON.stringify(id1));

    const id2 = await call("insert", "INSERT INTO people (name, score) VALUES (?, ?)", ["Bob", 20]);
    ok(id2 === id1 + 1, "ids increment", `${id1} -> ${id2}`);

    section("update -> affectedRows");

    const n1 = await call("update", "UPDATE people SET score = 99 WHERE name = ?", ["Ada"]);
    ok(n1 === 1, "update returns the affected row count", JSON.stringify(n1));

    const n0 = await call("update", "UPDATE people SET score = 1 WHERE name = ?", ["nobody"]);
    ok(n0 === 0, "a write matching nothing returns 0, not nil", JSON.stringify(n0));

    const nDel = await call("update", "DELETE FROM people WHERE name = ?", ["nobody"]);
    ok(nDel === 0, "DELETE matching nothing returns 0", JSON.stringify(nDel));

    section("single -> first row or null");

    const row = await call("single", "SELECT * FROM people WHERE name = ?", ["Ada"]);
    ok(
      row && row.name === "Ada" && row.score === 99,
      "single returns the row",
      JSON.stringify(row)
    );

    const noRow = await call("single", "SELECT * FROM people WHERE name = ?", ["nobody"]);
    ok(nil(noRow), "single with no match is nil, not an empty table", JSON.stringify(noRow));

    section("scalar -> first column of first row, or null");

    const name = await call("scalar", "SELECT name FROM people WHERE id = ?", [id1]);
    ok(name === "Ada", "scalar returns the value", JSON.stringify(name));

    const count = await call("scalar", "SELECT COUNT(*) FROM people");
    ok(count === 2, "scalar reads an aggregate", JSON.stringify(count));

    const noScalar = await call("scalar", "SELECT name FROM people WHERE id = ?", [99999]);
    ok(nil(noScalar), "scalar with no match is nil", JSON.stringify(noScalar));

    const nullCol = await call("scalar", "SELECT note FROM people WHERE id = ?", [id1]);
    ok(nil(nullCol), "a NULL first column is nil", JSON.stringify(nullCol));

    section("query / execute / fetch -> rows");

    const rows = await call("query", "SELECT * FROM people ORDER BY id");
    ok(
      Array.isArray(rows) && rows.length === 2,
      "query returns an array of rows",
      JSON.stringify(rows && rows.length)
    );

    const empty = await call("query", "SELECT * FROM people WHERE name = ?", ["nobody"]);
    ok(
      Array.isArray(empty) && empty.length === 0,
      "query with no matches is an empty array, not nil",
      JSON.stringify(empty)
    );

    const viaExecute = await call("execute", "SELECT * FROM people ORDER BY id");
    ok(
      Array.isArray(viaExecute) && viaExecute.length === 2,
      "execute is an alias of query and returns rows",
      JSON.stringify(viaExecute && viaExecute.length)
    );

    const viaFetch = await call("fetch", "SELECT * FROM people ORDER BY id");
    ok(Array.isArray(viaFetch) && viaFetch.length === 2, "fetch likewise returns rows");

    section("mysql-async aliases keep their own meaning");

    const affected = await call("mysql_execute", "UPDATE people SET score = 5 WHERE name = ?", [
      "Bob",
    ]);
    ok(
      affected === 1,
      "mysql_execute returns affected rows, unlike oxmysql:execute",
      JSON.stringify(affected)
    );

    section("the _async and Sync suffixes change nothing");

    for (const suffix of ["", "_async", "Sync"]) {
      const v = await call(`scalar${suffix}`, "SELECT COUNT(*) FROM people");
      ok(v === 2, `scalar${suffix} returns the same value`, JSON.stringify(v));
    }

    section("types survive the round trip");

    await call("update", "CREATE TABLE IF NOT EXISTS types (i INT, t VARCHAR(20), n INT)");
    await call("insert", "INSERT INTO types (i, t, n) VALUES (?, ?, ?)", [42, "text", null]);
    const t = await call("single", "SELECT * FROM types");
    ok(
      typeof t.i === "number" && t.i === 42,
      "an integer comes back a number",
      JSON.stringify(t.i)
    );
    ok(typeof t.t === "string" && t.t === "text", "text comes back a string", JSON.stringify(t.t));
    ok(nil(t.n), "NULL comes back nil, not an empty string", JSON.stringify(t.n));

    section("an array parameter expands into a list, as mysql2 does");

    // `WHERE x IN (?)` with a table of values is routine oxmysql - 20 corpus
    // statements use it, most of them esx_core's - and mysql2 interpolates it
    // to `IN (1, 2, 3)`. tDB bound the array as ONE value, so the statement
    // became `IN ({:p0})` with an array bound to it: zero rows, no error. On an
    // UPDATE that meant the write silently hit nothing.
    await call(
      "update",
      "CREATE TABLE IF NOT EXISTS accounts (name VARCHAR(20) NOT NULL, owner VARCHAR(20) NOT NULL, money INT)"
    );
    for (const [name, owner, money] of [
      ["bank", "ada", 100],
      ["cash", "ada", 50],
      ["black", "ada", 25],
      ["bank", "bob", 900],
    ]) {
      await call("insert", "INSERT INTO accounts (name, owner, money) VALUES (?, ?, ?)", [
        name,
        owner,
        money,
      ]);
    }

    const inList = await call(
      "query",
      "SELECT name FROM accounts WHERE name IN (?) AND owner = ?",
      [["bank", "cash"], "ada"]
    );
    ok(
      Array.isArray(inList) && inList.length === 2,
      "IN (?) with an array matches every element, not zero rows",
      JSON.stringify(inList)
    );

    // The scalar AFTER the array still binds correctly. Placeholders are paired
    // with the rewritten SQL by POSITION, so an expansion that mis-stepped the
    // counter would silently shift every later parameter.
    ok(
      inList.every((r) => r.name === "bank" || r.name === "cash"),
      "and the parameter after the expanded array still binds to the right value",
      JSON.stringify(inList)
    );

    const inListAffected = await call(
      "update",
      "UPDATE accounts SET money = 0 WHERE name IN (?) AND owner = ?",
      [["bank", "cash"], "ada"]
    );
    ok(
      inListAffected === 2,
      "an UPDATE ... IN (?) affects every matching row",
      JSON.stringify(inListAffected)
    );
    ok(
      (await call("scalar", "SELECT money FROM accounts WHERE name = ? AND owner = ?", [
        "bank",
        "bob",
      ])) === 900,
      "and leaves a row that only matched the array's value under a different owner"
    );
    ok(
      (await call("scalar", "SELECT money FROM accounts WHERE name = ? AND owner = ?", [
        "black",
        "ada",
      ])) === 25,
      "and leaves a row the array never named"
    );

    // A single-element array must behave like a one-element list, not like the
    // bare scalar wrapped in anything.
    const one = await call("query", "SELECT name FROM accounts WHERE name IN (?)", [["black"]]);
    ok(
      one.length === 1 && one[0].name === "black",
      "a one-element array works",
      JSON.stringify(one)
    );

    // An empty list. mysql2 emits `IN ()`, a syntax error in MySQL and SQLite
    // alike; tDB binds a single NULL, which is valid and matches nothing. That
    // is the result a caller passing an empty list wants, and it can only turn
    // a crash into zero rows.
    const none = await call("query", "SELECT name FROM accounts WHERE name IN (?)", [[]]);
    ok(
      Array.isArray(none) && none.length === 0,
      "an empty array matches nothing instead of being a syntax error",
      JSON.stringify(none)
    );

    section("a named parameter keyed with its prefix, against a real database");

    // lb-phone's server/misc/backup.lua:19, verbatim in shape, including the
    // prefixed keys it actually builds (`params["@identifier"]`). Reading only
    // the bare name bound both to NULL, which `phone_backups.id` being NOT NULL
    // turned into `constraint failed: NOT NULL constraint failed` in game and
    // crash-looped the phone client-side. On a nullable column the same bug
    // stored NULL, and in a WHERE clause matched nothing, both silently.
    //
    // Run live rather than against the translator alone because this statement
    // is also an upsert: it goes through resolveConflictTarget, which needs a
    // real schema to resolve, so a unit-level repro cannot reach this path.
    await call(
      "update",
      "CREATE TABLE IF NOT EXISTS backups (id VARCHAR(50) NOT NULL, phone_number VARCHAR(20) NOT NULL, PRIMARY KEY (id))"
    );

    await call(
      "update",
      "INSERT INTO backups (id, phone_number) VALUES (@identifier, @phoneNumber) " +
        "ON DUPLICATE KEY UPDATE phone_number = @phoneNumber",
      { "@identifier": "char1:abc", "@phoneNumber": "5550101" }
    );
    ok(
      (await call("scalar", "SELECT phone_number FROM backups WHERE id = ?", ["char1:abc"])) ===
        "5550101",
      "an upsert with @-prefixed keys stores the values rather than NULL"
    );

    // The UPDATE half of the same statement, which is where a wrong binding
    // would overwrite good data with NULL instead of failing loudly.
    await call(
      "update",
      "INSERT INTO backups (id, phone_number) VALUES (@identifier, @phoneNumber) " +
        "ON DUPLICATE KEY UPDATE phone_number = @phoneNumber",
      { "@identifier": "char1:abc", "@phoneNumber": "5550202" }
    );
    ok(
      (await call("scalar", "SELECT phone_number FROM backups WHERE id = ?", ["char1:abc"])) ===
        "5550202",
      "and the ON DUPLICATE KEY UPDATE half updates it, rather than nulling it"
    );
    ok(
      (await call("scalar", "SELECT COUNT(*) FROM backups")) === 1,
      "with no duplicate row, so the conflict target resolved"
    );

    // A prefixed key in a WHERE clause is the silent half: no constraint can
    // catch it, so it just returns nothing.
    const foundByPrefixed = await call("single", "SELECT * FROM backups WHERE id = @id", {
      "@id": "char1:abc",
    });
    ok(
      foundByPrefixed && foundByPrefixed.phone_number === "5550202",
      "a @-prefixed key in a WHERE clause matches its row instead of nothing",
      JSON.stringify(foundByPrefixed)
    );

    const foundByColon = await call("single", "SELECT * FROM backups WHERE id = :id", {
      ":id": "char1:abc",
    });
    ok(foundByColon && foundByColon.phone_number === "5550202", "and so does a :-prefixed key");

    section("a parameter-count mismatch is reported, as oxmysql does");

    let threw = null;
    try {
      await call("query", "SELECT * FROM people WHERE id = ?", [1, 2, 3]);
    } catch (e) {
      threw = e;
    }
    ok(
      threw && /Expected 1 parameters, but received 3/.test(threw.message),
      "too many parameters throws with oxmysql's wording",
      threw && threw.message.slice(0, 80)
    );

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
