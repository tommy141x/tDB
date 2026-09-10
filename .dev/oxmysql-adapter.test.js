/**
 * End-to-end checks for the oxmysql compatibility adapter.
 *
 * Runs the adapter against a real PocketBase instance with the resource's own
 * pb_hooks, using SQL taken from the shape of what qb-core, ESX and lb-phone
 * actually issue. The assertions are about oxmysql's exact return values, since
 * a drop-in that returns the right data in the wrong shape still breaks every
 * caller.
 *
 * Dev harness. Run from the resource root: node .dev/oxmysql-adapter.test.js
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

const OxMySQLAdapter = require(path.join(ROOT, "adapters/oxmysql.js"));
const PocketBase = require(path.join(ROOT, "bin/pocketbase.cjs.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const PORT = 8161;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "adapter@example.com";
const PASSWORD = "adapter-password-123";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-adapter-"));
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

    const logged = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (m) => logged.push(m),
      error: (m) => logged.push(m),
    };

    // The real wrapAsync adds auth recovery; the adapter's contract is just
    // "returns a promise", so a pass-through isolates the adapter here.
    const adapter = new OxMySQLAdapter(pb, (fn) => fn, logger);
    const call = (name, ...args) => adapter.handle(name, args);

    // ----------------------------------------------------------------
    console.log("\n=== Export surface");

    for (const name of ["query", "execute", "fetch", "single", "scalar", "insert", "update", "prepare", "rawExecute", "transaction", "store"]) {
      const missing = [name, `${name}_async`, `${name}Sync`].filter(
        (n) => !adapter.supportedExports.includes(n),
      );
      ok(missing.length === 0, `${name} exported with _async and Sync variants`, show(missing));
    }

    for (const legacy of ["mysql_execute", "mysql_insert", "mysql_fetch_all", "mysql_fetch_scalar", "mysql_transaction", "mysql_store"]) {
      ok(
        adapter.supportedExports.includes(legacy),
        `${legacy} provided for mysql-async compatibility`,
      );
    }

    ok(
      adapter.canHandle("query", ["SELECT 1"]) === true,
      "canHandle accepts a SELECT",
    );
    ok(
      adapter.canHandle("query", [{ not: "sql" }]) === false,
      "canHandle rejects a non-string query",
    );
    ok(
      adapter.canHandle("query", ["WITH x AS (SELECT 1) SELECT * FROM x"]) === true,
      "canHandle accepts a CTE",
    );

    // ----------------------------------------------------------------
    console.log("\n=== Schema creation with MySQL DDL");

    await call(
      "update",
      `CREATE TABLE IF NOT EXISTS players (
         id INT NOT NULL AUTO_INCREMENT,
         citizenid VARCHAR(50) NOT NULL,
         license VARCHAR(255),
         name VARCHAR(255),
         money INT DEFAULT 0,
         metadata LONGTEXT,
         last_updated DATETIME ON UPDATE CURRENT_TIMESTAMP,
         PRIMARY KEY (id),
         UNIQUE KEY citizenid (citizenid),
         KEY license (license)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    ok(true, "qb-core style CREATE TABLE with inline keys executes");

    const indexes = await call(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'players'",
    );
    ok(
      indexes.some((i) => /citizenid/.test(i.name)) &&
        indexes.some((i) => /license/.test(i.name)),
      "inline UNIQUE KEY and KEY became real indexes",
      show(indexes.map((i) => i.name)),
    );

    const triggers = await call(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    );
    ok(triggers.length > 0, "ON UPDATE CURRENT_TIMESTAMP became a trigger", show(triggers));

    // ----------------------------------------------------------------
    console.log("\n=== Text compares case-insensitively, as it does in MySQL");

    await call(
      "insert",
      "INSERT INTO players (citizenid, license, name) VALUES (?, ?, ?)",
      ["CaseTest01", "license:AbCdEf", "MixedCase"],
    );

    const wrongCase = await call(
      "single",
      "SELECT * FROM players WHERE license = ?",
      ["LICENSE:ABCDEF"],
    );
    ok(
      wrongCase && wrongCase.citizenid === "CaseTest01",
      "a lookup in the wrong case still finds the row (silently finds nothing in stock SQLite)",
      show(wrongCase),
    );

    const likeCase = await call(
      "query",
      "SELECT citizenid FROM players WHERE name LIKE ?",
      ["mixedcase"],
    );
    ok(likeCase.length === 1, "LIKE matches regardless of case", show(likeCase));

    // MySQL treats these as the same value in a UNIQUE key; so must we.
    let duplicate = null;
    try {
      await call("insert", "INSERT INTO players (citizenid) VALUES (?)", [
        "casetest01",
      ]);
    } catch (e) {
      duplicate = e.message;
    }
    ok(
      duplicate !== null,
      "a UNIQUE key rejects the same value in another case, as MySQL does",
      duplicate,
    );

    await call("update", "DELETE FROM players WHERE citizenid = ?", ["CaseTest01"]);

    // ----------------------------------------------------------------
    console.log("\n=== Return values match oxmysql exactly");

    const insertId = await call(
      "insert",
      "INSERT INTO players (citizenid, license, name, money) VALUES (?, ?, ?, ?)",
      ["ABC123", "license:aaa", "Tommy", 500],
    );
    ok(
      typeof insertId === "number" && insertId > 0,
      "insert returns insertId, not an object",
      show(insertId),
    );
    ok(
      (await call("scalar", "SELECT id FROM players WHERE citizenid = ?", [
        "ABC123",
      ])) === insertId,
      "the insertId is the id of the row that was actually inserted",
      show(insertId),
    );

    const affected = await call(
      "update",
      "UPDATE players SET money = money + ? WHERE citizenid = ?",
      [250, "ABC123"],
    );
    ok(affected === 1, "update returns affectedRows", show(affected));

    const rows = await call("query", "SELECT * FROM players");
    ok(Array.isArray(rows) && rows.length === 1, "query returns an array of rows", show(rows));
    ok(rows[0].money === 750, "the update actually applied", show(rows[0]));

    const viaExecute = await call("execute", "SELECT * FROM players");
    ok(
      Array.isArray(viaExecute) && viaExecute.length === 1,
      "execute is an alias of query and returns rows (NOT affectedRows)",
      show(viaExecute),
    );

    const viaFetch = await call("fetch", "SELECT * FROM players");
    ok(Array.isArray(viaFetch), "fetch is an alias of query");

    const row = await call("single", "SELECT * FROM players WHERE citizenid = ?", ["ABC123"]);
    ok(row && !Array.isArray(row) && row.citizenid === "ABC123", "single returns one row object", show(row));

    const missingRow = await call("single", "SELECT * FROM players WHERE citizenid = ?", ["nope"]);
    ok(missingRow === null, "single returns null when nothing matches", show(missingRow));

    const money = await call("scalar", "SELECT money FROM players WHERE citizenid = ?", ["ABC123"]);
    ok(money === 750, "scalar returns the bare value", show(money));

    const missingScalar = await call("scalar", "SELECT money FROM players WHERE citizenid = ?", ["nope"]);
    ok(missingScalar === null, "scalar returns null when nothing matches");

    const count = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(count === 1, "scalar works on an aggregate with no alias", show(count));

    // ----------------------------------------------------------------
    console.log("\n=== Legacy mysql-async names");

    const legacyRows = await call("mysql_fetch_all", "SELECT * FROM players");
    ok(Array.isArray(legacyRows), "mysql_fetch_all returns rows");

    const legacyAffected = await call(
      "mysql_execute",
      "UPDATE players SET name = ? WHERE citizenid = ?",
      ["Renamed", "ABC123"],
    );
    ok(
      legacyAffected === 1,
      "mysql_execute maps to update and returns affectedRows",
      show(legacyAffected),
    );
    await call("update", "UPDATE players SET name = 'Tommy' WHERE citizenid = 'ABC123'");

    // ----------------------------------------------------------------
    console.log("\n=== prepare unpacking");

    // Every await/async path in oxmysql supplies a callback internally, so the
    // callback form is the one scripts actually observe.
    const preparedScalar = await new Promise((resolve) => {
      call(
        "prepare",
        "SELECT money FROM players WHERE citizenid = ?",
        ["ABC123"],
        resolve,
      );
    });
    ok(
      preparedScalar === 750,
      "prepare with a callback unwraps a single-column row to its value",
      show(preparedScalar),
    );

    const preparedRow = await new Promise((resolve) => {
      call("prepare", "SELECT citizenid, money FROM players WHERE citizenid = ?", ["ABC123"], resolve);
    });
    ok(
      preparedRow && preparedRow.citizenid === "ABC123" && preparedRow.money === 750,
      "prepare with a callback returns the row when it has several columns",
      show(preparedRow),
    );

    const preparedRows = await call("prepare", "SELECT citizenid FROM players", []);
    ok(
      Array.isArray(preparedRows),
      "prepare without a callback returns the rows array",
      show(preparedRows),
    );

    const preparedInsert = await new Promise((resolve) => {
      call(
        "prepare",
        "INSERT INTO players (citizenid, name) VALUES (?, ?)",
        [
          ["P1", "One"],
          ["P2", "Two"],
          ["P3", "Three"],
        ],
        resolve,
      );
    });
    ok(
      Array.isArray(preparedInsert) && preparedInsert.length === 3,
      "prepare with several parameter sets runs each one",
      show(preparedInsert),
    );

    const inserted = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(inserted === 4, "all three prepared inserts landed", show(inserted));

    // ----------------------------------------------------------------
    console.log("\n=== ON DUPLICATE KEY UPDATE");

    const before = await call("scalar", "SELECT COUNT(*) FROM players");
    await call(
      "insert",
      "INSERT INTO players (citizenid, name, money) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE money = VALUES(money), name = VALUES(name)",
      ["ABC123", "Upserted", 9000],
    );
    const after = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(after === before, "upsert on an existing row did not insert a duplicate", `${before} -> ${after}`);

    const upserted = await call("single", "SELECT * FROM players WHERE citizenid = ?", ["ABC123"]);
    ok(upserted.money === 9000 && upserted.name === "Upserted", "upsert updated the row", show(upserted));

    await call(
      "insert",
      "INSERT INTO players (citizenid, name, money) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE money = VALUES(money)",
      ["NEW999", "Fresh", 10],
    );
    const afterNew = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(afterNew === before + 1, "upsert on a new key inserted", `${after} -> ${afterNew}`);

    // A conflict target the statement never supplies would silently duplicate
    // rows, so it must be refused instead.
    let refused = null;
    try {
      await call(
        "insert",
        "INSERT INTO players (name) VALUES (?) ON DUPLICATE KEY UPDATE name = VALUES(name)",
        ["NoKey"],
      );
    } catch (e) {
      refused = e.message;
    }
    ok(
      refused !== null && /duplicate/i.test(refused),
      "an upsert that supplies no unique key is refused, not silently duplicated",
      refused,
    );

    // ----------------------------------------------------------------
    console.log("\n=== Transactions are atomic");

    const beforeTx = await call("scalar", "SELECT COUNT(*) FROM players");

    const okTx = await call("transaction", [
      ["INSERT INTO players (citizenid, name) VALUES (?, ?)", ["TX1", "First"]],
      ["INSERT INTO players (citizenid, name) VALUES (?, ?)", ["TX2", "Second"]],
    ]);
    ok(okTx === true, "a successful transaction returns true", show(okTx));

    const afterTx = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(afterTx === beforeTx + 2, "both statements committed", `${beforeTx} -> ${afterTx}`);

    const badTx = await call("transaction", [
      ["INSERT INTO players (citizenid, name) VALUES (?, ?)", ["TX3", "Third"]],
      ["INSERT INTO players (citizenid, name) VALUES (?, ?)", ["TX1", "Duplicate"]],
    ]);
    ok(badTx === false, "a failing transaction returns false rather than throwing", show(badTx));

    const afterBadTx = await call("scalar", "SELECT COUNT(*) FROM players");
    ok(
      afterBadTx === afterTx,
      "the failed transaction rolled back completely - no partial write",
      `${afterTx} -> ${afterBadTx}`,
    );

    const objectTx = await call("transaction", [
      { query: "UPDATE players SET money = ? WHERE citizenid = ?", values: [1, "TX1"] },
    ]);
    ok(objectTx === true, "transaction accepts { query, values } entries");

    // ----------------------------------------------------------------
    console.log("\n=== MySQL dialect that SQLite does not share");

    const now = await call("query", "SELECT NOW() AS t, UNIX_TIMESTAMP() AS ts");
    ok(
      now[0] && now[0].t && typeof now[0].ts === "number",
      "NOW() and UNIX_TIMESTAMP() translate",
      show(now[0]),
    );

    const concat = await call(
      "scalar",
      "SELECT CONCAT(citizenid, ' - ', name) FROM players WHERE citizenid = ?",
      ["ABC123"],
    );
    ok(concat === "ABC123 - Upserted", "CONCAT translates", show(concat));

    const conditional = await call(
      "scalar",
      "SELECT IF(money > 100, 'rich', 'poor') FROM players WHERE citizenid = ?",
      ["ABC123"],
    );
    ok(conditional === "rich", "MySQL IF() translates to IIF()", show(conditional));

    const ifnull = await call(
      "scalar",
      "SELECT IFNULL(license, 'none') FROM players WHERE citizenid = ?",
      ["TX1"],
    );
    ok(ifnull === "none", "IFNULL translates", show(ifnull));

    const backticks = await call(
      "query",
      "SELECT `citizenid`, `money` FROM `players` WHERE `citizenid` = ?",
      ["ABC123"],
    );
    ok(backticks.length === 1, "backtick identifiers translate", show(backticks));

    const limited = await call("query", "SELECT citizenid FROM players ORDER BY id LIMIT 1, 2");
    ok(limited.length === 2, "MySQL LIMIT offset,count translates", show(limited));

    const deleted = await call("update", "DELETE FROM players WHERE citizenid = ? LIMIT 1", ["TX2"]);
    ok(deleted === 1, "DELETE ... LIMIT translates and deletes exactly one row", show(deleted));

    // ----------------------------------------------------------------
    console.log("\n=== Named parameters");

    const named = await call(
      "single",
      "SELECT * FROM players WHERE citizenid = @cid AND money >= @min",
      { cid: "ABC123", min: 100 },
    );
    ok(named && named.citizenid === "ABC123", "@name parameters bind", show(named));

    const colonNamed = await call(
      "scalar",
      "SELECT name FROM players WHERE citizenid = :cid",
      { cid: "ABC123" },
    );
    ok(colonNamed === "Upserted", ":name parameters bind", show(colonNamed));

    // ----------------------------------------------------------------
    console.log("\n=== Callbacks");

    const cbResult = await new Promise((resolve) => {
      call("query", "SELECT citizenid FROM players WHERE citizenid = ?", ["ABC123"], resolve);
    });
    ok(Array.isArray(cbResult) && cbResult.length === 1, "callback form delivers the result", show(cbResult));

    const cbNoParams = await new Promise((resolve) => {
      call("scalar", "SELECT COUNT(*) FROM players", resolve);
    });
    ok(typeof cbNoParams === "number", "(sql, callback) form works without parameters", show(cbNoParams));

    const stored = await call("store", "SELECT 1");
    ok(stored === "SELECT 1", "store hands the query back", show(stored));

    // ----------------------------------------------------------------
    console.log("\n=== Untranslatable SQL fails loudly");

    let translationError = null;
    try {
      await call("query", "SELECT SQL_CALC_FOUND_ROWS * FROM players");
    } catch (e) {
      translationError = e.message;
    }
    ok(
      translationError !== null && /SQL_CALC_FOUND_ROWS/i.test(translationError),
      "an untranslatable construct is refused by name",
      translationError,
    );

    let sqlError = null;
    try {
      await call("query", "SELECT * FROM table_that_does_not_exist");
    } catch (e) {
      sqlError = e.message;
    }
    ok(
      sqlError !== null && /table_that_does_not_exist/.test(sqlError),
      "a database error reaches the caller with its message intact",
      sqlError,
    );

    // ----------------------------------------------------------------
    console.log("\n=== Cache correctness");

    adapter.enableCache(60000, 100);
    const cached1 = await call("scalar", "SELECT money FROM players WHERE citizenid = ?", ["ABC123"]);
    await call("update", "UPDATE players SET money = 4242 WHERE citizenid = ?", ["ABC123"]);
    const cached2 = await call("scalar", "SELECT money FROM players WHERE citizenid = ?", ["ABC123"]);
    ok(
      cached1 === 9000 && cached2 === 4242,
      "a write invalidates cached reads instead of serving stale data",
      `${cached1} -> ${cached2}`,
    );
    adapter.disableCache();

    // ----------------------------------------------------------------
    console.log("\n=== Concurrency");

    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call("scalar", "SELECT COUNT(*) FROM players WHERE money >= ?", [i]),
      ),
    );
    ok(
      concurrent.every((v) => typeof v === "number"),
      "twelve concurrent queries all resolve (no request auto-cancellation)",
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
