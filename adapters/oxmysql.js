/**
 * oxmysql compatibility adapter.
 *
 * Presents the oxmysql export surface (and the mysql-async / ghmattimysql names
 * it in turn replaces) on top of PocketBase's SQLite database, so scripts
 * written against oxmysql - qb-core, ox_core, lb-phone and friends - run
 * unmodified.
 *
 * How it works: MySQL statements are translated to SQLite by
 * utils/sql-translator.js and executed through the pb_hooks SQL routes, which
 * return dynamically shaped, correctly typed rows. This adapter's own job is
 * narrow - argument handling, statement classification, and returning exactly
 * what each oxmysql export returns.
 *
 * Return values were taken from oxmysql 2.12.0's own source rather than from
 * its docs, because two of them are easy to get backwards:
 *
 *   - `execute` and `fetch` are aliases of `query` (rows), NOT of `update`.
 *     The mysql-async compatibility layer separately maps its `execute` to
 *     `update`, which is where the confusion comes from.
 *   - `prepare` and `rawExecute` return different things depending on whether a
 *     callback was supplied. Every await/async path in oxmysql goes through the
 *     callback form, so that path unpacks a single row - and a single-column
 *     row down to its bare value.
 *
 * Anything that cannot be translated faithfully raises an error naming the
 * construct. A wrong row is far worse than a failed call: it corrupts save data
 * silently, and the script author has no reason to suspect the database layer.
 */

// Relative to this file: a required module resolves from its own directory,
// unlike a manifest server_script, which resolves from the resource root.
const translator = require("../utils/sql-translator.js");
const { describeRouteError } = require("../utils/route-error.js");

// Export name -> how the result is shaped. See the note above about `execute`.
const RESULT_MODES = {
  query: "rows",
  execute: "rows",
  fetch: "rows",
  single: "row",
  scalar: "scalar",
  update: "affectedRows",
  insert: "insertId",
  prepare: "prepare",
  rawExecute: "raw",
  transaction: "transaction",
  store: "store",
};

// Legacy names oxmysql provides on behalf of the resources it replaces. The
// manifest declares `provide 'mysql-async'` and `provide 'ghmattimysql'`, so
// these have to exist for that claim to be true.
const LEGACY_ALIASES = {
  mysql_execute: "update",
  mysql_insert: "insert",
  mysql_fetch_all: "query",
  mysql_fetch_scalar: "scalar",
  mysql_transaction: "transaction",
  mysql_store: "store",
};

// Statements that return rows. Everything else is run for its effect.
const ROW_KEYWORDS = ["SELECT", "WITH", "VALUES", "PRAGMA", "EXPLAIN"];

// Leading keywords accepted as SQL at all.
const SQL_KEYWORDS = ROW_KEYWORDS.concat([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "SET",
  "START",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
]);

class OxMySQLAdapter {
  constructor(pb, wrapAsync, logger) {
    this.name = "OxMySQL";
    this.pb = pb;
    this.wrapAsync = wrapAsync;
    this.logger = logger || console;

    // Result cache, off by default. Only row queries are cached, and any write
    // through this adapter clears it - see invalidateCache().
    this.queryCache = new Map();
    this.cacheConfig = { enabled: false, ttl: 60000, maxSize: 100 };

    // Table schemas, used to resolve ON DUPLICATE KEY conflict targets.
    this.schemaCache = new Map();

    // Matches oxmysql's mysql_slow_query_warning default.
    this.slowQueryThreshold = 150;

    this.translatorReady = null;

    this.supportedExports = OxMySQLAdapter.buildExportList();
  }

  /**
   * Every supported export, including the _async and Sync variants FiveM
   * scripts call.
   */
  static buildExportList() {
    const names = [];
    const base = Object.keys(RESULT_MODES).concat(Object.keys(LEGACY_ALIASES));

    for (const name of base) {
      names.push(name, `${name}_async`, `${name}Sync`);
    }

    return names.concat([
      "enableCache",
      "disableCache",
      "invalidateCache",
      "setSlowQueryThreshold",
    ]);
  }

  // ==========================================================================
  // Cache controls
  // ==========================================================================

  enableCache(ttl = 60000, maxSize = 100) {
    this.cacheConfig = { enabled: true, ttl, maxSize };
    this.logger.debug(`Query cache enabled: TTL=${ttl}ms, MaxSize=${maxSize}`);
    return true;
  }

  disableCache() {
    this.cacheConfig.enabled = false;
    this.queryCache.clear();
    return true;
  }

  /**
   * Drop cached results. Called automatically after every write, so a cached
   * read can never outlive the data it described.
   */
  invalidateCache(pattern) {
    if (!pattern) {
      this.queryCache.clear();
      return true;
    }

    for (const key of Array.from(this.queryCache.keys())) {
      if (key.includes(pattern)) this.queryCache.delete(key);
    }
    return true;
  }

  setSlowQueryThreshold(ms) {
    this.slowQueryThreshold = ms;
    return true;
  }

  cacheKey(sql, params) {
    // \u0000 as the separator: it cannot occur in SQL, so no pair of
    // (sql, params) can collide with another by concatenation. Written as an
    // escape rather than a literal - a raw NUL byte in the source makes the
    // file binary to git and ripgrep.
    return `${sql}\u0000${JSON.stringify(params === undefined ? null : params)}`;
  }

  readCache(sql, params) {
    if (!this.cacheConfig.enabled) return undefined;

    const entry = this.queryCache.get(this.cacheKey(sql, params));
    if (!entry) return undefined;

    if (Date.now() - entry.at > this.cacheConfig.ttl) {
      this.queryCache.delete(this.cacheKey(sql, params));
      return undefined;
    }

    return entry.value;
  }

  writeCache(sql, params, value) {
    if (!this.cacheConfig.enabled) return;

    if (this.queryCache.size >= this.cacheConfig.maxSize) {
      this.queryCache.delete(this.queryCache.keys().next().value);
    }

    this.queryCache.set(this.cacheKey(sql, params), { at: Date.now(), value });
  }

  // ==========================================================================
  // Dispatch
  // ==========================================================================

  canHandle(exportName, args) {
    if (!this.supportedExports.includes(exportName)) return false;

    const baseName = OxMySQLAdapter.baseName(exportName);

    if (LEGACY_ALIASES[baseName] === undefined && !RESULT_MODES[baseName]) {
      // Cache controls take no SQL.
      return true;
    }

    const method = LEGACY_ALIASES[baseName] || baseName;

    if (method === "transaction") return Array.isArray(args[0]);
    if (method === "store") return typeof args[0] === "string";

    if (typeof args[0] !== "string") return false;

    return SQL_KEYWORDS.includes(OxMySQLAdapter.leadingKeyword(args[0]));
  }

  handle(exportName, args) {
    const baseName = OxMySQLAdapter.baseName(exportName);

    switch (baseName) {
      case "enableCache":
        return this.enableCache(args[0], args[1]);
      case "disableCache":
        return this.disableCache();
      case "invalidateCache":
        return this.invalidateCache(args[0]);
      case "setSlowQueryThreshold":
        return this.setSlowQueryThreshold(args[0]);
      default:
        break;
    }

    const method = LEGACY_ALIASES[baseName] || baseName;
    const mode = RESULT_MODES[method];

    if (!mode) {
      throw new Error(`OxMySQL adapter does not support export: ${exportName}`);
    }

    const call = OxMySQLAdapter.parseArguments(args);

    // store() never touches the database; it hands the query back so the caller
    // can pass it around as a handle.
    if (mode === "store") {
      if (call.callback) {
        call.callback(call.sql);
        return undefined;
      }
      return call.sql;
    }

    const handler = async () => {
      const startedAt = Date.now();
      let value;

      try {
        value =
          mode === "transaction"
            ? await this.runTransaction(call.sql, call.params)
            : await this.runStatement(mode, call.sql, call.params, call);
      } finally {
        this.reportIfSlow(call.sql, Date.now() - startedAt);
      }

      if (call.callback) {
        call.callback(value);
        return undefined;
      }
      return value;
    };

    return this.wrapAsync(handler, `oxmysql:${exportName}`)();
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  /**
   * Run one statement and shape the result the way the calling export does.
   */
  async runStatement(mode, sql, params, call) {
    await this.ready();

    if (mode === "prepare" || mode === "raw") {
      return this.runParameterSets(mode, sql, params, call);
    }

    const wantsRows = mode === "rows" || mode === "row" || mode === "scalar";
    const kind = OxMySQLAdapter.statementKind(sql);

    // A row-shaped export against a write statement, or the reverse, is not an
    // error in oxmysql - it just yields nothing useful. Mirror that rather than
    // inventing a failure.
    if (wantsRows && kind !== "rows") {
      const result = await this.execute(sql, params);
      return mode === "rows" ? result : null;
    }

    if (!wantsRows && kind === "rows") {
      await this.select(sql, params);
      return null;
    }

    if (kind === "rows") {
      const rows = await this.select(sql, params);
      if (mode === "rows") return rows;
      if (mode === "row") return rows.length ? rows[0] : null;
      return OxMySQLAdapter.firstValue(rows);
    }

    const result = await this.execute(sql, params);
    if (mode === "affectedRows") return result.affectedRows;
    if (mode === "insertId") return result.insertId;
    return result;
  }

  /**
   * prepare/rawExecute accept one set of parameters or many, and unpack their
   * result differently depending on whether a callback was given.
   *
   * This mirrors oxmysql exactly, including the asymmetry: its async and await
   * paths all supply a callback internally, so those unwrap a lone row - and a
   * lone single-column row down to the value itself - while a direct call
   * without a callback returns the rows array.
   */
  async runParameterSets(mode, sql, params, call) {
    const sets = OxMySQLAdapter.parameterSets(params);
    const kind = OxMySQLAdapter.statementKind(sql);
    const unpack = mode === "prepare";

    const results = [];
    for (const set of sets) {
      if (kind === "rows") {
        const rows = await this.select(sql, set);
        results.push(rows);
      } else {
        const result = await this.execute(sql, set);
        if (!unpack) {
          results.push(result);
        } else {
          const keyword = OxMySQLAdapter.leadingKeyword(sql);
          results.push(
            keyword === "INSERT" ? result.insertId : result.affectedRows,
          );
        }
      }
    }

    if (results.length !== 1) return results;

    // Without a callback, hand back the single result untouched.
    if (!call.callback) return results[0];

    if (unpack && kind === "rows") {
      const rows = results[0];
      const first = rows.length ? rows[0] : null;
      if (first && Object.keys(first).length === 1) {
        return Object.values(first)[0];
      }
      return first;
    }

    return results[0];
  }

  /**
   * Run several statements atomically. Returns true or false, never throws -
   * which is what oxmysql callers branch on.
   */
  async runTransaction(queries, params) {
    await this.ready();

    try {
      const statements = [];

      for (const entry of OxMySQLAdapter.parseTransaction(queries, params)) {
        const translated = await this.translate(entry.sql, entry.params);

        // The statement first, then what it spun off. An inline KEY becomes a
        // CREATE INDEX on a table that does not exist yet if these run the
        // other way round - which is how they used to be ordered here, while
        // execute() below had it right.
        statements.push({ sql: translated.sql, params: translated.params });
        for (const extra of translated.extraStatements) {
          statements.push({ sql: extra });
        }
      }

      await this.send("/api/tdb/batch", {
        statements,
        transaction: true,
      });

      this.invalidateCache();
      return true;
    } catch (error) {
      this.logger.error(`Transaction failed and was rolled back: ${error.message}`);
      return false;
    }
  }

  /**
   * Run a row-returning statement.
   */
  async select(sql, params) {
    const cached = this.readCache(sql, params);
    if (cached !== undefined) return cached;

    const translated = await this.translate(sql, params);

    const response = await this.send("/api/tdb/query", {
      sql: translated.sql,
      params: translated.params,
    });

    this.writeCache(sql, params, response.rows);
    return response.rows;
  }

  /**
   * Run a statement for its effect.
   *
   * Some MySQL DDL becomes several SQLite statements - an inline KEY becomes a
   * CREATE INDEX, an ON UPDATE CURRENT_TIMESTAMP becomes a trigger. Those go
   * out as one atomic batch, so a table can never end up created without the
   * indexes and triggers that were declared with it.
   */
  async execute(sql, params) {
    const translated = await this.translate(sql, params);
    let response;

    if (translated.extraStatements.length) {
      const batch = await this.send("/api/tdb/batch", {
        statements: [
          { sql: translated.sql, params: translated.params },
        ].concat(translated.extraStatements.map((extra) => ({ sql: extra }))),
        transaction: true,
      });
      response = batch.results[0];
    } else {
      response = await this.send("/api/tdb/execute", {
        sql: translated.sql,
        params: translated.params,
      });
    }

    // Any write can invalidate any cached read, and the cache cannot know which.
    this.invalidateCache();

    return {
      affectedRows: response.affectedRows,
      insertId: response.insertId,
      warningStatus: 0,
    };
  }

  // ==========================================================================
  // Translation
  // ==========================================================================

  async ready() {
    if (!this.translatorReady) {
      this.translatorReady = translator.init();
    }
    await this.translatorReady;
  }

  /**
   * Translate MySQL to SQLite, loading any schema the translation needs first.
   */
  async translate(sql, params) {
    // ON DUPLICATE KEY UPDATE needs a conflict target, which only the table's
    // schema can supply. Translation itself is synchronous, so the schema is
    // fetched up front and resolved from cache during the translation.
    if (/\bON\s+DUPLICATE\s+KEY\b/i.test(sql)) {
      const match = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+[`"\[]?([A-Za-z0-9_$]+)/i.exec(
        sql,
      );
      if (match) await this.loadSchema(match[1]);
    }

    const translated = translator.translate(sql, params, {
      resolveConflictTarget: (table, insertColumns) =>
        this.resolveConflictTarget(table, insertColumns),
    });

    return {
      sql: translated.sql,
      params: translated.params,
      extraStatements: translated.extraStatements || [],
    };
  }

  async loadSchema(table) {
    if (this.schemaCache.has(table)) return this.schemaCache.get(table);

    let schema = null;
    try {
      schema = await this.send("/api/tdb/schema", { table });
    } catch (error) {
      schema = null;
    }

    this.schemaCache.set(table, schema);
    return schema;
  }

  /**
   * Choose the SQLite ON CONFLICT target for a MySQL ON DUPLICATE KEY UPDATE.
   *
   * MySQL fires on whichever unique constraint the row violates; SQLite makes
   * you name one. The only candidate that can behave like MySQL here is a key
   * whose every column the statement actually supplies - a conflict target the
   * INSERT never provides values for could never match, so the upsert would
   * silently degrade into a plain insert and duplicate rows.
   */
  resolveConflictTarget(table, insertColumns) {
    const schema = this.schemaCache.get(table);

    if (!schema) {
      throw new Error(
        `Cannot translate ON DUPLICATE KEY UPDATE on "${table}": the table's schema could not be read`,
      );
    }

    const candidates = [];
    if (schema.primaryKey && schema.primaryKey.length) {
      candidates.push(schema.primaryKey);
    }
    for (const index of schema.uniqueIndexes || []) {
      if (index.length) candidates.push(index);
    }

    if (!candidates.length) {
      return null; // The translator reports this case in its own words.
    }

    const supplied = new Set(
      (insertColumns || []).map((c) => String(c).toLowerCase()),
    );
    const covered = candidates.find((candidate) =>
      candidate.every((column) => supplied.has(String(column).toLowerCase())),
    );

    if (covered) return covered;

    throw new Error(
      `Cannot translate ON DUPLICATE KEY UPDATE on "${table}": the statement inserts ` +
        `(${(insertColumns || []).join(", ") || "no named columns"}) but every unique key ` +
        `(${candidates.map((c) => c.join("+")).join(", ")}) needs columns it does not supply, ` +
        "so SQLite would insert duplicates instead of updating",
    );
  }

  // ==========================================================================
  // Transport
  // ==========================================================================

  async send(route, body) {
    try {
      return await this.pb.send(route, {
        method: "POST",
        body,
        requestKey: null, // Concurrent queries must not cancel each other.
      });
    } catch (error) {
      throw new Error(OxMySQLAdapter.describeError(error));
    }
  }

  static describeError(error) {
    return describeRouteError(error);
  }

  reportIfSlow(sql, ms) {
    if (this.slowQueryThreshold > 0 && ms >= this.slowQueryThreshold) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      this.logger.warn(
        `Slow query (${ms}ms): ${compact.length > 120 ? `${compact.slice(0, 120)}...` : compact}`,
      );
    }
  }

  // ==========================================================================
  // Argument handling
  // ==========================================================================

  static baseName(exportName) {
    return exportName.replace(/_async$/, "").replace(/Sync$/, "");
  }

  /**
   * oxmysql accepts (sql), (sql, params), (sql, callback) and
   * (sql, params, callback).
   */
  static parseArguments(args) {
    const sql = args[0];
    let params;
    let callback = null;

    if (typeof args[1] === "function") {
      callback = args[1];
    } else {
      params = args[1];
      if (typeof args[2] === "function") callback = args[2];
    }

    return { sql, params, callback };
  }

  /**
   * Normalise prepare/rawExecute parameters into a list of parameter sets.
   */
  static parameterSets(params) {
    if (params === undefined || params === null) return [undefined];

    if (Array.isArray(params)) {
      if (params.length && params.every((entry) => Array.isArray(entry))) {
        return params;
      }
      return [params];
    }

    if (typeof params === "object") return [params];

    return [[params]];
  }

  /**
   * A transaction accepts a list of query strings, [sql, params] pairs, or
   * { query, values } objects, with optional parameters shared by all of them.
   */
  static parseTransaction(queries, params) {
    if (!Array.isArray(queries)) {
      throw new Error(
        `Transaction queries must be an array, received '${typeof queries}'`,
      );
    }

    const shared = params && typeof params === "object" ? params : undefined;

    return queries.map((entry, index) => {
      if (typeof entry === "string") {
        return { sql: entry, params: shared };
      }

      if (Array.isArray(entry)) {
        return { sql: entry[0], params: entry[1] === undefined ? shared : entry[1] };
      }

      if (entry && typeof entry === "object" && entry.query) {
        return {
          sql: entry.query,
          params:
            entry.values !== undefined
              ? entry.values
              : entry.parameters !== undefined
                ? entry.parameters
                : shared,
        };
      }

      throw new Error(`Invalid transaction query at index ${index}`);
    });
  }

  /**
   * The statement's opening keyword, ignoring leading whitespace and comments.
   */
  static leadingKeyword(sql) {
    let rest = String(sql);

    for (;;) {
      const trimmed = rest.replace(/^\s+/, "");

      if (trimmed.startsWith("--")) {
        const newline = trimmed.indexOf("\n");
        if (newline === -1) return "";
        rest = trimmed.slice(newline + 1);
        continue;
      }

      if (trimmed.startsWith("/*")) {
        const close = trimmed.indexOf("*/");
        if (close === -1) return "";
        rest = trimmed.slice(close + 2);
        continue;
      }

      const match = trimmed.match(/^[a-zA-Z_]+/);
      return match ? match[0].toUpperCase() : "";
    }
  }

  static statementKind(sql) {
    return ROW_KEYWORDS.includes(OxMySQLAdapter.leadingKeyword(sql))
      ? "rows"
      : "exec";
  }

  /**
   * The first column of the first row, which is what scalar returns.
   */
  static firstValue(rows) {
    if (!rows.length) return null;

    const values = Object.values(rows[0]);
    return values.length ? values[0] : null;
  }
}

module.exports = OxMySQLAdapter;
