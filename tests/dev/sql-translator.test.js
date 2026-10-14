/**
 * Translation checks for the oxmysql compatibility layer. Every translated
 * statement is handed to a real SQLite engine, since the only useful definition
 * of "translated" is that SQLite accepts it and it means the same thing.
 *
 * Run from the resource root: node .dev/sql-translator.test.js
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Resolve require() the way citizen-scripting-node does. See the file itself:
// only manifest server_scripts get the resource root as their base.
const ROOT = require("./fivem-require.js");

const translator = require(path.join(ROOT, "server/utils/sql-translator.js"));

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
    JSON.stringify(r)
  );

  r = np("SELECT * FROM t WHERE a = :name");
  ok(r.keys[0] === "name", "':name' becomes ? with key recorded");

  r = np("SELECT * FROM t WHERE note = 'is this a ? or @thing' AND a = ?");
  ok(
    r.keys.length === 1 && r.sql.includes("'is this a ? or @thing'"),
    "placeholders inside string literals are left alone",
    JSON.stringify(r)
  );

  section("Parameter binding");

  const bound = translator.translate(
    "SELECT * FROM players WHERE citizenid = @cid AND money > @min",
    { cid: "ABC123", min: 500 },
    { resolveConflictTarget }
  );
  // Scalars bind as text on purpose: SQLite applies a column's affinity to a
  // bound value, so '500' lands in a numeric column as 500, while an id stored
  // as TEXT still matches. Binding the number instead matched nothing against a
  // PocketBase-owned table's TEXT id. The value-level proof is below.
  ok(
    bound.params.p0 === "ABC123" && bound.params.p1 === "500",
    "named params bind in order, as text",
    JSON.stringify(bound.params)
  );
  ok(
    /\{:p0\}/.test(bound.sql) && /\{:p1\}/.test(bound.sql),
    "emits PocketBase {:pN} bind syntax",
    bound.sql
  );

  // oxmysql accepts a named parameter keyed WITH its prefix, and its own docs
  // show that form, so that is what resources write. Reading only the bare name
  // bound every one to NULL: lb-phone's backup.lua passes
  // `params["@identifier"]`, which hit `NOT NULL constraint failed:
  // phone_backups.id` in game. On a nullable column the same bug stored NULL
  // silently, and in a WHERE clause it matched nothing - no error either way,
  // which is the class this translator exists to refuse.
  for (const [label, supplied] of [
    ["@", { "@cid": "ABC123", "@min": 500 }],
    [":", { ":cid": "ABC123", ":min": 500 }],
  ]) {
    const prefixed = translator.translate(
      "SELECT * FROM players WHERE citizenid = @cid AND money > @min",
      supplied,
      { resolveConflictTarget }
    );
    ok(
      prefixed.params.p0 === "ABC123" && prefixed.params.p1 === "500",
      `a named param keyed with its ${label} prefix binds the same as the bare name`,
      JSON.stringify(prefixed.params)
    );
  }

  // A deliberate NULL must not fall through to a differently-keyed value, which
  // is why presence is tested rather than `=== undefined`.
  const explicitNull = translator.translate(
    "SELECT * FROM players WHERE citizenid = @cid",
    { cid: null, "@cid": "should not be reached" },
    { resolveConflictTarget }
  );
  ok(
    explicitNull.params.p0 === null,
    "an explicitly null bare key wins over a prefixed one, rather than being treated as absent",
    JSON.stringify(explicitNull.params)
  );

  const boundArr = translator.translate(
    "SELECT * FROM players WHERE citizenid = ? AND money > ?",
    ["XYZ", 10],
    { resolveConflictTarget }
  );
  ok(
    boundArr.params.p0 === "XYZ" && boundArr.params.p1 === "10",
    "array params bind positionally, as text",
    JSON.stringify(boundArr.params)
  );

  // Binding as text must not change what is stored or what matches.
  const affDb = new DatabaseSync(":memory:");
  affDb.exec("CREATE TABLE aff (id TEXT PRIMARY KEY, n INTEGER, r REAL, b BOOLEAN)");

  const bindOf = (value) =>
    translator.translate("SELECT ?", [value], { resolveConflictTarget }).params.p0;

  affDb
    .prepare("INSERT INTO aff (id, n, r, b) VALUES (?, ?, ?, ?)")
    .run(bindOf(7), bindOf(42), bindOf(3.5), bindOf(true));

  const stored = affDb
    .prepare("SELECT typeof(n) AS n, typeof(r) AS r, typeof(b) AS b, b AS bv FROM aff")
    .get();
  ok(
    stored.n === "integer" && stored.r === "real" && stored.b === "integer" && stored.bv === 1,
    "a text-bound scalar is stored with the column's own type",
    JSON.stringify(stored)
  );
  ok(
    affDb.prepare("SELECT n FROM aff WHERE n = ?").all(bindOf(42)).length === 1,
    "and a numeric column still matches a text-bound value"
  );
  ok(
    affDb.prepare("SELECT n FROM aff WHERE id = ?").all(bindOf(7)).length === 1,
    "a TEXT id matches a text-bound number, which is the whole point"
  );
  ok(bindOf(null) === null, "NULL stays NULL");
  ok(bindOf(undefined) === null, "an absent parameter is NULL");
  ok(bindOf(false) === "0", "false binds as '0', not 'false'");
  ok(bindOf(Number.NaN) === null, "NaN has no SQL spelling, so NULL");
  const buf = Buffer.from([1, 2, 3]);
  ok(bindOf(buf) === buf, "a BLOB is passed through untouched");

  section("Real framework SQL -> valid SQLite");

  checkPrepares("basic select", "SELECT * FROM players WHERE citizenid = ?", ["a"]);
  checkPrepares("increment", "UPDATE users SET money = money + ? WHERE identifier = ?", [100, "x"]);
  checkPrepares(
    "join + LIMIT x,y",
    "SELECT p.*, v.plate FROM players p LEFT JOIN player_vehicles v ON v.citizenid = p.citizenid WHERE p.license = ? ORDER BY p.id DESC LIMIT 5, 10",
    ["l"]
  );
  checkPrepares(
    "NOW/IFNULL/CONCAT",
    "SELECT NOW() AS t, IFNULL(money, 0) AS m, CONCAT(firstname, ' ', lastname) AS n FROM users",
    []
  );
  checkPrepares("INSERT ... SET", "INSERT INTO logs SET message = ?, created = NOW()", ["m"]);
  checkPrepares("backticks", "SELECT `name`, `money` FROM `users` WHERE `identifier` = ?", ["i"]);
  checkPrepares(
    "GROUP_CONCAT SEPARATOR",
    "SELECT citizenid, GROUP_CONCAT(plate SEPARATOR ',') AS plates FROM player_vehicles GROUP BY citizenid",
    []
  );
  checkPrepares(
    "UNIX_TIMESTAMP",
    "SELECT COUNT(*) AS count FROM bans WHERE license = ? AND expire > UNIX_TIMESTAMP()",
    ["l"]
  );
  checkPrepares(
    "ON DUPLICATE KEY UPDATE",
    "INSERT INTO players (citizenid, license, money) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE money = VALUES(money)",
    ["a", "b", 1]
  );
  checkPrepares("DELETE ... LIMIT", "DELETE FROM phone_messages WHERE id = ? LIMIT 1", [1]);
  checkPrepares("MySQL IF()", "SELECT IF(money > 0, 'rich', 'poor') AS status FROM users", []);

  section("Upsert semantics actually work");

  const db = freshDb();
  const up = checkPrepares(
    "upsert prepares",
    "INSERT INTO players (citizenid, license, money) VALUES (@cid, @lic, @money) ON DUPLICATE KEY UPDATE money = VALUES(money)",
    { cid: "C1", lic: "L1", money: 100 },
    { db }
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
      JSON.stringify(rows)
    );
  }

  section("DDL translation");

  const ddlDb = freshDb();
  const ddl = translator.translate(
    "CREATE TABLE IF NOT EXISTS characters (id INT NOT NULL AUTO_INCREMENT, citizenid VARCHAR(50), updated DATETIME ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE KEY cid (citizenid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    [],
    { resolveConflictTarget }
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
      JSON.stringify(idx)
    );

    const trg = ddlDb.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all();
    ok(trg.length > 0, "ON UPDATE CURRENT_TIMESTAMP became a trigger", JSON.stringify(trg));
  } catch (e) {
    ok(false, "CREATE TABLE executes on SQLite", `${e.message}\n      -> ${ddl.sql}`);
  }

  section("DDL as mysqldump actually writes it");

  // The fixture above is hand-written: an unquoted table name and a width-less
  // INT. A real dump backticks every identifier and writes int(11).
  const dumpDb = freshDb();
  const dumpSql =
    "CREATE TABLE IF NOT EXISTS `dump_players` (\n" +
    "  `id` int(11) NOT NULL AUTO_INCREMENT,\n" +
    "  `citizenid` varchar(50) NOT NULL,\n" +
    "  `money` int(11) NOT NULL DEFAULT 0,\n" +
    "  PRIMARY KEY (`id`),\n" +
    "  KEY `idx_citizenid` (`citizenid`)\n" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
  const dump = translator.translate(dumpSql, [], { resolveConflictTarget });

  // codeMask blanks quoted identifiers, so the table-name pattern can fall back
  // to capturing "IF" and put every inline index on a table called IF.
  ok(
    dump.extraStatements.every((s) => !/\bON\s+"IF"/i.test(s)),
    "an index is built on the table, not on the word IF",
    JSON.stringify(dump.extraStatements)
  );
  ok(
    dump.extraStatements.some((s) => /ON\s+"dump_players"/i.test(s)),
    "the backticked table name is read correctly through IF NOT EXISTS",
    JSON.stringify(dump.extraStatements)
  );

  // SQLite takes AUTOINCREMENT only on a column declared exactly INTEGER
  // PRIMARY KEY; int(11) is a different type token and is rejected outright.
  ok(
    !/INTEGER\s*\(\s*\d+\s*\)[^,)]*AUTOINCREMENT/i.test(dump.sql),
    "the display width is dropped from the auto-increment column",
    dump.sql
  );

  try {
    dumpDb.exec(dump.sql);
    for (const extra of dump.extraStatements) dumpDb.exec(extra);
    ok(true, "a dump-shaped CREATE TABLE executes on SQLite");

    dumpDb.exec("INSERT INTO dump_players (citizenid, money) VALUES ('ABC', 10)");
    dumpDb.exec("INSERT INTO dump_players (citizenid, money) VALUES ('DEF', 20)");
    const ids = dumpDb.prepare("SELECT id FROM dump_players ORDER BY id").all();
    ok(
      ids.length === 2 && ids[0].id === 1 && ids[1].id === 2,
      "AUTO_INCREMENT still assigns ids",
      JSON.stringify(ids)
    );
  } catch (e) {
    ok(
      false,
      "a dump-shaped CREATE TABLE executes on SQLite",
      `${e.message}\n      -> ${dump.sql}`
    );
  }

  // Statement order matters: the index cannot be created before the table.
  ok(
    /^\s*CREATE\s+TABLE/i.test(dump.sql),
    "the table statement is the main one, and extras follow it",
    dump.sql.slice(0, 60)
  );

  section("The safety gate rejects rather than corrupts");

  function expectThrow(label, sql, opts = {}) {
    try {
      translator.translate(sql, [], { resolveConflictTarget, ...opts });
      ok(false, label, "expected a SQLTranslationError, got a result");
    } catch (e) {
      ok(
        e instanceof translator.SQLTranslationError,
        `${label} (${e.construct || e.message.slice(0, 60)})`
      );
    }
  }

  expectThrow(
    "upsert on a table with no unique key is rejected",
    "INSERT INTO bans (license) VALUES (?) ON DUPLICATE KEY UPDATE license = VALUES(license)"
  );
  // DATE_ADD/DATE_SUB with a literal interval are translated now; qb-core
  // prunes with UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 31 DAY)). A non-literal
  // interval still has no SQLite form and is refused.
  expectThrow(
    "DATE_ADD with a non-literal interval is rejected",
    "SELECT DATE_ADD(NOW(), INTERVAL days DAY) AS d"
  );
  expectThrow("SQL_CALC_FOUND_ROWS is rejected", "SELECT SQL_CALC_FOUND_ROWS * FROM players");
  expectThrow("garbage SQL is rejected", "SELECT FROM WHERE ((( ");

  // Both reach SQLite as "no such table"/"no such function" otherwise, which
  // names the symptom and not the construct. lb-phone's database checker hits
  // both on startup.
  // TABLES, COLUMNS, STATISTICS and KEY_COLUMN_USAGE are translated now, via a
  // derived table that exposes MySQL's own column names. A view that has no
  // SQLite equivalent is still refused rather than quietly answering wrong.
  expectThrow(
    "an unsupported information_schema view is still refused",
    "SELECT * FROM INFORMATION_SCHEMA.TRIGGERS WHERE TABLE_NAME = ?"
  );

  // Positional, and PocketBase sorts a collection's columns, so after adoption
  // the dump's order is not the table's order. Values would land in the wrong
  // columns without erroring, so this is refused rather than translated.
  expectThrow("a column-list-free INSERT is refused", "INSERT INTO t VALUES (1, 2, 3)");
  expectThrow("...with a backticked table too", "INSERT INTO `t` VALUES (1, 2)");
  expectThrow("...and INSERT IGNORE", "INSERT IGNORE INTO t VALUES (1)");
  expectThrow("...and REPLACE INTO", "REPLACE INTO t VALUES (1)");

  // ...but it must not catch the shapes that legitimately contain VALUES.
  checkPrepares(
    "a named-column INSERT still works",
    "INSERT INTO players (citizenid, money) VALUES (?, ?)",
    ["a", 1]
  );
  checkPrepares(
    "INSERT ... SELECT still works",
    "INSERT INTO logs (message) SELECT name FROM players",
    []
  );
  expectThrow(
    "DROP FOREIGN KEY is rejected by name",
    "ALTER TABLE `phone_message_members` DROP FOREIGN KEY `fk_sender`"
  );

  section("AUTO_INCREMENT shapes real dumps actually use");

  // SQLite takes AUTOINCREMENT only on a column declared exactly INTEGER
  // PRIMARY KEY. Each of these is a type token it reads as something else.
  function execCreate(label, sql) {
    const db = new DatabaseSync(":memory:");
    let out;
    try {
      out = translator.translate(sql, [], { resolveConflictTarget });
    } catch (e) {
      ok(false, label, `translate threw: ${e.message}`);
      return null;
    }
    try {
      db.exec(out.sql);
      for (const extra of out.extraStatements) db.exec(extra);
      ok(true, label, null);
      return { db, out };
    } catch (e) {
      ok(false, label, `SQLite rejected: ${e.message}\n      -> ${out.sql}`);
      return null;
    }
  }

  const unsigned = execCreate(
    "INT UNSIGNED NOT NULL AUTO_INCREMENT is accepted",
    "CREATE TABLE `t1` (`id` INT UNSIGNED NOT NULL AUTO_INCREMENT, `name` VARCHAR(20), PRIMARY KEY (`id`))"
  );

  if (unsigned) {
    unsigned.db.exec("INSERT INTO t1 (name) VALUES ('a'), ('b')");
    const rows = unsigned.db.prepare("SELECT id FROM t1 ORDER BY id").all();
    ok(
      rows.length === 2 && rows[0].id === 1 && rows[1].id === 2,
      "the id column still auto-assigns",
      JSON.stringify(rows)
    );
  }

  // MySQL allows AUTO_INCREMENT on a column of a composite key; SQLite does
  // not. Narrowing it is lossless because an auto-increment column is already
  // unique on its own. Shape taken from lb-phone's phone_clock_alarms.
  const composite = execCreate(
    "AUTO_INCREMENT inside a composite PRIMARY KEY is accepted",
    "CREATE TABLE `t2` (`id` INT UNSIGNED NOT NULL AUTO_INCREMENT, `phone_number` VARCHAR(15) NOT NULL, PRIMARY KEY (`id`, `phone_number`))"
  );

  if (composite) {
    composite.db.exec("INSERT INTO t2 (phone_number) VALUES ('555'), ('555'), ('666')");
    const rows = composite.db.prepare("SELECT id, phone_number FROM t2 ORDER BY id").all();
    ok(
      rows.length === 3 && rows[0].id === 1 && rows[2].id === 3,
      "rows sharing the trailing key column still insert, with distinct ids",
      JSON.stringify(rows)
    );

    const idx = composite.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 't2'")
      .all();
    ok(
      idx.some((r) => /phone_number/.test(r.name)),
      "the index the wider key provided is re-created",
      JSON.stringify(idx)
    );
  }

  section("CREATE TRIGGER IF NOT EXISTS");

  // Polyglot's MySQL front end rejects IF NOT EXISTS here; SQLite accepts it.
  const trig = execCreate(
    "a trigger with IF NOT EXISTS translates",
    "CREATE TABLE `posts` (`id` INTEGER PRIMARY KEY, `likes` INT DEFAULT 0)"
  );

  if (trig) {
    trig.db.exec("CREATE TABLE likes (post_id INTEGER)");
    const t = translator.translate(
      "CREATE TRIGGER IF NOT EXISTS bump AFTER INSERT ON likes FOR EACH ROW BEGIN UPDATE posts SET likes = likes + 1 WHERE id = NEW.post_id; END",
      [],
      { resolveConflictTarget }
    );
    ok(
      /CREATE TRIGGER IF NOT EXISTS/i.test(t.sql),
      "IF NOT EXISTS is restored, so a re-import is idempotent",
      t.sql.slice(0, 60)
    );
    try {
      trig.db.exec(t.sql);
      trig.db.exec(t.sql);
      trig.db.exec("INSERT INTO posts (id) VALUES (1)");
      trig.db.exec("INSERT INTO likes (post_id) VALUES (1)");
      const n = trig.db.prepare("SELECT likes FROM posts WHERE id = 1").get();
      ok(n.likes === 1, "the trigger fires once per row", JSON.stringify(n));
    } catch (e) {
      ok(false, "the trigger applies twice without error", e.message);
    }
  }

  section("information_schema views");

  // Translated as derived tables aliased to MySQL's own column names, so the
  // caller's SELECT list, WHERE, GROUP BY and HAVING are left untouched. That
  // is what keeps placeholder order intact and what makes shapes nobody
  // enumerated work - esx_core alone issues four different projections.
  const isDb = new DatabaseSync(":memory:");
  isDb.exec(`
    CREATE TABLE users (identifier varchar(60) NOT NULL, ssn varchar(11), name varchar(255) DEFAULT 'x', age int(11));
    CREATE UNIQUE INDEX ux_users_ssn ON users (ssn);
    CREATE INDEX ix_users_name ON users (name);
    CREATE TABLE players (citizenid varchar(50) NOT NULL);
    CREATE TABLE child (pid varchar(50) REFERENCES players(citizenid));
  `);

  function isq(label, sql, params, expected) {
    let out;
    try {
      out = translator.translate(sql, params, { resolveConflictTarget });
    } catch (e) {
      ok(false, label, `translate threw: ${e.message}`);
      return;
    }
    try {
      const rows = isDb.prepare(out.sql.replace(/\{:(\w+)\}/g, ":$1")).all(out.params);
      const got = JSON.stringify(rows.map((r) => Object.values(r)[0]));
      ok(got === expected, label, `got ${got}, expected ${expected}`);
    } catch (e) {
      ok(false, label, `SQLite rejected: ${e.message}`);
    }
  }

  // qbx_core asks whether its table exists before migrating.
  isq(
    "TABLES: an existing table is found",
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_NAME = 'players' AND TABLE_SCHEMA in (SELECT DATABASE())",
    [],
    "[1]"
  );
  isq(
    "TABLES: an absent table is not",
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_NAME = 'nope' AND TABLE_SCHEMA in (SELECT DATABASE())",
    [],
    "[0]"
  );

  // esx_core's index checks, including a GROUP BY/HAVING over a nested SELECT.
  isq(
    "STATISTICS: a single-column unique index is detected",
    "SELECT COUNT(*) FROM ( SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND NON_UNIQUE = 0 GROUP BY INDEX_NAME HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'ssn' ) t",
    [],
    "[1]"
  );
  isq(
    "STATISTICS: an indexed column is reported",
    "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND SEQ_IN_INDEX = 1 AND SUB_PART IS NULL",
    ["users", "name"],
    "[1]"
  );
  isq(
    "STATISTICS: an unindexed column is not",
    "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? AND SEQ_IN_INDEX = 1 AND SUB_PART IS NULL",
    ["users", "identifier"],
    "[0]"
  );

  isq(
    "COLUMNS: DATA_TYPE drops the declared width",
    "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'age'",
    [],
    '["int"]'
  );
  isq(
    "COLUMNS: CHARACTER_MAXIMUM_LENGTH reads the width",
    "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'identifier'",
    [],
    "[60]"
  );
  isq(
    "COLUMNS: IS_NULLABLE is NO for NOT NULL",
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'identifier'",
    [],
    '["NO"]'
  );
  isq(
    "COLUMNS: IS_NULLABLE is YES otherwise",
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'ssn'",
    [],
    '["YES"]'
  );
  isq(
    "COLUMNS: esx_core's varchar filter",
    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'varchar' AND COLUMN_NAME IN ('identifier','ssn')",
    [],
    "[2]"
  );
  isq(
    "KEY_COLUMN_USAGE: a foreign key is reported",
    "SELECT REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_NAME = 'child'",
    [],
    '["players"]'
  );

  // A caller passing its real MySQL schema name must still get rows. The
  // derived tables report 'main', so comparing TABLE_SCHEMA to anything else
  // would have returned zero rows silently - this is the night_shifts probe.
  isq(
    "a caller's own schema name does not zero the result",
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    ["some_mysql_db", "users", "ssn"],
    '["ssn"]'
  );

  section("MySQL introspection statements");

  // night_shifts ran these at boot and gated playerConnecting on them, so each
  // unsupported one took the whole server down. It is retired now, which is
  // exactly why these are pinned here: the live reproducer is gone.
  const introDb2 = new DatabaseSync(":memory:");
  introDb2.exec(`
    CREATE TABLE players (id INTEGER PRIMARY KEY, citizenid TEXT NOT NULL, money INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX idx_players_citizenid ON players (citizenid);
  `);

  function introspect(label, sql, check) {
    let out;
    try {
      out = translator.translate(sql, [], { resolveConflictTarget });
    } catch (e) {
      ok(false, label, `translate threw: ${e.message}`);
      return;
    }
    try {
      const rows = introDb2.prepare(out.sql.replace(/\{:(\w+)\}/g, ":$1")).all();
      const problem = check(rows);
      ok(!problem, label, problem || undefined);
    } catch (e) {
      ok(
        false,
        label,
        `SQLite rejected: ${e.message}
      -> ${out.sql.slice(0, 110)}`
      );
    }
  }

  const fieldsOf = (rows) => rows.map((r) => r.Field);

  for (const [label, sql] of [
    ["SHOW COLUMNS FROM", "SHOW COLUMNS FROM players"],
    ["SHOW FULL COLUMNS FROM", "SHOW FULL COLUMNS FROM players"],
    ["SHOW FIELDS IN", "SHOW FIELDS IN players"],
    ["DESCRIBE", "DESCRIBE players"],
    ["DESC", "DESC players"],
    ["a backticked table name", "SHOW COLUMNS FROM `players`"],
  ]) {
    introspect(`${label} lists the columns, as MySQL names them`, sql, (rows) => {
      const fields = fieldsOf(rows);
      if (fields.join(",") !== "id,citizenid,money") return `Field was ${JSON.stringify(fields)}`;
      if (!("Type" in rows[0]) || !("Null" in rows[0]) || !("Key" in rows[0])) {
        return `missing MySQL column names: ${JSON.stringify(Object.keys(rows[0]))}`;
      }
      return null;
    });
  }

  introspect("a primary key reports Key=PRI and Null=NO", "DESCRIBE players", (rows) => {
    const id = rows.find((r) => r.Field === "id");
    if (id.Key !== "PRI") return `Key was ${JSON.stringify(id.Key)}`;
    // SQLite reports notnull = 0 for an INTEGER PRIMARY KEY; MySQL says NO.
    if (id.Null !== "NO") return `Null was ${JSON.stringify(id.Null)}`;
    return null;
  });

  introspect("a nullable column reports Null=YES", "DESCRIBE players", (rows) => {
    const money = rows.find((r) => r.Field === "money");
    return money.Null === "YES" ? null : `Null was ${JSON.stringify(money.Null)}`;
  });

  for (const [label, sql] of [
    ["SHOW INDEX FROM", "SHOW INDEX FROM players"],
    ["SHOW KEYS FROM", "SHOW KEYS FROM players"],
    ["SHOW INDEXES FROM", "SHOW INDEXES FROM players"],
  ]) {
    introspect(`${label} lists indexes with MySQL's column names`, sql, (rows) => {
      const row = rows.find((r) => r.Key_name === "idx_players_citizenid");
      if (!row) return `no such index in ${JSON.stringify(rows.map((r) => r.Key_name))}`;
      if (row.Column_name !== "citizenid") return `Column_name was ${row.Column_name}`;
      // MySQL's Non_unique is 0 for a UNIQUE index.
      if (row.Non_unique !== 0) return `Non_unique was ${row.Non_unique}`;
      if (row.Table !== "players") return `Table was ${row.Table}`;
      return null;
    });
  }

  introspect("SHOW CREATE TABLE returns the DDL", "SHOW CREATE TABLE players", (rows) =>
    rows[0] && /CREATE TABLE/i.test(rows[0]["Create Table"]) ? null : `got ${JSON.stringify(rows)}`
  );

  introspect("SHOW DATABASES names SQLite's primary schema", "SHOW DATABASES", (rows) =>
    rows[0] && rows[0].Database === "main" ? null : `got ${JSON.stringify(rows)}`
  );

  introspect("SHOW SCHEMAS behaves the same", "SHOW SCHEMAS", (rows) =>
    rows[0] && rows[0].Database === "main" ? null : `got ${JSON.stringify(rows)}`
  );

  // Double quotes are MySQL string literals, not identifiers: MySQL's default
  // sql_mode has no ANSI_QUOTES, so `DROP TABLE "x"` is a syntax error there
  // too. Accepting them would make tDB diverge from oxmysql, not match it.
  ok(
    translator
      .translate('SELECT "citizenid" FROM players', [], { resolveConflictTarget })
      .sql.includes("'citizenid'"),
    "a double-quoted name stays a string literal, as MySQL reads it"
  );

  section("INFORMATION_SCHEMA.COLUMNS column probe");

  // The shape migration code uses to ask "does this column exist". It gates
  // night_shifts' startup, which in turn gates playerConnecting, so a failure
  // here rejected every join on the server.
  const iscDb = new DatabaseSync(":memory:");
  iscDb.exec(`
    CREATE TABLE nsmdt_calls (id INTEGER PRIMARY KEY, caller TEXT, created_at TEXT);
    CREATE TABLE nsmdt_units (id INTEGER PRIMARY KEY, badge TEXT);
  `);

  const PROBE =
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?";

  function probe(label, sql, params, expected) {
    let out;
    try {
      out = translator.translate(sql, params, { resolveConflictTarget });
    } catch (e) {
      ok(false, label, `translate threw: ${e.message}`);
      return;
    }
    try {
      const rows = iscDb.prepare(out.sql.replace(/\{:(\w+)\}/g, ":$1")).all(out.params);
      const got = JSON.stringify(rows.map((r) => Object.values(r)[0]));
      ok(got === expected, label, `got ${got}, expected ${expected}`);
    } catch (e) {
      ok(false, label, `SQLite rejected: ${e.message}`);
    }
  }

  probe("an existing column is found", PROBE, ["db", "nsmdt_calls", "caller"], '["caller"]');
  probe("a missing column yields nothing", PROBE, ["db", "nsmdt_calls", "nope"], "[]");
  probe("a missing table yields nothing", PROBE, ["db", "nope", "caller"], "[]");
  probe("the right table is chosen", PROBE, ["db", "nsmdt_units", "badge"], '["badge"]');
  probe("a column of another table does not leak in", PROBE, ["db", "nsmdt_units", "caller"], "[]");
  probe(
    "the COUNT(*) form works too",
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    ["db", "nsmdt_calls", "caller"],
    "[1]"
  );
  probe(
    "and the form without TABLE_SCHEMA",
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?",
    ["nsmdt_calls", "created_at"],
    '["created_at"]'
  );

  // The parameters must stay in the caller's order. keys are recorded from the
  // original statement before any rewrite, so emitting them in a different
  // order would pair TABLE_SCHEMA's value with the table name - silently.
  const ordered = translator.translate(PROBE, ["db", "nsmdt_calls", "caller"], {
    resolveConflictTarget,
  });
  ok(
    ordered.params.p0 === "db" &&
      ordered.params.p1 === "nsmdt_calls" &&
      ordered.params.p2 === "caller",
    "placeholders keep the caller's order through the rewrite",
    JSON.stringify(ordered.params)
  );

  section("Server introspection functions");

  // Polyglot rewrites DATABASE() to the MySQL synonym SCHEMA() and leaves
  // VERSION() alone, so both used to reach SQLite as "no such function".
  const introDb = freshDb();

  function evalScalar(label, sql, check) {
    const out = checkPrepares(label, sql, [], { db: introDb });
    if (!out) return;
    const row = introDb.prepare(out.sqliteSql).get();
    const value = row[Object.keys(row)[0]];
    ok(check(value), `${label} -> ${JSON.stringify(value)}`);
  }

  evalScalar(
    "DATABASE() returns SQLite's primary schema name",
    "SELECT DATABASE()",
    (v) => v === "main"
  );
  evalScalar("SCHEMA() behaves the same", "SELECT SCHEMA()", (v) => v === "main");
  evalScalar(
    "VERSION() returns the real engine version",
    "SELECT VERSION()",
    (v) => typeof v === "string" && /^\d+\.\d+/.test(v)
  );
  evalScalar(
    "VERSION() does not claim to be MariaDB",
    "SELECT VERSION()",
    (v) => !/mariadb|mysql/i.test(v)
  );

  // The rewrites key off a call's parens, so same-named columns are untouched.
  checkPrepares(
    "a column named version is not rewritten",
    "SELECT id FROM logs WHERE message = ?",
    ["x"],
    { db: introDb }
  );

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
    { resolveConflictTarget }
  );

  if (coll) {
    coll.sqliteSql = coll.sql.replace(/\{:(\w+)\}/g, ":$1");
    collDb.exec(coll.sqliteSql);
    for (const extra of coll.extraStatements) collDb.exec(extra);
    ok(true, "CREATE TABLE with text columns is accepted by SQLite");

    ok(
      /license TEXT\(64\) COLLATE NOCASE/i.test(coll.sql),
      "a text column gains COLLATE NOCASE, matching MySQL's default collation",
      coll.sql
    );
    ok(
      /COLLATE BINARY/i.test(coll.sql) && !/utf8mb4_bin/i.test(coll.sql),
      "an explicit _bin collation becomes BINARY, not a name SQLite cannot resolve",
      coll.sql
    );
    ok(!/avatar BLOB COLLATE/i.test(coll.sql), "a BLOB column is left alone", coll.sql);
    ok(
      /'has, a comma \(and parens\)'/.test(coll.sql),
      "a DEFAULT string containing commas and parens is not mistaken for structure",
      coll.sql
    );

    // Prove the behaviour, not just the text.
    collDb
      .prepare("INSERT INTO accounts (license, token) VALUES (?, ?)")
      .run("license:AbCdEf", "TokenAbC");

    const found = collDb.prepare("SELECT id FROM accounts WHERE license = ?").all("LICENSE:ABCDEF");
    ok(found.length === 1, "a wrong-case lookup finds the row");

    const tokenMiss = collDb.prepare("SELECT id FROM accounts WHERE token = ?").all("tokenabc");
    ok(tokenMiss.length === 0, "the _bin column stayed case-sensitive, as its author asked");

    let uniqueErr = null;
    try {
      collDb.prepare("INSERT INTO accounts (license) VALUES (?)").run("LICENSE:abcdef");
    } catch (e) {
      uniqueErr = e.message;
    }
    ok(
      uniqueErr !== null,
      "the UNIQUE index treats differing case as the same value, as MySQL does",
      uniqueErr
    );
  }

  section("Caching");

  translator.clearCache();
  const q = "SELECT * FROM players WHERE citizenid = ?";
  const a = translator.translate(q, ["one"], { resolveConflictTarget });
  const b = translator.translate(q, ["two"], { resolveConflictTarget });
  ok(a.sql === b.sql, "same shape yields identical SQL");
  ok(
    a.params.p0 === "one" && b.params.p0 === "two",
    "cached shape still binds fresh params",
    JSON.stringify([a.params, b.params])
  );

  section("The gate does not refuse valid SQL");

  // The safety gate's own comment says refusing valid SQL is the worst outcome
  // available here, and three of its patterns were doing it: they matched
  // ordinary words that are only keywords in a context the pattern did not
  // check. Every entry below is plain, valid MySQL a resource could really
  // write, and every one was refused before this section existed.
  //
  // Unquoted on purpose. codeMask blanks a backticked identifier before the
  // gate runs, so `\`fxsql_values\`` always passed and only the bare form bit --
  // which is why this went unnoticed: the corpus COUNTS refusals by construct
  // but never asserted a refusal was justified, so four of these sat in the
  // output being read as four genuinely unsupported statements.
  const mustTranslate = [
    // A table name ending in `values` is not a missing column list. Both of
    // these are real statements in Qbox-project/qbxsql.
    ["INSERT INTO fxsql_values (name, enabled) VALUES (?, ?)", ["a", 1]],
    ["INSERT INTO qbxsql_benchmark_values (id, value, payload) VALUES (?, 0, ?)", ["x", "y"]],
    ["INSERT INTO values_log (a) VALUES (?)", ["x"]],
    ["REPLACE INTO fxsql_values (name) VALUES (?)", ["a"]],
    // `engine` is a real column in qbx_core and qb-garages. Already anchored;
    // kept here so the anchor cannot be loosened without this failing.
    ["SELECT engine FROM player_vehicles WHERE plate = ?", ["x"]],
    ["UPDATE player_vehicles SET engine = ?, body = ? WHERE plate = ?", [1, 2, "x"]],
    // SEPARATOR is only a keyword inside GROUP_CONCAT's argument list.
    ["SELECT separator FROM config WHERE id = ?", [1]],
    ["UPDATE config SET separator = ? WHERE id = ?", [",", 1]],
    // MODIFY is only a keyword in ALTER TABLE.
    ["SELECT modify FROM perms WHERE job = ?", ["police"]],
    ["UPDATE perms SET modify = ? WHERE job = ?", [1, "police"]],
    // DECLARE is only a keyword in a CREATE body.
    ["SELECT declare FROM customs WHERE id = ?", [1]],
    ["UPDATE customs SET declare = ? WHERE id = ?", [1, 1]],
    // These were already safe; they pin the boundary.
    ["SELECT interval FROM schedules WHERE id = ?", [1]],
    ["UPDATE schedules SET interval = ? WHERE id = ?", [60, 1]],
    ["SELECT change FROM registers WHERE id = ?", [1]],
    ["SELECT key FROM kvp WHERE key = ?", ["a"]],
    ["INSERT INTO crypto (name, worth) VALUES (?, ?)", ["qbit", 1000]],
    // GROUP_CONCAT ... SEPARATOR used to be refused by name. It should not be:
    // the transpiler turns it into SQLite's two-argument form, which the engine
    // PocketBase embeds accepts and answers correctly. Measured.
    ["SELECT GROUP_CONCAT(name SEPARATOR ', ') FROM t", []],
    ["SELECT GROUP_CONCAT(name) FROM t", []],
    ["SELECT GROUP_CONCAT(DISTINCT name) FROM t", []],
    // A keyword inside a string literal is not a keyword.
    ["SELECT * FROM t WHERE note = 'MODIFY COLUMN is in this string'", []],
    ["SELECT * FROM t WHERE note = 'INSERT INTO x VALUES (1)'", []],
    ["SELECT * FROM t WHERE descr = 'CALL me'", []],
    // A JOIN inside a SET subquery is not a multi-table UPDATE.
    ["UPDATE t SET a = (SELECT b FROM u JOIN v ON v.id = u.id WHERE u.id = t.id)", []],
    ["DELETE FROM t WHERE id IN (SELECT id FROM u WHERE flag = ?)", [1]],
  ];

  for (const [sql, supplied] of mustTranslate) {
    let refused = null;
    try {
      translator.translate(sql, supplied, { resolveConflictTarget });
    } catch (error) {
      refused = error.construct || error.message;
    }
    ok(refused === null, `not refused: ${sql.slice(0, 64)}`, refused || undefined);
  }

  // The same patterns must still catch the real thing, or the anchors above
  // have simply disabled them.
  const mustRefuse = [
    ["INSERT INTO crypto VALUES (?, ?, ?)", ["a", "b", "c"], /column list/],
    ["CREATE TRIGGER t AFTER INSERT ON a BEGIN DECLARE v INT; END", [], /DECLARE/],
    ["LOCK TABLES users WRITE", [], /LOCK TABLES/],
    ["CALL my_proc(1)", [], /CALL/],
    ["SET @v := 1", [], /SET @variable/],
    ["ALTER TABLE t DROP FOREIGN KEY fk_a", [], /DROP FOREIGN KEY/],
  ];

  // Five entries left this list rather than being deleted quietly, because each
  // one is now SUPPORTED and the suite has to say which behaviour replaced the
  // refusal:
  //
  //   * ALTER TABLE ... MODIFY/CHANGE COLUMN now return a table-rebuild
  //     descriptor instead of throwing; see the section below.
  //   * UPDATE ... JOIN and multi-table DELETE now translate to EXISTS
  //     subqueries; see the section above.
  for (const [sql, supplied, pattern] of mustRefuse) {
    let refused = null;
    try {
      translator.translate(sql, supplied, { resolveConflictTarget });
    } catch (error) {
      refused = error.construct || error.message;
    }
    ok(
      refused !== null && pattern.test(refused),
      `still refused, by name: ${sql.slice(0, 56)}`,
      refused === null ? "translated" : refused
    );
  }

  section("GROUP_CONCAT keeps the ORDER BY MySQL puts inside the call");

  // MySQL writes `GROUP_CONCAT(x ORDER BY y SEPARATOR s)`. The transpiler
  // converted the SEPARATOR correctly and DROPPED the ORDER BY, so the result
  // came back in arbitrary order with no error. Both real uses in the corpus
  // have an ORDER BY: sd-phone builds a last-message preview with
  // SUBSTRING_INDEX(GROUP_CONCAT(body ORDER BY created_at DESC ...), ...), so
  // dropping it showed the OLDEST message where the newest was wanted.
  // Measured on real data: 'third~second~first' with the clause,
  // 'first~second~third' without.
  //
  // SQLite has taken ORDER BY inside an aggregate since 3.44, and the engine
  // PocketBase 0.40.4 embeds is 3.53.4 - measured against the real binary by
  // tests/dev/probe-group-concat.js, not against node:sqlite, which is a
  // different build.
  const groupConcat = [
    [
      "SELECT GROUP_CONCAT(name ORDER BY name ASC SEPARATOR ',') FROM t",
      /group_concat\(name, ',' ORDER BY name ASC\)/,
    ],
    // No SEPARATOR: the comma is written out anyway, because the two-argument
    // form is what carries the ORDER BY.
    [
      "SELECT GROUP_CONCAT(name ORDER BY created_at DESC) FROM t",
      /group_concat\(name, ',' ORDER BY created_at DESC\)/,
    ],
    // Backticks inside the clause travel through a string literal, where the
    // transpiler cannot see them, so they are converted here or the output
    // would trip the backtick gate.
    [
      "SELECT GROUP_CONCAT(`name` ORDER BY `created_at` DESC SEPARATOR '|') FROM t",
      /group_concat\("name", '\|' ORDER BY "created_at" DESC\)/,
    ],
  ];

  for (const [sql, pattern] of groupConcat) {
    let got = null;
    let failed = null;
    try {
      got = translator.translate(sql, [], { resolveConflictTarget }).sql;
    } catch (error) {
      failed = error.construct || error.message;
    }
    ok(got !== null && pattern.test(got), `ORDER BY survives: ${sql.slice(0, 52)}`, failed || got);
  }

  // sd-phone's real statement, end to end.
  const lastMessage = translator.translate(
    "SELECT SUBSTRING_INDEX(GROUP_CONCAT(body ORDER BY created_at DESC SEPARATOR '~'), '~', 1) " +
      "AS last FROM m WHERE c = ?",
    ["x"],
    { resolveConflictTarget }
  );
  ok(
    /ORDER BY created_at DESC/.test(lastMessage.sql),
    "sd-phone's last-message preview keeps its DESC ordering",
    lastMessage.sql
  );
  ok(
    lastMessage.params.p0 === "x",
    "and the statement's own parameter still binds",
    JSON.stringify(lastMessage.params)
  );

  // The two forms that genuinely have no SQLite spelling are refused BY NAME,
  // rather than translated into something that fails at the database.
  const groupConcatRefused = [
    // Measured against the real engine: "DISTINCT aggregates must have exactly
    // one argument", so the separator cannot be passed at all.
    ["SELECT GROUP_CONCAT(DISTINCT name SEPARATOR ',') FROM t", /DISTINCT \.\.\. SEPARATOR/],
    ["SELECT GROUP_CONCAT(DISTINCT name ORDER BY name) FROM t", /DISTINCT \.\.\. ORDER BY/],
  ];

  for (const [sql, pattern] of groupConcatRefused) {
    let refused = null;
    try {
      translator.translate(sql, [], { resolveConflictTarget });
    } catch (error) {
      refused = error.construct || error.message;
    }
    ok(
      refused !== null && pattern.test(refused),
      `refused by name: ${sql.slice(0, 52)}`,
      refused === null ? "translated" : refused
    );
  }

  // A bound parameter in the ORDER BY would be REORDERED: MySQL's text order is
  // expr, order-by, separator and SQLite's is expr, separator, order-by, and
  // placeholders are paired with the rewritten statement by POSITION. Refused
  // rather than risked.
  let reordered = null;
  try {
    translator.translate("SELECT GROUP_CONCAT(name ORDER BY ? SEPARATOR ?) FROM t", ["a", "b"], {
      resolveConflictTarget,
    });
  } catch (error) {
    reordered = error.construct || error.message;
  }
  ok(
    reordered !== null && /bound parameter/.test(reordered),
    "a bound parameter in the ORDER BY is refused, not silently re-paired",
    reordered === null ? "translated" : reordered
  );

  section("UPDATE ... JOIN and multi-table DELETE become EXISTS subqueries");

  // SQLite updates one table and has no JOIN in UPDATE. Its own answer is
  // `UPDATE ... FROM`, which MySQL cannot parse - so the transpiler could never
  // be shown that form. An EXISTS subquery is valid in BOTH dialects, so these
  // go through the ordinary path with no marker.
  //
  // Executed, not just matched: a rewrite that updates every row instead of the
  // joined ones would look perfect as text.
  {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE users (identifier TEXT, accounts TEXT)");
    db.exec("CREATE TABLE ops (identifier TEXT, operation_id TEXT)");
    db.exec("INSERT INTO users VALUES ('c1','old'),('c2','keep')");
    db.exec("INSERT INTO ops VALUES ('c1','op7')");

    const updated = translator.translate(
      "UPDATE users u JOIN ops p ON p.identifier = u.identifier SET u.accounts = ? WHERE p.operation_id = ?",
      ["NEW", "op7"],
      { resolveConflictTarget }
    );
    const info = db.prepare(updated.sql.replace(/\{:(\w+)\}/g, ":$1")).run(updated.params);
    ok(info.changes === 1, "only the joined row is updated", `changes ${info.changes}`);
    const after = db.prepare("SELECT accounts FROM users ORDER BY identifier").all();
    ok(
      after[0].accounts === "NEW" && after[1].accounts === "keep",
      "and the unjoined row is untouched",
      JSON.stringify(after)
    );

    // The SET list comes before the ON clause in the output where MySQL has it
    // after, so this is the assertion that the parameters did not get re-paired.
    ok(
      updated.params.p0 === "NEW" && updated.params.p1 === "op7",
      "the SET parameter stays ahead of the WHERE parameter",
      JSON.stringify(updated.params)
    );

    db.exec("CREATE TABLE w (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE p2 (operation_id TEXT)");
    db.exec("INSERT INTO w VALUES (1),(2)");
    db.exec("INSERT INTO p2 VALUES ('legacy:1')");
    const deleted = translator.translate(
      "DELETE w FROM w w JOIN p2 p ON p.operation_id = CONCAT('legacy:', w.id)",
      [],
      { resolveConflictTarget }
    );
    const dinfo = db.prepare(deleted.sql).run();
    ok(dinfo.changes === 1, "a multi-table DELETE removes only the joined row");
    ok(db.prepare("SELECT id FROM w").all().length === 1, "and leaves the other one");
  }

  // Four aliases, an INNER JOIN and four assignments: qbx_vehicleshop's, which
  // is the shape that has to keep working.
  const financing = translator.translate(
    "UPDATE vehicle_financing AS vf INNER JOIN player_vehicles AS pv ON vf.vehicleId = pv.id " +
      "SET vf.balance = ?, vf.paymentamount = ?, vf.paymentsleft = ?, vf.financetime = ? WHERE pv.id = ?",
    [1, 2, 3, 4, 5],
    { resolveConflictTarget }
  );
  ok(
    /SET balance = \{:p0\}/.test(financing.sql) && !/vf\.balance/.test(financing.sql),
    "the target's alias is stripped from the assigned columns, as SQLite requires",
    financing.sql
  );
  ok(
    financing.params.p4 === "5",
    "and the WHERE parameter is still last",
    JSON.stringify(financing.params)
  );

  // Two refusals, both about silence rather than syntax.
  for (const [sql, supplied, pattern] of [
    [
      // EXISTS cannot carry a value out of the joined table.
      "UPDATE a JOIN b ON a.id = b.id SET a.x = b.y",
      [],
      /assigning from the joined table/,
    ],
  ]) {
    let refused = null;
    try {
      translator.translate(sql, supplied, { resolveConflictTarget });
    } catch (error) {
      refused = error.construct || error.message;
    }
    ok(
      refused !== null && pattern.test(refused),
      `refused by name: ${sql.slice(0, 54)}`,
      refused === null ? "translated" : refused
    );
  }

  // A JOIN inside a SET subquery is not a multi-table UPDATE and must be left
  // alone - the pattern keys off the JOIN coming BEFORE the SET.
  const subquery = translator.translate(
    "UPDATE t SET a = (SELECT b FROM u JOIN v ON v.id = u.id WHERE u.id = t.id)",
    [],
    { resolveConflictTarget }
  );
  ok(!/EXISTS/i.test(subquery.sql), "a JOIN inside a SET subquery is untouched", subquery.sql);

  section("ALTER TABLE MODIFY/CHANGE hands over a table-rebuild descriptor");

  // SQLite cannot retype a column, change a default, or add or remove NOT NULL,
  // so these were refused by name - 13 real statements. A rebuild needs the
  // LIVE schema, so the translator parses the actions and the executor plans
  // them; `sql` on the result is the UNTRANSLATED original and must not run.
  const rebuilds = [
    [
      "ALTER TABLE `users` MODIFY COLUMN `ssn` VARCHAR(11) NOT NULL",
      { table: "users", kinds: ["modify"], first: { column: "ssn" } },
    ],
    [
      "ALTER TABLE `weed_plants` CHANGE COLUMN `building` `property` varchar(30) NULL",
      { table: "weed_plants", kinds: ["change"], first: { from: "building", to: "property" } },
    ],
    [
      // mysqldump's shape: a MODIFY and a sequence start in one statement.
      "ALTER TABLE `addon_account_data` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9",
      { table: "addon_account_data", kinds: ["modify", "autoIncrementStart"] },
    ],
    [
      // qb-vehicleshop's. SQLite cannot add a constraint in place, so this
      // needs the same rebuild MODIFY does; it used to fail the whole file.
      "ALTER TABLE `player_vehicles` ADD CONSTRAINT FK_pv_players " +
        "FOREIGN KEY (citizenid) REFERENCES `players` (citizenid) ON DELETE CASCADE",
      { table: "player_vehicles", kinds: ["addForeignKey"] },
    ],
    [
      // qbx_core's: an ADD COLUMN alongside a MODIFY, which have to land
      // together because MySQL applied them in one statement.
      "ALTER TABLE `players` ADD COLUMN IF NOT EXISTS `last_logged_out` timestamp NULL " +
        "DEFAULT NULL AFTER `last_updated`, MODIFY COLUMN `name` varchar(255) NOT NULL",
      { table: "players", kinds: ["addColumn", "modify"] },
    ],
  ];

  for (const [sql, expected] of rebuilds) {
    const out = translator.translate(sql, [], { resolveConflictTarget });
    ok(
      out.rebuild && out.rebuild.table === expected.table,
      `a rebuild descriptor names the table: ${expected.table}`,
      JSON.stringify(out.rebuild)
    );
    ok(
      out.rebuild &&
        JSON.stringify(out.rebuild.actions.map((a) => a.kind)) === JSON.stringify(expected.kinds),
      `and every action in order: ${expected.kinds.join(" + ")}`,
      JSON.stringify(out.rebuild && out.rebuild.actions)
    );
    if (expected.first) {
      const action = out.rebuild.actions[0];
      for (const [key, value] of Object.entries(expected.first)) {
        ok(
          action[key] === value,
          `and reads the column name off the ORIGINAL, not the mask: ${key} = ${value}`,
          JSON.stringify(action)
        );
      }
    }
  }

  // An ALTER that needs no rebuild must keep taking the cheaper path, or every
  // ADD COLUMN would start rewriting its whole table.
  for (const sql of ["ALTER TABLE t ADD COLUMN x int DEFAULT 0", "ALTER TABLE t ADD KEY idx (a)"]) {
    const out = translator.translate(sql, [], { resolveConflictTarget });
    ok(!out.rebuild, `no rebuild for: ${sql}`, JSON.stringify(out.rebuild));
  }

  section("A rewrite may reorder or duplicate placeholders, and says so");

  // Placeholders are paired with the rewritten statement by POSITION, which is
  // why two constructs used to be refused outright. That was never necessary:
  // the translator OWNS the mapping, so a rewrite that moves or copies a
  // placeholder only has to report the new order and the key list is rebuilt.
  {
    const { DatabaseSync } = require("node:sqlite");

    // esx_core's: a parameter in ON, in SET and in WHERE. MySQL's text order is
    // ON, SET, WHERE; the output's is SET, ON, WHERE.
    const permuted = translator.translate(
      "UPDATE addon_account_data a JOIN ops p ON p.operation_id = ? SET a.money = ? WHERE a.account_name = ?",
      ["OP7", "999", "bank"],
      { resolveConflictTarget }
    );
    ok(
      permuted.params.p0 === "999" && permuted.params.p1 === "OP7" && permuted.params.p2 === "bank",
      "the ON parameter follows the SET parameter, as the output text does",
      JSON.stringify(permuted.params)
    );

    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE addon_account_data (account_name TEXT, money INT)");
    db.exec("CREATE TABLE ops (operation_id TEXT)");
    db.exec("INSERT INTO addon_account_data VALUES ('bank',1),('black',1)");
    db.exec("INSERT INTO ops VALUES ('OP7')");
    const hit = db.prepare(permuted.sql.replace(/\{:(\w+)\}/g, ":$1")).run(permuted.params);
    ok(hit.changes === 1, "and it updates exactly the joined row", `changes ${hit.changes}`);
    ok(
      db.prepare("SELECT money FROM addon_account_data WHERE account_name = ?").get("bank")
        .money === 999,
      "with the right value in it"
    );

    // A wrong operation id must match nothing - the proof that the ON parameter
    // is really being used as the ON parameter.
    const missed = translator.translate(
      "UPDATE addon_account_data a JOIN ops p ON p.operation_id = ? SET a.money = ? WHERE a.account_name = ?",
      ["NOPE", "5", "bank"],
      { resolveConflictTarget }
    );
    ok(
      db.prepare(missed.sql.replace(/\{:(\w+)\}/g, ":$1")).run(missed.params).changes === 0,
      "a non-matching ON parameter matches nothing, so it is not being re-paired"
    );
  }

  section("MATCH ... AGAINST becomes a substring search across the same columns");

  // A stated approximation, like ADD PRIMARY KEY becoming a UNIQUE INDEX.
  // SQLite's full-text search is FTS5, a virtual table needing a shadow copy
  // and sync triggers - which a SELECT cannot create. Measured across the
  // corpus: all 9 of these are ox_banking's and ox_mdt's, every one uses
  // BOOLEAN MODE, and 7 of the 9 carry their own ORDER BY, so they do not read
  // relevance even under MySQL. Refusing meant their search boxes returned an
  // error instead of rows.
  {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE characters (stateId TEXT, firstName TEXT, lastName TEXT)");
    db.exec(
      "INSERT INTO characters VALUES ('AB1','John','Smith'),('CD2','Jane','Doe'),('smi9','Zed','Zed')"
    );

    const search = (term) => {
      // ox_mdt's statement, verbatim in shape.
      const out = translator.translate(
        "SELECT stateId FROM characters WHERE MATCH (stateId, firstName, lastName) AGAINST (? IN BOOLEAN MODE)",
        [term],
        { resolveConflictTarget }
      );
      return {
        sql: out.sql,
        params: out.params,
        rows: db
          .prepare(out.sql.replace(/\{:(\w+)\}/g, ":$1"))
          .all(out.params)
          .map((r) => r.stateId),
      };
    };

    const smi = search("smi");
    // CONCAT, not `||`: this rewrite runs BEFORE the transpiler, and in MySQL's
    // default sql_mode `||` is logical OR - emitting it produced
    // `'%' OR ? OR '%'`, which is truthy for every row, so the search returned
    // the whole table. Measured.
    ok(
      /LIKE '%' \|\| \{:p0\} \|\| '%'/.test(smi.sql),
      "the term is concatenated, not OR-ed",
      smi.sql
    );
    ok(
      smi.params.p0 === "smi" && smi.params.p1 === "smi" && smi.params.p2 === "smi",
      "one bound term becomes one copy per column",
      JSON.stringify(smi.params)
    );
    ok(
      smi.rows.length === 2 && smi.rows.includes("AB1") && smi.rows.includes("smi9"),
      "it matches across every named column, and only the rows that contain the term",
      JSON.stringify(smi.rows)
    );
    ok(JSON.stringify(search("doe").rows) === '["CD2"]', "a term in one column matches one row");
    ok(search("zzz").rows.length === 0, "and a term in none matches nothing");
  }

  // Parameters before, between and after two MATCHes, which is ox_banking's
  // transactions query - the shape where a miscounted expansion would shift
  // every later parameter.
  const twoMatches = translator.translate(
    "SELECT x FROM t WHERE (fromId = ? OR toId = ?) AND (MATCH(c.fullName) AGAINST (? IN BOOLEAN MODE) " +
      "OR MATCH(at.message) AGAINST (? IN BOOLEAN MODE)) AND (fromId = ?) LIMIT 6 OFFSET ?",
    ["A", "B", "term1", "term2", "C", 30],
    { resolveConflictTarget }
  );
  ok(
    twoMatches.params.p0 === "A" &&
      twoMatches.params.p1 === "B" &&
      twoMatches.params.p2 === "term1" &&
      twoMatches.params.p3 === "term2" &&
      twoMatches.params.p4 === "C" &&
      twoMatches.params.p5 === "30",
    "every parameter around two MATCHes keeps its place",
    JSON.stringify(twoMatches.params)
  );

  // And alongside the IN (?) array expansion, which also grows the list.
  const withArray = translator.translate(
    "SELECT a FROM t WHERE g IN (?) AND MATCH (c.stateId, c.firstName) AGAINST (? IN BOOLEAN MODE)",
    [["police", "ems"], "jo"],
    { resolveConflictTarget }
  );
  ok(
    withArray.params.p0_0 === "police" &&
      withArray.params.p0_1 === "ems" &&
      withArray.params.p1 === "jo" &&
      withArray.params.p2 === "jo",
    "an array expansion and a MATCH expansion compose without colliding",
    JSON.stringify(withArray.params)
  );

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => {
      console.log(`  - ${f}`);
    });
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
