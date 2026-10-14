/**
 * One-off probe: import lb-phone's phone.sql through the real importer against a
 * real PocketBase, and report what landed. Not part of the suite - phone.sql is
 * a third-party file and is not redistributed here.
 *
 * node tests/dev/probe-lbphone-import.js [path/to/phone.sql]
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
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux"
);
const PORT = 8187;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "lbprobe@example.com";
const PASSWORD = "lbprobe-password-123";

const SOURCE = process.argv[2] || path.join(ROOT, "../../[scripts]/lb-phone/phone.sql");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = {
  info: (m) => console.log(`  info  ${m}`),
  warn: (m) => console.log(`  WARN  ${m}`),
  error: (m) => console.log(`  ERROR ${m}`),
  debug: () => {},
};

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`phone.sql not found at ${SOURCE}`);
    process.exit(2);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-lbprobe-"));
  const hooksDir = `${dataDir}-hooks`;
  const sqlDir = `${dataDir}-sql`;
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(sqlDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, "pb_hooks"))) {
    fs.copyFileSync(path.join(ROOT, "pb_hooks", file), path.join(hooksDir, file));
  }
  fs.copyFileSync(SOURCE, path.join(sqlDir, "phone.sql"));

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
    { stdio: "ignore" }
  );

  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${URL_BASE}/api/health`)).ok) break;
      } catch (_) {}
      await sleep(200);
    }

    const pb = new PocketBase(URL_BASE);
    pb.autoCancellation(false);
    await pb.collection("_superusers").authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    const adapter = new OxMySQLAdapter(pb, (fn) => fn, log);

    console.log(`\n=== importing ${path.basename(SOURCE)}`);
    const summary = await sqlImport.run(adapter, sqlDir, log, {
      onChanged: "warn",
    });

    console.log("\n=== summary");
    console.log(`  applied: ${JSON.stringify(summary.applied)}`);
    console.log(`  partial: ${JSON.stringify(summary.partial)}`);
    console.log(`  failed:  ${JSON.stringify(summary.failed)}`);

    const ledger = await sqlImport.readLedger(adapter);
    const row = ledger.get("phone.sql");
    console.log(`\n=== ledger row`);
    console.log(`  status:     ${row && row.status}`);
    console.log(`  statements: ${row && row.statements}`);
    console.log(`  note:       ${row && row.error}`);

    const count = async (sql) => {
      const rows = await adapter.handle("query", [sql]);
      return rows[0] ? Object.values(rows[0])[0] : 0;
    };
    console.log("\n=== what landed");
    for (const type of ["table", "trigger", "index"]) {
      const all = await count(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = '${type}'`);
      const named = await count(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%'`
      );
      console.log(`  ${type}s: ${all} total, ${named} explicitly named`);
    }

    // The tables the running server actually asked for and could not find.
    console.log("\n=== tables the live server reported missing");
    for (const t of [
      "phone_instagram_stories",
      "phone_twitter_hashtags",
      "phone_tinder_accounts",
      "phone_notifications",
      "phone_tiktok_notifications",
      "phone_clock_alarms",
    ]) {
      const n = await count(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='${t}'`
      );
      console.log(`  ${n ? "OK     " : "MISSING"} ${t}`);
    }

    // Hand every imported table to PocketBase, and time it at scale.
    const pbAdopt = require(path.join(ROOT, "server/utils/pb-adopt.js"));
    const adoptDeps = {
      query: (q, p) => adapter.handle("query", [q, p || []]),
      exec: (q, p) => adapter.handle("update", [q, p || []]),
      rawExec: (q) =>
        pb.send("/api/tdb/execute", {
          method: "POST",
          body: { sql: q, params: {} },
          requestKey: null,
        }),
      collections: {
        getFullList: () => pb.collections.getFullList({ requestKey: null }),
        getOne: (n) => pb.collections.getOne(n, { requestKey: null }),
        create: (d) => pb.collections.create(d),
        update: (id, d) => pb.collections.update(id, d),
        delete: (id) => pb.collections.delete(id),
      },
      logger: log,
    };
    console.log("");
    console.log("=== adoption at scale");
    const beforeColumns = new Map();
    for (const t of ["phone_message_messages", "phone_phones"]) {
      beforeColumns.set(
        t,
        (await adapter.handle("query", ["SELECT name FROM pragma_table_info(?)", [t]])).map((r) => r.name),
      );
    }
    const planned = await pbAdopt.plan(adoptDeps);
    console.log(`  planned: ${planned.length} table(s)`);
    const strategies = {};
    for (const entry of planned) {
      strategies[entry.idStrategy] = (strategies[entry.idStrategy] || 0) + 1;
    }
    console.log(`  id strategies: ${JSON.stringify(strategies)}`);
    const fkCount = planned.reduce((a, e) => a + e.foreignKeys.length, 0);
    console.log(`  foreign keys to re-create: ${fkCount}`);

    const tAdopt = Date.now();
    const adoptSummary = await pbAdopt.adopt(adoptDeps, planned);
    console.log(`  ${pbAdopt.describe(adoptSummary)} in ${Date.now() - tAdopt}ms`);
    for (const f of adoptSummary.failed.slice(0, 8)) console.log(`  FAILED ${f}`);
    for (const u of adoptSummary.unsupported.slice(0, 5)) console.log(`  NOT REPRODUCIBLE ${u}`);

    const afterCols = await pb.collections.getFullList({ requestKey: null });
    const bases = afterCols.filter((c) => c.type === "base" && c.name.startsWith("phone_"));
    console.log(`  phone_* base (editable) collections: ${bases.length}`);
    try {
      const probe2 = await pb.collection("phone_phones").getList(1, 2, { requestKey: null });
      console.log(`  phone_phones editable collection reads: ${probe2.totalItems} row(s)`);
    } catch (e) {
      console.log(`  phone_phones read FAILED: ${e.message}`);
    }
    // Did adoption keep every column, and in what order?
    const colsBefore = beforeColumns.get("phone_message_messages") || [];
    const colsAfter = (
      await adapter.handle("query", ["SELECT name FROM pragma_table_info(?)", ["phone_message_messages"]])
    ).map((r) => r.name);
    const missing = colsBefore.filter((c) => !colsAfter.includes(c));
    const added = colsAfter.filter((c) => !colsBefore.includes(c));
    console.log(`  columns before: ${colsBefore.join(",")}`);
    console.log(`  columns after : ${colsAfter.join(",")}`);
    console.log(`  missing: ${JSON.stringify(missing)}  added: ${JSON.stringify(added)}`);
    console.log(`  order preserved: ${JSON.stringify(colsBefore) === JSON.stringify(colsAfter)}`);

    const rowTotal = await adapter.handle("scalar", ["SELECT COUNT(*) FROM phone_phones"]);
    console.log(`  rows preserved in phone_phones: ${rowTotal}`);

    // Re-run must not replay the INSERTs.
    const again = await sqlImport.run(adapter, sqlDir, log, { onChanged: "warn" });
    console.log(
      `\n=== second run (must skip, not replay): skipped=${JSON.stringify(again.skipped)} applied=${JSON.stringify(again.applied)} partial=${JSON.stringify(again.partial)}`
    );
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
