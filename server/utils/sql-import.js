// Importing the .sql dumps other FiveM resources expect you to load into MySQL
// by hand. Drop the file in `sql/`, restart, and the schema is there.
//
// A file is applied once ever, tracked in a ledger table keyed by filename with
// the SHA-256 alongside, because replaying a dump duplicates every row its
// INSERTs carry. It lands whole or not at all, in one transaction (above
// MAX_STATEMENTS_PER_BATCH it is chunked and atomicity is per chunk, which the
// importer says out loud). A file that changed after it was applied is reported
// rather than re-run, and a failure names the file, line and statement while the
// resource still starts.
//
// Splitting is where this gets dangerous: `text.split(";")` shreds any INSERT
// whose data contains a semicolon, which for a FiveM dump means the first item
// description with a sentence in it. The scanner tracks string literals
// (backslash and doubled-quote escaping), backtick identifiers, `--`/`#`/block
// comments, MySQL /*!40101 ... */ conditionals, and DELIMITER blocks.
module.exports = (function () {
  const crypto = require("crypto");
  const fs = require("fs");
  const path = require("path");
  const tableRebuild = require("./table-rebuild.js");
  const conditionalDdl = require("./conditional-ddl.js");

  const LEDGER_TABLE = "tdb_sql_imports";

  // Beyond this, one transaction per file stops being reasonable to hold open.
  const MAX_STATEMENTS_PER_BATCH = 500;

  // Truncate what goes in the ledger's error column, and in the console.
  const MAX_ERROR_LENGTH = 400;
  const MAX_SNIPPET_LENGTH = 160;

  // Returns the index just past the closing quote. MySQL escapes a quote by
  // doubling it or, for ' and ", with a backslash; backticks only double.
  function consumeQuoted(text, start, quote) {
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && quote !== "`") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (text[i + 1] === quote) {
          i += 2; // an escaped quote, not the end
          continue;
        }
        return i + 1;
      }
      i++;
    }
    return text.length; // unterminated; let the translator complain about it
  }

  function countNewlines(text, from, to) {
    let count = 0;
    for (let i = from; i < to; i++) if (text[i] === "\n") count++;
    return count;
  }

  // Returns {sql, line}, the 1-based line each statement started on, so a
  // failure can point at somewhere in the file.
  function splitStatements(text) {
    const statements = [];
    let buffer = "";
    let line = 1;
    let startLine = 1;
    let delimiter = ";";
    let i = 0;

    const flush = () => {
      const sql = buffer.trim();
      if (sql) statements.push({ sql, line: startLine });
      buffer = "";
      startLine = line;
    };

    while (i < text.length) {
      const ch = text[i];
      const pair = text.substr(i, 2);

      // Includes MySQL's /*!40101 ... */ conditionals, which only ever carry
      // session settings, so dropping them is correct here.
      if (pair === "/*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? text.length : end + 2;
        line += countNewlines(text, i, stop);
        buffer += " ";
        i = stop;
        continue;
      }

      // MySQL requires whitespace after `--`, which is what keeps this from
      // eating the operator in `a--b`.
      const isDashComment = pair === "--" && (i + 2 >= text.length || /\s/.test(text[i + 2]));
      if (isDashComment || ch === "#") {
        const end = text.indexOf("\n", i);
        buffer += " ";
        i = end === -1 ? text.length : end; // leave the newline to be counted
        continue;
      }

      // DELIMITER only means anything at the start of a line.
      if ((i === 0 || text[i - 1] === "\n") && /^delimiter[ \t]+/i.test(text.substr(i, 10))) {
        const end = text.indexOf("\n", i);
        const stop = end === -1 ? text.length : end;
        const value = text
          .slice(i, stop)
          .replace(/^delimiter[ \t]+/i, "")
          .trim();
        if (value) {
          flush();
          delimiter = value;
        }
        i = stop;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === "`") {
        const stop = consumeQuoted(text, i, ch);
        line += countNewlines(text, i, stop);
        buffer += text.slice(i, stop);
        i = stop;
        continue;
      }

      if (text.startsWith(delimiter, i)) {
        flush();
        i += delimiter.length;
        continue;
      }

      if (ch === "\n") {
        line++;
        buffer += ch;
        if (!buffer.trim()) startLine = line;
        i++;
        continue;
      }

      buffer += ch;
      i++;
    }

    flush();
    return statements;
  }

  // Session setup mysqldump emits. Meaningless here, and passing it to the
  // translator would fail an otherwise importable file. Transaction control is
  // on the list on purpose: the importer runs the file in a transaction of its
  // own and a nested BEGIN/COMMIT would fight it.
  const SESSION_NOISE = [
    /^SET\s/i,
    /^LOCK\s+TABLES\b/i,
    /^UNLOCK\s+TABLES\b/i,
    /^START\s+TRANSACTION\b/i,
    /^BEGIN\b/i,
    /^COMMIT\b/i,
    /^ROLLBACK\b/i,
    /^USE\s/i,
    /^CREATE\s+DATABASE\b/i,
    /^CREATE\s+SCHEMA\b/i,
    /^DROP\s+DATABASE\b/i,
    /^DROP\s+SCHEMA\b/i,
    /^ALTER\s+TABLE\s+.+\s(?:DISABLE|ENABLE)\s+KEYS\b/i,
    /^FLUSH\b/i,
  ];

  function isSessionNoise(sql) {
    const trimmed = String(sql).trim();

    // `SET @var` is NOT noise: it is half of MySQL's conditional-DDL idiom,
    // where the variable holds a SQL string that PREPARE/EXECUTE then runs.
    // The blanket /^SET\s/i below would swallow it before the interpreter
    // could ever see it, which is why the whole idiom looked unsupported.
    //
    // Except when the value reads a SYSTEM variable. mysqldump opens with
    // `SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT` to save session
    // state and restores it at the end; those really are noise, and nothing
    // ever consumes them as SQL. The `@@` is what separates the two.
    if (/^SET\s+@[A-Za-z_]/i.test(trimmed) && !/@@/.test(trimmed)) return false;

    return SESSION_NOISE.some((pattern) => pattern.test(trimmed));
  }

  /**
   * Turn an ALTER that needs a table rebuild into the statements that do it.
   *
   * SQLite's ALTER TABLE cannot retype a column, change a default, add or
   * remove NOT NULL, or add a constraint, so MODIFY/CHANGE were refused by
   * name. The documented answer is to rebuild the table, which needs the LIVE
   * schema - so the translator hands over a descriptor and this reads the
   * schema and asks table-rebuild.js to plan it.
   *
   * `tableSql` is read as well as the pragma because the pragma cannot describe
   * a table well enough to rebuild it: measured, it reports none of
   * AUTOINCREMENT, UNIQUE, CHECK, a foreign key or COLLATE. Rebuilding from the
   * pragma alone would drop all of them silently.
   *
   * Every trigger in the schema is passed, not just this table's: the final
   * RENAME reparses the whole schema, so a trigger on an unrelated table that
   * mentions this one breaks it.
   */
  async function planTableRebuild(adapter, rebuild) {
    const rows = (sql, params) => adapter.handle("query", [sql, params || []]);
    const table = rebuild.table;

    const columns = await rows(
      // Backticked, never double-quoted: `notnull` is a reserved word and the
      // MySQL front end reads "notnull" as the string literal.
      "SELECT name, type, `notnull`, dflt_value, pk FROM pragma_table_info(?)",
      [table]
    );

    if (!columns.length) {
      const error = new Error(
        `Cannot rebuild ${table}: it does not exist yet. An ALTER that retypes ` +
          "a column has to run after the CREATE TABLE that makes it."
      );
      error.construct = "ALTER TABLE before CREATE TABLE";
      throw error;
    }

    const created = await rows("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?", [
      "table",
      table,
    ]);
    const indexes = await rows(
      "SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL",
      ["index", table]
    );
    const triggers = await rows(
      "SELECT name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL",
      ["trigger"]
    );

    return tableRebuild.planRebuild({
      table,
      actions: rebuild.actions,
      columns,
      indexes,
      triggers,
      tableSql: created.length ? created[0].sql : null,
    });
  }

  /**
   * A session variable's value as a SQL literal.
   *
   * Substituted as a literal rather than bound, because the statement's own
   * placeholders are already paired with it by position and inserting a
   * parameter would shift every one of them.
   */
  function quoteSqlLiteral(value) {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "boolean") return value ? "1" : "0";
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function isCreateTrigger(sql) {
    return /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\b/i.test(sql);
  }

  function triggerName(sql) {
    const m =
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_$.]+)[`"]?/i.exec(
        sql
      );
    return m ? m[1] : "(unnamed)";
  }

  // "partial" means every statement but some trigger(s) applied. It gates
  // re-running exactly like "applied": the INSERTs already landed.
  const APPLIED_STATUSES = new Set(["applied", "partial"]);

  // Relative to this file: a required module resolves from its own directory.
  const triggerRewrite = require("./trigger-rewrite.js");

  const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename VARCHAR(255) NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    statements INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'applied',
    error TEXT,
    applied_at VARCHAR(32) NOT NULL,
    duration_ms INT NOT NULL DEFAULT 0,
    PRIMARY KEY (filename)
  )`;

  async function ensureLedger(adapter) {
    await adapter.execute(LEDGER_DDL);
  }

  async function readLedger(adapter) {
    const rows = await adapter.select(
      `SELECT filename, checksum, statements, status, error, applied_at, duration_ms
       FROM ${LEDGER_TABLE}`
    );
    const byFilename = new Map();
    for (const row of rows || []) byFilename.set(row.filename, row);
    return byFilename;
  }

  // Two statements rather than an upsert, so this does not depend on ON
  // DUPLICATE KEY translation. Returned, not executed, so the caller can put it
  // in the same transaction as the file.
  function ledgerStatements(record) {
    return [
      {
        sql: `DELETE FROM ${LEDGER_TABLE} WHERE filename = ?`,
        params: [record.filename],
      },
      {
        sql: `INSERT INTO ${LEDGER_TABLE}
              (filename, checksum, statements, status, error, applied_at, duration_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          record.filename,
          record.checksum,
          record.statements,
          record.status,
          record.error || null,
          record.applied_at,
          record.duration_ms,
        ],
      },
    ];
  }

  async function writeLedger(adapter, record) {
    const statements = [];
    for (const entry of ledgerStatements(record)) {
      const translated = await adapter.translate(entry.sql, entry.params);
      statements.push({ sql: translated.sql, params: translated.params });
    }
    await adapter.send("/api/tdb/batch", { statements, transaction: true });
  }

  function checksum(text) {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  function snippet(sql) {
    const compact = String(sql).replace(/\s+/g, " ").trim();
    return compact.length > MAX_SNIPPET_LENGTH
      ? `${compact.slice(0, MAX_SNIPPET_LENGTH)}...`
      : compact;
  }

  function trimError(message) {
    const text = String(message || "unknown error");
    return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}...` : text;
  }

  // The batch route reports the failing statement as a 1-based index; map it
  // back to a line in the file.
  function locate(message, origins) {
    const match = /statement\s+(\d+)\b/i.exec(String(message || ""));
    if (!match) return null;
    return origins[Number(match[1]) - 1] || null;
  }

  // Resolves to a ledger-shaped record, status "applied" or "failed".
  async function importFile(adapter, filePath, logger) {
    const filename = path.basename(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    const startedAt = Date.now();

    const parsed = splitStatements(text);
    const executable = parsed.filter((entry) => !isSessionNoise(entry.sql));
    const skippedNoise = parsed.length - executable.length;

    const record = {
      filename,
      checksum: checksum(text),
      statements: executable.length,
      status: "applied",
      error: null,
      applied_at: new Date().toISOString(),
      duration_ms: 0,
    };

    if (!executable.length) {
      logger.warn(`${filename}: no statements to run - recording it as applied`);
      record.duration_ms = Date.now() - startedAt;
      await writeLedger(adapter, record);
      return record;
    }

    // Translate first, so a construct with no faithful SQLite form is caught
    // before anything is sent.
    const skipped = [];
    const rewrites = [];
    const statements = [];
    const origins = []; // parallel to `statements`, for locating a failure

    // Which session variables this file sets, known before the loop because a
    // statement that READS one has to be held back until the interpreter has
    // evaluated it - and that happens during execution, not here.
    //
    // Scoped to names the FILE sets on purpose. `@name` in an ordinary query is
    // a named PLACEHOLDER the caller binds, which is what 8 of the 9 corpus
    // statements mentioning an `@` actually are; treating those as variables
    // would replace a caller's parameter with a literal.
    const fileVariables = new Set();
    for (const entry of executable) {
      const declared = /^\s*SET\s+@([A-Za-z_][A-Za-z0-9_]*)/i.exec(entry.sql);
      if (declared) fileVariables.add(declared[1].toLowerCase());
    }

    const readsFileVariable = (sql) => {
      if (!fileVariables.size) return false;
      for (const match of String(sql).matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (fileVariables.has(match[1].toLowerCase())) return true;
      }
      return false;
    };

    for (const entry of executable) {
      let translated;

      // MySQL's conditional-DDL dance: SET @v := (SELECT IF(<cond>, '<ddl>',
      // 'SELECT 1')) + PREPARE/EXECUTE, or a procedure holding
      // IF NOT EXISTS (<cond>) THEN <ddl> END IF, called once and dropped.
      // Resources use it only because MySQL has no
      // `ALTER TABLE ... ADD INDEX IF NOT EXISTS`.
      //
      // Held as a marker, not translated: every condition is a real SELECT over
      // information_schema, and the interpreter EVALUATES it against the live
      // database rather than guessing what it means - which it can only do once
      // the statements before it have run.
      if (conditionalDdl.claims(entry.sql)) {
        statements.push({ conditional: entry.sql });
        origins.push(entry);
        continue;
      }

      // Reads a variable this file set, so its text is not final yet.
      if (readsFileVariable(entry.sql)) {
        statements.push({ deferred: entry.sql, params: entry.params });
        origins.push(entry);
        continue;
      }

      // Awaited separately, then translated synchronously: a trigger we are
      // about to skip must not produce a rejected promise, because FiveM
      // reports one even when it is caught, and six expected skips printed six
      // stack traces for an outcome this loop handles.
      await adapter.prepareSchema(entry.sql);

      try {
        translated = adapter.translateSync(entry.sql, entry.params);
      } catch (error) {
        // A trigger is the one statement whose loss is recoverable: the tables
        // and every row still arrive, and only derived values it maintained go
        // stale. Failing the file over one would import nothing at all, so it
        // is skipped with a warning. Anything else still fails the whole file.
        if (isCreateTrigger(entry.sql)) {
          const name = triggerName(entry.sql);

          // Three MySQL trigger shapes are expressible in SQLite, just not in
          // the same words. Tried only after the ordinary path has failed, so
          // the triggers that already translate are untouched.
          const rewritten = triggerRewrite.rewrite(
            entry.sql,
            (piece) => adapter.translateSync(piece, {}).sql
          );

          if (rewritten.handled) {
            for (const statement of rewritten.statements) {
              statements.push({ sql: statement });
              origins.push(entry);
            }
            rewrites.push(`${name} (${rewritten.shapes.join(" + ")})`);
            logger.debug(
              `${filename}: trigger ${name} rewritten for SQLite ` +
                `(${rewritten.shapes.join(" + ")})` +
                (rewritten.statements.length > 1
                  ? `, as ${rewritten.statements.length} triggers`
                  : "")
            );
            continue;
          }

          skipped.push(`${name} (${error.construct || "untranslatable"})`);
          // Any line number in the message is relative to the trigger body,
          // not the file, so say which trigger before quoting it.
          logger.warn(
            `${filename}: trigger ${name} (file line ${entry.line}) was ` +
              `SKIPPED - ${error.message} Line numbers below are within the ` +
              `trigger body. Values it maintained will not update by themselves.`
          );
          continue;
        }

        record.status = "failed";
        record.error = trimError(`line ${entry.line}: ${error.message} - ${snippet(entry.sql)}`);
        record.duration_ms = Date.now() - startedAt;
        logger.error(`${filename}: ${record.error}`);
        await writeLedger(adapter, record);
        return record;
      }

      // An ALTER that needs the table rebuilt. `translated.sql` is the
      // UNTRANSLATED original here and must never be executed.
      //
      // Only a MARKER is recorded, because a rebuild has to be planned from the
      // LIVE schema and this loop runs before anything has been sent - the
      // table it rebuilds usually does not exist yet, being created by a
      // CREATE TABLE earlier in the same file. The execution phase plans it
      // when it reaches this point in the order.
      if (translated.rebuild) {
        statements.push({ rebuild: translated.rebuild });
        origins.push(entry);
        rewrites.push(`${translated.rebuild.table} (table rebuild)`);
        continue;
      }

      // Then anything it spun off: an inline KEY becomes a CREATE INDEX, which
      // needs the table to exist first.
      statements.push({ sql: translated.sql, params: translated.params });
      origins.push(entry);
      for (const extra of translated.extraStatements) {
        statements.push({ sql: extra });
        origins.push(entry);
      }
    }

    const chunked = statements.length > MAX_STATEMENTS_PER_BATCH;
    // Set before the batch runs: on a single-batch file the ledger row travels
    // inside the same transaction, so it has to already say "partial".
    if (skipped.length) {
      record.statements = executable.length - skipped.length;
      record.status = "partial";
      record.error = trimError(`${skipped.length} trigger(s) skipped: ${skipped.join("; ")}`);
    }

    if (chunked) {
      logger.warn(
        `${filename}: ${statements.length} statements - applying in chunks of ` +
          `${MAX_STATEMENTS_PER_BATCH}, so a failure can leave earlier chunks applied`
      );
    }

    // A rebuild marker splits the file, because the statements before it have to
    // be in the database before its schema can be read. Atomicity is then per
    // segment rather than per file, the same trade the chunked path makes.
    const segments = [[]];
    const breaksAt = [];
    for (const statement of statements) {
      if (statement.rebuild || statement.conditional || statement.deferred) {
        breaksAt.push(statement);
        segments.push([]);
        continue;
      }
      segments[segments.length - 1].push(statement);
    }

    if (breaksAt.length) {
      const why = breaksAt.some((b) => b.rebuild) ? "a table rebuild or " : "";
      logger.warn(
        `${filename}: ${breaksAt.length} statement(s) need ${why}the live schema, ` +
          "so the file is applied in segments and a failure can leave earlier ones applied"
      );
    }

    // One interpreter per file, as MySQL scopes a session variable per
    // connection and these files always set, use and drop within themselves.
    const ddlSession = conditionalDdl.createSession();

    // What the interpreter runs its evaluations and its chosen DDL through.
    // `exec` has to repeat the rebuild handover, because a chosen branch is
    // often `ALTER TABLE ... MODIFY COLUMN` - which translate() answers with a
    // descriptor, not SQL.
    const ddlDeps = {
      scalar: async (sql) => {
        const rows = await adapter.handle("query", [sql, []]);
        if (!rows || !rows.length) return null;
        const first = rows[0];
        const keys = Object.keys(first);
        return keys.length ? first[keys[0]] : null;
      },
      exec: async (sql) => {
        await adapter.prepareSchema(sql);
        const t = adapter.translateSync(sql, {});
        if (t.rebuild) {
          const planned = await planTableRebuild(adapter, t.rebuild);
          if (planned.length) {
            await adapter.send("/api/tdb/batch", {
              statements: planned.map((one) => ({ sql: one })),
              transaction: false,
            });
          }
          return;
        }
        await adapter.send("/api/tdb/batch", {
          statements: [{ sql: t.sql, params: t.params }].concat(
            (t.extraStatements || []).map((extra) => ({ sql: extra }))
          ),
          transaction: true,
        });
      },
    };

    try {
      for (let seg = 0; seg < segments.length; seg++) {
        const segment = segments[seg];
        const isFinalSegment = seg === segments.length - 1;

        for (let offset = 0; offset < segment.length; offset += MAX_STATEMENTS_PER_BATCH) {
          const chunk = segment.slice(offset, offset + MAX_STATEMENTS_PER_BATCH);
          const isLast = isFinalSegment && offset + MAX_STATEMENTS_PER_BATCH >= segment.length;

          record.duration_ms = Date.now() - startedAt;

          // On a single-batch file the ledger row rides in the same transaction,
          // so the record and the schema cannot disagree.
          const payload = isLast
            ? chunk.concat(
                await Promise.all(
                  ledgerStatements(record).map(async (entry) => {
                    const t = await adapter.translate(entry.sql, entry.params);
                    return { sql: t.sql, params: t.params };
                  })
                )
              )
            : chunk;

          if (payload.length) {
            await adapter.send("/api/tdb/batch", {
              statements: payload,
              transaction: true,
            });
          }
        }

        // The marker that ended this segment, now that everything before it is
        // in the database.
        const marker = breaksAt[seg];
        if (!marker) continue;

        if (marker.conditional) {
          const outcome = await ddlSession.feed(marker.conditional, ddlDeps);
          if (outcome.ran.length) {
            rewrites.push(`conditional DDL (${outcome.ran.length} statement(s))`);
            logger.debug(
              `${filename}: conditional DDL ran ${outcome.ran.length} statement(s)` +
                (outcome.note ? ` - ${outcome.note}` : "")
            );
          }
          continue;
        }

        if (marker.deferred) {
          // Substituted here because the value only exists once the SET has
          // been evaluated. MySQL does this for free; without it the `@name`
          // reached the translator as a named placeholder and bound NULL -
          // silently storing NULL over esx's job skins.
          const values = ddlSession.variables();
          const resolved = marker.deferred.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => {
            const key = name.toLowerCase();
            if (!Object.prototype.hasOwnProperty.call(values, key)) return whole;
            return quoteSqlLiteral(values[key]);
          });
          await ddlDeps.exec(resolved);
          continue;
        }

        const rebuild = marker.rebuild;
        if (!rebuild) continue;

        const planned = await planTableRebuild(adapter, rebuild);
        if (planned.length) {
          await adapter.send("/api/tdb/batch", {
            statements: planned.map((sql) => ({ sql })),
            // NOT transactional: the plan opens with `PRAGMA foreign_keys=off`
            // and closes by turning it back on, and PRAGMA foreign_keys is
            // silently ignored inside a transaction - so wrapping it would
            // leave foreign keys enforced, fail the DROP, and roll the whole
            // rebuild back. Measured; see table-rebuild.js's header.
            transaction: false,
          });
        }

        logger.debug(
          `${filename}: ${rebuild.table} rebuilt for ${rebuild.actions.length} ` +
            `ALTER action(s), ${planned.length} statement(s)`
        );
      }

      // An empty final segment means the file ended on a rebuild, so the ledger
      // row has not been written inside a batch yet.
      if (!segments[segments.length - 1].length) {
        await writeLedger(adapter, record);
      }
    } catch (error) {
      const origin = locate(error.message, origins);
      record.status = "failed";
      record.error = trimError(
        origin ? `line ${origin.line}: ${error.message} - ${snippet(origin.sql)}` : error.message
      );
      record.duration_ms = Date.now() - startedAt;
      logger.error(`${filename}: ${record.error}`);
      await writeLedger(adapter, record);
      return record;
    }

    adapter.invalidateCache();
    record.duration_ms = Date.now() - startedAt;

    const noise = skippedNoise ? `, ${skippedNoise} session statement(s) skipped` : "";
    const triggers =
      (rewrites.length ? `, ${rewrites.length} trigger(s) rewritten` : "") +
      (skipped.length ? `, ${skipped.length} trigger(s) skipped` : "");
    logger.info(
      `${filename}: applied ${executable.length - skipped.length} statement(s) ` +
        `in ${record.duration_ms}ms${noise}${triggers}`
    );
    return record;
  }

  // Applies every pending file in `dir` in filename order. Never throws: a
  // failing file is recorded and the next is still attempted, so one bad dump
  // does not hide the rest. options: onChanged "warn" | "apply" | "error",
  // only (filenames), force (re-apply even if the ledger says applied).
  async function run(adapter, dir, logger, options = {}) {
    const summary = { applied: [], partial: [], failed: [], skipped: [], changed: [] };

    if (!fs.existsSync(dir)) return summary;

    let files = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".sql"))
      .sort();

    if (options.only) {
      const wanted = new Set(options.only);
      files = files.filter((name) => wanted.has(name));
    }

    if (!files.length) return summary;

    await adapter.ready();
    await ensureLedger(adapter);
    const ledger = await readLedger(adapter);

    for (const filename of files) {
      const previous = ledger.get(filename);
      const filePath = path.join(dir, filename);

      if (previous && APPLIED_STATUSES.has(previous.status) && !options.force) {
        const current = checksum(fs.readFileSync(filePath, "utf8"));

        if (current === previous.checksum) {
          summary.skipped.push(filename);
          continue;
        }

        // Re-running would replay every INSERT the file contains, so that is
        // never the default.
        if (options.onChanged === "apply") {
          logger.warn(`${filename}: changed since it was applied - re-applying as configured`);
        } else {
          summary.changed.push(filename);
          const message =
            `${filename}: changed since it was applied and was NOT re-run. ` +
            `Re-applying a dump replays its INSERTs. To run it anyway: ` +
            `tdb sql import ${filename} --force`;
          if (options.onChanged === "error") logger.error(message);
          else logger.warn(message);
          continue;
        }
      }

      const record = await importFile(adapter, filePath, logger);
      if (record.status === "partial") summary.partial.push(filename);
      else if (record.status === "applied") summary.applied.push(filename);
      else summary.failed.push(filename);
    }

    return summary;
  }

  return {
    splitStatements,
    isSessionNoise,
    checksum,
    ensureLedger,
    readLedger,
    run,
  };
})();
