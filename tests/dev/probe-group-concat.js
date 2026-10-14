/**
 * What does the SQLite engine PocketBase actually embeds support?
 *
 * This exists because of GROUP_CONCAT. MySQL writes
 * `GROUP_CONCAT(x ORDER BY y SEPARATOR s)`; the transpiler turns the SEPARATOR
 * into SQLite's second argument correctly but DROPS the ORDER BY, which changes
 * the result silently. Whether that can be translated instead of refused
 * depends on whether the engine supports ORDER BY inside an aggregate, which
 * SQLite only gained in 3.44 (Nov 2023).
 *
 * node:sqlite on this machine is 3.53 and supports it, but node:sqlite is NOT
 * the engine that runs in production - PocketBase ships its own. Measuring the
 * wrong engine is how you ship a translation that works in the test suite and
 * fails on a server, so this asks the real one.
 *
 * Dev harness, not part of the suite. Run from the resource root:
 *   node tests/dev/probe-group-concat.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux"
);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-gcprobe-"));
const PORT = 8211;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "gcprobe@example.com";
const PASSWORD = "gcprobe-password-123";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function post(pathname, body, token) {
  const res = await fetch(`${URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json };
}

async function main() {
  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", DATA_DIR], {
    encoding: "utf8",
  });

  const server = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      DATA_DIR,
      "--migrationsDir",
      path.join(DATA_DIR, "migrations"),
    ],
    { stdio: "ignore" }
  );

  try {
    if (!(await waitForHealth())) throw new Error("server never became healthy");

    const auth = await post("/api/collections/_superusers/auth-with-password", {
      identity: EMAIL,
      password: PASSWORD,
    });
    const token = auth.json && auth.json.token;
    if (!token) throw new Error("could not authenticate");

    // The built-in /api/sql is read-only, which is all this needs: every probe
    // is a SELECT over a literal row set, so no table has to be created.
    const sql = async (label, query) => {
      const r = await post("/api/sql", { query }, token);
      const body = JSON.stringify(r.json);
      console.log(`  ${String(r.status).padEnd(4)} ${label}`);
      console.log(`       ${body && body.length > 200 ? body.slice(0, 200) + "..." : body}`);
      return r;
    };

    console.log("\n=== Which engine is this");
    await sql("sqlite_version()", "SELECT sqlite_version() AS v");

    console.log("\n=== group_concat forms (rows: c, a, b, a)");
    const rows =
      "SELECT 'c' AS name UNION ALL SELECT 'a' UNION ALL SELECT 'b' UNION ALL SELECT 'a'";

    await sql("1-arg", `SELECT group_concat(name) AS g FROM (${rows})`);
    await sql("2-arg (SEPARATOR)", `SELECT group_concat(name, ',') AS g FROM (${rows})`);
    await sql("DISTINCT, 1-arg", `SELECT group_concat(DISTINCT name) AS g FROM (${rows})`);
    await sql("DISTINCT, 2-arg", `SELECT group_concat(DISTINCT name, ',') AS g FROM (${rows})`);
    await sql(
      "ORDER BY inside the aggregate",
      `SELECT group_concat(name, ',' ORDER BY name ASC) AS g FROM (${rows})`
    );
    await sql(
      "ORDER BY DESC inside the aggregate",
      `SELECT group_concat(name, ',' ORDER BY name DESC) AS g FROM (${rows})`
    );
    await sql(
      "DISTINCT + ORDER BY, 1-arg",
      `SELECT group_concat(DISTINCT name ORDER BY name ASC) AS g FROM (${rows})`
    );

    console.log("\n=== Other version-gated things worth knowing about");
    await sql("RETURNING clause", "SELECT 1 WHERE 0");
    await sql("IIF()", "SELECT iif(1, 'y', 'n') AS v");
    await sql("strict tables supported", "SELECT 1 AS ok");
    await sql("JSON ->> operator", `SELECT '{"a":1}' ->> '$.a' AS v`);
    await sql("unixepoch()", "SELECT unixepoch('2026-01-01') AS v");
    await sql("concat()", "SELECT concat('a', 'b') AS v");
    await sql("format()", "SELECT format('%d', 5) AS v");

    console.log("\nData dir left at:", DATA_DIR);
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
