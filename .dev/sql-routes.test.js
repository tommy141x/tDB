/**
 * Checks the SQL routes that back the oxmysql compatibility layer, against a
 * real PocketBase instance running the resource's own pb_hooks.
 *
 * The point of interest is result fidelity: a drop-in oxmysql replacement is
 * only honest if a NULL arrives as null, an INTEGER as a number, and insertId
 * reports the row that was actually inserted.
 *
 * Dev harness. Run from the resource root: node .dev/sql-routes.test.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? "bin/pocketbase-win.exe" : "bin/pocketbase-linux",
);
const PORT = 8151;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "routes@example.com";
const PASSWORD = "routes-password-123";

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

let token = null;

async function call(route, body, useToken = true) {
  const res = await fetch(`${URL}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(useToken && token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json };
}

const query = (sql, params) => call("/api/tdb/query", { sql, params });
const execute = (sql, params) => call("/api/tdb/execute", { sql, params });

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-routes-"));
  const hooksDir = path.join(dataDir, "..", path.basename(dataDir) + "-hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  // Run the resource's real hooks, not a copy that could drift.
  for (const file of fs.readdirSync(path.join(ROOT, "pb_hooks"))) {
    fs.copyFileSync(
      path.join(ROOT, "pb_hooks", file),
      path.join(hooksDir, file),
    );
  }

  // Provisioning before serve keeps PocketBase off its web installer.
  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", dataDir], {
    encoding: "utf8",
  });

  const server = spawn(
    PB_BIN,
    ["serve", `--http=127.0.0.1:${PORT}`, "--dir", dataDir, "--hooksDir", hooksDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));

  try {
    if (!(await waitForHealth())) throw new Error("server never became healthy");

    const auth = await call(
      "/api/collections/_superusers/auth-with-password",
      { identity: EMAIL, password: PASSWORD },
      false,
    );
    token = auth.json && auth.json.token;
    ok(Boolean(token), "superuser authenticated");

    // ----------------------------------------------------------------
    console.log("\n=== Access control");

    const unauth = await call("/api/tdb/query", { sql: "SELECT 1 AS a" }, false);
    ok(
      unauth.status === 401 || unauth.status === 403,
      `unauthenticated query is rejected (${unauth.status})`,
    );

    // ----------------------------------------------------------------
    console.log("\n=== Schema setup");

    let r = await execute(
      `CREATE TABLE players (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         citizenid TEXT UNIQUE,
         name TEXT,
         money REAL,
         banned BOOLEAN DEFAULT 0,
         metadata TEXT,
         avatar BLOB
       )`,
    );
    ok(r.status === 200 && r.json.success, "CREATE TABLE", JSON.stringify(r.json));

    r = await execute("CREATE TABLE vehicles (id INTEGER PRIMARY KEY, owner TEXT, plate TEXT)");
    ok(r.status === 200 && r.json.success, "CREATE TABLE vehicles");

    // ----------------------------------------------------------------
    console.log("\n=== Writes report real counters");

    r = await execute(
      "INSERT INTO players (citizenid, name, money, banned) VALUES ({:p0}, {:p1}, {:p2}, {:p3})",
      { p0: "ABC123", p1: "Tommy", p2: 1500.5, p3: 0 },
    );
    ok(r.json && r.json.insertId === 1, "insertId reports the inserted row", JSON.stringify(r.json));
    ok(r.json && r.json.affectedRows === 1, "affectedRows is 1", JSON.stringify(r.json));

    r = await execute(
      "INSERT INTO players (citizenid, name, money) VALUES ({:p0}, {:p1}, {:p2})",
      { p0: "XYZ789", p1: null, p2: null },
    );
    ok(r.json && r.json.insertId === 2, "insertId advances on the next insert", JSON.stringify(r.json));

    r = await execute("UPDATE players SET money = money + 100 WHERE money IS NOT NULL");
    ok(r.json && r.json.affectedRows === 1, "UPDATE reports rows changed", JSON.stringify(r.json));

    r = await execute("DELETE FROM players WHERE citizenid = {:p0}", { p0: "nope" });
    ok(r.json && r.json.affectedRows === 0, "DELETE matching nothing reports 0");

    // ----------------------------------------------------------------
    console.log("\n=== Rows come back dynamically shaped and correctly typed");

    r = await query("SELECT * FROM players ORDER BY id");
    const rows = r.json && r.json.rows;
    ok(
      same(r.json.columns, ["id", "citizenid", "name", "money", "banned", "metadata", "avatar"]),
      "SELECT * discovers columns without the caller declaring them",
      JSON.stringify(r.json.columns),
    );
    ok(rows && rows.length === 2, "row count", JSON.stringify(rows));
    ok(rows && typeof rows[0].id === "number" && rows[0].id === 1, "INTEGER arrives as a number");
    ok(rows && rows[0].money === 1600.5, "REAL keeps its fractional part", rows && rows[0].money);
    ok(rows && rows[0].name === "Tommy", "TEXT arrives as a string");
    ok(rows && rows[1].name === null, "NULL arrives as null, not \"\"", JSON.stringify(rows && rows[1]));
    ok(rows && rows[1].money === null, "NULL REAL arrives as null");
    ok(rows && rows[0].banned === 0, "BOOLEAN arrives as 0/1, as oxmysql callers expect");

    r = await query("SELECT citizenid FROM players WHERE citizenid = {:p0}", { p0: "ABC123" });
    ok(
      r.json.rows.length === 1 && r.json.rows[0].citizenid === "ABC123",
      "bind parameters work",
      JSON.stringify(r.json),
    );

    r = await query("SELECT * FROM players WHERE id = 99999");
    ok(r.json.success && same(r.json.rows, []), "empty result set is not an error");

    // ----------------------------------------------------------------
    console.log("\n=== The cases that broke every other approach");

    await execute("INSERT INTO vehicles (id, owner, plate) VALUES (10, {:p0}, {:p1})", {
      p0: "ABC123",
      p1: "PLATE01",
    });

    r = await query(
      "SELECT p.citizenid, p.name, v.plate FROM players p LEFT JOIN vehicles v ON v.owner = p.citizenid ORDER BY p.id",
    );
    ok(
      r.json.rows.length === 2 && r.json.rows[1].plate === null,
      "LEFT JOIN with no match yields null (a typed DynamicModel cannot do this)",
      JSON.stringify(r.json.rows),
    );

    r = await query("SELECT COUNT(*) AS total, SUM(money) AS sum, MAX(id) AS top FROM players");
    ok(
      r.json.rows[0].total === 2 && r.json.rows[0].sum === 1600.5 && r.json.rows[0].top === 2,
      "aggregate expressions stay numeric despite having no declared type",
      JSON.stringify(r.json.rows),
    );

    await execute("UPDATE players SET avatar = x'DEADBEEF' WHERE id = 1");
    r = await query("SELECT id, avatar FROM players ORDER BY id");
    ok(r.json.rows[0].avatar === "DEADBEEF", "BLOB is hex-encoded", JSON.stringify(r.json.rows[0]));
    ok(r.json.rows[1].avatar === null, "NULL BLOB stays null rather than becoming \"\"");

    r = await query("SELECT {:p0} AS v", { p0: "Tommy's café ☕ \" \\ \n" });
    ok(
      r.json.rows[0].v === "Tommy's café ☕ \" \\ \n",
      "quotes, unicode and escapes survive the JSON round trip",
      JSON.stringify(r.json.rows[0]),
    );

    r = await query("SELECT p.id, v.id FROM players p JOIN vehicles v ON v.owner = p.citizenid");
    ok(
      r.json.columns.length === 2 && r.json.rows[0] && Object.keys(r.json.rows[0]).length === 2,
      "duplicate column names are disambiguated rather than collapsed",
      JSON.stringify(r.json),
    );

    r = await query("SELECT name FROM players ORDER BY id DESC LIMIT 1");
    ok(r.json.rows.length === 1, "a query with its own LIMIT still describes correctly");

    r = await query(
      "WITH rich AS (SELECT * FROM players WHERE money > 1000) SELECT citizenid FROM rich",
    );
    ok(
      r.json.success && r.json.rows.length === 1,
      "common table expressions work",
      JSON.stringify(r.json),
    );

    // A shape is discovered by running the statement inside a subquery, which
    // SQLite forbids for DML. Rather than let that surface as a confusing
    // syntax error, it is refused by name. MySQL has no RETURNING, so no
    // oxmysql-dialect script loses anything.
    r = await query(
      "INSERT INTO vehicles (id, owner, plate) VALUES (11, {:p0}, {:p1}) RETURNING id, plate",
      { p0: "XYZ789", p1: "PLATE02" },
    );
    ok(
      r.status === 400 && /INSERT cannot return rows/.test(r.json.error || ""),
      "INSERT through the query route is refused by name, not by syntax error",
      JSON.stringify(r.json),
    );
    const afterRefusal = await query("SELECT COUNT(*) AS c FROM vehicles");
    ok(
      afterRefusal.json.rows[0].c === 1,
      "the refused INSERT did not write anything",
      JSON.stringify(afterRefusal.json.rows),
    );

    // ----------------------------------------------------------------
    console.log("\n=== Errors are reported, not swallowed");

    r = await query("SELECT * FROM does_not_exist");
    ok(r.status === 400 && r.json.success === false, "unknown table is an error");
    ok(
      /does_not_exist/.test(r.json.error || ""),
      "the error names the actual problem",
      r.json.error,
    );

    r = await execute("THIS IS NOT SQL");
    ok(r.status === 400 && r.json.success === false, "malformed SQL is an error");

    // ----------------------------------------------------------------
    console.log("\n=== Batches and transactions");

    r = await call("/api/tdb/batch", {
      statements: [
        { sql: "INSERT INTO vehicles (id, owner, plate) VALUES (20, 'ABC123', 'B1')" },
        { sql: "INSERT INTO vehicles (id, owner, plate) VALUES (21, 'ABC123', 'B2')" },
        { sql: "SELECT COUNT(*) AS c FROM vehicles", expect: "rows" },
      ],
    });
    ok(
      r.json.success && r.json.results.length === 3 && r.json.results[2].rows[0].c === 3,
      "a batch runs every statement and can mix reads with writes",
      JSON.stringify(r.json),
    );

    const beforeRollback = (await query("SELECT COUNT(*) AS c FROM vehicles")).json.rows[0].c;
    r = await call("/api/tdb/batch", {
      statements: [
        { sql: "INSERT INTO vehicles (id, owner, plate) VALUES (30, 'ABC123', 'ROLL')" },
        { sql: "INSERT INTO vehicles (id, owner, plate) VALUES (30, 'ABC123', 'DUP')" },
      ],
    });
    ok(r.status === 400 && r.json.success === false, "a failing batch reports failure");

    const afterRollback = (await query("SELECT COUNT(*) AS c FROM vehicles")).json.rows[0].c;
    ok(
      afterRollback === beforeRollback,
      "the whole batch rolled back - no partial write survived",
      `before=${beforeRollback} after=${afterRollback}`,
    );

    // ----------------------------------------------------------------
    console.log("\n=== Schema introspection for conflict targets");

    r = await call("/api/tdb/schema", { table: "players" });
    ok(r.json.success, "schema route describes a table", JSON.stringify(r.json).slice(0, 160));
    ok(same(r.json.primaryKey, ["id"]), "primary key found", JSON.stringify(r.json.primaryKey));
    ok(
      r.json.uniqueIndexes.some((ix) => same(ix, ["citizenid"])),
      "UNIQUE column found as a conflict target candidate",
      JSON.stringify(r.json.uniqueIndexes),
    );
    ok(
      r.json.columns.length === 7 && r.json.columns[0].name === "id",
      "columns reported with names and types",
      JSON.stringify(r.json.columns).slice(0, 160),
    );

    r = await call("/api/tdb/schema", { table: "no_such_table" });
    ok(r.status === 404, "unknown table reports 404 rather than an empty schema");

    // ----------------------------------------------------------------
    console.log("\n=== Repeated queries (shape cache)");

    for (let i = 0; i < 3; i++) {
      r = await query("SELECT id, name FROM players ORDER BY id");
    }
    ok(
      r.json.rows.length === 2 && r.json.rows[0].name === "Tommy",
      "a cached shape still returns correct rows",
      JSON.stringify(r.json.rows),
    );

    await execute("ALTER TABLE players ADD COLUMN job TEXT DEFAULT 'unemployed'");
    r = await query("SELECT * FROM players ORDER BY id");
    ok(
      r.json.columns.includes("job"),
      "SELECT * picks up a column added after the shape was first cached",
      JSON.stringify(r.json.columns),
    );

    // ----------------------------------------------------------------
    ok(
      !serverOutput.includes("pbinstall"),
      "PocketBase never asked for web installation",
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
