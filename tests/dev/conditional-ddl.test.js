/**
 * MySQL's conditional-DDL dance, checked against real SQLite.
 *
 * The module's whole claim is that it EVALUATES each condition instead of
 * guessing what it means, so asserting on returned SQL text would prove nothing
 * about the only thing that matters. Every case below therefore builds a real
 * schema in node:sqlite, feeds the verbatim statements from the shipped
 * resources they came from, and then asks the database what happened: does the
 * index exist, does the column exist, did the second run do nothing.
 *
 * The conditions reach SQLite through sql-translator, which is what makes
 * information_schema.COLUMNS and .STATISTICS resolve at all.
 *
 * Run from the resource root: node tests/dev/conditional-ddl.test.js
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = require("./fivem-require.js");

const translator = require(path.join(ROOT, "server/utils/sql-translator.js"));
const tableRebuild = require(path.join(ROOT, "server/utils/table-rebuild.js"));
const conditionalDdl = require(path.join(ROOT, "server/utils/conditional-ddl.js"));

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

// ---------------------------------------------------------------------------
// The database the migrations run against
// ---------------------------------------------------------------------------

// Column types are declared with widths on purpose: CHARACTER_MAXIMUM_LENGTH is
// read back out of the declared type by rewriteInformationSchema, so a bare
// TEXT would make the ESX banking condition unanswerable.
function freshDb(identifierWidth) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE banking (
      id INTEGER PRIMARY KEY,
      identifier varchar(${identifierWidth === undefined ? 46 : identifierWidth}) COLLATE NOCASE,
      time INTEGER
    );
    CREATE TABLE users (identifier varchar(60) PRIMARY KEY, name TEXT);
    CREATE TABLE k9_certifications (
      id INTEGER PRIMARY KEY,
      citizenid varchar(50),
      job varchar(50),
      active INTEGER DEFAULT 1
    );
    CREATE TABLE user_licenses (id INTEGER PRIMARY KEY, type varchar(60), owner varchar(60));
    CREATE TABLE addon_account_data (
      id INTEGER PRIMARY KEY,
      account_name varchar(60),
      money INTEGER,
      owner varchar(60)
    );
  `);
  return db;
}

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

const translate = (sql) => translator.translate(sql, [], { resolveConflictTarget: () => ["id"] });

/**
 * The injected I/O, wired to a live database.
 *
 * `exec` has to understand a rebuild descriptor as well as plain SQL, because
 * `ALTER TABLE ... MODIFY COLUMN` - one of the four ESX statements below - comes
 * back from the translator as a plan to execute rather than a statement, with
 * `sql` still holding the untranslated MySQL. This is the same handover
 * sql-import.js does; without it the MODIFY case would run MySQL text.
 */
function depsFor(db) {
  const executed = [];

  return {
    executed,
    scalar: async (sql) => {
      const row = db.prepare(translate(sql).sql).get();
      return row === undefined ? null : Object.values(row)[0];
    },
    exec: async (sql) => {
      const result = translate(sql);

      if (result.rebuild) {
        const plan = tableRebuild.planRebuild({
          ...introspect(db, result.rebuild.table),
          actions: result.rebuild.actions,
        });
        executed.push({ sql, plan });
        for (const statement of plan) db.exec(statement);
        return;
      }

      executed.push({ sql, plan: [result.sql] });
      db.exec(result.sql);
      for (const extra of result.extraStatements || []) db.exec(translate(extra).sql);
    },
  };
}

async function feedAll(db, statements) {
  const session = conditionalDdl.createSession();
  const deps = depsFor(db);
  const ran = [];
  const notes = [];

  for (const sql of statements) {
    const result = await session.feed(sql, deps);
    ran.push(...result.ran);
    if (result.note) notes.push(result.note);
  }

  return { ran, notes, executed: deps.executed };
}

async function refuses(label, statements, construct, db) {
  const session = conditionalDdl.createSession();
  const deps = depsFor(db || freshDb());

  try {
    for (const sql of statements) await session.feed(sql, deps);
  } catch (error) {
    ok(
      error.construct === construct,
      label,
      `expected construct ${JSON.stringify(construct)}, got ${JSON.stringify(error.construct)} (${error.message})`
    );
    return error;
  }

  ok(false, label, "it did not refuse at all");
  return null;
}

const indexExists = (db, name) =>
  scalar(db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='${name}'`) === 1;

const columnExists = (db, table, name) =>
  scalar(db, `SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name='${name}'`) === 1;

// ---------------------------------------------------------------------------
// Spelling A, verbatim from esx-framework/ESX-Legacy-Addons
// ---------------------------------------------------------------------------

const PREPARE_SEQUENCE = ["PREPARE s FROM @banking_migration", "EXECUTE s", "DEALLOCATE PREPARE s"];

const MODIFY_IDENTIFIER = `SET @banking_migration := (SELECT IF(
  (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'banking' AND COLUMN_NAME = 'identifier') < 60,
  'ALTER TABLE \`banking\` MODIFY COLUMN \`identifier\` VARCHAR(60) NULL',
  'SELECT 1'))`;

const ADD_BANKING_INDEX = `SET @banking_migration := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'banking' AND INDEX_NAME = 'idx_banking_time'),
  'SELECT 1',
  'ALTER TABLE \`banking\` ADD INDEX \`idx_banking_time\` (\`time\`)'))`;

const ADD_USERS_PINCODE = `SET @banking_migration := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pincode'),
  'SELECT 1',
  'ALTER TABLE \`users\` ADD COLUMN \`pincode\` INT NULL'))`;

// ---------------------------------------------------------------------------
// Spelling B, verbatim from XxNightLordxX/K9Script
// ---------------------------------------------------------------------------

const K9_NAME = "john_k9_migration_0004_add_idx_citizen_job_active";

const K9_SEQUENCE = [
  `DROP PROCEDURE IF EXISTS \`${K9_NAME}\``,
  `CREATE PROCEDURE \`${K9_NAME}\`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'k9_certifications' AND INDEX_NAME = 'idx_citizen_job_active'
  ) THEN
    ALTER TABLE \`k9_certifications\` ADD KEY \`idx_citizen_job_active\` (\`citizenid\`, \`job\`, \`active\`);
  END IF;
END`,
  `CALL \`${K9_NAME}\`()`,
  `DROP PROCEDURE \`${K9_NAME}\``,
];

const HARDENING = `CREATE PROCEDURE esx_hardening_20261002()
BEGIN
  IF EXISTS (SELECT 1 FROM user_licenses GROUP BY owner, type HAVING COUNT(*) > 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Duplicate user_licenses: reconcile before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM addon_account_data GROUP BY account_name, COALESCE(owner, '') HAVING COUNT(*) > 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Duplicate addon account data';
  END IF;
END`;

async function main() {
  await translator.init();

  section("claims() tags every statement in both spellings, and nothing else");

  const tagged = [
    ["SET @banking_migration := (SELECT 1)", "setVariable"],
    ["PREPARE s FROM @banking_migration", "prepare"],
    ["EXECUTE s", "execute"],
    ["DEALLOCATE PREPARE s", "deallocate"],
    ["CREATE PROCEDURE `p`() BEGIN SELECT 1; END", "createProcedure"],
    ["CALL `p`()", "call"],
    ["DROP PROCEDURE IF EXISTS `p`", "dropProcedure"],
  ];
  for (const [sql, tag] of tagged) {
    ok(conditionalDdl.claims(sql) === tag, `claims ${tag}`, conditionalDdl.claims(sql));
  }

  // SET NAMES / SET FOREIGN_KEY_CHECKS are mysqldump noise the importer already
  // drops; claiming them would hand this module statements it has no business
  // interpreting.
  for (const sql of [
    "SET NAMES utf8mb4",
    "SET FOREIGN_KEY_CHECKS = 0",
    "CREATE TABLE t (id INT)",
    "INSERT INTO t VALUES (1)",
    "ALTER TABLE t ADD COLUMN x INT",
  ]) {
    ok(conditionalDdl.claims(sql) === false, `does not claim: ${sql.slice(0, 32)}`);
  }

  section("Spelling A: MODIFY COLUMN identifier, condition TRUE (varchar(46) < 60)");

  {
    const db = freshDb(46);
    const { ran, executed } = await feedAll(db, [MODIFY_IDENTIFIER, ...PREPARE_SEQUENCE]);

    ok(
      ran.length === 1 && /MODIFY COLUMN `identifier`/.test(ran[0]),
      "the live column width answered the condition and the MODIFY branch ran",
      JSON.stringify(ran)
    );
    // Measured, and the honest outcome rather than a failure: SQLite has no
    // column widths, so varchar(46) and varchar(60) are the same TEXT-affinity
    // column and table-rebuild plans nothing at all. The branch was still
    // chosen from the real schema, which is what this module promises.
    ok(
      executed.length === 1 && executed[0].plan.length === 0,
      "its rebuild plan is empty, because a width change is a no-op in SQLite",
      JSON.stringify(executed[0]?.plan)
    );
  }

  section("Spelling A: MODIFY COLUMN identifier, condition FALSE (varchar(60) is not < 60)");

  {
    const db = freshDb(60);
    const { ran, notes } = await feedAll(db, [MODIFY_IDENTIFIER, ...PREPARE_SEQUENCE]);

    ok(
      ran.length === 1 && /^SELECT 1$/i.test(ran[0]),
      "the no-op branch ran, so nothing was altered",
      JSON.stringify(ran)
    );
    ok(
      notes.length === 1 && /no-op branch/.test(notes[0]),
      "and it says so",
      JSON.stringify(notes)
    );
  }

  section("Spelling A: ADD INDEX idx_banking_time");

  {
    const db = freshDb();
    ok(!indexExists(db, "idx_banking_time"), "the index is absent to begin with");

    const first = await feedAll(db, [ADD_BANKING_INDEX, ...PREPARE_SEQUENCE]);
    ok(
      first.ran.length === 1 && /ADD INDEX `idx_banking_time`/.test(first.ran[0]),
      "the index was missing, so the ADD INDEX branch ran",
      JSON.stringify(first.ran)
    );
    ok(indexExists(db, "idx_banking_time"), "and the index really exists now");

    const second = await feedAll(db, [ADD_BANKING_INDEX, ...PREPARE_SEQUENCE]);
    ok(
      second.ran.length === 1 && /^SELECT 1$/i.test(second.ran[0]),
      "re-run: information_schema.STATISTICS now reports it, so the no-op branch ran",
      JSON.stringify(second.ran)
    );
  }

  section("Spelling A: ADD COLUMN users.pincode");

  {
    const db = freshDb();
    ok(!columnExists(db, "users", "pincode"), "the column is absent to begin with");

    const first = await feedAll(db, [ADD_USERS_PINCODE, ...PREPARE_SEQUENCE]);
    ok(
      first.ran.length === 1 && /ADD COLUMN `pincode`/.test(first.ran[0]),
      "the column was missing, so the ADD COLUMN branch ran",
      JSON.stringify(first.ran)
    );
    ok(columnExists(db, "users", "pincode"), "and the column really exists now");

    const second = await feedAll(db, [ADD_USERS_PINCODE, ...PREPARE_SEQUENCE]);
    ok(
      second.ran.length === 1 && /^SELECT 1$/i.test(second.ran[0]),
      "re-run: the column is now in information_schema.COLUMNS, so nothing ran",
      JSON.stringify(second.ran)
    );
    // A second ADD COLUMN would be the failure this whole module exists to
    // prevent: SQLite rejects it outright and the import dies with the file
    // half applied.
    ok(
      scalar(db, "SELECT COUNT(*) FROM pragma_table_info('users')") === 3,
      "and there is exactly one pincode column",
      String(scalar(db, "SELECT COUNT(*) FROM pragma_table_info('users')"))
    );
  }

  section("Spelling B: the K9Script procedure, run twice");

  {
    const db = freshDb();
    const first = await feedAll(db, K9_SEQUENCE);

    ok(
      first.ran.length === 1 && /ADD KEY `idx_citizen_job_active`/.test(first.ran[0]),
      "first run: the index was missing, so the ALTER inside the THEN ran",
      JSON.stringify(first.ran)
    );
    ok(indexExists(db, "idx_citizen_job_active"), "and the index really exists");
    ok(
      rows(db, "SELECT name FROM pragma_index_info('idx_citizen_job_active')")
        .map((r) => r.name)
        .join(",") === "citizenid,job,active",
      "over the three columns, in order",
      JSON.stringify(rows(db, "SELECT name FROM pragma_index_info('idx_citizen_job_active')"))
    );

    // Idempotency is the entire reason the resource ships the procedure.
    const second = await feedAll(db, K9_SEQUENCE);
    ok(second.ran.length === 0, "second run: nothing executed at all", JSON.stringify(second.ran));
    ok(
      second.notes.length === 1 && /condition false/.test(second.notes[0]),
      "and it reports which condition came back false",
      JSON.stringify(second.notes)
    );
    ok(
      scalar(
        db,
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_citizen_job_active'"
      ) === 1,
      "with still exactly one index of that name"
    );
  }

  section("Spelling B: SIGNAL SQLSTATE is a data precondition and must abort");

  {
    const db = freshDb();
    db.exec("INSERT INTO user_licenses (type, owner) VALUES ('dmv','ada'), ('dmv','ada')");

    const error = await refuses(
      "duplicate user_licenses rows abort the migration",
      [HARDENING, "CALL esx_hardening_20261002()"],
      "SIGNAL SQLSTATE",
      db
    );
    ok(
      !!error?.message.includes("Duplicate user_licenses: reconcile before migration"),
      "with the MESSAGE_TEXT verbatim, because that is the instruction to the operator",
      error?.message
    );
    ok(!!error?.message.includes("45000"), "and the SQLSTATE it signalled");
  }

  {
    const db = freshDb();
    db.exec("INSERT INTO user_licenses (type, owner) VALUES ('dmv','ada'), ('weapon','bob')");
    db.exec(
      "INSERT INTO addon_account_data (account_name, money, owner) VALUES ('bank', 1, 'ada')"
    );

    const clean = await feedAll(db, [HARDENING, "CALL esx_hardening_20261002()"]);
    ok(clean.ran.length === 0, "with no duplicates it does nothing", JSON.stringify(clean.ran));
    ok(
      clean.notes.length === 1 && (clean.notes[0].match(/condition false/g) || []).length === 2,
      "having evaluated both IF blocks, not just the first",
      JSON.stringify(clean.notes)
    );
  }

  section("Spelling B: a two-IF body whose first block passes and second aborts");

  {
    const db = freshDb();
    db.exec(
      "INSERT INTO addon_account_data (account_name, money, owner) VALUES ('bank',1,'ada'), ('bank',2,'ada')"
    );

    const error = await refuses(
      "the first IF's DDL runs, then the second IF aborts",
      [
        `CREATE PROCEDURE mixed_20261014()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'banking' AND INDEX_NAME = 'idx_banking_time') THEN
    ALTER TABLE \`banking\` ADD INDEX \`idx_banking_time\` (\`time\`);
  END IF;
  IF EXISTS (SELECT 1 FROM addon_account_data GROUP BY account_name, COALESCE(owner, '') HAVING COUNT(*) > 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Duplicate addon account data';
  END IF;
END`,
        "CALL mixed_20261014()",
      ],
      "SIGNAL SQLSTATE",
      db
    );
    ok(
      !!error?.message.includes("Duplicate addon account data"),
      "naming the second block's message",
      error?.message
    );
    // Blocks run in order, so the first block's index is already there when the
    // second aborts. Rolling it back is the importer's transaction, not this
    // module's job - and it has to be visible here or the ordering claim is
    // untested.
    ok(indexExists(db, "idx_banking_time"), "and the first block's index did get created");
  }

  section("Everything else is refused by name");

  const BODY = (statements) => [
    `CREATE PROCEDURE refuse_me()
BEGIN
${statements}
END`,
    "CALL refuse_me()",
  ];

  await refuses(
    "DECLARE",
    BODY("  DECLARE n INT;\n  SELECT COUNT(*) INTO n FROM banking;"),
    "DECLARE"
  );

  await refuses(
    "ELSE",
    BODY(
      "  IF EXISTS (SELECT 1 FROM banking) THEN\n" +
        "    ALTER TABLE `banking` ADD INDEX `a` (`time`);\n" +
        "  ELSE\n" +
        "    ALTER TABLE `banking` ADD INDEX `b` (`id`);\n" +
        "  END IF;"
    ),
    "ELSE"
  );

  await refuses(
    "ELSEIF",
    BODY(
      "  IF EXISTS (SELECT 1 FROM banking) THEN\n" +
        "    ALTER TABLE `banking` ADD INDEX `a` (`time`);\n" +
        "  ELSEIF EXISTS (SELECT 1 FROM users) THEN\n" +
        "    ALTER TABLE `banking` ADD INDEX `b` (`id`);\n" +
        "  END IF;"
    ),
    "ELSEIF"
  );

  await refuses(
    "WHILE",
    BODY("  WHILE 1 = 1 DO\n    ALTER TABLE `banking` ADD INDEX `a` (`time`);\n  END WHILE;"),
    "WHILE"
  );

  await refuses(
    "LOOP",
    BODY("  LOOP\n    ALTER TABLE `banking` ADD INDEX `a` (`time`);\n  END LOOP;"),
    "LOOP"
  );

  await refuses("REPEAT", BODY("  REPEAT\n    SELECT 1;\n  UNTIL 1 = 1 END REPEAT;"), "REPEAT");

  await refuses("a cursor", BODY("  OPEN cur;\n  FETCH cur INTO x;\n  CLOSE cur;"), "cursor");

  await refuses(
    "a nested IF inside a THEN",
    BODY(
      "  IF EXISTS (SELECT 1 FROM banking) THEN\n" +
        "    IF EXISTS (SELECT 1 FROM users) THEN\n" +
        "      ALTER TABLE `banking` ADD INDEX `a` (`time`);\n" +
        "    END IF;\n" +
        "  END IF;"
    ),
    "nested IF"
  );

  await refuses(
    "SET of a local variable",
    BODY("  SET n = 1;\n  SELECT n;"),
    "SET of a local variable"
  );

  await refuses(
    "a CALL of a procedure never defined in this file",
    ["CALL some_procedure_the_dba_made()"],
    "CALL of a procedure not defined in this file"
  );

  await refuses(
    "a CALL from inside a body, of a procedure defined in this file",
    [
      "CREATE PROCEDURE inner_p() BEGIN SELECT 1; END",
      "CREATE PROCEDURE outer_p() BEGIN CALL inner_p(); END",
      "CALL outer_p()",
    ],
    "CALL inside a procedure body"
  );

  await refuses(
    "PREPARE from a variable nothing SET",
    ["PREPARE s FROM @never_set"],
    "PREPARE FROM an unset session variable"
  );

  await refuses(
    "EXECUTE of a handle nothing PREPAREd",
    ["EXECUTE s"],
    "EXECUTE of a statement that was never PREPAREd"
  );

  await refuses(
    "EXECUTE ... USING, whose parameters are not bound",
    ["SET @v := (SELECT 'SELECT 1')", "PREPARE s FROM @v", "EXECUTE s USING @v"],
    "EXECUTE ... USING"
  );

  await refuses(
    "a procedure that takes parameters",
    ["CREATE PROCEDURE p(IN n INT) BEGIN SELECT n; END"],
    "CREATE PROCEDURE with parameters"
  );

  await refuses(
    "CALL with arguments",
    ["CREATE PROCEDURE p() BEGIN SELECT 1; END", "CALL p(1)"],
    "CALL with arguments"
  );

  await refuses(
    "an IF with no END IF",
    BODY("  IF EXISTS (SELECT 1 FROM banking) THEN\n    SELECT 1;"),
    "IF without END IF"
  );

  await refuses(
    "a statement this module never claimed",
    ["INSERT INTO banking (identifier) VALUES ('x')"],
    "unclaimed statement"
  );

  section("A SET is evaluated when it is SET, not when it is EXECUTEd");

  {
    // MySQL freezes the branch at SET time. If this module deferred evaluation
    // to EXECUTE, the index created in between would flip the answer and the
    // second EXECUTE would run SELECT 1 instead of the ALTER it was handed.
    const db = freshDb();
    const session = conditionalDdl.createSession();
    const deps = depsFor(db);

    await session.feed(ADD_BANKING_INDEX, deps);
    db.exec('CREATE INDEX "idx_banking_time" ON "banking"("time")');
    await session.feed("PREPARE s FROM @banking_migration", deps);
    const result = await session.feed("EXECUTE s", deps);

    ok(
      result.ran.length === 1 && /ADD INDEX `idx_banking_time`/.test(result.ran[0]),
      "the branch chosen at SET time is the branch EXECUTE runs",
      JSON.stringify(result.ran)
    );
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
