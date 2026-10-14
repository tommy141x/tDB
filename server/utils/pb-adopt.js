// Hands a raw SQLite table over to PocketBase so it becomes a real, editable
// collection in the admin UI, without a second copy of the schema that could
// drift from it.
//
// Why not simply register the existing table: PocketBase refuses.
//   pb.collections.create({ name: <existing table> })
//     -> validation_collection_name_invalid
//        "The name shouldn't match with an existing internal table."
// Writing the _collections row by hand instead gets "Missing collection
// context." at runtime. And a *view* collection, which can be pointed at an
// existing table, is read-only: PocketBase answers "Unsupported collection
// type." to every write even after INSTEAD OF triggers make the view writable
// in SQLite. All three measured 2026-10-13.
//
// So the table has to be one PocketBase created. The sequence that works, also
// measured, is create a collection under a temporary name, copy the rows into
// it, drop the original, then rename the collection into the freed name.
// PocketBase renames by ALTER TABLE, so the result is a table it owns, carrying
// the original name and data, editable in the UI, with raw SQL and the records
// API reading and writing the same rows.
//
// What it costs, and what is done about it:
//
//   * PocketBase's `id` is always TEXT. `WHERE id = ?` with a bound number
//     would stop matching, because SQLite applies column affinity to literals
//     but not to parameters. That is handled in sql-translator's bindValue,
//     which sends every scalar as text; it is a precondition for this module.
//
//   * An integer id would stop looking like one, so `id > ?` and paging would
//     silently become string comparison. A table whose id was an INTEGER
//     primary key therefore gets a trigger that replaces PocketBase's random
//     default with the next integer, which is transparent to every INSERT
//     shape rather than only the ones a rewrite would recognise.
//
//   * A collection cannot express a FOREIGN KEY, so each one is re-created as a
//     trigger. ON DELETE CASCADE and SET NULL fire for deletes made through the
//     admin UI too, which was verified rather than assumed.
//
// Nothing here touches FiveM. Everything is injected, so it is testable offline.
module.exports = (function () {
  const WORKING_SUFFIX = "__tdb_adopting";
  // The prefix an earlier version of tDB used for its read-only view
  // collections, kept so a database from that version can be tidied up.
  const DEFAULT_VIEW_PREFIX = "v_";
  const REGISTRY = "tdb_adopted";

  const REGISTRY_DDL = `CREATE TABLE IF NOT EXISTS ${REGISTRY} (
    table_name TEXT NOT NULL,
    id_strategy TEXT NOT NULL,
    adopted_at TEXT NOT NULL,
    PRIMARY KEY (table_name)
  )`;

  // Measured: text -> TEXT, number -> NUMERIC, bool -> BOOLEAN, json -> JSON.
  // Dates stay text because PocketBase's date field is strict ISO-8601 and a
  // MySQL datetime is not, so declaring it a date would reject existing rows.
  // BLOB also stays text: PocketBase has no binary field, and SQLite does not
  // apply TEXT affinity to a blob value, so the bytes survive.
  function fieldTypeFor(declared) {
    const type = String(declared || "").toUpperCase();

    if (!type) return "text";
    if (/BOOL/.test(type)) return "bool";
    if (/JSON/.test(type)) return "json";
    if (/INT/.test(type)) return "number";
    if (/REAL|FLOA|DOUB|DEC|NUMERIC/.test(type)) return "number";
    return "text";
  }

  function workingName(table) {
    return `${table}${WORKING_SUFFIX}`;
  }

  function isAdoptable(table) {
    if (typeof table !== "string" || !table) return false;
    if (table.startsWith("_") || table.startsWith("sqlite_")) return false;
    if (table.endsWith(WORKING_SUFFIX)) return false;
    // Our own bookkeeping stays raw, or adopting it would rewrite the table
    // this module reads to decide what to adopt.
    if (table === REGISTRY) return false;
    return true;
  }

  // "numeric" when the original id was an integer primary key and must keep
  // looking like one, "text" when it already was a string, "rowid" when there
  // was no id column at all and PocketBase's own is the only one.
  function idStrategyFor(columns) {
    const id = columns.find((c) => c.name === "id");
    if (!id) return "rowid";
    if (/INT/i.test(String(id.type || "")) && id.pk) return "numeric";
    return "text";
  }

  // Backticks, NOT double quotes.
  //
  // Everything this module runs goes through the oxmysql path, so it is parsed
  // as MySQL before it reaches SQLite -- and MySQL reads "x" as a string
  // literal, not an identifier. `DROP TABLE "notes"` therefore died with
  // 'Expected identifier, got "String"'. The translator turns backticks into
  // SQLite's double quotes itself. Measured 2026-10-13, same trap as ESCAPE.
  function quote(name) {
    return `\`${String(name).replace(/`/g, "``")}\``;
  }

  /**
   * The statements that re-create one foreign key as triggers.
   *
   * A collection has no FOREIGN KEY, so the referential action is what has to
   * survive; the constraint itself cannot. CASCADE and SET NULL are emitted,
   * RESTRICT and NO ACTION are reported instead of approximated, because
   * refusing a write is not something to fake with a trigger.
   */
  function cascadeTriggers(table, fk, index) {
    const name = `${table}_fk${index}`;
    const parent = fk.table;
    const childCol = fk.from;
    const parentCol = fk.to || "id";
    const out = [];

    const onDelete = String(fk.on_delete || "").toUpperCase();
    if (onDelete === "CASCADE") {
      out.push(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${name}_del`)} AFTER DELETE ON ${quote(parent)} ` +
          `FOR EACH ROW BEGIN DELETE FROM ${quote(table)} ` +
          `WHERE ${quote(childCol)} = OLD.${quote(parentCol)}; END`
      );
    } else if (onDelete === "SET NULL") {
      out.push(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${name}_del`)} AFTER DELETE ON ${quote(parent)} ` +
          `FOR EACH ROW BEGIN UPDATE ${quote(table)} SET ${quote(childCol)} = NULL ` +
          `WHERE ${quote(childCol)} = OLD.${quote(parentCol)}; END`
      );
    }

    const onUpdate = String(fk.on_update || "").toUpperCase();
    if (onUpdate === "CASCADE") {
      out.push(
        `CREATE TRIGGER IF NOT EXISTS ${quote(`${name}_upd`)} AFTER UPDATE OF ${quote(parentCol)} ` +
          `ON ${quote(parent)} FOR EACH ROW BEGIN UPDATE ${quote(table)} ` +
          `SET ${quote(childCol)} = NEW.${quote(parentCol)} ` +
          `WHERE ${quote(childCol)} = OLD.${quote(parentCol)}; END`
      );
    }

    return {
      statements: out,
      unsupported: onDelete === "RESTRICT" || onDelete === "NO ACTION" ? onDelete : null,
    };
  }

  // Replaces PocketBase's random id with the next integer, after the row lands.
  // An AFTER INSERT trigger rather than an INSERT rewrite because it is then
  // transparent to every shape: a bare VALUES list, a multi-row VALUES, an
  // INSERT ... SELECT. An explicitly supplied numeric id is left alone.
  function numericIdTrigger(table) {
    return (
      `CREATE TRIGGER IF NOT EXISTS ${quote(`${table}_tdb_numeric_id`)} ` +
      `AFTER INSERT ON ${quote(table)} FOR EACH ROW ` +
      `WHEN NEW.id GLOB 'r[0-9a-f]*' BEGIN ` +
      `UPDATE ${quote(table)} SET id = CAST((SELECT IFNULL(MAX(CAST(id AS INTEGER)), 0) + 1 ` +
      `FROM ${quote(table)} WHERE id GLOB '[0-9]*') AS TEXT) WHERE rowid = NEW.rowid; END`
    );
  }

  /**
   * Order so that a table is adopted BEFORE anything it references.
   *
   * Adopting a parent first leaves every child's FOREIGN KEY pointing at a
   * primary key that no longer exists, and SQLite then rejects writes to that
   * child with "foreign key mismatch". A child rebuilt as a collection has no
   * foreign keys at all, so taking dependents first means that by the time a
   * parent is rebuilt, nothing references it. No pragma needed, which matters
   * because PocketBase pools connections and a per-connection pragma would not
   * reliably apply to the next statement.
   *
   * A cycle cannot be ordered; those tables are returned in their original
   * order and whichever constraint cannot be satisfied is reported.
   */
  function orderByDependency(entries) {
    const byName = new Map(entries.map((e) => [e.table, e]));

    // Reverse edges: parent -> the tables that reference it. Walking forward
    // from a table to its parents is not enough, because plain iteration can
    // still reach a parent first; a dependent has to be emitted before the
    // table it points at, so the walk has to start from the parent and clear
    // its dependents.
    const dependents = new Map();
    for (const entry of entries) {
      for (const fk of entry.foreignKeys) {
        if (!dependents.has(fk.table)) dependents.set(fk.table, new Set());
        dependents.get(fk.table).add(entry.table);
      }
    }

    const ordered = [];
    const state = new Map();

    const visit = (entry) => {
      if (!entry) return;
      const seen = state.get(entry.table);
      // "visiting" means a cycle; stop rather than recursing forever and let
      // whichever constraint cannot be satisfied be reported.
      if (seen) return;
      state.set(entry.table, "visiting");

      for (const child of dependents.get(entry.table) || []) {
        visit(byName.get(child));
      }

      ordered.push(entry);
      state.set(entry.table, "done");
    };

    for (const entry of entries) visit(entry);
    return ordered;
  }

  /**
   * Rebuild the table PocketBase just created so the columns the source had as
   * nullable are nullable again.
   *
   * PocketBase emits every column as `NOT NULL DEFAULT <zero>` and offers no way
   * to ask for anything else - `required: false` produces the same DDL,
   * measured. The table is still empty at this point, so rebuilding it carries
   * no risk to data, and the collection row keeps pointing at the same name.
   *
   * Columns are read back from pragma_table_info rather than parsed out of the
   * DDL text, so whatever PocketBase chose for `id` (a TEXT primary key with a
   * random default) is reproduced exactly instead of being re-invented.
   */
  async function rebuildNullable(deps, working, nullable) {
    const { query } = deps;
    // Raw, NOT translated. The column defaults come straight out of
    // pragma_table_info and are SQLite's own syntax: PocketBase's id default is
    // `'r'||lower(hex(randomblob(7)))`, and the MySQL front end has no `||`
    // concatenation operator, so putting this through the translator fails with
    // "Expected RParen, got DPipe".
    const exec = deps.rawExec || deps.exec;
    if (!nullable.length) return;

    const shape = await query(
      "SELECT name, type, `notnull`, dflt_value, pk FROM pragma_table_info(?)",
      [working]
    );
    if (!shape.length) return;

    const wanted = new Set(nullable.map((n) => String(n).toLowerCase()));

    const defs = shape.map((col) => {
      const relax = wanted.has(String(col.name).toLowerCase()) && Number(col.pk) === 0;
      const parts = [quote(col.name), col.type || "TEXT"];

      if (!relax) {
        if (Number(col.notnull) === 1) parts.push("NOT NULL");
        // The default is dropped for a relaxed column on purpose: it is what
        // turns an omitted value into '' instead of NULL.
        if (col.dflt_value !== null && col.dflt_value !== undefined) {
          // Parenthesised, always. pragma_table_info strips the outer parens
          // off an expression default, and SQLite will not take the expression
          // back without them: PocketBase's id default came back as
          // `'r'||lower(hex(randomblob(7)))` and re-declaring it that way fails
          // with `near "||": syntax error`. Parens are accepted around a plain
          // literal and around CURRENT_TIMESTAMP too, both measured, so there
          // is no case that needs the bare form.
          parts.push(`DEFAULT (${col.dflt_value})`);
        }
      }
      if (Number(col.pk) === 1) parts.push("PRIMARY KEY");
      return parts.join(" ");
    });

    const aside = `${working}__pbshape`;
    await exec(`ALTER TABLE ${quote(working)} RENAME TO ${quote(aside)}`);
    await exec(`CREATE TABLE ${quote(working)} (${defs.join(", ")})`);
    await exec(`DROP TABLE ${quote(aside)}`);
  }

  /**
   * Keep a NULL a NULL when the admin UI writes over it.
   *
   * PocketBase's record model has no NULL, so an edit sends the zero value for
   * every field - including ones the operator never touched - and that '' or 0
   * lands on top of an existing NULL. `WHERE col IS NULL` then stops matching,
   * silently. Measured: editing one field zeroed an unrelated NULL column.
   *
   * The guard fires only when the column WAS NULL and the incoming value is the
   * zero value, so a populated value is never touched and setting a real value
   * over a NULL still works. The one case it decides for the operator is a
   * deliberate NULL -> '' on a text column, which the UI cannot express anyway:
   * it renders both as an empty box, so preserving the NULL is the only choice
   * that does not lose information.
   *
   * No recursion risk: SQLite's recursive_triggers is off by default, so the
   * trigger's own UPDATE does not re-fire it.
   */
  function nullGuardTrigger(table, nullable, columns) {
    if (!nullable.length) return null;

    const typeOf = new Map(columns.map((c) => [c.name, String(c.type || "").toUpperCase()]));
    const zeroFor = (name) => {
      const type = typeOf.get(name) || "";
      if (/INT|REAL|FLOA|DOUB|DEC|NUMERIC|BOOL/.test(type)) return "0";
      return "''";
    };

    const relaxed = nullable.filter((n) => n !== "id");
    if (!relaxed.length) return null;

    const condition = relaxed
      .map((c) => `(OLD.${quote(c)} IS NULL AND NEW.${quote(c)} = ${zeroFor(c)})`)
      .join(" OR ");

    const assignments = relaxed
      .map(
        (c) =>
          `${quote(c)} = CASE WHEN OLD.${quote(c)} IS NULL AND NEW.${quote(c)} = ${zeroFor(c)} ` +
          `THEN NULL ELSE NEW.${quote(c)} END`
      )
      .join(", ");

    return (
      `CREATE TRIGGER IF NOT EXISTS ${quote(`${table}_tdb_null_guard`)} ` +
      `AFTER UPDATE ON ${quote(table)} FOR EACH ROW WHEN ${condition} ` +
      `BEGIN UPDATE ${quote(table)} SET ${assignments} WHERE rowid = NEW.rowid; END`
    );
  }

  /**
   * The message an operator can act on.
   *
   * tDB's own routes answer `{ success: false, error: "<sqlite message>" }` with
   * no `message` key, so PocketBase's client fills in its generic fallback and
   * `error.message` reads "Something went wrong." - which hid the real reason a
   * rebuild failed. The route's own field is checked first.
   */
  function describeError(error) {
    const response = error && error.response;
    if (response && response.error) return response.error;
    if (response && response.message && response.message !== "Something went wrong.") {
      return response.message;
    }
    return (error && error.message) || String(error);
  }

  async function readTable(query, table) {
    // `notnull` is read because it decides whether the table can be adopted
    // at all; it is carried across when the table is rebuilt.
    const columns = await query(
      // Backticked, NOT double-quoted. `notnull` is a reserved word, and the
      // MySQL front end reads "notnull" as the string literal 'notnull' - which
      // made this read the word "notnull" for every column, so nothing ever
      // looked nullable and the check silently did nothing while its tests
      // passed. Same trap as quote() above.
      "SELECT name, type, pk, `notnull` FROM pragma_table_info(?)",
      [table]
    );
    // Backticked for the same reason as quote(): these are reserved words and
    // "table" would be read as a string literal by the MySQL front end.
    const foreignKeys = await query(
      "SELECT `table`, `from`, `to`, on_delete, on_update FROM pragma_foreign_key_list(?)",
      [table]
    );
    const indexes = await query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
      [table]
    );
    return { columns, foreignKeys, indexes };
  }

  /**
   * Remove the read-only `v_<table>` view collections an earlier version of tDB
   * created, now that the table itself is adopted as an editable collection.
   *
   * They are not orphans - the SQLite view still exists, so prune() correctly
   * leaves them alone - but they are redundant duplicates. Left in place, an
   * operator sees both `phone_phones` and `v_phone_phones` in the admin UI, one
   * editable and one not, and no way to tell which is authoritative. On a
   * database carried over from that version that is 152 extra rows.
   *
   * Only removed when the real table exists, so this can never take away the
   * only view of some data.
   */
  async function pruneLegacyViews(deps, prefix = DEFAULT_VIEW_PREFIX) {
    const { query, collections, exec } = deps;
    const logger = deps.logger || console;
    const removed = [];

    let tables = [];
    let existing = [];
    try {
      tables = await query("SELECT name FROM sqlite_master WHERE type = ?", ["table"]);
      existing = await collections.getFullList();
    } catch (error) {
      logger.warn(`Could not look for legacy view collections: ${error.message}`);
      return removed;
    }

    const realTables = new Set(tables.map((t) => t && t.name).filter(Boolean));

    for (const collection of existing) {
      if (collection.system) continue;
      if (collection.type !== "view") continue;
      if (!collection.name || !collection.name.startsWith(prefix)) continue;

      const backing = collection.name.slice(prefix.length);
      // Only if the table it shadowed is really there.
      if (!realTables.has(backing)) continue;

      try {
        await collections.delete(collection.id);
        // PocketBase drops its own SQLite view with the collection; this is a
        // belt-and-braces sweep for one left behind by a hand-edit.
        try {
          await exec(`DROP VIEW IF EXISTS \`${collection.name}\``);
        } catch (_) {
          // Already gone with the collection.
        }
        removed.push(collection.name);
      } catch (error) {
        logger.warn(`Could not remove the legacy view ${collection.name}: ${error.message}`);
      }
    }

    if (removed.length) {
      logger.info(
        `Removed ${removed.length} superseded read-only view collection(s); their tables are now editable`
      );
    }
    return removed;
  }

  /**
   * Delete collections whose backing table or view is gone.
   *
   * A collection row in _collections outlives the table when something drops it
   * through raw SQL, which the oxmysql path does all the time. The admin UI then
   * lists a collection that errors on open, and it stays that way forever: the
   * operator has no way to know the row is the problem. Measured after a
   * resource dropped its 16 tables and left 16 dead collections behind.
   *
   * System collections are never touched, and neither is one whose table exists.
   */
  async function prune(deps) {
    const { query, collections } = deps;
    const logger = deps.logger || console;
    const removed = [];

    let objects = [];
    let existing = [];
    try {
      objects = await query("SELECT name FROM sqlite_master WHERE type IN (?, ?)", [
        "table",
        "view",
      ]);
      existing = await collections.getFullList();
    } catch (error) {
      logger.warn(`Could not look for orphaned collections: ${error.message}`);
      return removed;
    }

    const present = new Set(objects.map((o) => o && o.name).filter(Boolean));

    for (const collection of existing) {
      // PocketBase's own, by its flag and by name: deleting one of these would
      // break the instance rather than tidy it.
      if (collection.system) continue;
      if (!collection.name || collection.name.startsWith("_")) continue;
      if (present.has(collection.name)) continue;

      try {
        await collections.delete(collection.id);
        removed.push(collection.name);
      } catch (error) {
        logger.warn(
          `Could not remove the orphaned collection ${collection.name}: ${error.message}`
        );
      }
    }

    // The registry row is a leftover too: it would claim a table is adopted
    // when neither the table nor its collection exists any more.
    for (const name of removed) {
      try {
        await deps.exec(`DELETE FROM ${quote(REGISTRY)} WHERE table_name = ?`, [name]);
      } catch (_) {
        // The registry may not exist yet on a first run; nothing to clean.
      }
    }

    if (removed.length) {
      logger.info(
        `Removed ${removed.length} collection(s) whose table no longer exists: ${removed.join(", ")}`
      );
    }
    return removed;
  }

  /**
   * What would be adopted, without changing anything. Useful on its own: the
   * command prints this before touching a live database.
   */
  async function plan(deps) {
    const { query, collections } = deps;

    const tables = await query("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name", [
      "table",
    ]);
    const existing = await collections.getFullList();
    const owned = new Set(existing.map((c) => c.name));

    const out = [];
    for (const row of tables) {
      const table = row && row.name;
      if (!isAdoptable(table)) continue;
      // Already a collection: PocketBase owns it, nothing to do.
      if (owned.has(table)) continue;

      const { columns, foreignKeys, indexes } = await readTable(query, table);
      if (!columns.length) continue;

      // PocketBase has no concept of NULL: every column it creates is NOT NULL
      // with a zero-value default, and `required: false` makes no difference.
      // Adoption therefore rebuilds the table it created, carrying the source's
      // own nullability across, and installs a guard trigger so an edit through
      // the admin UI cannot write a zero value over an existing NULL. Both are
      // measured; see rebuildNullable() and nullGuardTrigger().
      const nullable = columns.filter((c) => Number(c.notnull) === 0).map((c) => c.name);

      out.push({
        table,
        columns,
        foreignKeys,
        indexes,
        idStrategy: idStrategyFor(columns),
        nullable,
      });
    }
    return out;
  }

  /**
   * Adopt the tables in `plan`. Idempotent: a table already owned by PocketBase
   * is skipped, and a working table left behind by an interrupted run is
   * cleaned up before retrying.
   *
   * Never throws. A table that fails is reported and the rest are still
   * attempted, because stopping halfway through 164 tables is worse than
   * finishing the ones that work.
   */
  async function adopt(deps, entryList) {
    let entries = entryList;
    const { query, exec, collections } = deps;
    // Sends SQL straight to SQLite with no MySQL translation. Needed to put
    // back triggers read out of sqlite_master.
    const rawExec = deps.rawExec || exec;
    const logger = deps.logger || console;

    const summary = {
      adopted: [],
      failed: [],
      triggers: 0,
      unsupported: [],
      removed: [],
      // Working tables removed after a failed adopt, so a retry is clean.
      cleaned: [],
    };

    // Before adopting: a dead collection would otherwise keep its name
    // reserved, and PocketBase refuses to adopt a table whose name is taken.
    summary.removed = await prune(deps);

    // BEFORE adoption, not after. A `v_<table>` view selects from the table,
    // and adoption rebuilds that table - so the view has to go first or the
    // adoption of its table fails. Safe because the condition is that the real
    // table exists, which means the data stays reachable through it.
    summary.legacyViews = await pruneLegacyViews(deps);

    // Cascade triggers are created only once every table exists; see below.
    const deferredTriggers = [];
    // Same second pass, but sent raw. The null guards use `WHEN` and `rowid`,
    // neither of which the MySQL front end parses: it stops at "Expected
    // EXECUTE or BEGIN in trigger body".
    const deferredRaw = [];

    await exec(REGISTRY_DDL);

    // Every existing trigger comes off first and goes back on at the end.
    // A trigger lives in the schema, not in the table it writes to, so
    // dropping a table leaves triggers on OTHER tables referencing something
    // that no longer exists -- after which any write to those tables fails with
    // "error in trigger ...: no such table". Measured on lb-phone's schema,
    // where the Instagram counter triggers took out nine adoptions.
    let savedTriggers = [];
    try {
      savedTriggers = (
        await query("SELECT name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL", [
          "trigger",
        ])
      ).filter((t) => t.name && !String(t.name).startsWith("sqlite_"));

      for (const trigger of savedTriggers) {
        await exec(`DROP TRIGGER IF EXISTS ${quote(trigger.name)}`);
      }
    } catch (error) {
      logger.warn(`Could not set triggers aside: ${error.message}`);
    }

    entries = orderByDependency(entries);

    for (const entry of entries) {
      const { table, columns, foreignKeys, indexes, idStrategy } = entry;
      const nullable = Array.isArray(entry.nullable) ? entry.nullable : [];
      const working = workingName(table);

      try {
        // An interrupted previous run can leave this behind.
        const before = await collections.getFullList();
        const stale = before.find((c) => c.name === working);
        if (stale) await collections.delete(stale.id);

        const fields = columns
          .filter((c) => c.name !== "id")
          .map((c) => ({ name: c.name, type: fieldTypeFor(c.type) }));

        const created = await collections.create({
          name: working,
          type: "base",
          fields,
        });

        // While the table PocketBase just made is still EMPTY, rebuild it so
        // the source's nullable columns are nullable again. Done here and not
        // later because there is no data to carry at this point, so there is
        // nothing to lose if it fails.
        await rebuildNullable(deps, working, nullable);

        // Copy. The id is cast to text because PocketBase's is TEXT; a table
        // with no id borrows its rowid, which is what gives every row a key.
        const names = columns.map((c) => c.name).filter((n) => n !== "id");
        const idSource = idStrategy === "rowid" ? "rowid" : quote("id");
        const columnList = ["id", ...names].map(quote).join(", ");
        const selectList = [`CAST(${idSource} AS TEXT)`, ...names.map(quote)].join(", ");

        await exec(
          `INSERT INTO ${quote(working)} (${columnList}) SELECT ${selectList} FROM ${quote(table)}`
        );

        // Free the name, then take it.
        await exec(`DROP TABLE ${quote(table)}`);
        await collections.update(created.id, { name: table });

        // Indexes after the rename, so they are declared against the real name.
        if (indexes.length) {
          const declared = indexes
            .map((i) => i.sql)
            .filter(Boolean)
            // PocketBase rejects an index naming a different table.
            .map((s) => s.replace(/\s+/g, " ").trim());
          if (declared.length) {
            try {
              await collections.update(created.id, { indexes: declared });
            } catch (error) {
              summary.unsupported.push(`${table}: indexes (${error.message})`);
            }
          }
        }

        if (idStrategy === "numeric") {
          await exec(numericIdTrigger(table));
          summary.triggers++;
        }

        // Deferred with the cascades, for the same reason: it is created on the
        // real name, and the second pass runs once every table is in place.
        const guard = nullGuardTrigger(table, nullable, columns);
        if (guard) deferredRaw.push({ what: `${table} null guard`, sql: guard });

        // Referential actions are deferred to a second pass. A cascade trigger
        // lives on the PARENT table, and adopting that parent drops it -- which
        // silently removed every cascade whose parent sorted after its child.
        for (let i = 0; i < foreignKeys.length; i++) {
          const { statements, unsupported } = cascadeTriggers(table, foreignKeys[i], i);
          if (unsupported) {
            summary.unsupported.push(`${table}.${foreignKeys[i].from}: ON DELETE ${unsupported}`);
          }
          deferredTriggers.push(...statements);
        }

        await exec(
          `INSERT INTO ${quote(REGISTRY)} (table_name, id_strategy, adopted_at) ` +
            `VALUES (?, ?, ?)`,
          [table, idStrategy, new Date().toISOString()]
        );

        summary.adopted.push(table);
      } catch (error) {
        const why = describeError(error);
        summary.failed.push(`${table}: ${why}`);
        logger.warn(`Could not adopt ${table}: ${why}`);

        // Clean up after ourselves. A failure part-way through leaves the
        // working collection and its table on disk: 27 `<table>__tdb_adopting`
        // tables were found on a live server after a failed run, the count grew
        // on every boot, and a retry could collide with its own leftover. This
        // is the "half importing / leaving files around" class, so the failing
        // path has to tidy up rather than relying on the next run to notice.
        try {
          const after = await collections.getFullList();
          const debris = after.find((c) => c.name === working);
          // Deleting the collection drops the table PocketBase made for it.
          if (debris) await collections.delete(debris.id);
          summary.cleaned.push(working);
        } catch (cleanupError) {
          logger.warn(
            `Could not remove the working table ${working} after a failed adopt ` +
              `(${cleanupError.message}); drop it by hand before retrying`
          );
        }
      }
    }

    // Second pass. Every table is in place now, so a trigger on a parent
    // cannot be dropped by that parent's own adoption.
    // Restored raw: sqlite_master hands back SQLite syntax, with double-quoted
    // identifiers that the MySQL front end reads as string literals. These are
    // already SQLite, so they must not be translated again.
    for (const trigger of savedTriggers) {
      try {
        await rawExec(trigger.sql);
      } catch (error) {
        summary.unsupported.push(`trigger ${trigger.name}: ${error.message}`);
      }
    }

    for (const { what, sql } of deferredRaw) {
      try {
        await rawExec(sql);
        summary.triggers++;
      } catch (error) {
        const why = describeError(error);
        summary.failed.push(`${what}: ${why}`);
        logger.warn(`Could not create the ${what}: ${why}`);
      }
    }

    for (const statement of deferredTriggers) {
      try {
        await exec(statement);
        summary.triggers++;
      } catch (error) {
        summary.failed.push(`trigger: ${error.message}`);
        logger.warn(`Could not re-create a referential action: ${error.message}`);
      }
    }

    return summary;
  }

  function describe(summary) {
    const parts = [];
    if (summary.adopted.length) parts.push(`${summary.adopted.length} adopted`);
    if (summary.legacyViews && summary.legacyViews.length) {
      parts.push(`${summary.legacyViews.length} superseded view(s) removed`);
    }
    if (summary.removed && summary.removed.length) {
      parts.push(`${summary.removed.length} orphan(s) removed`);
    }
    if (summary.triggers) parts.push(`${summary.triggers} trigger(s) re-created`);
    if (summary.unsupported.length) parts.push(`${summary.unsupported.length} not reproducible`);
    if (summary.cleaned && summary.cleaned.length) {
      parts.push(`${summary.cleaned.length} working table(s) cleaned up`);
    }
    if (summary.failed.length) parts.push(`${summary.failed.length} failed`);
    return parts.length ? parts.join(", ") : "nothing to adopt";
  }

  return {
    plan,
    adopt,
    prune,
    pruneLegacyViews,
    describe,
    fieldTypeFor,
    idStrategyFor,
    isAdoptable,
    cascadeTriggers,
    workingName,
    REGISTRY,
  };
})();
