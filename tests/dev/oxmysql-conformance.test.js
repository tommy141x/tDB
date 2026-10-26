/**
 * Conformance against oxmysql's real contract.
 *
 * tDB's claim is that it is a drop-in replacement. Both tables below are
 * transcribed from oxmysql's own source:
 *
 *   overextended/oxmysql @ bae715c244d7ef8136a025c8a35ced3daff51738
 *     src/index.ts     - the export surface
 *     lib/MySQL.lua    - the library surface
 *
 * When oxmysql changes, re-transcribe and re-run. A failure here is a
 * divergence a server owner would hit by swapping one resource for the other.
 *
 * Run from the resource root: node tests/dev/oxmysql-conformance.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = require("./fivem-require.js");

const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));
const PocketBaseAdapter = require(path.join(ROOT, "server/adapters/pocketbase.js"));

let pass = 0;
let fail = 0;
const gaps = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
    return;
  }
  fail++;
  gaps.push(label);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

function section(name) {
  console.log(`\n=== ${name}`);
}

// Keys of the MySQL object in src/index.ts. Order as written there.
const OX_METHODS = [
  "isReady",
  "awaitConnection",
  "query",
  "single",
  "scalar",
  "update",
  "insert",
  "transaction",
  "startTransaction",
  "prepare",
  "rawExecute",
  "store",
  "execute", // MySQL.execute = MySQL.query
  "fetch", // MySQL.fetch = MySQL.query
];

// src/index.ts registers each key three times:
//   exports(key, exp) / exports(`${key}_async`) / exports(`${key}Sync`)
function oxExportNames() {
  const names = [];
  for (const key of OX_METHODS) {
    names.push(key, `${key}_async`, `${key}Sync`);
  }
  return names;
}

// Everything tDB registers: the adapters, plus the state exports client.js
// registers before PocketBase is up.
function tdbExportNames() {
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const stub = {
    send: async () => ({}),
    autoCancellation() {},
    collection() {
      return {};
    },
  };
  const ox = new OxMySQLAdapter(stub, (fn) => fn, quiet);
  const pb = new PocketBaseAdapter(stub, (fn) => fn, quiet);

  const names = new Set([...ox.supportedExports, ...pb.supportedExports]);

  // Read these out of client.js rather than restating them, so the test
  // notices if one is renamed or dropped.
  const client = fs.readFileSync(path.join(ROOT, "server/utils/client.js"), "utf8");
  for (const m of client.matchAll(/^\s*exports\("([A-Za-z0-9_]+)"/gm)) {
    names.add(m[1]);
  }
  return names;
}

function main() {
  section("Export surface (src/index.ts)");

  const expected = oxExportNames();
  const have = tdbExportNames();

  const missing = expected.filter((n) => !have.has(n));

  console.log(
    `  oxmysql registers ${expected.length}; tDB provides ${expected.length - missing.length}`
  );

  for (const name of expected) {
    ok(have.has(name), `exports.oxmysql:${name}`);
  }

  section("Library surface (lib/MySQL.lua)");

  const lua = fs.readFileSync(path.join(ROOT, "lib/MySQL.lua"), "utf8");

  // oxmysql: MySQL.ready = setmetatable({ await = onReady }, { __call = ... })
  // so both MySQL.ready(cb) and MySQL.ready.await() are valid. A plain
  // `function MySQL.ready(cb)` makes `.await` index a function value.
  ok(
    !/^function MySQL\.ready\(/m.test(lua),
    "MySQL.ready carries .await (not a plain function)",
    "oxmysql callers use MySQL.ready.await(); a plain function cannot be indexed"
  );

  // oxmysql: setmetatable(MySQL, { __index = function(_, index) ... end })
  // Any MySQL.<name> forwards to the export of the same name, so a script using
  // a method this library never enumerated still works.
  ok(
    /setmetatable\(\s*MySQL\s*,/.test(lua),
    "MySQL has a catch-all __index that forwards unknown methods",
    "without it, any method not enumerated here is a nil-value call"
  );

  // oxmysql's alias table includes prepare, for both namespaces.
  for (const ns of ["Sync", "Async"]) {
    ok(new RegExp(`MySQL\\.${ns}\\.prepare`).test(lua), `MySQL.${ns}.prepare exists`);
    ok(new RegExp(`MySQL\\.${ns}\\.store`).test(lua), `MySQL.${ns}.store exists`);
  }

  ok(/MySQL\.startTransaction/.test(lua), "MySQL.startTransaction exists");

  // oxmysql's MySQL.Sync.store returns an integer handle into queryStore, and
  // safeArgs turns a numeric first argument back into the stored string.
  ok(
    /queryStore/.test(lua),
    "a stored-query handle can be passed back as the query",
    "oxmysql's store returns an integer index, not the query text"
  );

  section("Exports exist from the first frame, as oxmysql's do");

  // oxmysql registers its exports at load; tDB's adapters only arrive when
  // PocketBase is up. A script that queries during its own startup must still
  // get its rows, not "no such export" - that is what broke night_shifts_mdt.
  const ExportRouter = require(path.join(ROOT, "server/utils/export-router.js"));

  return (async () => {
    const registered = new Map();
    let releaseReady;
    const ready = new Promise((r) => {
      releaseReady = r;
    });

    const router = new ExportRouter(
      (name, fn) => registered.set(name, fn),
      () => ready,
      { info() {}, warn() {}, error() {}, debug() {} }
    );

    router.registerExports(["query", "insert"]);

    ok(
      registered.has("query") && registered.has("insert"),
      "export names are registered before any adapter exists"
    );

    // Called now, with no adapter: must park rather than throw.
    let threw = null;
    let pending;
    try {
      pending = registered.get("query")("SELECT 1", []);
    } catch (e) {
      threw = e;
    }
    ok(!threw, "a call before readiness does not throw", threw && threw.message);
    ok(pending && typeof pending.then === "function", "it returns a promise instead");

    // Adapter turns up late, exactly as the ready handler does it.
    const calls = [];
    router.registerAdapter(
      {
        name: "late",
        canHandle: () => true,
        handle: (name, args) => {
          calls.push([name, args[0]]);
          return Promise.resolve([{ ok: 1 }]);
        },
      },
      10
    );
    releaseReady(true);

    const rows = await pending;
    ok(
      Array.isArray(rows) && rows[0] && rows[0].ok === 1,
      "the parked call dispatches and resolves once ready",
      JSON.stringify(rows)
    );
    ok(
      calls.length === 1 && calls[0][1] === "SELECT 1",
      "it reaches the adapter with its original arguments",
      JSON.stringify(calls)
    );

    // Warm path must not take the parking branch.
    const warm = await registered.get("insert")("INSERT INTO t VALUES (1)", []);
    ok(calls.length === 2, "a call after readiness dispatches directly", String(calls.length));
    ok(Array.isArray(warm), "and still returns the adapter's value");

    section("Exports are published under the names of the resources tDB replaces");

    // `provide 'oxmysql'` in the manifest does NOT alias exports. Measured on a
    // live FiveM server: GetResourceState('oxmysql') reports `started`, which is
    // why dependency checks pass and why this looked fine for so long, but
    //   exports.oxmysql:scalar('SELECT 1')
    // answers "No such export scalar in resource oxmysql". Every script that was
    // never ported to tDB was failing - which is every script the compatibility
    // layer exists for.
    //
    // The mechanism is oxmysql's own: answer `__cfx_export_<resource>_<method>`
    // with the function. Also measured live, including the calling convention:
    // the `:` form delivers (query, parameters, cb) with the self slot already
    // stripped, so an aliased name can share the real entry point unchanged.
    {
      const registered = new Map();
      const exported = new Map();
      const quiet = { info() {}, warn() {}, error() {}, debug() {} };

      const router = new ExportRouter(
        (name, fn) => exported.set(name, fn),
        () => Promise.resolve(),
        quiet,
        (eventName, handler) => registered.set(eventName, handler)
      );

      router.registerExports(OxMySQLAdapter.buildExportList());

      const aliased = OxMySQLAdapter.aliasedResources();
      for (const [resourceName, methods] of Object.entries(aliased)) {
        router.registerAliases(resourceName, methods);
      }

      // The four names real scripts in the wild actually call.
      for (const [resourceName, method] of [
        ["oxmysql", "query"],
        ["oxmysql", "single"],
        ["oxmysql", "scalar_async"],
        ["oxmysql", "insert"],
        ["mysql-async", "mysql_fetch_all"],
        ["ghmattimysql", "execute"],
        ["ghmattimysql", "scalarSync"],
      ]) {
        ok(
          registered.has(`__cfx_export_${resourceName}_${method}`),
          `exports['${resourceName}']:${method} is published`
        );
      }

      // Registering has to hand back a live function, not answer once: FiveM
      // fires the event every time a consumer resolves the export.
      const handler = registered.get("__cfx_export_oxmysql_query");
      let first = null;
      let second = null;
      handler((fn) => (first = fn));
      handler((fn) => (second = fn));
      ok(typeof first === "function", "and resolving it yields a function");
      ok(typeof second === "function", "and it can be resolved more than once");

      // The aliased name must route to the SAME behaviour as tDB's own export,
      // or the two can drift.
      const seen = [];
      router.registerAdapter({
        name: "stub",
        canHandle: () => true,
        handle: (exportName, args) => {
          seen.push([exportName, args]);
          return "ok";
        },
      });

      const viaAlias = first("SELECT 1", [1, 2]);
      ok(viaAlias === "ok", "an aliased call dispatches", String(viaAlias));
      ok(
        seen.length === 1 && seen[0][0] === "query",
        "under the export name it aliases, not under the resource name",
        JSON.stringify(seen.map((s) => s[0]))
      );
      ok(
        Array.isArray(seen[0][1]) && seen[0][1][0] === "SELECT 1",
        "with the arguments passed straight through",
        JSON.stringify(seen[0][1])
      );

      // ghmattimysql's `execute` means ROWS (it maps from oxmysql's `query`),
      // while mysql-async's `mysql_execute` means affectedRows. Publishing the
      // name is all that is needed because the meanings already differ correctly,
      // but assert it so a future tidy-up cannot collapse the two.
      ok(
        aliased.ghmattimysql.includes("execute") && !aliased.ghmattimysql.includes("mysql_execute"),
        "ghmattimysql gets `execute` (rows), not mysql-async's `mysql_execute`"
      );
      ok(
        aliased["mysql-async"].includes("mysql_execute") &&
          !aliased["mysql-async"].includes("execute"),
        "and mysql-async gets `mysql_execute` (affectedRows), not `execute`"
      );

      // No registrar (an older host, or a unit test) must warn rather than
      // throw, so a missing one costs the aliases and not the resource.
      const bare = new ExportRouter(
        () => {},
        () => Promise.resolve(),
        quiet
      );
      let threw = null;
      try {
        bare.registerAliases("oxmysql", ["query"]);
      } catch (error) {
        threw = error;
      }
      ok(threw === null, "a missing event registrar degrades rather than throwing", String(threw));
    }

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);

    if (gaps.length) {
      console.log("\nDivergences from oxmysql:");
      for (const g of gaps) console.log(`  - ${g}`);
    }

    process.exitCode = fail === 0 ? 0 : 1;
  })();
}

main();
