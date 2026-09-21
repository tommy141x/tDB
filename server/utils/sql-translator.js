/**
 * MySQL -> SQLite translation for the oxmysql compatibility layer.
 *
 * Scripts written against oxmysql issue MySQL. PocketBase stores its data in
 * plain SQLite. Something has to bridge the two, and the bridge has exactly
 * one property that matters more than coverage:
 *
 *     it must never return plausible-looking wrong data.
 *
 * A query this layer cannot translate faithfully has to fail loudly, naming
 * the construct it choked on, so the problem surfaces as an error in the
 * console instead of as an inventory that quietly reads back empty.
 *
 * Pipeline:
 *
 *   1. normalizePlaceholders  ?, @name and :name all become positional ?,
 *                             because a MySQL parser reads @name as a user
 *                             variable rather than as a bind parameter.
 *   2. preprocessMySQL        Rewrite the MySQL-only constructs that the
 *                             transpiler passes through untouched.
 *   3. transpile              Polyglot (WASM sqlglot port) does the lexical
 *                             dialect work: quoting, LIMIT x,y, CONCAT, NOW,
 *                             IFNULL, GROUP_CONCAT ... SEPARATOR, INSERT SET.
 *   4. assertTranslated       Reject any output still containing MySQL-only
 *                             syntax. This is the safety gate; Polyglot
 *                             reports success even when it has passed a
 *                             construct straight through.
 *   5. toPocketBaseParams     ? becomes {:pN}, PocketBase's bind syntax.
 *
 * Translations are cached by query shape - parameterised queries mean a
 * server only ever runs a finite set of them.
 */
module.exports = (function () {
  // Relative to this file: a required module resolves from its own directory,
  // unlike a manifest server_script, which resolves from the resource root.
  const polyglot = require("../vendor/polyglot/index.cjs");

  // ==========================================================================
  // WASM lifecycle
  // ==========================================================================
  let initPromise = null;

  /**
   * Load the WASM module. Safe to call repeatedly; the work happens once.
   */
  function init() {
    if (!initPromise) {
      initPromise = polyglot.init();
    }
    return initPromise;
  }

  function isReady() {
    return polyglot.isInitialized();
  }

  // ==========================================================================
  // Errors
  // ==========================================================================

  /**
   * Thrown when a query cannot be translated faithfully. Carries the original
   * SQL and the construct responsible so the console line is actionable.
   */
  class SQLTranslationError extends Error {
    constructor(message, { sql, construct, translated } = {}) {
      super(message);
      this.name = "SQLTranslationError";
      this.sql = sql;
      this.construct = construct;
      this.translated = translated;
    }
  }

  // ==========================================================================
  // Literal-aware scanning
  // ==========================================================================
  /**
   * Walk SQL, reporting which characters sit outside string literals,
   * quoted identifiers and comments. Every rewrite below uses this so that a
   * '?' or '@' inside a string value is never mistaken for a placeholder.
   *
   * @param {string} sql
   * @param {function(string, number, boolean): void} visit
   *   Called per character with (char, index, isCode).
   */
  function scan(sql, visit) {
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      const next = sql[i + 1];

      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        visit(ch, i, false);
        continue;
      }

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          visit(ch, i, false);
          visit(next, i + 1, false);
          i++;
          inBlockComment = false;
          continue;
        }
        visit(ch, i, false);
        continue;
      }

      if (inSingle) {
        visit(ch, i, false);
        // '' is an escaped quote; \' is one too in MySQL.
        if (ch === "\\" && next !== undefined) {
          visit(next, i + 1, false);
          i++;
        } else if (ch === "'") {
          inSingle = false;
        }
        continue;
      }

      if (inDouble) {
        visit(ch, i, false);
        if (ch === "\\" && next !== undefined) {
          visit(next, i + 1, false);
          i++;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }

      if (inBacktick) {
        visit(ch, i, false);
        if (ch === "`") inBacktick = false;
        continue;
      }

      if (ch === "-" && next === "-") {
        inLineComment = true;
        visit(ch, i, false);
        continue;
      }
      if (ch === "#") {
        inLineComment = true;
        visit(ch, i, false);
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        visit(ch, i, false);
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        visit(ch, i, false);
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        visit(ch, i, false);
        continue;
      }
      if (ch === "`") {
        inBacktick = true;
        visit(ch, i, false);
        continue;
      }

      visit(ch, i, true);
    }
  }

  /**
   * Blank out every non-code character, preserving offsets. Regex-based
   * inspection then runs against a string where literals cannot match.
   */
  function codeMask(sql) {
    const out = new Array(sql.length).fill(" ");
    scan(sql, (ch, i, isCode) => {
      if (isCode) out[i] = ch;
    });
    return out.join("");
  }

  // ==========================================================================
  // 1. Placeholder normalisation
  // ==========================================================================
  /**
   * Rewrite every placeholder style oxmysql accepts into a positional ?, and
   * return the parameter key each one came from.
   *
   * oxmysql callers pass either an array (for ?) or an object (for @name and
   * :name). The returned `keys` array records, per positional placeholder,
   * which key of that object to read - or the numeric index for ?.
   *
   * @returns {{sql: string, keys: Array<string|number>}}
   */
  function normalizePlaceholders(sql) {
    const mask = codeMask(sql);
    const keys = [];
    let out = "";
    let positional = 0;
    let i = 0;

    while (i < sql.length) {
      // Only treat it as a placeholder if it is real code, not a literal.
      if (mask[i] === "?") {
        keys.push(positional++);
        out += "?";
        i++;
        continue;
      }

      if (mask[i] === "@" || mask[i] === ":") {
        // ":=" is an assignment, and "::" is a cast - neither is a parameter.
        const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(mask.slice(i + 1));
        if (nameMatch) {
          keys.push(nameMatch[0]);
          out += "?";
          i += 1 + nameMatch[0].length;
          continue;
        }
      }

      out += sql[i];
      i++;
    }

    return { sql: out, keys };
  }

  /**
   * Turn positional ? into PocketBase's {:pN} bind syntax and build the
   * matching params object from whatever shape the caller supplied.
   */
  function toPocketBaseParams(sql, keys, params) {
    const mask = codeMask(sql);
    const bound = {};
    let out = "";
    let n = 0;

    for (let i = 0; i < sql.length; i++) {
      if (mask[i] === "?") {
        const name = `p${n}`;
        const key = keys[n];

        let value;
        if (Array.isArray(params)) {
          value = params[typeof key === "number" ? key : n];
        } else if (params && typeof params === "object") {
          value = typeof key === "number" ? params[key] : params[key];
        }

        // PocketBase binds undefined poorly; NULL is the honest equivalent.
        bound[name] = value === undefined ? null : value;

        out += `{:${name}}`;
        n++;
        continue;
      }
      out += sql[i];
    }

    return { sql: out, params: bound };
  }

  // ==========================================================================
  // 2. MySQL-only rewrites
  // ==========================================================================

  /**
   * INSERT ... ON DUPLICATE KEY UPDATE has no direct SQLite equivalent.
   * SQLite's ON CONFLICT DO UPDATE requires an explicit conflict target,
   * while MySQL infers it from whichever unique key collided - so the target
   * has to come from the table's schema, which the caller supplies.
   *
   * @param {string} sql
   * @param {function(string): string[]|null} resolveConflictTarget
   *   Given a table name, returns the columns of its primary/unique key.
   */
  function splitUpsert(sql, resolveConflictTarget) {
    const mask = codeMask(sql);
    const dupMatch = /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.exec(mask);
    if (!dupMatch) return null;

    const tableMatch = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+([`"\[]?)([A-Za-z0-9_$]+)\1/i.exec(
      mask,
    );
    if (!tableMatch) {
      throw new SQLTranslationError(
        "ON DUPLICATE KEY UPDATE found but the target table could not be identified",
        { sql, construct: "ON DUPLICATE KEY UPDATE" },
      );
    }

    const table = tableMatch[2];

    // MySQL's ON DUPLICATE KEY fires on any unique constraint, while SQLite
    // demands one named target. Hand the resolver the columns being inserted so
    // it can pick the constraint this statement can actually violate.
    const columnListMatch = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+[`"\[]?[A-Za-z0-9_$]+[`"\]]?\s*\(([^)]*)\)/i.exec(
      mask.slice(0, dupMatch.index),
    );
    const insertColumns = columnListMatch
      ? columnListMatch[1]
          .split(",")
          .map((c) => c.trim().replace(/^[`"\[]|[`"\]]$/g, ""))
          .filter(Boolean)
      : [];

    const target = resolveConflictTarget
      ? resolveConflictTarget(table, insertColumns)
      : null;

    if (!target || target.length === 0) {
      throw new SQLTranslationError(
        `ON DUPLICATE KEY UPDATE on "${table}" cannot be translated: the table has no primary key or unique index for SQLite to use as a conflict target`,
        { sql, construct: "ON DUPLICATE KEY UPDATE" },
      );
    }

    // MySQL's VALUES(col) refers to the row that would have been inserted;
    // SQLite spells that excluded.col. Backticks keep it parseable as MySQL,
    // since the assignment list is transpiled as MySQL below.
    const assignments = sql
      .slice(dupMatch.index + dupMatch[0].length)
      .replace(/;\s*$/, "")
      .replace(
        /\bVALUES\s*\(\s*([`"]?)([A-Za-z0-9_$]+)\1\s*\)/gi,
        (_m, _q, col) => `excluded.\`${col}\``,
      );

    return {
      table,
      target,
      insert: sql.slice(0, dupMatch.index).replace(/;\s*$/, "").trim(),
      assignments: assignments.trim(),
    };
  }

  /**
   * SQLite only supports LIMIT on DELETE/UPDATE when compiled with
   * SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which PocketBase's driver is not.
   * Silently dropping the LIMIT would delete more rows than asked, so the
   * statement is rewritten to bound itself through rowid instead.
   */
  function rewriteDeleteLimit(sql) {
    const mask = codeMask(sql);

    const head = /^\s*DELETE\s+FROM\s+([`"\[]?)([A-Za-z0-9_$]+)\1/i.exec(mask);
    if (!head) return sql;

    // Only a LIMIT at the statement's own level counts; one inside a
    // subquery is already legal and must be left alone.
    const limitIndex = findTopLevel(mask, /\bLIMIT\b/gi);
    if (limitIndex === -1) return sql;

    const table = head[2];
    const clauses = sql.slice(head.index + head[0].length, limitIndex).trim();
    const limit = sql
      .slice(limitIndex + "LIMIT".length)
      .replace(/;\s*$/, "")
      .trim();

    return (
      `DELETE FROM \`${table}\` WHERE rowid IN ` +
      `(SELECT rowid FROM \`${table}\` ${clauses} LIMIT ${limit})`
    );
  }

  /**
   * Index of the first match that sits outside any parentheses, or -1.
   * Used to tell a statement's own clause from one inside a subquery.
   */
  function findTopLevel(mask, pattern) {
    const depths = parenDepths(mask);
    pattern.lastIndex = 0;

    let m;
    while ((m = pattern.exec(mask)) !== null) {
      if (depths[m.index] === 0) return m.index;
    }
    return -1;
  }

  /**
   * Parenthesis nesting depth at each character of a code-masked string.
   */
  function parenDepths(mask) {
    const depths = new Array(mask.length).fill(0);
    let depth = 0;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === "(") {
        depths[i] = depth;
        depth++;
        continue;
      }
      if (mask[i] === ")") {
        depth = Math.max(0, depth - 1);
      }
      depths[i] = depth;
    }
    return depths;
  }

  /**
   * Functions SQLite has no equivalent for, expressed in terms it does have.
   */
  function rewriteFunctions(sql) {
    let out = sql;

    // UNIX_TIMESTAMP() -> seconds since epoch, now.
    out = out.replace(
      /\bUNIX_TIMESTAMP\s*\(\s*\)/gi,
      "CAST(strftime('%s','now') AS INTEGER)",
    );
    // UNIX_TIMESTAMP(expr) -> seconds since epoch for expr.
    out = out.replace(
      /\bUNIX_TIMESTAMP\s*\(([^()]*)\)/gi,
      (_m, arg) => `CAST(strftime('%s',${arg}) AS INTEGER)`,
    );
    // FROM_UNIXTIME(expr) -> datetime text.
    out = out.replace(
      /\bFROM_UNIXTIME\s*\(([^()]*)\)/gi,
      (_m, arg) => `datetime(${arg},'unixepoch')`,
    );
    // MySQL's two-argument IF() is SQLite's IIF().
    out = out.replace(/\bIF\s*\(/gi, "IIF(");

    return out;
  }

  /**
   * Strip the parts of a CREATE TABLE that only MySQL understands, and hand
   * back the indexes that have to become separate statements.
   *
   * @returns {{sql: string, extraStatements: string[]}}
   */
  function rewriteCreateTable(sql) {
    const mask = codeMask(sql);
    const extraStatements = [];

    if (!/^\s*CREATE\s+(TEMPORARY\s+)?TABLE\b/i.exec(mask)) {
      return { sql, extraStatements };
    }

    // Read the name off the original statement, not the mask: codeMask blanks
    // quoted identifiers, so `CREATE TABLE IF NOT EXISTS \`players\`` left
    // nothing for the name group to match. The old pattern then backtracked
    // out of its optional IF-NOT-EXISTS branch and captured "IF" - building
    // every inline index on a table of that name. Anchoring at the start is
    // what keeps this safe to run against the unmasked text: a string literal
    // cannot precede the CREATE.
    const tableMatch =
      /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"\[]([^`"\]]+)[`"\]]|([A-Za-z0-9_$]+))/i.exec(
        sql,
      );
    const table = tableMatch ? tableMatch[1] || tableMatch[2] : null;

    let out = sql;

    // Inline index definitions: MySQL allows them inside CREATE TABLE,
    // SQLite requires CREATE INDEX afterwards.
    out = out.replace(
      /,\s*(UNIQUE\s+)?(?:KEY|INDEX)\s+([`"]?)([A-Za-z0-9_$]+)\2\s*\(([^)]*)\)/gi,
      (_m, unique, _q, name, cols) => {
        if (table) {
          const columns = cols
            .split(",")
            .map((c) => `"${c.trim().replace(/[`"]/g, "").replace(/\s*\(\d+\)$/, "")}"`)
            .join(", ");
          extraStatements.push(
            `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${table}_${name}" ON "${table}" (${columns})`,
          );
        }
        return "";
      },
    );

    // ON UPDATE CURRENT_TIMESTAMP has no column-level equivalent; it needs a
    // trigger. Capture the column, drop the clause.
    out = out.replace(
      /([`"]?)([A-Za-z0-9_$]+)\1(\s+[A-Za-z]+(?:\([^)]*\))?[^,)]*?)\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP/gi,
      (_m, _q, col, rest) => {
        if (table) {
          extraStatements.push(
            `CREATE TRIGGER IF NOT EXISTS "${table}_${col}_onupdate" ` +
              `AFTER UPDATE ON "${table}" FOR EACH ROW BEGIN ` +
              `UPDATE "${table}" SET "${col}" = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid; END`,
          );
        }
        return `${col}${rest}`;
      },
    );

    // SQLite accepts AUTOINCREMENT only on a column declared exactly INTEGER
    // PRIMARY KEY - a display width makes it a different type token and the
    // statement is rejected with "AUTOINCREMENT is only allowed on an INTEGER
    // PRIMARY KEY". mysqldump writes `int(11) NOT NULL AUTO_INCREMENT` for
    // essentially every table it has ever produced, so the width has to go.
    // Only on the auto-increment column: elsewhere the width is harmless and
    // worth keeping as documentation of the original schema.
    out = out.replace(
      /\b(INT|INTEGER|BIGINT|MEDIUMINT|SMALLINT|TINYINT)\s*\(\s*\d+\s*\)([^,)]*?\bAUTO_INCREMENT\b)/gi,
      (_m, type, rest) => `${type}${rest}`,
    );

    // Table options SQLite has no concept of.
    out = out.replace(
      /\)\s*(ENGINE\s*=\s*\w+|DEFAULT\s+CHARSET\s*=\s*\w+|CHARACTER\s+SET\s+\w+|COLLATE\s*=?\s*\w+|AUTO_INCREMENT\s*=\s*\d+|ROW_FORMAT\s*=\s*\w+|COMMENT\s*=\s*'[^']*'|\s)*\s*;?\s*$/i,
      ")",
    );

    // Clean up any empty column-list entries left by the removals above.
    out = out.replace(/,\s*,/g, ",").replace(/\(\s*,/g, "(").replace(/,\s*\)/g, ")");

    return { sql: out, extraStatements };
  }

  /**
   * Text types whose MySQL default collation compares case-insensitively.
   */
  const TEXT_TYPE = /\b(?:CHARACTER\s+VARYING|VARCHAR|NVARCHAR|VARCHAR2|NCHAR|CHAR|TINYTEXT|MEDIUMTEXT|LONGTEXT|TEXT|CLOB|ENUM)\b(\s*\([^)]*\))?/i;

  // Entries in a column list that define a constraint rather than a column.
  const TABLE_CONSTRAINT =
    /^\s*(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|KEY|INDEX)\b/i;

  // A column the author deliberately made byte-exact. MySQL's own way of
  // asking for case-sensitivity, so it must be honoured, not overridden.
  const EXPLICIT_BINARY = /\b(?:BINARY|COLLATE\s+\w*(?:_bin|_cs|BINARY)\w*)\b/i;

  // The only three collations SQLite knows.
  const SQLITE_COLLATIONS = /^(?:BINARY|NOCASE|RTRIM)$/i;

  /**
   * Translate a MySQL collation name into the nearest SQLite one.
   *
   * `COLLATE utf8mb4_bin` passes the safety gate untouched - it is valid
   * MySQL, not a construct with no equivalent - but SQLite raises "no such
   * collating sequence" the moment the table is used. Mapping by suffix
   * preserves the author's actual intent, which is only ever one of two
   * things: compare exactly, or compare case-insensitively.
   */
  function mapCollation(entry) {
    return entry.replace(/\bCOLLATE\s+([A-Za-z0-9_]+)/gi, (whole, name) => {
      if (SQLITE_COLLATIONS.test(name)) return whole;
      if (/(?:_bin|_cs)$/i.test(name)) return "COLLATE BINARY";
      return "COLLATE NOCASE";
    });
  }

  /**
   * Give text columns MySQL's case-insensitive comparison behaviour.
   *
   * This is the difference most likely to bite a script moved from MySQL and
   * the least likely to be noticed. MySQL's default collation
   * (utf8mb4_general_ci and friends) compares case-insensitively, so
   * `WHERE license = 'LICENSE:AB12'` finds a row stored as 'license:ab12'.
   * SQLite compares TEXT byte-for-byte, so the same query returns nothing at
   * all - no error, just a player whose data has apparently vanished.
   *
   * COLLATE NOCASE on the column carries that behaviour into =, IN, LIKE,
   * ORDER BY, GROUP BY and unique indexes alike, which also matches MySQL,
   * where 'ABC' and 'abc' collide in a UNIQUE key.
   *
   * Two limits worth stating rather than hiding:
   *   - SQLite's NOCASE folds ASCII only, so 'Ä' and 'ä' still differ. MySQL's
   *     general_ci does fold them. Identifiers in FiveM scripts - licenses,
   *     citizen ids, plates - are ASCII in practice.
   *   - Applied at CREATE TABLE, so it governs tables this resource creates.
   *     A table created before this existed keeps binary collation until it
   *     is recreated.
   *
   * A column that explicitly asks for BINARY or a _bin/_cs collation is left
   * alone.
   */
  function applyTextCollation(sql) {
    const mask = codeMask(sql);

    if (!/^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(mask)) return sql;

    const open = mask.indexOf("(");
    if (open === -1) return sql;

    const depths = parenDepths(mask);

    // The matching close paren for the column list.
    let close = -1;
    for (let i = open + 1; i < mask.length; i++) {
      if (mask[i] === ")" && depths[i] === 0) {
        close = i;
        break;
      }
    }
    if (close === -1) return sql;

    // Top-level commas separate one column or constraint from the next.
    const bounds = [open + 1];
    for (let i = open + 1; i < close; i++) {
      if (mask[i] === "," && depths[i] === 1) bounds.push(i + 1);
    }
    bounds.push(close + 1);

    let out = "";
    let cursor = 0;

    for (let b = 0; b < bounds.length - 1; b++) {
      const start = bounds[b];
      // Everything up to the separator, without the separator itself.
      const end = bounds[b + 1] - 1;
      const entry = sql.slice(start, end);

      out += sql.slice(cursor, start);
      cursor = end;

      if (/\bCOLLATE\b/i.test(entry)) {
        // Already spoken for - only make the name one SQLite recognises.
        out += mapCollation(entry);
        continue;
      }

      if (TABLE_CONSTRAINT.test(entry) || EXPLICIT_BINARY.test(entry)) {
        out += entry;
        continue;
      }

      const type = TEXT_TYPE.exec(entry);
      if (!type) {
        out += entry;
        continue;
      }

      const at = type.index + type[0].length;
      out += `${entry.slice(0, at)} COLLATE NOCASE${entry.slice(at)}`;
    }

    return out + sql.slice(cursor);
  }

  // ==========================================================================
  // 4. The safety gate
  // ==========================================================================
  /**
   * Constructs that must never survive into the SQL handed to SQLite.
   * Polyglot reports success while passing several of these through, so this
   * check is what stands between a bad translation and corrupt data.
   */
  const UNTRANSLATED = [
    [/\bON\s+DUPLICATE\s+KEY\b/i, "ON DUPLICATE KEY UPDATE"],
    [/\bUNIX_TIMESTAMP\s*\(/i, "UNIX_TIMESTAMP()"],
    [/\bFROM_UNIXTIME\s*\(/i, "FROM_UNIXTIME()"],
    [/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i, "ON UPDATE CURRENT_TIMESTAMP"],
    [/\bAUTO_INCREMENT\b/i, "AUTO_INCREMENT"],
    [/\bENGINE\s*=/i, "ENGINE="],
    [/\bDEFAULT\s+CHARSET\b/i, "DEFAULT CHARSET"],
    [/\b(UNIQUE\s+)?KEY\s+[`"]?[A-Za-z0-9_$]+[`"]?\s*\(/i, "inline KEY/INDEX definition"],
    [/\bSEPARATOR\b/i, "GROUP_CONCAT ... SEPARATOR"],
    [/\bSTRAIGHT_JOIN\b/i, "STRAIGHT_JOIN"],
    [/\bSQL_CALC_FOUND_ROWS\b/i, "SQL_CALC_FOUND_ROWS"],
    [/\bDATE_ADD\s*\(|\bDATE_SUB\s*\(/i, "DATE_ADD()/DATE_SUB()"],
    [/\bINTERVAL\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\b/i, "INTERVAL"],
    [/`/, "backtick-quoted identifier"],
  ];

  /**
   * SQLite rejects LIMIT on DELETE/UPDATE unless built with
   * SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which PocketBase's driver is not.
   * Only a top-level LIMIT is a problem - the rowid rewrite above puts a
   * perfectly legal one inside a subquery.
   */
  function hasTopLevelWriteLimit(mask) {
    if (!/^\s*(DELETE|UPDATE)\b/i.test(mask)) return false;
    return findTopLevel(mask, /\bLIMIT\b/gi) !== -1;
  }

  /**
   * Reject SQL that still contains MySQL-only syntax after translation.
   * @throws {SQLTranslationError}
   */
  function assertTranslated(translated, originalSql) {
    const mask = codeMask(translated);

    for (const [pattern, construct] of UNTRANSLATED) {
      if (pattern.test(mask)) {
        throw new SQLTranslationError(
          `Cannot translate MySQL to SQLite: unsupported construct ${construct}. ` +
            `Rewrite the query, or use the PocketBase exports directly.`,
          { sql: originalSql, construct, translated },
        );
      }
    }

    if (hasTopLevelWriteLimit(mask)) {
      throw new SQLTranslationError(
        "Cannot translate MySQL to SQLite: unsupported construct DELETE/UPDATE ... LIMIT. " +
          "Rewrite the query, or use the PocketBase exports directly.",
        { sql: originalSql, construct: "DELETE/UPDATE ... LIMIT", translated },
      );
    }
  }

  // ==========================================================================
  // Translation
  // ==========================================================================
  const cache = new Map();
  const MAX_CACHE_ENTRIES = 2000;

  /**
   * Translate a MySQL statement into SQLite, with PocketBase bind syntax.
   *
   * @param {string} sql MySQL statement as written by the calling script.
   * @param {object|array} params Values for its placeholders.
   * @param {object} [options]
   * @param {function(string): string[]|null} [options.resolveConflictTarget]
   *   Maps a table name to its primary/unique key columns. Required only for
   *   ON DUPLICATE KEY UPDATE.
   * @returns {{sql: string, params: object, extraStatements: string[]}}
   * @throws {SQLTranslationError} when faithful translation is not possible.
   */
  function translate(sql, params, options = {}) {
    if (typeof sql !== "string" || sql.trim() === "") {
      throw new SQLTranslationError("Empty SQL statement", { sql });
    }

    if (!isReady()) {
      throw new SQLTranslationError(
        "SQL translator is not initialised yet - await init() first",
        { sql },
      );
    }

    // Cache on the query shape. Parameters are bound separately, so the same
    // shape always yields the same translated SQL.
    const cacheKey = sql;
    let shape = cache.get(cacheKey);

    if (!shape) {
      shape = buildShape(sql, options);

      if (cache.size >= MAX_CACHE_ENTRIES) {
        // Plain FIFO eviction; query shapes are stable, so this only trims
        // pathological cases such as unparameterised generated SQL.
        cache.delete(cache.keys().next().value);
      }
      cache.set(cacheKey, shape);
    }

    const bound = toPocketBaseParams(shape.sql, shape.keys, params);

    return {
      sql: bound.sql,
      params: bound.params,
      extraStatements: shape.extraStatements,
    };
  }

  /**
   * Transpile MySQL to SQLite, turning a parse failure into our own error.
   */
  function transpileOrThrow(sql, originalSql) {
    const result = polyglot.transpile(sql, "mysql", "sqlite");

    if (!result.success || !result.sql || !result.sql[0]) {
      throw new SQLTranslationError(
        `Could not parse SQL as MySQL: ${result.error}`,
        { sql: originalSql },
      );
    }
    return result.sql[0];
  }

  /**
   * Pull the assignment list back out of a transpiled dummy UPDATE.
   */
  function extractSetClause(updateSql, originalSql) {
    const mask = codeMask(updateSql);
    const setIndex = findTopLevel(mask, /\bSET\b/gi);

    if (setIndex === -1) {
      throw new SQLTranslationError(
        "Could not translate the ON DUPLICATE KEY UPDATE assignment list",
        { sql: originalSql, construct: "ON DUPLICATE KEY UPDATE" },
      );
    }
    return updateSql.slice(setIndex + "SET".length).trim();
  }

  /**
   * Run the full pipeline for one query shape.
   */
  function buildShape(originalSql, options) {
    const normalized = normalizePlaceholders(originalSql);

    let working = normalized.sql;
    let extraStatements = [];

    // MySQL-side rewrites, before the transpiler sees the statement.
    working = rewriteFunctions(working);
    working = rewriteDeleteLimit(working);

    const created = rewriteCreateTable(working);
    working = created.sql;
    extraStatements = created.extraStatements;

    // ON CONFLICT is not MySQL syntax, so an upsert cannot be assembled
    // before transpiling - the MySQL parser would reject its own output.
    // Translate the INSERT and the assignment list separately, then join
    // them with the SQLite clause.
    const upsert = splitUpsert(working, options.resolveConflictTarget);

    let translated;
    if (upsert) {
      const insertSql = transpileOrThrow(upsert.insert, originalSql);
      const setSql = extractSetClause(
        transpileOrThrow(
          `UPDATE \`${upsert.table}\` SET ${upsert.assignments}`,
          originalSql,
        ),
        originalSql,
      );

      const targetList = upsert.target.map((c) => `"${c}"`).join(", ");
      translated = `${insertSql} ON CONFLICT (${targetList}) DO UPDATE SET ${setSql}`;
    } else {
      translated = transpileOrThrow(working, originalSql);
    }

    // Polyglot returns success even when it has passed a MySQL-only
    // construct through untouched, so verify rather than trust.
    assertTranslated(translated, originalSql);

    // After the gate, because it deliberately introduces a COLLATE clause
    // that MySQL-side checks have no reason to expect.
    if (options.textCollation !== false) {
      translated = applyTextCollation(translated);
    }

    return {
      sql: translated,
      keys: normalized.keys,
      extraStatements,
    };
  }

  function clearCache() {
    cache.clear();
  }

  return {
    init,
    isReady,
    translate,
    clearCache,
    SQLTranslationError,
    // Exposed for tests.
    _internal: {
      normalizePlaceholders,
      toPocketBaseParams,
      splitUpsert,
      rewriteDeleteLimit,
      rewriteFunctions,
      rewriteCreateTable,
      assertTranslated,
      codeMask,
    },
  };
})();
