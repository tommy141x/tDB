/**
 * Importing .sql files that ship with other resources.
 *
 * A FiveM script normally arrives with a `.sql` dump you are expected to load
 * into MySQL by hand before it will start. There is no MySQL here, so tDB does
 * that job itself: drop the file in `sql/`, restart, and the schema is there.
 *
 * The rules, in order of how much trouble they save:
 *
 *   1. A file is applied once, ever. Applying a dump twice duplicates every
 *      row its INSERTs carry, so a ledger table records what has run, keyed by
 *      filename, with the file's SHA-256 alongside.
 *   2. A file lands whole or not at all. Every statement goes out in one
 *      transaction, so a dump that fails halfway cannot leave a half-built
 *      schema behind. (Above MAX_STATEMENTS_PER_BATCH the file is chunked and
 *      atomicity becomes per-chunk - the importer says so when that happens.)
 *   3. A file that changed after it was applied is reported, not re-run.
 *      Re-running is a decision with data loss on the other side of it, so it
 *      is never automatic.
 *   4. A failure is reported with the file, the line, and the statement, and
 *      the resource still starts. A dump that cannot be translated is a thing
 *      to go and fix, not a reason to take the server down.
 *
 * Splitting a dump is the part that quietly destroys databases if done
 * casually: `text.split(";")` breaks apart any INSERT whose data contains a
 * semicolon, which for a FiveM dump means the first item description with a
 * sentence in it. The scanner below tracks string literals (both backslash and
 * doubled-quote escaping), backtick identifiers, `--`/`#`/block comments,
 * MySQL's `/*!40101 ... *\/` version-conditional comments, and `DELIMITER`
 * blocks for the occasional trigger.
 */
module.exports = (function () {
  const crypto = require("crypto");
  const fs = require("fs");
  const path = require("path");

  const LEDGER_TABLE = "tdb_sql_imports";

  // Beyond this, one transaction per file stops being reasonable to hold open.
  const MAX_STATEMENTS_PER_BATCH = 500;

  // Truncate what goes in the ledger's error column, and in the console.
  const MAX_ERROR_LENGTH = 400;
  const MAX_SNIPPET_LENGTH = 160;

  // ==========================================================================
  // Splitting
  // ==========================================================================

  /**
   * Consume a quoted run starting at `start`, returning the index just past the
   * closing quote.
   *
   * MySQL escapes a quote either by doubling it or, for ' and ", with a
   * backslash. Backtick identifiers only support doubling.
   */
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

  /**
   * Split a dump into statements.
   *
   * @param {string} text
   * @returns {Array<{sql: string, line: number}>} statements with the 1-based
   *   line each one started on, for error messages worth reading.
   */
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

      // Block comment, including MySQL's /*!40101 ... */ conditional form.
      // The conditional ones only ever carry session settings, so dropping
      // them is both correct here and what we want.
      if (pair === "/*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? text.length : end + 2;
        line += countNewlines(text, i, stop);
        buffer += " ";
        i = stop;
        continue;
      }

      // Line comment. MySQL requires whitespace after `--`, which is what
      // keeps it from eating the operator in `a--b`.
      const isDashComment =
        pair === "--" && (i + 2 >= text.length || /\s/.test(text[i + 2]));
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
        const value = text.slice(i, stop).replace(/^delimiter[ \t]+/i, "").trim();
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

  // ==========================================================================
  // Session noise
  // ==========================================================================

  /**
   * Statements mysqldump emits to set up a MySQL session. None of them mean
   * anything here, and feeding them to the translator would fail a file that
   * is otherwise perfectly importable.
   *
   * Transaction control is on this list deliberately: the importer runs the
   * whole file in one transaction of its own, and a nested BEGIN/COMMIT from
   * the dump would fight it.
   */
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
    return SESSION_NOISE.some((pattern) => pattern.test(trimmed));
  }

  // ==========================================================================
  // Ledger
  // ==========================================================================

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
       FROM ${LEDGER_TABLE}`,
    );
    const byFilename = new Map();
    for (const row of rows || []) byFilename.set(row.filename, row);
    return byFilename;
  }

  /**
   * The ledger row for a file, as two statements so it does not depend on
   * ON DUPLICATE KEY translation. Returned rather than executed so the caller
   * can put it in the same transaction as the file itself.
   */
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

  // ==========================================================================
  // Importing
  // ==========================================================================

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
    return text.length > MAX_ERROR_LENGTH
      ? `${text.slice(0, MAX_ERROR_LENGTH)}...`
      : text;
  }

  /**
   * The batch route reports which statement failed as a 1-based index. Map it
   * back to the line in the file the author can actually go and look at.
   */
  function locate(message, origins) {
    const match = /statement\s+(\d+)\b/i.exec(String(message || ""));
    if (!match) return null;
    return origins[Number(match[1]) - 1] || null;
  }

  /**
   * Apply one file.
   *
   * @returns {Promise<object>} a ledger-shaped record, status "applied" or "failed"
   */
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
    // before anything has been sent.
    const statements = [];
    const origins = []; // parallel to `statements`, for locating a failure
    for (const entry of executable) {
      let translated;
      try {
        translated = await adapter.translate(entry.sql, entry.params);
      } catch (error) {
        record.status = "failed";
        record.error = trimError(
          `line ${entry.line}: ${error.message} - ${snippet(entry.sql)}`,
        );
        record.duration_ms = Date.now() - startedAt;
        logger.error(`${filename}: ${record.error}`);
        await writeLedger(adapter, record);
        return record;
      }

      // The statement, then anything it spun off - an inline KEY becomes a
      // CREATE INDEX, which needs the table to exist first.
      statements.push({ sql: translated.sql, params: translated.params });
      origins.push(entry);
      for (const extra of translated.extraStatements) {
        statements.push({ sql: extra });
        origins.push(entry);
      }
    }

    const chunked = statements.length > MAX_STATEMENTS_PER_BATCH;
    if (chunked) {
      logger.warn(
        `${filename}: ${statements.length} statements - applying in chunks of ` +
          `${MAX_STATEMENTS_PER_BATCH}, so a failure can leave earlier chunks applied`,
      );
    }

    try {
      for (let offset = 0; offset < statements.length; offset += MAX_STATEMENTS_PER_BATCH) {
        const chunk = statements.slice(offset, offset + MAX_STATEMENTS_PER_BATCH);
        const isLast = offset + MAX_STATEMENTS_PER_BATCH >= statements.length;

        record.duration_ms = Date.now() - startedAt;

        // On a single-batch file the ledger row rides along in the same
        // transaction, so the record and the schema can never disagree.
        const payload = isLast
          ? chunk.concat(
              await Promise.all(
                ledgerStatements(record).map(async (entry) => {
                  const t = await adapter.translate(entry.sql, entry.params);
                  return { sql: t.sql, params: t.params };
                }),
              ),
            )
          : chunk;

        await adapter.send("/api/tdb/batch", {
          statements: payload,
          transaction: true,
        });
      }
    } catch (error) {
      const origin = locate(error.message, origins);
      record.status = "failed";
      record.error = trimError(
        origin
          ? `line ${origin.line}: ${error.message} - ${snippet(origin.sql)}`
          : error.message,
      );
      record.duration_ms = Date.now() - startedAt;
      logger.error(`${filename}: ${record.error}`);
      await writeLedger(adapter, record);
      return record;
    }

    adapter.invalidateCache();
    record.duration_ms = Date.now() - startedAt;

    const noise = skippedNoise ? `, ${skippedNoise} session statement(s) skipped` : "";
    logger.info(
      `${filename}: applied ${executable.length} statement(s) in ${record.duration_ms}ms${noise}`,
    );
    return record;
  }

  // ==========================================================================
  // Startup pass
  // ==========================================================================

  /**
   * Apply every pending file in `dir`, in filename order.
   *
   * Never throws. A file that fails is reported and recorded, and the next one
   * is still attempted - one bad dump should not hide the rest.
   *
   * @param {object} adapter the OxMySQL adapter (its translate/select/execute/send)
   * @param {string} dir absolute path to the drop folder
   * @param {object} logger
   * @param {object} [options] `onChanged`: "warn" | "apply" | "error"
   * @param {string[]} [options.only] apply just these filenames
   * @param {boolean} [options.force] re-apply even if the ledger says applied
   */
  async function run(adapter, dir, logger, options = {}) {
    const summary = { applied: [], failed: [], skipped: [], changed: [] };

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

      if (previous && previous.status === "applied" && !options.force) {
        const current = checksum(fs.readFileSync(filePath, "utf8"));

        if (current === previous.checksum) {
          summary.skipped.push(filename);
          continue;
        }

        // The file changed after it was applied. Re-running it would replay
        // every INSERT it contains, so that is never the default.
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
      if (record.status === "applied") summary.applied.push(filename);
      else summary.failed.push(filename);
    }

    return summary;
  }

  return {
    LEDGER_TABLE,
    MAX_STATEMENTS_PER_BATCH,
    splitStatements,
    isSessionNoise,
    checksum,
    ensureLedger,
    readLedger,
    importFile,
    run,
  };
})();
