/**
 * The 12-step table rebuild, checked against real SQLite with rows in the table.
 *
 * A plan that parses is not a plan that is correct: the whole point of a rebuild
 * is that it moves live data, so every case below builds a realistic source
 * table WITH ROWS - including a NULL where one matters - runs the planned
 * statements against node:sqlite, and then asserts the rows survived, the new
 * shape is what was asked for, and the indexes and triggers still exist AND
 * still fire. Asserting the statement text would prove nothing about any of
 * that.
 *
 * The twelve statements exercised are the ones harvested from shipped FiveM
 * resources and currently refused by the translator.
 *
 * Run from the resource root: node tests/dev/table-rebuild.test.js
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = require("./fivem-require.js");

const rebuild = require(path.join(ROOT, "server/utils/table-rebuild.js"));

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

const section = (n) => console.log(`\n=== ${n}`);

const rows = (db, sql) => db.prepare(sql).all();
const scalar = (db, sql) => Object.values(db.prepare(sql).get())[0];

// Live introspection, exactly the shape planRebuild documents.
function introspect(db, table) {
  return {
    table,
    tableSql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)
      .sql,
    columns: rows(
      db,
      `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`
    ),
    indexes: rows(
      db,
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND sql IS NOT NULL`
    ),
    triggers: rows(db, "SELECT name, sql FROM sqlite_master WHERE type='trigger'"),
  };
}

// The pragmas bracket the transaction rather than sitting inside it, because a
// PRAGMA foreign_keys issued inside one is silently ignored - measured, and the
// reason the module emits them first and last instead of leaving them out.
function run(db, statements) {
  const isPragma = (s) => /^PRAGMA /i.test(s);
  let first = 0;
  while (first < statements.length && isPragma(statements[first])) first++;
  let last = statements.length;
  while (last > first && isPragma(statements[last - 1])) last--;

  for (const statement of statements.slice(0, first)) db.exec(statement);
  db.exec("BEGIN");
  try {
    for (const statement of statements.slice(first, last)) db.exec(statement);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    for (const statement of statements.slice(last)) db.exec(statement);
  }
}

function plan(db, table, actions) {
  return rebuild.planRebuild({ ...introspect(db, table), actions });
}

function shapeOf(db, table) {
  return rows(db, `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`)
    .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)
    .join(" | ");
}

function fresh(ddl) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(ddl);
  return db;
}

function main() {
  section("parseColumnDef: the affinity each MySQL type really has");

  const affinities = [
    ["varchar(255) NOT NULL COLLATE utf8mb4_unicode_ci", "TEXT", true],
    ["VARCHAR(11) NOT NULL", "TEXT", true],
    ["MEDIUMTEXT NOT NULL", "TEXT", true],
    ["int(11) NOT NULL AUTO_INCREMENT", "INTEGER", true],
    ["tinyint NOT NULL DEFAULT 1", "INTEGER", true],
    ["varchar(30) NULL", "TEXT", false],
    ["timestamp NULL DEFAULT NULL", "NUMERIC", false],
    ["DOUBLE DEFAULT 0", "REAL", null],
    ["longblob", "BLOB", null],
    ["enum('a','b') NOT NULL", "TEXT", true],
  ];
  for (const [text, affinity, notNull] of affinities) {
    const def = rebuild.parseColumnDef(text);
    ok(
      def.affinity === affinity && def.notNull === notNull,
      `"${text}" -> ${affinity}, notNull ${notNull}`,
      `got ${def.affinity}, notNull ${def.notNull}`
    );
  }

  // SQLite's affinity rules decided, not recalled. typeof() on a stored '123'
  // separates the five classes: TEXT keeps it text, INTEGER/NUMERIC coerce it,
  // REAL makes it a float, BLOB leaves it alone.
  const probe = new DatabaseSync(":memory:");
  const expectedTypeof = {
    TEXT: "text",
    INTEGER: "integer",
    NUMERIC: "integer",
    REAL: "real",
    BLOB: "text",
  };
  const declarable = affinities.filter(([text]) => !/^enum/i.test(text));
  let affinityAgrees = 0;
  for (const [i, [text, affinity]] of declarable.entries()) {
    const declared = rebuild.parseColumnDef(text).type;
    probe.exec(`CREATE TABLE p${i} (x ${declared})`);
    probe.exec(`INSERT INTO p${i} VALUES ('123')`);
    const got = probe.prepare(`SELECT typeof(x) t FROM p${i}`).get().t;
    if (got === expectedTypeof[affinity]) affinityAgrees++;
    else ok(false, `SQLite agrees ${declared} has ${affinity} affinity`, `typeof was ${got}`);
  }
  ok(
    affinityAgrees === declarable.length,
    `real SQLite agrees with every affinity verdict (${affinityAgrees}/${declarable.length})`
  );

  ok(
    rebuild.parseColumnDef("int(11) NOT NULL").notNull === true &&
      rebuild.parseColumnDef("int(11)").notNull === null,
    "an unstated NOT NULL is null, not false"
  );

  for (const [text, construct] of [
    ["datetime ON UPDATE CURRENT_TIMESTAMP", "ON UPDATE CURRENT_TIMESTAMP"],
    ["int GENERATED ALWAYS AS (1) STORED", "generated column"],
    ["varchar(10) DEFAULT (CONCAT('a','b'))", "DEFAULT (expression)"],
    ["varchar(10) DEFAULT 'a\\'b'", "DEFAULT with a backslash escape"],
    ["int SRID 4326", "column definition keyword SRID"],
  ]) {
    let thrown = null;
    try {
      rebuild.parseColumnDef(text);
    } catch (error) {
      thrown = error;
    }
    ok(
      thrown && thrown.construct === construct,
      `"${text}" is refused as ${construct}`,
      thrown ? `construct was ${thrown.construct}` : "it did not throw"
    );
  }

  section("Width, CHARACTER SET and COLLATE need no rebuild at all");

  {
    const db = fresh(`
      CREATE TABLE users (id INTEGER, ssn TEXT COLLATE NOCASE NOT NULL, PRIMARY KEY (id));
      INSERT INTO users VALUES (1, '123-45-6789'), (2, '987-65-4321');
    `);

    // ALTER TABLE `users` MODIFY COLUMN `ssn` VARCHAR(11) NOT NULL;
    const widen = [{ kind: "modify", column: "ssn", definition: "VARCHAR(11) NOT NULL" }];
    const schema = introspect(db, "users");
    ok(
      rebuild.needsRebuild({ actions: widen, columns: schema.columns }) === false,
      "VARCHAR(11) over a TEXT NOT NULL column needs no rebuild"
    );
    ok(plan(db, "users", widen).length === 0, "and plans no statements at all");

    // ALTER TABLE `src_phone_data` MODIFY COLUMN `citizenid` VARCHAR(50)
    //   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
    const charset = [
      {
        kind: "modify",
        column: "ssn",
        definition: "VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
      },
    ];
    ok(
      plan(db, "users", charset).length === 0,
      "a CHARACTER SET plus a case-insensitive COLLATE is a no-op too"
    );

    // ALTER TABLE `src_phone_messages` MODIFY COLUMN `text` MEDIUMTEXT NOT NULL;
    ok(
      plan(db, "users", [{ kind: "modify", column: "ssn", definition: "MEDIUMTEXT NOT NULL" }])
        .length === 0,
      "MEDIUMTEXT is TEXT, so retyping to it is a no-op"
    );

    // A _bin collation is the one COLLATE change SQLite can express.
    ok(
      rebuild.needsRebuild({
        actions: [
          { kind: "modify", column: "ssn", definition: "VARCHAR(11) COLLATE utf8mb4_bin NOT NULL" },
        ],
        columns: schema.columns,
      }) === true,
      "a _bin collation does need a rebuild, because it is not a no-op"
    );

    ok(
      rows(db, "SELECT * FROM users").length === 2,
      "nothing was run, so nothing moved",
      shapeOf(db, "users")
    );
  }

  section("AUTO_INCREMENT on a column that already is the INTEGER primary key");

  {
    const db = fresh(`
      CREATE TABLE addon_account_data (id INTEGER, account_name TEXT, money NUMERIC, PRIMARY KEY (id));
      INSERT INTO addon_account_data VALUES (1,'bank',100),(8,'black_money',5);
    `);

    // ALTER TABLE `addon_account_data` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;
    const actions = [
      { kind: "modify", column: "id", definition: "int(11) NOT NULL AUTO_INCREMENT" },
      { kind: "autoIncrementStart", value: 9 },
    ];
    ok(
      rebuild.needsRebuild({ actions, columns: introspect(db, "addon_account_data").columns }) ===
        false,
      "re-declaring the existing INTEGER primary key as AUTO_INCREMENT is a no-op"
    );

    const statements = plan(db, "addon_account_data", actions);
    run(db, statements);
    ok(
      rows(db, "SELECT * FROM addon_account_data").length === 2,
      "both rows survive",
      JSON.stringify(rows(db, "SELECT * FROM addon_account_data"))
    );
    db.exec("INSERT INTO addon_account_data (account_name, money) VALUES ('society',0)");
    ok(
      scalar(db, "SELECT id FROM addon_account_data WHERE account_name='society'") === 9,
      "and the next id is 9, because a plain INTEGER primary key already hands out max(id)+1",
      JSON.stringify(rows(db, "SELECT * FROM addon_account_data"))
    );

    // ALTER TABLE `addon_inventory_items` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
    const db2 = fresh(`
      CREATE TABLE addon_inventory_items (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO addon_inventory_items VALUES (1,'bread');
    `);
    ok(
      plan(db2, "addon_inventory_items", [
        { kind: "modify", column: "id", definition: "int(11) NOT NULL AUTO_INCREMENT" },
      ]).length === 0,
      "AUTO_INCREMENT with no start value plans nothing"
    );

    // ALTER TABLE `users` MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
    const db3 = fresh(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, identifier TEXT);
      INSERT INTO users VALUES (1,'char1:a'),(2,'char1:b');
    `);
    run(
      db3,
      plan(db3, "users", [
        { kind: "modify", column: "id", definition: "int(11) NOT NULL AUTO_INCREMENT" },
        { kind: "autoIncrementStart", value: 3 },
      ])
    );
    db3.exec("INSERT INTO users (identifier) VALUES ('char1:c')");
    ok(
      scalar(db3, "SELECT id FROM users WHERE identifier='char1:c'") === 3,
      "AUTO_INCREMENT=3 over two rows lands on 3",
      JSON.stringify(rows(db3, "SELECT * FROM users"))
    );
  }

  section("AUTO_INCREMENT on anything else is refused by name");

  {
    const db = fresh("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
    let thrown = null;
    try {
      plan(db, "t", [
        { kind: "modify", column: "n", definition: "int(11) NOT NULL AUTO_INCREMENT" },
      ]);
    } catch (error) {
      thrown = error;
    }
    ok(
      thrown &&
        thrown.construct === "AUTO_INCREMENT on a column that is not the INTEGER primary key",
      "AUTO_INCREMENT on a non-key column throws with a construct",
      thrown ? thrown.construct : "it did not throw"
    );

    thrown = null;
    try {
      plan(db, "t", [
        { kind: "modify", column: "id", definition: "varchar(64) NOT NULL AUTO_INCREMENT" },
      ]);
    } catch (error) {
      thrown = error;
    }
    ok(
      thrown &&
        thrown.construct === "AUTO_INCREMENT on a column that is not the INTEGER primary key",
      "a TEXT primary key is not an INTEGER one, and is refused"
    );
  }

  section("sqlite_sequence behaves the way the plan assumes");

  {
    // Asserted rather than taken on trust: the documented workaround is
    // INSERT OR REPLACE, and that does NOT work, because sqlite_sequence has
    // no index on `name` for the REPLACE to conflict with.
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
    db.exec("INSERT INTO a (v) VALUES ('x')");
    db.exec("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('a', 8)");
    ok(
      rows(db, "SELECT * FROM sqlite_sequence WHERE name='a'").length === 2,
      "INSERT OR REPLACE appends a duplicate sqlite_sequence row instead of replacing it"
    );
    db.exec("INSERT INTO a (v) VALUES ('y')");
    ok(
      scalar(db, "SELECT id FROM a WHERE v='y'") === 2,
      "so the sequence was NOT set, and the next id is 2",
      String(scalar(db, "SELECT id FROM a WHERE v='y'"))
    );

    db.exec("DELETE FROM sqlite_sequence WHERE name='a'");
    db.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('a', 8)");
    db.exec("INSERT INTO a (v) VALUES ('z')");
    ok(
      scalar(db, "SELECT id FROM a WHERE v='z'") === 9,
      "DELETE then INSERT does set it, and seq 8 means a next id of 9 - it stores the LAST used value",
      String(scalar(db, "SELECT id FROM a WHERE v='z'"))
    );

    // And why the module emits nothing for a table declared without the
    // keyword: in a database that has no AUTOINCREMENT table anywhere,
    // sqlite_sequence does not exist at all, so the write is not a no-op - it
    // is an error that would take the whole rebuild down with it.
    const plain = new DatabaseSync(":memory:");
    plain.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT)");
    let missing = null;
    try {
      plain.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('b', 8)");
    } catch (error) {
      missing = error;
    }
    ok(
      missing && /no such table: sqlite_sequence/.test(missing.message),
      "sqlite_sequence does not exist until some table is declared AUTOINCREMENT",
      missing ? missing.message : "the write succeeded"
    );

    // And where it does exist, a row for a non-AUTOINCREMENT table is ignored.
    const mixed = new DatabaseSync(":memory:");
    mixed.exec("CREATE TABLE seeded (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
    mixed.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT)");
    mixed.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('b', 8)");
    mixed.exec("INSERT INTO b (v) VALUES ('q')");
    ok(
      scalar(mixed, "SELECT id FROM b") === 1,
      "and a sequence row for a plain INTEGER primary key has no effect",
      String(scalar(mixed, "SELECT id FROM b"))
    );
  }

  section("A pure rename takes the cheap path");

  {
    const db = fresh(`
      CREATE TABLE weed_plants (id INTEGER PRIMARY KEY, building TEXT, stage INTEGER DEFAULT 1, progress INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX wp_building ON weed_plants (building);
      CREATE TABLE plant_log (what TEXT);
      CREATE TRIGGER wp_log AFTER INSERT ON weed_plants BEGIN INSERT INTO plant_log VALUES (NEW.building); END;
      INSERT INTO weed_plants VALUES (1,'motel',1,0),(2,NULL,2,10);
    `);

    // ALTER TABLE `weed_plants` CHANGE COLUMN `building` `property` varchar(30) NULL;
    const actions = [
      { kind: "change", from: "building", to: "property", definition: "varchar(30) NULL" },
    ];
    const schema = introspect(db, "weed_plants");
    ok(
      rebuild.needsRebuild({ actions, columns: schema.columns }) === false,
      "a rename of an already-TEXT, already-nullable column needs no rebuild"
    );

    const statements = plan(db, "weed_plants", actions);
    ok(
      statements.length === 1 && /RENAME COLUMN/.test(statements[0]),
      "and plans exactly one RENAME COLUMN",
      JSON.stringify(statements)
    );

    run(db, statements);
    ok(
      shapeOf(db, "weed_plants") ===
        "id:INTEGER:0:null:1 | property:TEXT:0:null:0 | stage:INTEGER:0:1:0 | progress:INTEGER:1:0:0",
      "the shape is the old one with one column renamed",
      shapeOf(db, "weed_plants")
    );
    ok(
      JSON.stringify(
        rows(db, "SELECT id, property, stage, progress FROM weed_plants ORDER BY id")
      ) ===
        '[{"id":1,"property":"motel","stage":1,"progress":0},{"id":2,"property":null,"stage":2,"progress":10}]',
      "both rows survive, NULL included",
      JSON.stringify(rows(db, "SELECT * FROM weed_plants"))
    );
    ok(
      scalar(db, "SELECT sql FROM sqlite_master WHERE name='wp_building'").includes("property"),
      "SQLite rewrote the index itself - which is the reason to look for this path",
      scalar(db, "SELECT sql FROM sqlite_master WHERE name='wp_building'")
    );
    db.exec("INSERT INTO weed_plants VALUES (3,'garage',1,0)");
    ok(
      scalar(db, "SELECT what FROM plant_log ORDER BY rowid DESC LIMIT 1") === "garage",
      "and the trigger still fires, reading the renamed column",
      JSON.stringify(rows(db, "SELECT * FROM plant_log"))
    );
  }

  section("A rename plus a NOT NULL and a DEFAULT: the full rebuild");

  {
    const db = fresh(`
      CREATE TABLE weed_plants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property TEXT COLLATE NOCASE,
        stage INTEGER DEFAULT 1,
        progress INTEGER,
        owner TEXT NOT NULL,
        UNIQUE (property, stage),
        CHECK (stage >= 0)
      );
      CREATE INDEX wp_owner ON weed_plants (owner, progress);
      CREATE TABLE plant_log (what TEXT);
      CREATE TRIGGER wp_log AFTER UPDATE ON weed_plants BEGIN INSERT INTO plant_log VALUES (NEW.owner); END;
      INSERT INTO weed_plants (property, stage, progress, owner) VALUES ('motel',1,0,'ada'),('garage',2,7,'bob');
    `);

    // ALTER TABLE `weed_plants` CHANGE COLUMN `stage` `stage` tinyint NOT NULL DEFAULT 1;
    // ALTER TABLE `weed_plants` CHANGE COLUMN `progress` `stageProgress` tinyint NOT NULL DEFAULT 0;
    const actions = [
      { kind: "change", from: "stage", to: "stage", definition: "tinyint NOT NULL DEFAULT 1" },
      {
        kind: "change",
        from: "progress",
        to: "stageProgress",
        definition: "tinyint NOT NULL DEFAULT 0",
      },
    ];
    ok(
      rebuild.needsRebuild({ actions, columns: introspect(db, "weed_plants").columns }) === true,
      "adding NOT NULL and a DEFAULT does need a rebuild"
    );

    run(db, plan(db, "weed_plants", actions));

    ok(
      shapeOf(db, "weed_plants") ===
        "id:INTEGER:0:null:1 | property:TEXT:0:null:0 | stage:INTEGER:1:1:0 | " +
          "stageProgress:INTEGER:1:0:0 | owner:TEXT:1:null:0",
      "the new shape has NOT NULL, the defaults and the rename, in the original column order",
      shapeOf(db, "weed_plants")
    );
    ok(
      JSON.stringify(
        rows(db, "SELECT id, property, stage, stageProgress, owner FROM weed_plants ORDER BY id")
      ) ===
        '[{"id":1,"property":"motel","stage":1,"stageProgress":0,"owner":"ada"},' +
          '{"id":2,"property":"garage","stage":2,"stageProgress":7,"owner":"bob"}]',
      "every value came across byte-identical",
      JSON.stringify(rows(db, "SELECT * FROM weed_plants"))
    );

    const ddl = scalar(db, "SELECT sql FROM sqlite_master WHERE name='weed_plants'");
    ok(
      /AUTOINCREMENT/.test(ddl) && /UNIQUE/.test(ddl) && /CHECK/.test(ddl) && /NOCASE/.test(ddl),
      "AUTOINCREMENT, UNIQUE, CHECK and COLLATE NOCASE all survived - none of which pragma_table_info reports",
      ddl
    );

    ok(
      scalar(db, "SELECT sql FROM sqlite_master WHERE name='wp_owner'") !== undefined,
      "the index is back after the drop that took it away"
    );
    ok(
      scalar(db, "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='wp_log'") === 1,
      "the trigger is back too"
    );
    db.exec("UPDATE weed_plants SET stage = 3 WHERE id = 1");
    ok(scalar(db, "SELECT what FROM plant_log") === "ada", "and it still fires");

    // The UNIQUE constraint really is enforced, not just present in the text.
    let violated = false;
    try {
      db.exec("INSERT INTO weed_plants (property, stage, owner) VALUES ('garage',2,'cal')");
    } catch (_) {
      violated = true;
    }
    ok(violated, "the carried UNIQUE constraint is enforced");

    db.exec("INSERT INTO weed_plants (property, owner) VALUES ('newplot','dee')");
    ok(
      scalar(db, "SELECT id FROM weed_plants WHERE owner='dee'") === 3 &&
        scalar(db, "SELECT stageProgress FROM weed_plants WHERE owner='dee'") === 0,
      "AUTOINCREMENT still allocates and the new DEFAULT applies",
      JSON.stringify(rows(db, "SELECT * FROM weed_plants"))
    );
  }

  section("An index on the renamed column is recreated against the new name");

  {
    const db = fresh(`
      CREATE TABLE weed_plants (id INTEGER PRIMARY KEY, building TEXT, stage INTEGER);
      CREATE INDEX wp_b ON weed_plants (building);
      INSERT INTO weed_plants VALUES (1,'motel',1);
    `);
    run(
      db,
      plan(db, "weed_plants", [
        { kind: "change", from: "building", to: "property", definition: "varchar(30) NOT NULL" },
      ])
    );
    ok(
      scalar(db, "SELECT sql FROM sqlite_master WHERE name='wp_b'").includes('"property"'),
      "the stored index SQL was rewritten before being replayed",
      scalar(db, "SELECT sql FROM sqlite_master WHERE name='wp_b'")
    );
    ok(scalar(db, "SELECT property FROM weed_plants") === "motel", "the row survived");
  }

  section("A trigger on ANOTHER table that names this one survives the rename");

  {
    // Measured: without dropping it first, `ALTER TABLE ... RENAME TO` fails
    // with "error in trigger <name>: no such table", because the rename
    // reparses the whole schema and the old table is already gone.
    const db = fresh(`
      CREATE TABLE house_plants (id INTEGER PRIMARY KEY, stage INTEGER NOT NULL);
      CREATE TABLE waterings (id INTEGER PRIMARY KEY, plant INTEGER);
      CREATE TRIGGER w_bump AFTER INSERT ON waterings
        BEGIN UPDATE house_plants SET stage = stage + 1 WHERE id = NEW.plant; END;
      INSERT INTO house_plants VALUES (1,2);
    `);

    // ALTER TABLE `house_plants` MODIFY COLUMN `stage` int(11) DEFAULT 1;
    run(
      db,
      plan(db, "house_plants", [
        { kind: "modify", column: "stage", definition: "int(11) DEFAULT 1" },
      ])
    );

    ok(
      shapeOf(db, "house_plants") === "id:INTEGER:0:null:1 | stage:INTEGER:0:1:0",
      "NOT NULL dropped and DEFAULT 1 added, which MySQL's MODIFY also does",
      shapeOf(db, "house_plants")
    );
    ok(scalar(db, "SELECT stage FROM house_plants") === 2, "the row survived");
    db.exec("INSERT INTO waterings VALUES (1,1)");
    ok(
      scalar(db, "SELECT stage FROM house_plants") === 3,
      "the trigger on the other table still fires against the rebuilt one"
    );
    db.exec("INSERT INTO house_plants (id) VALUES (2)");
    ok(
      scalar(db, "SELECT stage FROM house_plants WHERE id=2") === 1,
      "and the new DEFAULT applies"
    );
  }

  section("A bare column reference in a multi-table trigger is refused, not guessed");

  {
    const db = fresh(`
      CREATE TABLE weed_plants (id INTEGER PRIMARY KEY, building TEXT);
      CREATE TABLE plant_log (building TEXT);
      CREATE TRIGGER wp_log AFTER INSERT ON weed_plants
        BEGIN INSERT INTO plant_log (building) SELECT building FROM weed_plants WHERE id = NEW.id; END;
      INSERT INTO weed_plants VALUES (1,'motel');
    `);
    let thrown = null;
    try {
      plan(db, "weed_plants", [
        { kind: "change", from: "building", to: "property", definition: "varchar(30) NOT NULL" },
      ]);
    } catch (error) {
      thrown = error;
    }
    ok(
      thrown && thrown.construct === "CHANGE COLUMN with an ambiguous trigger reference",
      "renaming a column a two-table trigger names unqualified is refused by name",
      thrown ? thrown.construct : "it did not throw"
    );
  }

  section("ADD COLUMN IF NOT EXISTS plus a MODIFY, in one statement");

  {
    const db = fresh(`
      CREATE TABLE players (
        citizenid TEXT PRIMARY KEY,
        name TEXT COLLATE NOCASE,
        last_updated NUMERIC,
        money NUMERIC
      );
      INSERT INTO players VALUES ('ABC1','Ada','2026-10-01',500),('ABC2',NULL,'2026-10-02',10);
    `);

    // ALTER TABLE `players` ADD COLUMN IF NOT EXISTS `last_logged_out` timestamp NULL DEFAULT NULL
    //   AFTER `last_updated`, MODIFY COLUMN `name` varchar(255) NOT NULL COLLATE utf8mb4_unicode_ci;
    const actions = [
      {
        kind: "addColumn",
        column: "last_logged_out",
        definition: "timestamp NULL DEFAULT NULL",
        after: "last_updated",
        ifNotExists: true,
      },
      {
        kind: "modify",
        column: "name",
        definition: "varchar(255) NOT NULL COLLATE utf8mb4_unicode_ci",
      },
    ];

    let thrown = null;
    try {
      run(db, plan(db, "players", actions));
    } catch (error) {
      thrown = error;
    }
    ok(
      thrown && /players\.name/.test(thrown.message),
      "adding NOT NULL over an existing NULL fails, and the message names the column",
      thrown ? thrown.message : "it did not throw"
    );
    ok(
      thrown && /still holds NULL/.test(thrown.message),
      "and says why, instead of SQLite's bare constraint complaint",
      thrown ? thrown.message : ""
    );
    ok(
      rows(db, "SELECT * FROM players").length === 2 &&
        shapeOf(db, "players").split(" | ").length === 4,
      "and the table is exactly as it was: no half-built rebuild left behind",
      shapeOf(db, "players")
    );

    db.exec("UPDATE players SET name = 'Bob' WHERE citizenid = 'ABC2'");
    run(db, plan(db, "players", actions));

    ok(
      shapeOf(db, "players") ===
        "citizenid:TEXT:0:null:1 | name:TEXT:1:null:0 | last_updated:NUMERIC:0:null:0 | " +
          "last_logged_out:NUMERIC:0:NULL:0 | money:NUMERIC:0:null:0",
      "the new column landed AFTER last_updated, as MySQL asked, and name is NOT NULL",
      shapeOf(db, "players")
    );
    ok(
      JSON.stringify(rows(db, "SELECT * FROM players ORDER BY citizenid")) ===
        '[{"citizenid":"ABC1","name":"Ada","last_updated":"2026-10-01","last_logged_out":null,"money":500},' +
          '{"citizenid":"ABC2","name":"Bob","last_updated":"2026-10-02","last_logged_out":null,"money":10}]',
      "both rows survive with the new column NULL",
      JSON.stringify(rows(db, "SELECT * FROM players"))
    );
    ok(
      scalar(db, "SELECT count(*) FROM players WHERE name = 'ADA'") === 1,
      "COLLATE NOCASE was reapplied, so MySQL's case-insensitive match still works"
    );

    // Re-running must not try to add it twice.
    ok(
      plan(db, "players", actions).length === 0,
      "running the same ALTER again is a no-op, which is what IF NOT EXISTS means",
      JSON.stringify(plan(db, "players", actions))
    );
  }

  section("ADD COLUMN on its own takes the cheap path");

  {
    const db = fresh(`
      CREATE TABLE players (citizenid TEXT PRIMARY KEY, money NUMERIC);
      INSERT INTO players VALUES ('ABC1',500);
    `);
    const statements = plan(db, "players", [
      { kind: "addColumn", column: "last_logged_out", definition: "timestamp NULL DEFAULT NULL" },
    ]);
    ok(
      statements.length === 1 && /ADD COLUMN/.test(statements[0]),
      "one ALTER TABLE ADD COLUMN, no rebuild",
      JSON.stringify(statements)
    );
    run(db, statements);
    ok(
      scalar(db, "SELECT count(*) FROM pragma_table_info('players')") === 3,
      "the column is there"
    );

    // NOT NULL with no default is the case SQLite's own ADD COLUMN refuses.
    ok(
      rebuild.needsRebuild({
        actions: [{ kind: "addColumn", column: "flag", definition: "int NOT NULL" }],
        columns: introspect(db, "players").columns,
      }) === true,
      "NOT NULL with no DEFAULT does need the long way round, because ADD COLUMN cannot do it"
    );
  }

  section("A rebuild under foreign keys, with a child table pointing at it");

  {
    const db = fresh(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, ssn TEXT COLLATE NOCASE);
      CREATE TABLE user_cars (plate TEXT PRIMARY KEY, owner INTEGER REFERENCES users(id));
      INSERT INTO users VALUES (1,'123'),(2,'456');
      INSERT INTO user_cars VALUES ('AAA',1);
    `);
    // ALTER TABLE `users` MODIFY COLUMN `char` INT DEFAULT 5 - same shape, on a
    // column whose name needs quoting.
    db.exec('ALTER TABLE users ADD COLUMN "char" INTEGER DEFAULT 0');
    db.exec('UPDATE users SET "char" = 1 WHERE id = 1');

    run(db, plan(db, "users", [{ kind: "modify", column: "char", definition: "INT DEFAULT 5" }]));

    ok(
      JSON.stringify(rows(db, 'SELECT id, ssn, "char" FROM users ORDER BY id')) ===
        '[{"id":1,"ssn":"123","char":1},{"id":2,"ssn":"456","char":0}]',
      "rows survive a rebuild of a reserved-word column",
      JSON.stringify(rows(db, "SELECT * FROM users"))
    );
    ok(
      scalar(db, "SELECT count(*) FROM user_cars") === 1,
      "the child table kept its row through the DROP TABLE"
    );
    db.exec("INSERT INTO users (ssn) VALUES ('789')");
    ok(scalar(db, "SELECT \"char\" FROM users WHERE ssn='789'") === 5, "and the new DEFAULT is 5");
    ok(scalar(db, "PRAGMA foreign_keys") === 1, "foreign keys are back on afterwards");
  }

  section("Refusals");

  {
    const db = fresh("CREATE TABLE t (a TEXT, b INTEGER)");
    for (const [label, actions, construct] of [
      [
        "a MODIFY of a column that does not exist",
        [{ kind: "modify", column: "nope", definition: "int NOT NULL" }],
        "ALTER TABLE ... MODIFY of a missing column",
      ],
      [
        "two actions on one column",
        [
          { kind: "modify", column: "b", definition: "int NOT NULL DEFAULT 1" },
          { kind: "modify", column: "b", definition: "int NOT NULL DEFAULT 2" },
        ],
        "ALTER TABLE with two actions on one column",
      ],
      [
        "an AUTO_INCREMENT start of 0",
        [{ kind: "autoIncrementStart", value: 0 }],
        "AUTO_INCREMENT=",
      ],
      // Both paths, because needsRebuild answers false for a kind it does not
      // know: on the cheap path an unrecognised action would otherwise be
      // dropped and the ALTER would report success having done nothing.
      [
        "an action kind nobody implemented, on the cheap path",
        [{ kind: "dropColumn", column: "a" }],
        "ALTER TABLE action dropColumn",
      ],
      [
        "an action kind nobody implemented, alongside a real rebuild",
        [
          { kind: "modify", column: "b", definition: "int NOT NULL DEFAULT 1" },
          { kind: "dropColumn", column: "a" },
        ],
        "ALTER TABLE action dropColumn",
      ],
    ]) {
      let thrown = null;
      try {
        plan(db, "t", actions);
      } catch (error) {
        thrown = error;
      }
      ok(
        thrown && thrown.construct === construct,
        `${label} -> ${construct}`,
        thrown ? `construct was ${thrown.construct}` : "it did not throw"
      );
    }

    let thrown = null;
    try {
      rebuild.planRebuild({
        table: "t",
        actions: [{ kind: "modify", column: "b", definition: "int NOT NULL DEFAULT 1" }],
        columns: introspect(db, "t").columns,
        indexes: [],
        triggers: [],
      });
    } catch (error) {
      thrown = error;
    }
    ok(
      thrown && thrown.construct === "table rebuild without the original CREATE TABLE text",
      "a rebuild with no CREATE TABLE text is refused rather than attempted from the pragma",
      thrown ? thrown.construct : "it did not throw"
    );
  }

  section("The copy never uses SELECT *");

  {
    const db = fresh(`
      CREATE TABLE t (a TEXT, b INTEGER, c TEXT);
      INSERT INTO t VALUES ('x',1,'y');
    `);
    const statements = plan(db, "t", [
      { kind: "change", from: "b", to: "bb", definition: "int NOT NULL DEFAULT 0" },
    ]);
    const copy = statements.find((s) => /^INSERT INTO "t__tdb_rebuild"/.test(s));
    ok(
      copy && !/SELECT\s+\*/.test(copy) && /\("a", "bb", "c"\)/.test(copy),
      "columns are named in both lists, in the new table's order",
      copy
    );
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
