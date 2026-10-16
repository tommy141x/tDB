/**
 * oxmysql compatibility adapter: the oxmysql export surface (plus the
 * mysql-async / ghmattimysql names it provides) over PocketBase's SQLite.
 * MySQL is translated by utils/sql-translator.js and run through the pb_hooks
 * SQL routes. Anything that cannot be translated faithfully raises an error
 * naming the construct, because a silently wrong row corrupts save data.
 */

// Relative to this file: a required module resolves from its own directory,
// unlike a manifest server_script, which resolves from the resource root.
const translator = require("../utils/sql-translator.js");
const { describeRouteError } = require("../utils/route-error.js");

// Export name -> result shape, read off oxmysql 2.12.0's source rather than its
// docs: `execute` and `fetch` alias `query` (rows), not `update`. Only the
// mysql-async compat layer maps its own `execute` to `update`.
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

// Legacy names oxmysql provides on behalf of the resources it replaces.
//
// These are the mysql-async spellings, and oxmysql publishes them UNDER THE
// `mysql-async` RESOURCE NAME, not under its own. tDB registers them both ways:
// as `exports.tDB:mysql_fetch_all` and, via ExportRouter.registerAliases, as
// `exports['mysql-async']:mysql_fetch_all` - which is the one real scripts
// call. See ALIASED_RESOURCES below.
const LEGACY_ALIASES = {
  mysql_execute: "update",
  mysql_insert: "insert",
  mysql_fetch_all: "query",
  mysql_fetch_scalar: "scalar",
  mysql_transaction: "transaction",
  mysql_store: "store",
};

// Which export names to publish under which other resource's name.
//
// Transcribed from oxmysql's own registration loop and its two compatibility
// tables (src/index.ts, src/compatibility/*.ts):
//
//   * oxmysql publishes everything it has, plus `_async` and `Sync` for each.
//   * ghmattimysql gets execute/scalar/transaction/store, plus `Sync` forms.
//     Its `execute` maps from `query`, so it means ROWS.
//   * mysql-async gets the six `mysql_*` names, plain only - oxmysql does not
//     give that one `Sync` variants.
//
// Note the trap `ghmattimysql:execute` sets: it is rows, while
// `mysql-async:mysql_execute` is affectedRows. Both names already resolve
// correctly through RESULT_MODES and LEGACY_ALIASES, so publishing the NAME is
// all that is needed here - the meaning is already right.
const GHMATTI_METHODS = ["execute", "scalar", "transaction", "store"];

// Statements that return rows. Everything else is run for its effect.
//
// SHOW is here because the translator rewrites `SHOW TABLES [LIKE ?]` into a
// SELECT over sqlite_master, so by the time anything executes it IS a row
// query -- but canHandle() runs on the ORIGINAL text, before translation, and
// a leading keyword it does not recognise means no adapter claims the call at
// all. Measured 2026-10-13: night_shifts probes `SHOW TABLES LIKE ?` per table
// at startup and gates playerConnecting on the result, so every one of those
// failing with "No adapter could handle export 'scalar'" left the server
// rejecting all connections with "currently migrating the database".
// DESCRIBE/DESC return rows too, and are rewritten the same way SHOW is.
const ROW_KEYWORDS = ["SELECT", "WITH", "VALUES", "PRAGMA", "EXPLAIN", "SHOW", "DESCRIBE", "DESC"];

// Anything that opens with a word and is not obviously a collection name. A
// statement claimed this way is still translated, so an unknown construct is
// refused by name rather than falling through to a misleading router error.
const STATEMENT_SHAPED = /^\s*[A-Za-z_][A-Za-z0-9_]*\s+\S/;

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

  /**
   * Which export names to publish under which OTHER resource's name, so an
   * unported script's `exports.oxmysql:query(...)` reaches tDB.
   */
  static aliasedResources() {
    const ghmatti = [];
    for (const name of GHMATTI_METHODS) ghmatti.push(name, `${name}Sync`);

    return {
      // Everything, since a consumer written against oxmysql may call any of it.
      oxmysql: OxMySQLAdapter.buildExportList(),
      ghmattimysql: ghmatti,
      "mysql-async": Object.keys(LEGACY_ALIASES),
    };
  }

  // Cache controls

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

  // Called after every write, so a cached read cannot outlive its data.
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
    // NUL separator: it cannot occur in SQL, so no two (sql, params) pairs can
    // collide by concatenation. Escaped, not literal - a raw NUL byte would make
    // the file binary to git and ripgrep.
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

  // Dispatch

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

    // Claim anything that reads as a statement, not only the keywords we know.
    //
    // An unrecognised leading keyword used to mean no adapter claimed the call,
    // and the router then reported "No adapter could handle export 'scalar'" --
    // which names the export, not the statement, and reads like a tDB wiring
    // fault. The caller sent SQL; the honest answer is which construct is
    // unsupported, and the translator already produces exactly that. So take
    // the call and let it explain itself.
    if (SQL_KEYWORDS.includes(OxMySQLAdapter.leadingKeyword(args[0]))) {
      return true;
    }

    return STATEMENT_SHAPED.test(args[0]);
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

  // Execution

  // Run one statement and shape the result the way the calling export does.
  async runStatement(mode, sql, params, call) {
    await this.ready();

    if (mode === "prepare" || mode === "raw") {
      return this.runParameterSets(mode, sql, params, call);
    }

    const wantsRows = mode === "rows" || mode === "row" || mode === "scalar";
    const kind = OxMySQLAdapter.statementKind(sql);

    // In oxmysql a row-shaped export against a write statement (or the reverse)
    // is not an error, it just yields nothing useful. Mirror that.
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
   * prepare/rawExecute take one parameter set or many. The callback asymmetry is
   * oxmysql's: its async/await paths all supply a callback internally, so those
   * unwrap a lone row, and a lone single-column row down to the bare value,
   * while a callback-less call gets the rows array.
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
          results.push(keyword === "INSERT" ? result.insertId : result.affectedRows);
        }
      }
    }

    if (results.length !== 1) return results;

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

  // Atomic. Returns true/false and never throws; oxmysql callers branch on that.
  async runTransaction(queries, params) {
    await this.ready();

    try {
      const statements = [];

      for (const entry of OxMySQLAdapter.parseTransaction(queries, params)) {
        const translated = await this.translate(entry.sql, entry.params);

        // Statement first, then what it spun off: reversed, an inline KEY
        // becomes a CREATE INDEX on a table that does not exist yet.
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

  // Some MySQL DDL becomes several SQLite statements (inline KEY -> CREATE INDEX,
  // ON UPDATE CURRENT_TIMESTAMP -> trigger). Those go out as one atomic batch so
  // a table cannot end up created without the indexes and triggers declared with it.
  async execute(sql, params) {
    const translated = await this.translate(sql, params);
    let response;

    if (translated.extraStatements.length) {
      const batch = await this.send("/api/tdb/batch", {
        statements: [{ sql: translated.sql, params: translated.params }].concat(
          translated.extraStatements.map((extra) => ({ sql: extra }))
        ),
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

  // Translation

  async ready() {
    if (!this.translatorReady) {
      this.translatorReady = translator.init();
    }
    await this.translatorReady;
  }

  // ON DUPLICATE KEY UPDATE needs a conflict target that only the table's
  // schema can supply, and translateSync below is synchronous, so the schema is
  // fetched up front and resolved from cache inside it.
  async prepareSchema(sql) {
    // Two shapes need the schema before the synchronous translate: an upsert,
    // to pick a conflict target, and a column-list-free INSERT, to expand it
    // into a named one.
    const needsTarget = /\bON\s+DUPLICATE\s+KEY\b/i.test(sql);
    const needsOrder = OxMySQLAdapter.COLUMN_LIST_FREE_INSERT.test(sql);
    if (!needsTarget && !needsOrder) return;

    const match =
      /\b(?:INSERT|REPLACE)\s+(?:(?:OR\s+)?IGNORE\s+)?INTO\s+[`"\[]?([A-Za-z0-9_$]+)/i.exec(sql);
    if (match) await this.loadSchema(match[1]);
  }

  /**
   * `INSERT INTO t VALUES (...)` with no column list, which is positional.
   *
   * The identifier is matched character by character rather than with a lazy
   * `[^(]*?`: that form read "any run of non-paren characters", which a table
   * name ending in `values` satisfies on its own, so a fully named INSERT into
   * `fxsql_values` looked like it had no column list.
   */
  static COLUMN_LIST_FREE_INSERT =
    /^\s*(?:INSERT(?:\s+(?:OR\s+)?IGNORE)?|REPLACE)\s+INTO\s+[`"\[]?[A-Za-z0-9_$.]*[`"\]]?\s+VALUES\b/i;

  /**
   * The column order a positional INSERT means, or null when it cannot be known.
   *
   * Adoption REORDERS columns - PocketBase sorts them - so the live order is not
   * the one a statement written against the original schema meant. pb-adopt
   * records the source order in its registry for exactly this, and the schema
   * route hands it back as `sourceColumns`; the live order is correct only for a
   * table that was never adopted.
   */
  resolveColumnOrder(table) {
    const schema = this.schemaCache.get(table);
    if (!schema) return null;

    if (Array.isArray(schema.sourceColumns) && schema.sourceColumns.length) {
      return schema.sourceColumns.slice();
    }

    if (Array.isArray(schema.columns) && schema.columns.length) {
      return schema.columns.map((c) => (typeof c === "string" ? c : c.name));
    }

    return null;
  }

  // Throws synchronously. Split out of translate() so a caller that expects a
  // failure can catch it without a promise ever existing: FiveM's runtime
  // reports a rejected promise even when it is awaited inside try/catch, so the
  // sql importer's skip-this-trigger path printed a stack trace for an outcome
  // it had already handled. Call prepareSchema first.
  translateSync(sql, params) {
    const translated = translator.translate(sql, params, {
      resolveConflictTarget: (table, insertColumns) =>
        this.resolveConflictTarget(table, insertColumns),
      resolveColumnOrder: (table) => this.resolveColumnOrder(table),
    });

    return {
      sql: translated.sql,
      params: translated.params,
      extraStatements: translated.extraStatements || [],
      // Passed through, or an ALTER needing a table rebuild would lose its
      // descriptor here and the UNTRANSLATED original would be executed -
      // which is exactly what happened: SQLite answered 'near "CHANGE":
      // syntax error'.
      rebuild: translated.rebuild,
    };
  }

  async translate(sql, params) {
    await this.prepareSchema(sql);
    return this.translateSync(sql, params);
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
   * MySQL fires ON DUPLICATE KEY on whichever unique constraint the row violates;
   * SQLite makes you name one. Only a key whose every column the statement
   * supplies can behave the same: a target the INSERT gives no values for can
   * never match, and the upsert degrades into a plain insert with duplicate rows.
   */
  // Returned when the insert cannot collide with any unique key, so the
  // ON DUPLICATE KEY UPDATE clause is unreachable and a plain INSERT is the
  // faithful translation. A string rather than a Symbol so it survives being
  // passed through the translator's options object unchanged.
  static NO_CONFLICT_POSSIBLE = "__tdb_no_conflict_possible";

  resolveConflictTarget(table, insertColumns) {
    const schema = this.schemaCache.get(table);

    if (!schema) {
      throw new Error(
        `Cannot translate ON DUPLICATE KEY UPDATE on "${table}": the table's schema could not be read`
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

    const supplied = new Set((insertColumns || []).map((c) => String(c).toLowerCase()));
    const covered = candidates.find((candidate) =>
      candidate.every((column) => supplied.has(String(column).toLowerCase()))
    );

    if (covered) return covered;

    // The statement supplies NONE of the columns of ANY unique key: there is
    // no collision for MySQL to detect either, so its UPDATE clause is
    // unreachable and it simply inserts. A plain INSERT is therefore not an
    // approximation, it is exactly what MySQL does.
    //
    // This is the habitual-idiom case: `INSERT INTO t (a, b) VALUES (?, ?)
    // ON DUPLICATE KEY UPDATE ...` against a table whose only unique key is an
    // autoincrement id. lb-phone's crypto app does it and threw on every boot
    // until this was separated out.
    //
    // The PARTIAL case stays a refusal, deliberately: if the insert supplies
    // some but not all of a composite unique key, MySQL may still collide
    // while SQLite's upsert has no complete conflict target to name - and
    // guessing there would insert duplicates instead of updating.
    const overlapsAny = candidates.some((candidate) =>
      candidate.some((column) => supplied.has(String(column).toLowerCase()))
    );

    if (!overlapsAny) return OxMySQLAdapter.NO_CONFLICT_POSSIBLE;

    throw new Error(
      `Cannot translate ON DUPLICATE KEY UPDATE on "${table}": the statement inserts ` +
        `(${(insertColumns || []).join(", ") || "no named columns"}) which covers part of a ` +
        `unique key but not all of it (${candidates.map((c) => c.join("+")).join(", ")}), ` +
        "so SQLite would insert duplicates instead of updating"
    );
  }

  // Transport

  async send(route, body) {
    try {
      return await this.pb.send(route, {
        method: "POST",
        body,
        requestKey: null, // Concurrent queries must not cancel each other.
      });
    } catch (error) {
      // The STATEMENT is named, because without it the message says something
      // failed but not what was running - and a resource issues hundreds of
      // statements. lb-phone's crypto update surfaced as
      // `oxmysql:prepare_async: Something went wrong.` with no way to tell
      // which of its queries it was.
      const statement = body && typeof body.sql === "string" ? body.sql : null;
      const where = statement
        ? ` while running: ${statement.replace(/\s+/g, " ").slice(0, 160)}`
        : ` (${route})`;

      throw new Error(`${OxMySQLAdapter.describeError(error)}${where}`);
    }
  }

  static describeError(error) {
    return describeRouteError(error);
  }

  reportIfSlow(sql, ms) {
    if (this.slowQueryThreshold > 0 && ms >= this.slowQueryThreshold) {
      const compact = String(sql).replace(/\s+/g, " ").trim();
      this.logger.warn(
        `Slow query (${ms}ms): ${compact.length > 120 ? `${compact.slice(0, 120)}...` : compact}`
      );
    }
  }

  // Argument handling

  static baseName(exportName) {
    return exportName.replace(/_async$/, "").replace(/Sync$/, "");
  }

  // oxmysql accepts (sql), (sql, params), (sql, callback), (sql, params, callback).
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

  // Normalise prepare/rawExecute parameters into a list of parameter sets.
  static parameterSets(params) {
    if (params === undefined || params === null) return [undefined];

    if (Array.isArray(params)) {
      if (params.length && params.every((entry) => Array.isArray(entry))) {
        return params;
      }

      // A batch row that arrives as a 1-INDEXED OBJECT rather than an array.
      //
      // This is not an exotic shape: a Lua row with a leading nil hole has an
      // undefined `#`, so msgpack emits a map, not a sequence -
      // `{ inventory, owner }` with an empty inventory marshals as
      // `{"2": owner}`. oxmysql normalises exactly this case
      // (src/utils/parseExecute.ts, the array-of-objects branch), and without
      // it N rows collapsed into ONE set whose values were the row objects
      // themselves.
      //
      // ox_inventory's periodic save is built this way: it fills
      // `parameters[index][total[index]] = data` where `data` is
      // `next(buffer) and json.encode(buffer) or nil`, then hands the batch to
      // MySQL.prepare. So every empty inventory in a save batch silently wrote
      // the wrong rows, or none.
      //
      // Guarded on EVERY entry being a plain object: a mixed array is a caller
      // error, and spreading one shape across the other would invent rows.
      if (
        params.length &&
        params.every(
          (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
        )
      ) {
        return params.map((entry) => OxMySQLAdapter.positionalFromKeys(entry));
      }

      return [params];
    }

    if (typeof params === "object") return [params];

    return [[params]];
  }

  /**
   * A 1-indexed object to the positional array it stands for.
   *
   * Keys are read as integers and placed at `key - 1`, which is oxmysql's own
   * rule, so a hole stays a hole and becomes a NULL bind rather than shifting
   * every later value left.
   */
  static positionalFromKeys(entry) {
    const out = [];
    let highest = 0;

    for (const [key, value] of Object.entries(entry)) {
      const index = Number.parseInt(key, 10);
      // A non-numeric key cannot be placed positionally. Returning the object
      // untouched lets the translator's named-parameter path read it, which is
      // what a caller passing `{ name = ..., label = ... }` meant.
      if (!Number.isInteger(index) || index < 1) return entry;
      out[index - 1] = value;
      if (index > highest) highest = index;
    }

    for (let i = 0; i < highest; i++) {
      if (out[i] === undefined) out[i] = null;
    }

    return out;
  }

  // Accepts query strings, [sql, params] pairs or { query, values } objects,
  // plus optional parameters shared by all of them.
  static parseTransaction(queries, params) {
    if (!Array.isArray(queries)) {
      throw new Error(`Transaction queries must be an array, received '${typeof queries}'`);
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

  // The opening keyword, ignoring leading whitespace and comments.
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
    return ROW_KEYWORDS.includes(OxMySQLAdapter.leadingKeyword(sql)) ? "rows" : "exec";
  }

  // The first column of the first row, which is what scalar returns.
  static firstValue(rows) {
    if (!rows.length) return null;

    const values = Object.values(rows[0]);
    return values.length ? values[0] : null;
  }
}

module.exports = OxMySQLAdapter;
