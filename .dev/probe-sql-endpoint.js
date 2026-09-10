/**
 * Probe how PocketBase 0.40.3 exposes raw SQL, to decide what the oxmysql
 * compatibility layer should execute against.
 *
 * Answers, against a live instance:
 *   - does the built-in POST /api/sql accept bind parameters?
 *   - does it return dynamically shaped rows?
 *   - does it allow writes, or is it read-only?
 *   - is it superuser-gated?
 *   - what do our own pb_hooks routes do by comparison?
 *
 * Dev harness. Run from the resource root: node .dev/probe-sql-endpoint.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-sqlprobe-"));
const PORT = 8097;
const URL = `http://127.0.0.1:${PORT}`;
const EMAIL = "probe@example.com";
const PASSWORD = "probe-password-123";

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
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json };
}

function show(label, r) {
  const body = JSON.stringify(r.json);
  console.log(
    `  ${String(r.status).padEnd(4)} ${label}\n       ${body && body.length > 260 ? body.slice(0, 260) + "..." : body}`,
  );
}

async function main() {
  // Copy the resource's hooks in, so both paths can be compared side by side.
  fs.mkdirSync(path.join(DATA_DIR, "../pb_hooks_probe"), { recursive: true });
  const hooksDir = path.join(path.dirname(DATA_DIR), "pb_hooks_probe");
  fs.copyFileSync(
    path.join(ROOT, "pb_hooks/api.pb.js"),
    path.join(hooksDir, "api.pb.js"),
  );

  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", DATA_DIR], {
    encoding: "utf8",
  });

  const server = spawn(
    PB_BIN,
    ["serve", `--http=127.0.0.1:${PORT}`, "--dir", DATA_DIR, "--hooksDir", hooksDir],
    { stdio: "ignore" },
  );

  try {
    if (!(await waitForHealth())) throw new Error("server never became healthy");

    // Authenticate as superuser.
    const auth = await post("/api/collections/_superusers/auth-with-password", {
      identity: EMAIL,
      password: PASSWORD,
    });
    const token = auth.json && auth.json.token;
    console.log("superuser authenticated:", Boolean(token));

    console.log("\n=== Built-in POST /api/sql");

    show("unauthenticated", await post("/api/sql", { query: "SELECT 1 AS one" }));
    show(
      "as superuser, simple select",
      await post("/api/sql", { query: "SELECT 1 AS one, 'x' AS two" }, token),
    );
    show(
      "dynamic shape (SELECT * from a system table)",
      await post("/api/sql", { query: "SELECT * FROM _collections LIMIT 1" }, token),
    );
    show(
      "with bind params {:p0}",
      await post(
        "/api/sql",
        { query: "SELECT {:p0} AS v", params: { p0: "bound" } },
        token,
      ),
    );
    show(
      "DDL (CREATE TABLE)",
      await post(
        "/api/sql",
        { query: "CREATE TABLE probe_t (id INTEGER PRIMARY KEY, name TEXT)" },
        token,
      ),
    );
    show(
      "INSERT (write)",
      await post(
        "/api/sql",
        { query: "INSERT INTO probe_t (name) VALUES ('alpha')" },
        token,
      ),
    );
    show(
      "read it back",
      await post("/api/sql", { query: "SELECT * FROM probe_t" }, token),
    );
    show(
      "multi-statement",
      await post(
        "/api/sql",
        { query: "SELECT 1 AS a; SELECT 2 AS b" },
        token,
      ),
    );

    console.log("\n=== Our pb_hooks routes");

    show(
      "/api/sql/query without columns",
      await post("/api/sql/query", { sql: "SELECT * FROM probe_t" }, token),
    );
    show(
      "/api/sql/query with columns",
      await post(
        "/api/sql/query",
        { sql: "SELECT * FROM probe_t", columns: { id: 0, name: "" } },
        token,
      ),
    );
    show(
      "/api/sql/execute",
      await post(
        "/api/sql/execute",
        { sql: "INSERT INTO probe_t (name) VALUES ('beta')" },
        token,
      ),
    );
    show(
      "/api/sql/query unauthenticated (should now be 401/403)",
      await post("/api/sql/query", {
        sql: "SELECT * FROM probe_t",
        columns: { id: 0, name: "" },
      }),
    );
    show("/api/extended/health", await post("/api/extended/health", {}, token));
  } finally {
    server.kill();
    await sleep(500);
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exitCode = 1;
});
