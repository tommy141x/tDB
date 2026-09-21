/**
 * Importing .sql dumps: the splitter, the ledger, and the once-only guarantee.
 *
 * The splitter gets the most attention here because it is the part that
 * quietly destroys a database when done casually. `text.split(";")` looks
 * fine against a hand-written schema and then breaks apart the first INSERT
 * carrying a semicolon inside a string - which for a FiveM dump means the
 * first item description with a sentence in it. Several checks below are
 * exactly that shape.
 *
 * Dev harness. Run from the resource root: node .dev/sql-import.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));
const sqlImport = require(path.join(ROOT, "server/utils/sql-import.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux",
);
const PORT = 8184;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "sqlimport@example.com";
const PASSWORD = "sqlimport-password-123";

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
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function collectingLogger() {
  const lines = [];
  const push = (level) => (m) => lines.push(`${level}: ${m}`);
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    text: () => lines.join("\n"),
  };
}

async function main() {
  // ======================================================================
  console.log("\n=== Splitting a dump");

  const split = (text) => sqlImport.splitStatements(text).map((s) => s.sql);

  ok(
    split("SELECT 1; SELECT 2;").length === 2,
    "two statements split on the semicolon",
  );
  ok(
    split("SELECT 1").length === 1,
    "a trailing statement without a semicolon is not lost",
  );
  ok(split("   \n\n  ").length === 0, "whitespace alone yields nothing");
  ok(split("SELECT 1;;;\nSELECT 2;").length === 2, "empty statements are dropped");

  // The one that matters.
  const withSemicolon = split(
    `INSERT INTO items (name, description) VALUES ('bandage', 'Heals you; use it wisely');
     INSERT INTO items (name, description) VALUES ('radio', 'Talk to people');`,
  );
  ok(
    withSemicolon.length === 2,
    "a semicolon inside a string literal does not split the statement",
    show(withSemicolon.length),
  );
  ok(
    withSemicolon[0].includes("Heals you; use it wisely"),
    "and the string survives intact",
    show(withSemicolon[0]),
  );

  ok(
    split(`INSERT INTO t VALUES ('it\\'s fine; really');`).length === 1,
    "a backslash-escaped quote does not end the string",
  );
  ok(
    split(`INSERT INTO t VALUES ('it''s fine; really');`).length === 1,
    "a doubled quote does not end the string",
  );
  ok(
    split(`INSERT INTO t VALUES ("double; quoted");`).length === 1,
    "double-quoted strings are tracked too",
  );
  ok(
    split("SELECT `weird;column` FROM t;").length === 1,
    "a semicolon inside a backtick identifier does not split",
  );
  ok(
    split(`INSERT INTO t VALUES ('C:\\\\path\\\\');\nSELECT 2;`).length === 2,
    "a string ending in an escaped backslash still terminates",
  );

  // Comments.
  ok(
    split("-- a comment; with a semicolon\nSELECT 1;").length === 1,
    "a line comment is dropped, semicolon and all",
  );
  ok(
    split("# hash comment; here\nSELECT 1;").length === 1,
    "a # comment is dropped",
  );
  ok(
    split("/* block; comment */ SELECT 1;").length === 1,
    "a block comment is dropped",
  );
  ok(
    split("/*!40101 SET NAMES utf8 */;\nSELECT 1;").length === 1,
    "a MySQL version-conditional comment is dropped",
  );
  ok(
    split("SELECT 1 -- trailing\n, 2;").length === 1,
    "a comment inside a statement does not end it",
  );
  ok(
    split("SELECT a--b FROM t;").length === 1 &&
      split("SELECT a--b FROM t;")[0].includes("--b"),
    "`--` without following whitespace is not a comment",
    show(split("SELECT a--b FROM t;")),
  );

  // DELIMITER.
  const withDelimiter = split(
    `DELIMITER $$
     CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET @a = 1; SET @b = 2; END$$
     DELIMITER ;
     SELECT 1;`,
  );
  ok(
    withDelimiter.length === 2,
    "a DELIMITER block is kept whole despite its inner semicolons",
    show(withDelimiter.length),
  );
  ok(
    withDelimiter[0].includes("SET @a = 1; SET @b = 2;"),
    "the trigger body is intact",
    show(withDelimiter[0]),
  );

  // Line numbers, which is what makes an error message useful.
  const located = sqlImport.splitStatements("SELECT 1;\n\n\nSELECT 2;\nSELECT 3;");
  ok(
    located[1].line === 4 && located[2].line === 5,
    "each statement carries the line it started on",
    show(located.map((s) => s.line)),
  );

  // ======================================================================
  console.log("\n=== Session noise");

  for (const noise of [
    "SET NAMES utf8mb4",
    "SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT",
    "SET FOREIGN_KEY_CHECKS = 0",
    "LOCK TABLES `players` WRITE",
    "UNLOCK TABLES",
    "START TRANSACTION",
    "COMMIT",
    "USE `fivem`",
    "CREATE DATABASE IF NOT EXISTS `fivem`",
    "ALTER TABLE `players` DISABLE KEYS",
    "FLUSH PRIVILEGES",
  ]) {
    ok(sqlImport.isSessionNoise(noise), `skipped as session noise: ${noise}`);
  }

  for (const real of [
    "CREATE TABLE players (id INT)",
    "INSERT INTO players (id) VALUES (1)",
    "UPDATE players SET id = 2",
    "ALTER TABLE players ADD COLUMN name VARCHAR(50)",
    "SELECT * FROM players",
  ]) {
    ok(!sqlImport.isSessionNoise(real), `kept as a real statement: ${real.slice(0, 40)}`);
  }

  // ======================================================================
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-sqlimport-"));
  const hooksDir = `${dataDir}-hooks`;
  const sqlDir = `${dataDir}-sql`;
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(sqlDir, { recursive: true });
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
        if ((await fetch(`${URL_BASE}/api/health`)).ok) break;
      } catch (_) {}
      await sleep(200);
    }

    const pb = new PocketBase(URL_BASE);
    pb.autoCancellation(false);
    await pb
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { requestKey: null });
    const adapter = new OxMySQLAdapter(pb, (fn) => fn, quiet);
    const call = (name, ...args) => adapter.handle(name, args);

    const write = (name, body) => fs.writeFileSync(path.join(sqlDir, name), body);
    const wipe = () => {
      for (const f of fs.readdirSync(sqlDir)) fs.unlinkSync(path.join(sqlDir, f));
    };

    // --------------------------------------------------------------------
    console.log("\n=== Importing a realistic dump");

    // Deliberately shaped like a mysqldump: session preamble, backticks,
    // MySQL table options, an inline KEY, and data containing a semicolon.
    write(
      "01-players.sql",
      `-- MySQL dump 10.13  Distrib 8.0.35
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS \`players\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`citizenid\` varchar(50) NOT NULL,
  \`name\` varchar(255) DEFAULT NULL,
  \`money\` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`),
  KEY \`idx_citizenid\` (\`citizenid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

LOCK TABLES \`players\` WRITE;
INSERT INTO \`players\` (\`citizenid\`, \`name\`, \`money\`) VALUES
  ('ABC123', 'Alice', 500);
INSERT INTO \`players\` (\`citizenid\`, \`name\`, \`money\`) VALUES
  ('DEF456', 'Bob; the builder', 250);
UNLOCK TABLES;
`,
    );

    const log = collectingLogger();
    const first = await sqlImport.run(adapter, sqlDir, log, { onChanged: "warn" });

    ok(
      first.applied.length === 1 && first.applied[0] === "01-players.sql",
      "a mysqldump-shaped file imports",
      show(first),
    );
    ok(first.failed.length === 0, "with no failures", log.text());

    const rows = await call("query", "SELECT * FROM players ORDER BY citizenid");
    ok(rows.length === 2, "both rows landed", show(rows));
    ok(
      rows[1] && rows[1].name === "Bob; the builder",
      "the value containing a semicolon is intact",
      show(rows[1]),
    );
    ok(
      rows[0] && rows[0].money === 500,
      "column types survived the MySQL table options",
      show(rows[0]),
    );

    // The inline KEY had to become a separate CREATE INDEX.
    const indexes = await call(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'players'",
    );
    ok(
      indexes.some((r) => String(r.name).includes("idx_citizenid")),
      "the inline KEY became a real index",
      show(indexes),
    );

    // --------------------------------------------------------------------
    console.log("\n=== A file runs once, ever");

    const second = await sqlImport.run(adapter, sqlDir, quiet, { onChanged: "warn" });
    ok(
      second.skipped.includes("01-players.sql") && second.applied.length === 0,
      "a second pass skips it",
      show(second),
    );
    const afterRerun = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(afterRerun === 2, "no rows were duplicated", show(afterRerun));

    // --------------------------------------------------------------------
    console.log("\n=== A changed file is reported, not replayed");

    fs.appendFileSync(
      path.join(sqlDir, "01-players.sql"),
      "\nINSERT INTO `players` (`citizenid`, `name`) VALUES ('GHI789', 'Carol');\n",
    );

    const driftLog = collectingLogger();
    const drifted = await sqlImport.run(adapter, sqlDir, driftLog, { onChanged: "warn" });
    ok(
      drifted.changed.includes("01-players.sql") && drifted.applied.length === 0,
      "the change is detected and the file is not re-run",
      show(drifted),
    );
    ok(
      /changed since it was applied/i.test(driftLog.text()),
      "and it says so",
      driftLog.text(),
    );
    ok(
      (await call("scalar", "SELECT COUNT(*) FROM players")) === 2,
      "still two rows - nothing was replayed",
    );

    const forced = await sqlImport.run(adapter, sqlDir, quiet, {
      onChanged: "apply",
      force: true,
    });
    ok(forced.applied.includes("01-players.sql"), "--force re-applies it", show(forced));
    ok(
      (await call("scalar", "SELECT COUNT(*) FROM players")) === 5,
      "and replays every INSERT, as advertised",
      show(await call("scalar", "SELECT COUNT(*) FROM players")),
    );

    // --------------------------------------------------------------------
    console.log("\n=== A failing file lands nothing");

    wipe();
    await call("update", "DROP TABLE IF EXISTS staging");
    write(
      "02-broken.sql",
      `CREATE TABLE staging (id INT NOT NULL, PRIMARY KEY (id));
INSERT INTO staging (id) VALUES (1);
THIS IS NOT SQL AT ALL;
INSERT INTO staging (id) VALUES (2);
`,
    );

    const failLog = collectingLogger();
    const broken = await sqlImport.run(adapter, sqlDir, failLog, { onChanged: "warn" });
    ok(broken.failed.includes("02-broken.sql"), "the file is reported failed", show(broken));

    const tables = await call(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staging'",
    );
    ok(
      tables.length === 0,
      "the table created before the bad statement was rolled back",
      show(tables),
    );
    ok(
      /line \d+/.test(failLog.text()),
      "the error names the line it failed on",
      failLog.text(),
    );

    // A failure must not stop the files after it.
    write("03-later.sql", "CREATE TABLE later_one (id INT);");
    const mixed = await sqlImport.run(adapter, sqlDir, quiet, { onChanged: "warn" });
    ok(
      mixed.applied.includes("03-later.sql"),
      "a later file is still attempted after a failure",
      show(mixed),
    );
    ok(
      mixed.failed.includes("02-broken.sql"),
      "and the broken one is retried, still failing",
      show(mixed),
    );

    // --------------------------------------------------------------------
    console.log("\n=== The ledger");

    const ledger = await sqlImport.readLedger(adapter);
    const brokenRow = ledger.get("02-broken.sql");
    ok(brokenRow && brokenRow.status === "failed", "a failed file is recorded as failed");
    ok(brokenRow && brokenRow.error, "with its error kept for `tdb sql status`", show(brokenRow?.error));
    const laterRow = ledger.get("03-later.sql");
    ok(laterRow && laterRow.status === "applied", "an applied file is recorded as applied");
    ok(
      laterRow && laterRow.checksum === sqlImport.checksum(fs.readFileSync(path.join(sqlDir, "03-later.sql"), "utf8")),
      "with the checksum that drift detection reads",
    );

    // --------------------------------------------------------------------
    console.log("\n=== Ordering and empty cases");

    wipe();
    write("20-second.sql", "INSERT INTO order_probe (n) VALUES (2);");
    write("10-first.sql", "CREATE TABLE order_probe (n INT); INSERT INTO order_probe (n) VALUES (1);");
    const ordered = await sqlImport.run(adapter, sqlDir, quiet, { onChanged: "warn" });
    ok(
      ordered.applied.join(",") === "10-first.sql,20-second.sql",
      "files run in filename order",
      show(ordered.applied),
    );
    ok(
      (await call("scalar", "SELECT COUNT(*) FROM order_probe")) === 2,
      "which is what let the second one insert into the first one's table",
    );

    wipe();
    const nothing = await sqlImport.run(adapter, sqlDir, quiet, {});
    ok(
      nothing.applied.length === 0 && nothing.failed.length === 0,
      "an empty folder is a no-op",
      show(nothing),
    );
    const missing = await sqlImport.run(adapter, path.join(sqlDir, "nope"), quiet, {});
    ok(missing.applied.length === 0, "a missing folder is a no-op, not an error");

    fs.writeFileSync(path.join(sqlDir, "notes.txt"), "not sql");
    const ignored = await sqlImport.run(adapter, sqlDir, quiet, {});
    ok(ignored.applied.length === 0, "non-.sql files are ignored");

    // --------------------------------------------------------------------
    console.log("\n=== The resource wires it in");

    const clientSource = fs.readFileSync(path.join(ROOT, "server/utils/client.js"), "utf8");
    ok(
      /await runSqlImports\(\);[\s\S]{0,80}notifyReady\(\)/.test(clientSource),
      "imports run before readiness, so consumers cannot race the schema",
    );
    ok(
      /RegisterCommand\(\s*"tdb"/.test(clientSource),
      "the tdb console command is registered",
    );
  } finally {
    server.kill();
    await sleep(500);
    for (const d of [dataDir, hooksDir, sqlDir]) {
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
