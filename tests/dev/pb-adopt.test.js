/**
 * Handing raw tables over to PocketBase so they become editable collections.
 *
 * This one rewrites tables, so the assertions are about not losing anything:
 * every row survives, ids keep looking like ids, a cascade still cascades, and
 * the admin UI's own API can edit a row that raw SQL then agrees with.
 *
 * Run from the resource root: node tests/dev/pb-adopt.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));
const pbAdopt = require(path.join(ROOT, "server/utils/pb-adopt.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux"
);
const PORT = 8207;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "adopt@example.com";
const PASSWORD = "adopt-password-123";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (n) => console.log(`\n=== ${n}`);

async function main() {
  section("Pure functions");

  ok(pbAdopt.fieldTypeFor("INTEGER") === "number", "INTEGER maps to number");
  ok(pbAdopt.fieldTypeFor("INT UNSIGNED") === "number", "INT UNSIGNED maps to number");
  ok(pbAdopt.fieldTypeFor("VARCHAR(20)") === "text", "VARCHAR maps to text");
  ok(pbAdopt.fieldTypeFor("BOOLEAN") === "bool", "BOOLEAN maps to bool");
  ok(pbAdopt.fieldTypeFor("JSON") === "json", "JSON maps to json");
  ok(pbAdopt.fieldTypeFor("REAL") === "number", "REAL maps to number");
  ok(
    pbAdopt.fieldTypeFor("DATETIME") === "text",
    "DATETIME stays text, since PocketBase's date field is strict ISO"
  );
  ok(pbAdopt.fieldTypeFor("") === "text", "an undeclared type defaults to text");

  ok(
    pbAdopt.idStrategyFor([{ name: "id", type: "INTEGER", pk: 1 }]) === "numeric",
    "an integer primary key id keeps looking numeric"
  );
  ok(
    pbAdopt.idStrategyFor([{ name: "id", type: "TEXT", pk: 1 }]) === "text",
    "a text id passes through"
  );
  ok(
    pbAdopt.idStrategyFor([{ name: "phone", type: "TEXT", pk: 1 }]) === "rowid",
    "a table with no id borrows its rowid"
  );

  ok(!pbAdopt.isAdoptable("_mfas"), "PocketBase internals are skipped");
  ok(!pbAdopt.isAdoptable("sqlite_sequence"), "SQLite internals are skipped");
  ok(!pbAdopt.isAdoptable(pbAdopt.REGISTRY), "the registry itself is skipped");
  ok(!pbAdopt.isAdoptable(pbAdopt.workingName("t")), "a leftover working table is skipped");
  ok(pbAdopt.isAdoptable("phone_phones"), "a real table is adoptable");

  const restrict = pbAdopt.cascadeTriggers(
    "c",
    { table: "p", from: "pid", to: "id", on_delete: "RESTRICT" },
    0
  );
  ok(
    !restrict.statements.length && restrict.unsupported === "RESTRICT",
    "ON DELETE RESTRICT is reported, not faked with a trigger",
    JSON.stringify(restrict)
  );

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-adopt-"));
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

    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const adapter = new OxMySQLAdapter(pb, (fn) => fn, quiet);
    const rows = (sql, params) => adapter.handle("query", [sql, params || []]);
    const run = (sql, params) => adapter.handle("update", [sql, params || []]);
    const one = async (sql, params) => {
      const r = await rows(sql, params);
      return r[0] ? Object.values(r[0])[0] : null;
    };

    const deps = () => ({
      query: rows,
      exec: run,
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
      logger: quiet,
    });

    // Built exactly as an imported dump builds them, through the oxmysql path.
    await run(
      "CREATE TABLE IF NOT EXISTS owners (phone VARCHAR(15) NOT NULL, label VARCHAR(40) NOT NULL, PRIMARY KEY (phone))"
    );
    await run(
      "CREATE TABLE IF NOT EXISTS notes (id INT UNSIGNED NOT NULL AUTO_INCREMENT, owner VARCHAR(15) NOT NULL, body LONGTEXT NOT NULL, score INT NOT NULL, PRIMARY KEY (id), FOREIGN KEY (owner) REFERENCES owners(phone) ON DELETE CASCADE)"
    );
    await run("INSERT INTO owners (phone, label) VALUES (?, ?)", ["555", "Ada"]);
    await run("INSERT INTO owners (phone, label) VALUES (?, ?)", ["666", "Bob"]);
    await run("INSERT INTO notes (owner, body, score) VALUES (?, ?, ?)", ["555", "first", 10]);
    await run("INSERT INTO notes (owner, body, score) VALUES (?, ?, ?)", ["555", "second", 20]);
    await run("INSERT INTO notes (owner, body, score) VALUES (?, ?, ?)", ["666", "third", 30]);

    const notesBefore = await one("SELECT COUNT(*) FROM notes");
    const ownersBefore = await one("SELECT COUNT(*) FROM owners");

    section("The pre-adoption backup");

    // PocketBase validates the backup name against a lowercase pattern and
    // requires the .zip extension. An ISO timestamp contains T and Z, so the
    // first version of this was rejected on every boot with PocketBase's
    // generic validation message and adoption never ran.
    const backupName = `pre-adopt-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .toLowerCase()}.zip`;

    ok(
      backupName === backupName.toLowerCase() && backupName.endsWith(".zip"),
      "the name tDB builds is lowercase and ends .zip",
      backupName
    );

    let created = null;
    try {
      await pb.backups.create(backupName);
      created = true;
    } catch (e) {
      created = e;
    }
    ok(
      created === true,
      "and PocketBase accepts it",
      created !== true ? String(created) : undefined
    );

    // The shape the old name produced, as a control for the assertion above.
    let rejected = null;
    try {
      await pb.backups.create(`pre-adopt-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
      rejected = false;
    } catch (e) {
      rejected = e;
    }
    ok(rejected !== false, "an uppercase name is genuinely rejected, so the rule is real");
    if (rejected && rejected !== false) {
      const described = require(path.join(ROOT, "server/utils/route-error.js")).describeRouteError(
        rejected
      );
      ok(/name:/.test(described), "and the description names the offending field", described);
    }

    section("Planning");

    const entries = await pbAdopt.plan(deps());
    const byName = new Map(entries.map((e) => [e.table, e]));
    ok(
      byName.has("notes") && byName.has("owners"),
      "both tables are planned",
      JSON.stringify([...byName.keys()])
    );
    ok(byName.get("notes").idStrategy === "numeric", "notes keeps numeric ids");
    ok(byName.get("owners").idStrategy === "rowid", "owners has no id, so rowid");
    ok(byName.get("notes").foreignKeys.length === 1, "the foreign key is seen");

    section("A nullable column stays nullable, and PocketBase still owns it");

    // PocketBase has no NULL: every column it creates is NOT NULL with a
    // zero-value default, and `required: false` makes no difference - measured
    // on the DDL it emits. Left alone, two things break: the row copy fails
    // with `NOT NULL constraint failed` (which is what left 27 scratch tables
    // on a live server), and an edit through the admin UI writes "" over an
    // existing NULL so `WHERE col IS NULL` silently stops matching.
    //
    // Adoption therefore rebuilds the table PocketBase made - while it is still
    // empty - with the source's own nullability, and installs a guard trigger
    // for the UI write. Both are asserted here, because the whole point is that
    // PocketBase owning the table costs nothing in SQL behaviour.
    await run(
      "CREATE TABLE IF NOT EXISTS optional_cols (id INT UNSIGNED NOT NULL AUTO_INCREMENT, logo_key VARCHAR(40), `rank` INT, notes LONGTEXT, PRIMARY KEY (id))"
    );
    await run("INSERT INTO optional_cols (logo_key, `rank`, notes) VALUES (?, ?, ?)", [
      null,
      null,
      "has notes",
    ]);
    await run("INSERT INTO optional_cols (logo_key, `rank`, notes) VALUES (?, ?, ?)", [
      "real-key",
      7,
      "populated",
    ]);

    const nullablePlan = await pbAdopt.plan(deps());
    const optionalEntry = nullablePlan.find((e) => e.table === "optional_cols");
    ok(optionalEntry, "a table with nullable columns is planned for adoption");
    ok(
      optionalEntry &&
        optionalEntry.nullable.includes("logo_key") &&
        optionalEntry.nullable.includes("rank"),
      "and the plan names which columns are nullable",
      JSON.stringify(optionalEntry && optionalEntry.nullable)
    );

    const nullableSummary = await pbAdopt.adopt(deps(), [optionalEntry]);
    ok(
      nullableSummary.adopted.includes("optional_cols"),
      "it adopts",
      JSON.stringify(nullableSummary)
    );

    const rebuilt = await rows("SELECT name, `notnull` FROM pragma_table_info(?)", [
      "optional_cols",
    ]);
    const notNullOf = new Map(rebuilt.map((c) => [c.name, Number(c.notnull)]));
    ok(
      notNullOf.get("logo_key") === 0 && notNullOf.get("rank") === 0,
      "and the columns the source had as nullable are nullable in PocketBase's table",
      JSON.stringify([...notNullOf])
    );

    ok(
      (await one("SELECT COUNT(*) FROM optional_cols WHERE logo_key IS NULL")) === 1,
      "the NULL survived the rebuild and IS NULL still matches"
    );

    // The UI write. PocketBase's record model has no NULL, so this sends "" for
    // logo_key and 0 for rank even though only `notes` was touched.
    const optionalRecords = await pb.collection("optional_cols").getFullList({ requestKey: null });
    ok(optionalRecords.length === 2, "both rows are visible in the admin UI");

    const nullRecord = optionalRecords.find((r) => r.notes === "has notes");
    let uiEdited = null;
    try {
      await pb
        .collection("optional_cols")
        .update(nullRecord.id, { notes: "edited in the UI" }, { requestKey: null });
      uiEdited = true;
    } catch (e) {
      uiEdited = e;
    }
    ok(uiEdited === true, "an edit through the UI succeeds", String(uiEdited));
    ok(
      (await one("SELECT notes FROM optional_cols WHERE id = ?", [nullRecord.id])) ===
        "edited in the UI",
      "the edit landed"
    );
    ok(
      (await one("SELECT COUNT(*) FROM optional_cols WHERE logo_key IS NULL")) === 1,
      'and the untouched NULL text column is still NULL, not ""'
    );
    ok(
      (await one("SELECT COUNT(*) FROM optional_cols WHERE `rank` IS NULL")) === 1,
      "and the untouched NULL numeric column is still NULL, not 0"
    );

    // The guard must not reach a row that was never NULL.
    ok(
      (await one("SELECT logo_key FROM optional_cols WHERE notes = ?", ["populated"])) ===
        "real-key",
      "a populated value is untouched by the guard"
    );

    // And it must not make a column permanently NULL: a real value over a NULL
    // still writes through.
    let filled = null;
    try {
      await pb
        .collection("optional_cols")
        .update(nullRecord.id, { logo_key: "now-set" }, { requestKey: null });
      filled = true;
    } catch (e) {
      filled = e;
    }
    ok(filled === true, "setting a real value over a NULL through the UI works", String(filled));
    ok(
      (await one("SELECT logo_key FROM optional_cols WHERE id = ?", [nullRecord.id])) === "now-set",
      "and it is what SQL reads back"
    );

    // SQL can still put the NULL back, which is what the resources themselves
    // do: oxmysql callers pass nil and expect NULL, not "".
    await run("UPDATE optional_cols SET logo_key = NULL WHERE id = ?", [nullRecord.id]);
    ok(
      (await one("SELECT COUNT(*) FROM optional_cols WHERE logo_key IS NULL")) === 1,
      "SQL can set a NULL back after adoption"
    );

    section("Adopting");

    const summary = await pbAdopt.adopt(deps(), entries);
    ok(
      summary.adopted.includes("notes") && summary.adopted.includes("owners"),
      "both adopted",
      JSON.stringify(summary)
    );
    ok(!summary.failed.length, "nothing failed", JSON.stringify(summary.failed));

    const cols = (await pb.collections.getFullList({ requestKey: null })).filter(
      (c) => c.name === "notes" || c.name === "owners"
    );
    ok(cols.length === 2, "they exist as collections");
    ok(
      cols.every((c) => c.type === "base"),
      "as base collections, which is what makes them editable",
      JSON.stringify(cols.map((c) => `${c.name}:${c.type}`))
    );
    ok(!cols.some((c) => c.name.startsWith("v_")), "under their real names, with no prefix");

    section("Nothing was lost");

    ok(
      (await one("SELECT COUNT(*) FROM notes")) === notesBefore,
      "every note survived",
      `${notesBefore} -> ${await one("SELECT COUNT(*) FROM notes")}`
    );
    ok((await one("SELECT COUNT(*) FROM owners")) === ownersBefore, "every owner survived");
    ok(
      (await one("SELECT body FROM notes WHERE score = ?", [20])) === "second",
      "a text-bound numeric lookup still finds its row"
    );
    ok(
      typeof (await one("SELECT score FROM notes WHERE body = ?", ["second"])) === "number",
      "a numeric column is still numeric after the copy"
    );

    section("Ids still look like ids");

    const ids = await rows("SELECT id FROM notes ORDER BY CAST(id AS INTEGER)");
    ok(
      ids.every((r) => /^\d+$/.test(String(r.id))),
      "existing ids stayed numeric",
      JSON.stringify(ids.map((r) => r.id))
    );

    const newId = await adapter.handle("insert", [
      "INSERT INTO notes (owner, body, score) VALUES (?, ?, ?)",
      ["555", "fourth", 40],
    ]);
    const afterIds = await rows("SELECT id FROM notes ORDER BY CAST(id AS INTEGER)");
    ok(
      afterIds.every((r) => /^\d+$/.test(String(r.id))),
      "a new row gets a numeric id, not PocketBase's random one",
      JSON.stringify(afterIds.map((r) => r.id))
    );
    ok(
      afterIds.length === ids.length + 1,
      "and it is actually there",
      `${ids.length} -> ${afterIds.length}`
    );
    ok(
      newId !== null && newId !== undefined,
      "insert still returns something",
      JSON.stringify(newId)
    );

    // Paging by id is the thing a random text id would have broken.
    const paged = await rows(
      "SELECT body FROM notes WHERE CAST(id AS INTEGER) > ? ORDER BY CAST(id AS INTEGER) LIMIT 2",
      [1]
    );
    ok(paged.length === 2, "paging by id still works", JSON.stringify(paged));

    section("The cascade still cascades");

    const before = await one("SELECT COUNT(*) FROM notes WHERE owner = ?", ["555"]);
    ok(before > 0, "owner 555 has notes to lose", String(before));

    await run("DELETE FROM owners WHERE phone = ?", ["555"]);
    ok(
      (await one("SELECT COUNT(*) FROM notes WHERE owner = ?", ["555"])) === 0,
      "deleting the owner removed its notes, as ON DELETE CASCADE did"
    );
    ok(
      (await one("SELECT COUNT(*) FROM notes WHERE owner = ?", ["666"])) === 1,
      "and left another owner's notes alone"
    );

    section("Editable through the admin UI's own API");

    const list = await pb.collection("notes").getList(1, 10, { requestKey: null });
    ok(list.totalItems > 0, "the records API lists rows", String(list.totalItems));

    const target = list.items[0];
    const updated = await pb
      .collection("notes")
      .update(target.id, { body: "edited in the UI" }, { requestKey: null });
    ok(updated.body === "edited in the UI", "a row can be edited");
    ok(
      (await one("SELECT body FROM notes WHERE id = ?", [String(target.id)])) ===
        "edited in the UI",
      "and raw SQL sees the edit, so there is one copy of the data"
    );

    const madeInUi = await pb
      .collection("notes")
      .create({ owner: "666", body: "created in the UI", score: 50 }, { requestKey: null });
    ok(
      (await one("SELECT body FROM notes WHERE id = ?", [String(madeInUi.id)])) ===
        "created in the UI",
      "a row created in the UI is visible to SQL"
    );

    await pb.collection("notes").delete(madeInUi.id, { requestKey: null });
    ok(
      (await one("SELECT COUNT(*) FROM notes WHERE id = ?", [String(madeInUi.id)])) === 0,
      "and deleting it in the UI removes it"
    );

    section("A dropped table does not leave a dead collection");

    // Raw SQL can drop a table PocketBase owns, and the _collections row then
    // outlives it: the admin UI lists a collection that errors on open, forever.
    await run(
      "CREATE TABLE IF NOT EXISTS scratch (id INT UNSIGNED NOT NULL AUTO_INCREMENT, v VARCHAR(10) NOT NULL, PRIMARY KEY (id))"
    );
    await pbAdopt.adopt(deps(), await pbAdopt.plan(deps()));
    ok(
      (await pb.collections.getFullList({ requestKey: null })).some((c) => c.name === "scratch"),
      "the scratch table became a collection"
    );

    await run("DROP TABLE scratch");
    const orphaned = (await pb.collections.getFullList({ requestKey: null })).some(
      (c) => c.name === "scratch"
    );
    ok(orphaned, "dropping it through SQL leaves the collection behind");

    const pruned = await pbAdopt.prune(deps());
    ok(pruned.includes("scratch"), "prune removes it", JSON.stringify(pruned));
    ok(
      !(await pb.collections.getFullList({ requestKey: null })).some((c) => c.name === "scratch"),
      "and it is gone from the admin UI"
    );

    const survivors = await pb.collections.getFullList({ requestKey: null });
    ok(
      survivors.some((c) => c.name === "users") && survivors.some((c) => c.name === "_superusers"),
      "PocketBase's own collections are never pruned",
      JSON.stringify(survivors.filter((c) => c.system || c.name.startsWith("_")).map((c) => c.name))
    );
    ok(
      survivors.some((c) => c.name === "notes"),
      "and a live table's collection survives"
    );

    section("Superseded v_ view collections are cleaned up");

    // A database carried over from the read-only era has a `v_<table>` view
    // collection beside every table. Those are not orphans - the view exists -
    // so prune() leaves them, but they are duplicates once the table itself is
    // an editable collection, and an operator cannot tell which is which.
    await run(
      "CREATE TABLE IF NOT EXISTS legacy_tbl (id INT UNSIGNED NOT NULL AUTO_INCREMENT, v VARCHAR(10) NOT NULL, PRIMARY KEY (id))"
    );
    await pb.collections.create({
      name: "v_legacy_tbl",
      type: "view",
      viewQuery: 'SELECT CAST("id" AS TEXT) AS id, "v" FROM "legacy_tbl"',
    });
    ok(
      (await pb.collections.getFullList({ requestKey: null })).some(
        (c) => c.name === "v_legacy_tbl"
      ),
      "a legacy view collection exists to start with"
    );

    // prune() must NOT take it: its backing view is real.
    const prunedLegacy = await pbAdopt.prune(deps());
    ok(
      !prunedLegacy.includes("v_legacy_tbl"),
      "prune leaves it alone, because it is not an orphan",
      JSON.stringify(prunedLegacy)
    );

    const legacySummary = await pbAdopt.adopt(deps(), await pbAdopt.plan(deps()));
    ok(
      legacySummary.legacyViews.includes("v_legacy_tbl"),
      "adoption removes it, ahead of rebuilding the table it shadowed",
      JSON.stringify(legacySummary.legacyViews)
    );

    const afterLegacy = await pb.collections.getFullList({ requestKey: null });
    ok(
      afterLegacy.some((c) => c.name === "legacy_tbl" && c.type === "base"),
      "the real table is there as an editable base collection"
    );
    ok(
      !afterLegacy.some((c) => c.name === "v_legacy_tbl"),
      "and the duplicate is gone",
      JSON.stringify(afterLegacy.filter((c) => c.name.startsWith("v_")).map((c) => c.name))
    );

    // A view whose table is NOT present must survive: it may be the only way
    // anyone can still see that data.
    await run("CREATE TABLE IF NOT EXISTS keepme (id INTEGER PRIMARY KEY, v VARCHAR(10))");
    await pb.collections.create({
      name: "v_orphan_view",
      type: "view",
      viewQuery: 'SELECT CAST("id" AS TEXT) AS id FROM "keepme"',
    });
    const keptSummary = await pbAdopt.pruneLegacyViews(deps());
    ok(
      !keptSummary.includes("v_orphan_view"),
      "a v_ view with no matching table is left alone",
      JSON.stringify(keptSummary)
    );

    section("Idempotence");

    const second = await pbAdopt.plan(deps());
    ok(
      !second.some((e) => e.table === "notes" || e.table === "owners"),
      "an adopted table is not planned again",
      JSON.stringify(second.map((e) => e.table))
    );

    const registry = await rows(
      `SELECT table_name, id_strategy FROM ${pbAdopt.REGISTRY} ORDER BY table_name`
    );
    ok(
      registry.some((r) => r.table_name === "notes") &&
        registry.some((r) => r.table_name === "owners"),
      "the adopted tables are recorded",
      JSON.stringify(registry)
    );
    ok(
      !registry.some((r) => r.table_name === "scratch"),
      "and a pruned table's row is cleaned up with it",
      JSON.stringify(registry)
    );
    ok(
      registry.find((r) => r.table_name === "notes").id_strategy === "numeric",
      "with the id strategy, so the runtime knows"
    );

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
