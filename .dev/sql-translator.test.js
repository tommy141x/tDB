/**
 * Translation checks for the oxmysql compatibility layer.
 *
 * Every translated statement is handed to a real SQLite engine, because the
 * only meaningful definition of "translated" is "SQLite accepts it and it
 * means the same thing". Run from the resource root:
 *
 *   node .dev/sql-translator.test.js
 */
const path = require("path");
const Module = require("module");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");

// FiveM resolves require() from the resource root; plain Node does not.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/^\.\/(utils|bin|adapters)\//.test(request)) {
    return originalResolve.call(this, path.join(ROOT, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

const translator = require(path.join(ROOT, "utils/sql-translator.js"));

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}${detail ? `\n      ${detail}` : ""}`);
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    return;
  }
  console.log(`  PASS  ${label}`);
}

// A schema close to what qb-core / ESX actually create.
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE players (
      id INTEGER,
      citizenid TEXT PRIMARY KEY,
      license TEXT,
      name TEXT COLLATE NOCASE,
      money INTEGER DEFAULT 0,
      metadata TEXT,
      inventory TEXT
    );
    CREATE TABLE users (
      identifier TEXT PRIMARY KEY,
      name TEXT,
      firstname TEXT,
      lastname TEXT,
      money INTEGER DEFAULT 0
    );
    CREATE TABLE player_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      citizenid TEXT,
      plate TEXT
    );
    CREATE TABLE bans (license TEXT, expire INTEGER);
    CREATE TABLE phone_messages (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, created TEXT);
  `);
  return db;
}

// Primary/unique key columns, as the runtime will supply from PRAGMA.
const CONFLICT_TARGETS = {
  players: ["citizenid"],
  users: ["identifier"],
};
const resolveConflictTarget = (t) => CONFLICT_TARGETS[t] || null;

function section(name) {
  console.log(`\n=== ${name}`);
}

/**
 * Translate, then require SQLite to accept the result.
 */
function checkPrepares(label, sql, params, opts = {}) {
  const db = opts.db || freshDb();
  let out;
  try {
    out = translator.translate(sql, params, { resolveConflictTarget });
  } catch (e) {
    ok(false, label, `translate threw: ${e.message}`);
    return null;
  }

  // PocketBase binds {:name}; SQLite itself wants :name.
  const sqliteSql = out.sql.replace(/\{:(\w+)\}/g, ":$1");

  try {
    for (const extra of out.extraStatements) db.exec(extra);
    db.prepare(sqliteSql);
    ok(true, label, null);
  } catch (e) {
    ok(false, label, `SQLite rejected: ${e.message}\n      -> ${sqliteSql}`);
    return null;
  }
  return { ...out, sqliteSql, db };
}

async function main() {
  await translator.init();
  console.log("translator initialised:", translator.isReady());

  // ------------------------------------------------------------------
  section("Placeholder normalisation");

  const np = translator._internal.normalizePlaceholders;

  let r = np("SELECT * FROM t WHERE a = ? AND b = ?");
  ok(r.sql.match(/\?/g).length === 2 && r.keys.length === 2, "positional ? preserved");

  r = np("SELECT * FROM t WHERE a = @name AND b = @other");
  ok(
    r.sql === "SELECT * FROM t WHERE a = ? AND b = ?" &&
      r.keys[0] === "name" &&
      r.keys[1] === "other",
    "@name becomes ? with key recorded",
    JSON.stringify(r),
  );

  r = np("SELECT * FROM t WHERE a = :name");
  ok(r.keys[0] === "name", "':name' becomes ? with key recorded");

  r = np("SELECT * FROM t WHERE note = 'is this a ? or @thing' AND a = ?");
  ok(
    r.keys.length === 1 && r.sql.includes("'is this a ? or @thing'"),
    "placeholders inside string literals are left alone",
    JSON.stringify(r),
  );

  // ------------------------------------------------------------------
  section("Parameter binding");

  const bound = translator.translate(
    "SELECT * FROM players WHERE citizenid = @cid AND money > @min",
    { cid: "ABC123", min: 500 },
    { resolveConflictTarget },
  );
  ok(
    bound.params.p0 === "ABC123" && bound.params.p1 === 500,
    "named params bind in order",
    JSON.stringify(bound.params),
  );
  ok(
    /\{:p0\}/.test(bound.sql) && /\{:p1\}/.test(bound.sql),
    "emits PocketBase {:pN} bind syntax",
    bound.sql,
  );

  const boundArr = translator.translate(
    "SELECT * FROM players WHERE citizenid = ? AND money > ?",
    ["XYZ", 10],
    { resolveConflictTarget },
  );
  ok(
    boundArr.params.p0 === "XYZ" && boundArr.params.p1 === 10,
    "array params bind positionally",
    JSON.stringify(boundArr.params),
  );

  // ------------------------------------------------------------------
  section("Real framework SQL -> valid SQLite");

  checkPrepares("basic select", "SELECT * FROM players WHERE citizenid = ?", ["a"]);
  checkPrepares(
    "increment",
    "UPDATE users SET money = money + ? WHERE identifier = ?",
    [100, "x"],
  );
  checkPrepares(
    "join + LIMIT x,y",
    "SELECT p.*, v.plate FROM players p LEFT JOIN player_vehicles v ON v.citizenid = p.citizenid WHERE p.license = ? ORDER BY p.id DESC LIMIT 5, 10",
    ["l"],
  );
  checkPrepares(
    "NOW/IFNULL/CONCAT",
    "SELECT NOW() AS t, IFNULL(money, 0) AS m, CONCAT(firstname, ' ', lastname) AS n FROM users",
    [],
  );
  checkPrepares("INSERT ... SET", "INSERT INTO logs SET message = ?, created = NOW()", ["m"]);
  checkPrepares(
    "backticks",
    "SELECT `name`, `money` FROM `users` WHERE `identifier` = ?",
    ["i"],
  );
  checkPrepares(
    "GROUP_CONCAT SEPARATOR",
    "SELECT citizenid, GROUP_CONCAT(plate SEPARATOR ',') AS plates FROM player_vehicles GROUP BY citizenid",
    [],
  );
  checkPrepares(
    "UNIX_TIMESTAMP",
    "SELECT COUNT(*) AS count FROM bans WHERE license = ? AND expire > UNIX_TIMESTAMP()",
    ["l"],
  );
  checkPrepares(
    "ON DUPLICATE KEY UPDATE",
    "INSERT INTO players (citizenid, license, money) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE money = VALUES(money)",
    ["a", "b", 1],
  );
  checkPrepares("DELETE ... LIMIT", "DELETE FROM phone_messages WHERE id = ? LIMIT 1", [1]);
  checkPrepares("MySQL IF()", "SELECT IF(money > 0, 'rich', 'poor') AS status FROM users", []);

  // ------------------------------------------------------------------
  section("Upsert semantics actually work");

  const db = freshDb();
  const up = checkPrepares(
    "upsert prepares",
    "INSERT INTO players (citizenid, license, money) VALUES (@cid, @lic, @money) ON DUPLICATE KEY UPDATE money = VALUES(money)",
    { cid: "C1", lic: "L1", money: 100 },
    { db },
  );

  if (up) {
    const stmt = db.prepare(up.sqliteSql);
    stmt.run({ p0: "C1", p1: "L1", p2: 100 });
    stmt.run({ p0: "C1", p1: "L1", p2: 250 });

    const rows = db.prepare("SELECT citizenid, money FROM players").all();
    ok(rows.length === 1, "upsert did not duplicate the row", JSON.stringify(rows));
    ok(
      rows[0] && rows[0].money === 250,
      "upsert updated money to the new value",
      JSON.stringify(rows),
    );
  }

  // ------------------------------------------------------------------
  section("DDL translation");

  const ddlDb = freshDb();
  const ddl = translator.translate(
    "CREATE TABLE IF NOT EXISTS characters (id INT NOT NULL AUTO_INCREMENT, citizenid VARCHAR(50), updated DATETIME ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY cid (citizenid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    [],
    { resolveConflictTarget },
  );
  try {
    ddlDb.exec(ddl.sql);
    for (const extra of ddl.extraStatements) ddlDb.exec(extra);
    ok(true, "CREATE TABLE executes on SQLite");

    const idx = ddlDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='characters'")
      .all();
    ok(
      idx.some((i) => /cid/.test(i.name)),
      "inline UNIQUE KEY became a real index",
      JSON.stringify(idx),
    );

    const trg = ddlDb
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all();
    ok(
      trg.length > 0,
      "ON UPDATE CURRENT_TIMESTAMP became a trigger",
      JSON.stringify(trg),
    );
  } catch (e) {
    ok(false, "CREATE TABLE executes on SQLite", `${e.message}\n      -> ${ddl.sql}`);
  }

  // ------------------------------------------------------------------
  section("The safety gate rejects rather than corrupts");

  function expectThrow(label, sql, opts = {}) {
    try {
      translator.translate(sql, [], { resolveConflictTarget, ...opts });
      ok(false, label, "expected a SQLTranslationError, got a result");
    } catch (e) {
      ok(
        e instanceof translator.SQLTranslationError,
        `${label} (${e.construct || e.message.slice(0, 60)})`,
      );
    }
  }

  expectThrow(
    "upsert on a table with no unique key is rejected",
    "INSERT INTO bans (license) VALUES (?) ON DUPLICATE KEY UPDATE license = VALUES(license)",
  );
  expectThrow("DATE_ADD is rejected", "SELECT DATE_ADD(NOW(), INTERVAL 1 DAY) AS d");
  expectThrow(
    "SQL_CALC_FOUND_ROWS is rejected",
    "SELECT SQL_CALC_FOUND_ROWS * FROM players",
  );
  expectThrow("garbage SQL is rejected", "SELECT FROM WHERE ((( ");

  // ------------------------------------------------------------------
  section("Text collation");

  const collDb = freshDb();

  // Not via checkPrepares: that helper runs extraStatements first, and the
  // index here cannot exist before its table. The adapter's execute() batches
  // them in the right order.
  const coll = translator.translate(
    `CREATE TABLE accounts (
       id INT AUTO_INCREMENT,
       license VARCHAR(64),
       note TEXT DEFAULT 'has, a comma (and parens)',
       token VARCHAR(64) COLLATE utf8mb4_bin,
       avatar BLOB,
       PRIMARY KEY (id),
       UNIQUE KEY license (license)
     )`,
    [],
    { resolveConflictTarget },
  );

  if (coll) {
    coll.sqliteSql = coll.sql.replace(/\{:(\w+)\}/g, ":$1");
    collDb.exec(coll.sqliteSql);
    for (const extra of coll.extraStatements) collDb.exec(extra);
    ok(true, "CREATE TABLE with text columns is accepted by SQLite");

    ok(
      /license TEXT\(64\) COLLATE NOCASE/i.test(coll.sql),
      "a text column gains COLLATE NOCASE, matching MySQL's default collation",
      coll.sql,
    );
    ok(
      /COLLATE BINARY/i.test(coll.sql) && !/utf8mb4_bin/i.test(coll.sql),
      "an explicit _bin collation becomes BINARY, not a name SQLite cannot resolve",
      coll.sql,
    );
    ok(
      !/avatar BLOB COLLATE/i.test(coll.sql),
      "a BLOB column is left alone",
      coll.sql,
    );
    ok(
      /'has, a comma \(and parens\)'/.test(coll.sql),
      "a DEFAULT string containing commas and parens is not mistaken for structure",
      coll.sql,
    );

    // Prove the behaviour, not just the text.
    collDb
      .prepare("INSERT INTO accounts (license, token) VALUES (?, ?)")
      .run("license:AbCdEf", "TokenAbC");

    const found = collDb
      .prepare("SELECT id FROM accounts WHERE license = ?")
      .all("LICENSE:ABCDEF");
    ok(found.length === 1, "a wrong-case lookup finds the row");

    const tokenMiss = collDb
      .prepare("SELECT id FROM accounts WHERE token = ?")
      .all("tokenabc");
    ok(
      tokenMiss.length === 0,
      "the _bin column stayed case-sensitive, as its author asked",
    );

    let uniqueErr = null;
    try {
      collDb
        .prepare("INSERT INTO accounts (license) VALUES (?)")
        .run("LICENSE:abcdef");
    } catch (e) {
      uniqueErr = e.message;
    }
    ok(
      uniqueErr !== null,
      "the UNIQUE index treats differing case as the same value, as MySQL does",
      uniqueErr,
    );
  }

  // ------------------------------------------------------------------
  section("Caching");

  translator.clearCache();
  const q = "SELECT * FROM players WHERE citizenid = ?";
  const a = translator.translate(q, ["one"], { resolveConflictTarget });
  const b = translator.translate(q, ["two"], { resolveConflictTarget });
  ok(a.sql === b.sql, "same shape yields identical SQL");
  ok(
    a.params.p0 === "one" && b.params.p0 === "two",
    "cached shape still binds fresh params",
    JSON.stringify([a.params, b.params]),
  );

  // ------------------------------------------------------------------
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
