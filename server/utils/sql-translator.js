/**
 * MySQL -> SQLite translation for the oxmysql compatibility layer. It must never
 * return plausible-looking wrong data: anything it cannot translate faithfully
 * fails loudly, naming the construct, rather than reading back quietly empty.
 *
 * Pipeline: ?, @name and :name all become positional ? (a MySQL parser reads
 * @name as a user variable, not a bind parameter), MySQL-only constructs are
 * rewritten, Polyglot (WASM sqlglot port) does the lexical dialect work,
 * assertTranslated rejects whatever MySQL-only syntax survived it, and ? finally
 * becomes PocketBase's {:pN}. Cached by query shape.
 */
module.exports = (function () {
  // Mirrors OxMySQLAdapter.NO_CONFLICT_POSSIBLE. Kept as a literal so the
  // translator does not have to require the adapter.
  const NO_CONFLICT_POSSIBLE = "__tdb_no_conflict_possible";

  // Relative to this file: a required module resolves from its own directory,
  // unlike a manifest server_script, which resolves from the resource root.
  const polyglot = require("../vendor/polyglot/index.cjs");

  let initPromise = null;

  // Safe to call repeatedly; the load happens once.
  function init() {
    if (!initPromise) {
      initPromise = polyglot.init();
    }
    return initPromise;
  }

  function isReady() {
    return polyglot.isInitialized();
  }

  // Carries the original SQL and the offending construct, so the console line
  // is actionable.
  class SQLTranslationError extends Error {
    constructor(message, { sql, construct, translated } = {}) {
      super(message);
      this.name = "SQLTranslationError";
      this.sql = sql;
      this.construct = construct;
      this.translated = translated;
    }
  }

  /**
   * Walk SQL, calling visit(char, index, isCode) per character, where isCode
   * means outside string literals, quoted identifiers and comments. Every
   * rewrite below uses this so a '?' or '@' inside a string value is never
   * mistaken for a placeholder.
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

  // Blank out every non-code character, preserving offsets, so regex inspection
  // runs against a string where literals cannot match.
  function codeMask(sql) {
    const out = new Array(sql.length).fill(" ");
    scan(sql, (ch, i, isCode) => {
      if (isCode) out[i] = ch;
    });
    return out.join("");
  }

  /**
   * Rewrite every placeholder style oxmysql accepts into a positional ?.
   * Callers pass an array (for ?) or an object (for @name and :name), so the
   * returned `keys` records per placeholder which object key to read, or the
   * numeric index for ?.
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

  // Positional ? becomes PocketBase's {:pN}, with a params object built from
  // whatever shape the caller supplied.
  // Scalars go to SQLite as text, and SQLite applies the destination column's
  // affinity to convert them back: '42' bound into an INTEGER column stores the
  // integer 42, and `credit > '0'` compares numerically.
  //
  // This is what lets PocketBase own a table without breaking its callers.
  // PocketBase's `id` is always TEXT, and SQLite applies affinity to literals
  // but NOT to bound parameters, so `WHERE id = ?` with the number 5 silently
  // matched nothing against an id stored as '5'. Measured: text binding matches
  // and still uses the primary key index, where a `CAST(id AS INTEGER)` rewrite
  // both broke id 0 and forced a table scan.
  //
  // It also tracks MySQL more closely than the old behaviour did, since MySQL
  // compares '7' = 7 as equal.
  function bindValue(value) {
    if (value === undefined || value === null) return null;

    // A BLOB has to stay bytes, or it lands as the text of its own toString.
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;

    // '1'/'0', never 'true'/'false': an INTEGER column cannot convert the words
    // and would keep them as text.
    if (typeof value === "boolean") return value ? "1" : "0";

    if (typeof value === "bigint") return String(value);

    if (typeof value === "number") {
      // NaN and Infinity have no SQL spelling; NULL is the honest answer.
      if (!Number.isFinite(value)) return null;
      return String(value);
    }

    // Tables, dates and anything else keep the shape they already had, so this
    // changes binding for scalars only.
    return value;
  }

  /**
   * Read a named parameter out of the caller's table, accepting the prefix.
   *
   * oxmysql takes both `{ x = 1 }` and `{ ['@x'] = 1 }` for `@x`, and its own
   * documentation shows the prefixed form, so that is what resources write.
   * lb-phone's backup.lua builds `params["@identifier"]`, and reading only the
   * bare name bound it to NULL - which `phone_backups.id` being NOT NULL turned
   * into a visible constraint failure, but which on any nullable column stored
   * NULL and in any WHERE clause matched nothing, both without an error.
   *
   * The bare name is tried first, then each prefix. Presence is tested with
   * hasOwnProperty rather than `=== undefined`, so a caller that deliberately
   * passes `{ x: null }` still gets NULL instead of falling through to a
   * differently-keyed value.
   */
  function readNamedParam(params, name) {
    if (!params || typeof params !== "object") return undefined;
    for (const candidate of [name, `@${name}`, `:${name}`]) {
      if (Object.prototype.hasOwnProperty.call(params, candidate)) return params[candidate];
    }
    return undefined;
  }

  /**
   * mysql2 expands an array parameter into a list; tDB has to do it itself.
   *
   * `WHERE id IN (?)` with `{ {1,2,3} }` is routine oxmysql - 20 statements in
   * the corpus use it, most of them esx_core's - and mysql2 interpolates it to
   * `IN (1, 2, 3)`. tDB bound the array as ONE value, so the statement became
   * `IN ({:p0})` with `p0` an array: zero rows, no error. Measured.
   *
   * Two shapes, matching mysql2's own:
   *   [1, 2, 3]          -> `?, ?, ?`           (an IN list)
   *   [[1, 2], [3, 4]]   -> `(?, ?), (?, ?)`    (a row list, for VALUES)
   *
   * A Buffer is NOT a list: it is one BLOB value, and `instanceof Uint8Array`
   * catches both it and a raw typed array before the array test can.
   *
   * An empty array yields a single NULL bind rather than an empty list. mysql2
   * would emit `IN ()`, which is a syntax error in MySQL and in SQLite alike;
   * `IN (NULL)` is valid and matches nothing, which is the result a caller
   * passing an empty list is actually after. Deliberate divergence: it can only
   * turn a crash into zero rows, never corrupt anything.
   */
  function isBindList(value) {
    if (!Array.isArray(value)) return false;
    return true;
  }

  function expandListBind(value, name, bound) {
    // Empty: one NULL, so the surrounding parens stay legal.
    if (!value.length) {
      bound[`${name}_0`] = null;
      return `{:${name}_0}`;
    }

    const rows = value.every((entry) => Array.isArray(entry));
    let n = 0;

    if (rows) {
      return value
        .map((row) => {
          const cells = row.map((cell) => {
            const key = `${name}_${n++}`;
            bound[key] = bindValue(cell);
            return `{:${key}}`;
          });
          return `(${cells.join(", ")})`;
        })
        .join(", ");
    }

    return value
      .map((entry) => {
        const key = `${name}_${n++}`;
        bound[key] = bindValue(entry);
        return `{:${key}}`;
      })
      .join(", ");
  }

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
          // A Lua table that does not arrive as a JS array arrives 1-indexed,
          // which is why oxmysql reads parameters[i + 1] for the positional
          // case. A named placeholder keeps its own key either way.
          value = typeof key === "number" ? params[key + 1] : readNamedParam(params, key);
        }

        // An array stands for a LIST of binds, not one value. Done here rather
        // than in buildShape because the expansion depends on the value, and
        // the shape is cached by SQL text - toPocketBaseParams runs per call,
        // so this is the only place that can see how many elements there are.
        if (isBindList(value) && !(value instanceof Uint8Array)) {
          out += expandListBind(value, name, bound);
          n++;
          continue;
        }

        bound[name] = bindValue(value);

        out += `{:${name}}`;
        n++;
        continue;
      }
      out += sql[i];
    }

    // oxmysql's parseArguments throws here, and matching that matters more than
    // being lenient: too many parameters means the caller's count is wrong, and
    // quietly dropping the extras turns a loud bug into a silent one. Fewer
    // than needed is still padded with NULL above, which oxmysql also does.
    if (n > 0 && Array.isArray(params) && params.length > n) {
      throw new SQLTranslationError(`Expected ${n} parameters, but received ${params.length}.`, {
        sql,
      });
    }

    return { sql: out, params: bound };
  }

  /**
   * INSERT ... ON DUPLICATE KEY UPDATE has no direct SQLite equivalent: ON
   * CONFLICT DO UPDATE needs an explicit target, where MySQL infers it from
   * whichever unique key collided. resolveConflictTarget(table, insertColumns)
   * supplies that target from the table's schema.
   */
  function splitUpsert(sql, resolveConflictTarget) {
    const mask = codeMask(sql);
    const dupMatch = /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.exec(mask);
    if (!dupMatch) return null;

    // Read the name off `sql`, NOT `mask`. codeMask blanks quoted identifiers,
    // so a backticked table - which is how qbx_core, qbx_management and every
    // mysqldump write it - matched nothing here and the upsert was refused with
    // "the target table could not be identified" despite the table being right
    // there. Safe unmasked: a string literal cannot precede INSERT INTO.
    const tableMatch = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+([`"[]?)([A-Za-z0-9_$]+)\1/i.exec(sql);
    if (!tableMatch) {
      throw new SQLTranslationError(
        "ON DUPLICATE KEY UPDATE found but the target table could not be identified",
        { sql, construct: "ON DUPLICATE KEY UPDATE" }
      );
    }

    const table = tableMatch[2];

    // The resolver gets the inserted columns so it can pick a constraint this
    // statement can actually violate.
    const columnListMatch =
      // Also off `sql`, for the same reason: the column names are quoted too.
      /\bINSERT\s+(?:IGNORE\s+)?INTO\s+[`"[]?[A-Za-z0-9_$]+[`"\]]?\s*\(([^)]*)\)/i.exec(
        sql.slice(0, dupMatch.index)
      );
    const insertColumns = columnListMatch
      ? columnListMatch[1]
          .split(",")
          .map((c) => c.trim().replace(/^[`"\[]|[`"\]]$/g, ""))
          .filter(Boolean)
      : [];

    const target = resolveConflictTarget ? resolveConflictTarget(table, insertColumns) : null;

    // The resolver can report that no collision is possible at all, because the
    // insert supplies none of the columns of any unique key. MySQL's UPDATE
    // clause is unreachable in that case, so the faithful translation is the
    // INSERT on its own.
    if (target === NO_CONFLICT_POSSIBLE) {
      return {
        table,
        target: null,
        plainInsert: true,
        insert: sql.slice(0, dupMatch.index).replace(/;\s*$/, "").trim(),
        assignments: "",
      };
    }

    if (!target || target.length === 0) {
      throw new SQLTranslationError(
        `ON DUPLICATE KEY UPDATE on "${table}" cannot be translated: the table has no primary key or unique index for SQLite to use as a conflict target`,
        { sql, construct: "ON DUPLICATE KEY UPDATE" }
      );
    }

    // MySQL's VALUES(col) is SQLite's excluded.col. Backticks keep it parseable
    // as MySQL, since the assignment list is transpiled as MySQL below.
    const assignments = sql
      .slice(dupMatch.index + dupMatch[0].length)
      .replace(/;\s*$/, "")
      .replace(
        /\bVALUES\s*\(\s*([`"]?)([A-Za-z0-9_$]+)\1\s*\)/gi,
        (_m, _q, col) => `excluded.\`${col}\``
      );

    return {
      table,
      target,
      insert: sql.slice(0, dupMatch.index).replace(/;\s*$/, "").trim(),
      assignments: assignments.trim(),
    };
  }

  // SQLite takes LIMIT on DELETE/UPDATE only when built with
  // SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which PocketBase's driver is not. Dropping
  // the LIMIT would delete more rows than asked, so bound it through rowid.
  /**
   * ALTER TABLE forms MySQL has and SQLite does not.
   *
   * SQLite's ALTER TABLE can only rename, add a column, or drop a column: it
   * cannot add a constraint or change a column's type. Found by running the
   * corpus from esx_core, qbx_core and qb-core, where these appear 15 times and
   * all of them translated to SQL that SQLite then rejected at execution -
   * worse than a refusal, because it reaches the database before it fails.
   *
   * Indexes ARE expressible, so those are translated; the rest is refused by
   * name through the gate.
   */
  /**
   * Split an ALTER's action list on its TOP-LEVEL commas.
   *
   * A definition carries commas of its own - `DECIMAL(10,2)`, `ENUM('a','b')` -
   * so a plain split mangles them. Runs against the code mask so a comma inside
   * a string literal is invisible.
   */
  function splitAlterActions(rest) {
    const mask = codeMask(rest);
    const parts = [];
    let depth = 0;
    let start = 0;

    for (let i = 0; i < rest.length; i++) {
      const ch = mask[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(rest.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(rest.slice(start));

    return parts.map((part) => part.trim()).filter((part) => part !== "");
  }

  /**
   * Parse an ALTER TABLE into the action list table-rebuild.js takes, or null
   * when nothing here needs a rebuild.
   *
   * SQLite's ALTER TABLE cannot retype a column, change a default, add or
   * remove NOT NULL, or add a constraint - so MODIFY, CHANGE and ADD FOREIGN
   * KEY were refused by name. They are the largest remaining block of real
   * statements: 13 across esx_core, qbx_core, qbx_weed, qb-weed, vorp_core and
   * src-phone. The documented way to do all of them is to rebuild the table,
   * which is what table-rebuild.js plans; this only has to recognise the shape
   * and hand over the pieces.
   *
   * Returns null unless at least one action genuinely needs the rebuild, so an
   * ALTER that only adds columns or indexes keeps taking the cheaper existing
   * path.
   */
  function parseRebuildActions(sql) {
    const head = /^\s*ALTER\s+TABLE\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s+([\s\S]+?)\s*;?\s*$/i.exec(
      sql
    );
    if (!head) return null;

    const table = head[1];
    const actions = [];
    let needsRebuild = false;

    // Matched against the ORIGINAL text, not the code mask.
    //
    // codeMask blanks quoted identifiers, so `` MODIFY `ssn` VARCHAR(11) ``
    // masked to `MODIFY       VARCHAR(11)` and the identifier group captured
    // VARCHAR - the column name became the type word and every definition was
    // read one token late. Same trap splitUpsert documents for its table name.
    //
    // Safe on the original: each pattern is anchored at the start of an action,
    // and a string literal cannot begin one. The mask is still what split the
    // list, so a comma inside a literal never became an action boundary.
    for (const part of splitAlterActions(head[2])) {
      // CHANGE [COLUMN] <from> <to> <definition>
      const change =
        /^CHANGE\s+(?:COLUMN\s+)?[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s*([\s\S]*)$/i.exec(
          part
        );
      if (change) {
        actions.push({
          kind: "change",
          from: change[1],
          to: change[2],
          definition: change[3].trim(),
        });
        needsRebuild = true;
        continue;
      }

      // MODIFY [COLUMN] <col> <definition>
      const modify = /^MODIFY\s+(?:COLUMN\s+)?[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s+([\s\S]*)$/i.exec(
        part
      );
      if (modify) {
        actions.push({
          kind: "modify",
          column: modify[1],
          definition: modify[2].trim(),
        });
        needsRebuild = true;
        continue;
      }

      // ADD [CONSTRAINT <name>] FOREIGN KEY (cols) REFERENCES t (cols) [actions]
      //
      // SQLite cannot add a constraint in place, so this needs the table
      // rebuilt - the same machinery MODIFY uses. Previously refused by name,
      // which failed the whole file: qb-vehicleshop's install.sql adds its
      // player_vehicles -> players key this way.
      const foreignKey =
        /^ADD\s+(?:CONSTRAINT\s+[`"[]?[A-Za-z0-9_$]+[`"\]]?\s+)?(FOREIGN\s+KEY\b[\s\S]*)$/i.exec(
          part
        );
      if (foreignKey) {
        actions.push({ kind: "addForeignKey", definition: foreignKey[1].trim() });
        needsRebuild = true;
        continue;
      }

      // AUTO_INCREMENT=<n>, which mysqldump emits alongside a MODIFY.
      const seq = /^AUTO_INCREMENT\s*=\s*(\d+)$/i.exec(part);
      if (seq) {
        actions.push({ kind: "autoIncrementStart", value: Number(seq[1]) });
        needsRebuild = true;
        continue;
      }

      // ADD [COLUMN] [IF NOT EXISTS] <col> <definition>. Carried along rather
      // than left behind, because MySQL allows it in the same statement as a
      // MODIFY - qbx_core's players migration does exactly that - and the two
      // have to land together.
      const add =
        /^ADD\s+(?:COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s+([\s\S]*)$/i.exec(
          part
        );
      if (add) {
        actions.push({
          kind: "addColumn",
          column: add[2],
          definition: add[3].trim(),
          ifNotExists: Boolean(add[1]),
        });
        continue;
      }

      // Something else in the list. Hand nothing over rather than guess: a
      // partial rebuild is worse than a refusal that names the construct.
      return null;
    }

    if (!needsRebuild || !actions.length) return null;

    return { table, actions };
  }

  function rewriteAlterTable(sql) {
    const head = /^\s*ALTER\s+TABLE\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s+([\s\S]+?)\s*;?\s*$/i.exec(
      sql
    );
    if (!head) return { sql, extraStatements: [] };

    const table = head[1];
    const extraStatements = [];

    // ADD [UNIQUE] {KEY|INDEX} name (cols) -> CREATE [UNIQUE] INDEX.
    // MySQL allows several comma-separated actions in one statement, which is
    // why each is pulled out rather than matching the whole clause.
    let rest = head[2];
    const quoteCols = (cols) =>
      cols
        .split(",")
        .map(
          (c) =>
            `\`${c
              .trim()
              .replace(/[`"]/g, "")
              .replace(/\s+(ASC|DESC)$/i, "")}\``
        )
        .join(", ");

    // ADD PRIMARY KEY (cols) -> a UNIQUE INDEX.
    //
    // SQLite cannot add a primary key to an existing table, and this is the
    // shape mysqldump emits: CREATE TABLE with no key, then one ALTER adding
    // the primary key alongside the ordinary ones. esx_core's legacy.sql does it
    // for 10 tables, and refusing meant the whole file rolled back to zero
    // tables - so the entire framework schema failed over a constraint that is
    // mostly expressible.
    //
    // A UNIQUE INDEX keeps the uniqueness. It is NOT identical: MySQL's ADD
    // PRIMARY KEY also forces the columns NOT NULL, while SQLite's unique index
    // treats NULLs as distinct and would admit several. mysqldump declares
    // these columns NOT NULL in the CREATE TABLE anyway, which is why the gap
    // is narrow in practice - but it is a stated approximation, not a silent
    // one, and it is written up in the compatibility docs.
    const primaryAdd = /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/gi;

    rest = rest.replace(primaryAdd, (_m, cols) => {
      extraStatements.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`${table}_pk\` ON \`${table}\` (${quoteCols(cols)})`
      );
      return "";
    });

    // FULLTEXT and SPATIAL become plain indexes, as in CREATE TABLE, and
    // `IF NOT EXISTS` is tolerated: MariaDB accepts it on ADD INDEX and scripts
    // write it that way (anpr-for-wk_wars2x does).
    const indexAdd =
      /\bADD\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s*\(([^)]*)\)/gi;

    rest = rest.replace(indexAdd, (_m, unique, name, cols) => {
      const columns = cols
        .split(",")
        .map(
          (c) =>
            `\`${c
              .trim()
              .replace(/[`"]/g, "")
              .replace(/\s+(ASC|DESC)$/i, "")}\``
        )
        .join(", ");
      // Only UNIQUE earns UNIQUE; the prefix may also be FULLTEXT or SPATIAL,
      // and treating either as unique would reject rows MySQL accepted.
      extraStatements.push(
        `CREATE ${/UNIQUE/i.test(unique || "") ? "UNIQUE " : ""}INDEX IF NOT EXISTS \`${name}\` ON \`${table}\` (${columns})`
      );
      return "";
    });

    // DROP {INDEX|KEY} name -> DROP INDEX name.
    const indexDrop = /\bDROP\s+(?:INDEX|KEY)\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?/gi;
    rest = rest.replace(indexDrop, (_m, name) => {
      extraStatements.push(`DROP INDEX IF EXISTS \`${name}\``);
      return "";
    });

    // SQLite's ALTER TABLE takes exactly ONE action, where MySQL accepts a
    // comma-separated list. qbx_vehicleshop drops four columns in one
    // statement, which translated cleanly and then failed with "near ,".
    // Each action becomes its own statement.
    const columnActions = [];
    rest = rest.replace(
      /\b(DROP|ADD)\s+COLUMN\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?(?:[^,]*?)?)(?=\s*,|\s*$)/gi,
      (_m, verb, body) => {
        columnActions.push(`ALTER TABLE \`${table}\` ${verb.toUpperCase()} COLUMN ${body.trim()}`);
        return "";
      }
    );

    if (columnActions.length > 1) {
      // The first becomes the statement itself; the rest ride along.
      const [first, ...others] = columnActions;
      extraStatements.push(...others);
      return { sql: first, extraStatements };
    }
    if (columnActions.length === 1) {
      const onlyIndexesLeft = rest.replace(/[\s,]+/g, " ").trim() === "";
      if (onlyIndexesLeft) {
        return { sql: columnActions[0], extraStatements };
      }
      // Something unrecognised remains; leave the original for the gate.
      return { sql, extraStatements: [] };
    }

    // Whatever is left of the action list.
    const remaining = rest.replace(/[\s,]+/g, " ").trim();

    if (!remaining) {
      // Every action became an index statement, so the ALTER itself is a no-op.
      // SQLite has no empty statement, so the first index takes its place.
      const first = extraStatements.shift();
      return { sql: first || sql, extraStatements };
    }

    // Something is left that is not an index: keep the original so the gate
    // names it, and keep any index actions alongside.
    return { sql, extraStatements: [] };
  }

  /**
   * UPDATE ... JOIN, and multi-table DELETE, as an EXISTS subquery.
   *
   * SQLite updates exactly one table and has no JOIN in UPDATE; its own answer
   * is `UPDATE ... FROM`, which MySQL cannot parse - so the transpiler could
   * never see that form. An EXISTS subquery is the shape that is valid in BOTH
   * dialects, so the statement goes through the ordinary path with no marker:
   *
   *   UPDATE a JOIN b ON <on> SET a.x = ? WHERE <where>
   *   UPDATE a SET x = ? WHERE EXISTS (SELECT 1 FROM b WHERE <on> AND (<where>))
   *
   * Equivalent whenever the SET expressions do not read the joined table -
   * which all three real statements satisfy, since they all assign bound
   * parameters. When one does read it, EXISTS cannot carry the value across and
   * the statement is refused by name rather than guessed at.
   *
   * Two refusals, both about silence:
   *
   *   * A placeholder in the ON clause. MySQL's text order is ON, SET, WHERE
   *     and the EXISTS form's is SET, ON, WHERE; placeholders are paired with
   *     the rewritten statement by POSITION, so moving the ON clause past the
   *     SET list would re-pair every one of them. esx_core has exactly such a
   *     statement.
   *   * A SET expression naming the joined table or its alias.
   */
  /**
   * `INSERT INTO t VALUES (...)` -> `INSERT INTO t (a, b, c) VALUES (...)`.
   *
   * A column-list-free INSERT is positional, and once PocketBase owns a table
   * the column order is PocketBase's, not the dump's: measured on
   * phone_message_messages, where `id,channel_id,sender,content,...` became
   * `attachments,channel_id,content,id,...`. Every column survives, but values
   * written positionally would land in the wrong ones, silently - so this was
   * refused outright.
   *
   * Naming the columns removes the ambiguity, and the order to name them in is
   * knowable: pb-adopt records the pre-adoption order, and for a table that was
   * never adopted the live order IS the source order.
   *
   * Returns the statement unchanged when the order cannot be resolved, leaving
   * the gate to refuse it in its own words - a wrong expansion is exactly the
   * silent corruption the refusal existed to prevent.
   */
  function expandValuesInsert(sql, resolveColumnOrder) {
    if (typeof resolveColumnOrder !== "function") return sql;

    const head =
      /^(\s*(?:INSERT(?:\s+(?:OR\s+)?IGNORE)?|REPLACE)\s+INTO\s+)([`"[]?)([A-Za-z0-9_$]+)([`"\]]?)(\s+)(VALUES\b)/i.exec(
        sql
      );
    if (!head) return sql;

    const order = resolveColumnOrder(head[3]);
    if (!Array.isArray(order) || !order.length) return sql;

    // The first tuple decides the arity. A mismatch means the statement does
    // not describe this table, so it is left for the gate rather than padded.
    const mask = codeMask(sql);
    const open = mask.indexOf("(", head.index + head[0].length);
    if (open === -1) return sql;
    const close = matchingParen(sql, open);
    if (close === -1) return sql;

    let depth = 0;
    let count = 1;
    for (let i = open + 1; i < close; i++) {
      if (mask[i] === "(") depth++;
      else if (mask[i] === ")") depth--;
      else if (mask[i] === "," && depth === 0) count++;
    }

    if (count !== order.length) return sql;

    const list = order.map((name) => `\`${name}\``).join(", ");
    // head[6] is the VALUES keyword, which has to be put back: head[0] spans it,
    // so slicing past head[0] alone dropped it and produced
    // `INSERT INTO t (a, b) ('x', 1)`.
    return (
      `${head[1]}${head[2]}${head[3]}${head[4]} (${list}) ${head[6]}` +
      sql.slice(head.index + head[0].length)
    );
  }

  // How many bound placeholders a fragment carries. Counted on the mask, so a
  // `?` inside a string literal is not one.
  function countPlaceholders(fragment) {
    const mask = codeMask(String(fragment || ""));
    return (mask.match(/\?/g) || []).length;
  }

  /**
   * MySQL full-text search as a substring search across the same columns.
   *
   *   MATCH (a, b) AGAINST (? IN BOOLEAN MODE)
   *   (a LIKE CONCAT('%', ?, '%') OR b LIKE CONCAT('%', ?, '%'))
   *
   * A STATED APPROXIMATION, in the same class as ADD PRIMARY KEY becoming a
   * UNIQUE INDEX, and the reasoning is worth recording because the obvious
   * objection - "that is not full-text search" - matters less here than it
   * looks:
   *
   *   * SQLite's answer is FTS5, which is a virtual table. Using it would mean
   *     creating a shadow table per searched table plus triggers to keep it in
   *     sync, which a SELECT cannot do and which the caller never asked for.
   *   * No relevance ranking. Measured across the corpus: all 9 of these
   *     statements are ox_banking's and ox_mdt's, every one uses BOOLEAN MODE,
   *     and 7 of the 9 carry their own ORDER BY (role, callSign, id) - so they
   *     do not read relevance even under MySQL.
   *   * MySQL applies a minimum token length (innodb_ft_min_token_size, 3 by
   *     default), so a two-character search returns NOTHING there and does
   *     return rows here. More permissive, not less, and worth knowing.
   *   * BOOLEAN MODE's operators (+word, -word, word*) are taken LITERALLY.
   *     A search for `+john` looks for the text "+john".
   *
   * Without this the whole statement is refused, which is not "less wrong" - it
   * means the resource's search box returns an error instead of rows.
   *
   * Returns { sql, expansions } where each expansion records the original
   * placeholder index that was duplicated and how many copies it now has, so
   * buildShape can grow the key list to match.
   */
  function rewriteMatchAgainst(sql) {
    const mask = codeMask(sql);
    const pattern = /\bMATCH\s*\(([^)]*)\)\s*AGAINST\s*\(\s*([\s\S]*?)\s*\)/gi;

    const found = [];
    for (const match of mask.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;

      // Read the column list and the search term off `sql`, not the mask: a
      // backticked column is blanked there, and a quoted search literal with
      // it. Same trap as splitUpsert's table name.
      const columnsText = sql.slice(start, end).replace(/^\s*MATCH\s*\(/i, "");
      const closeColumns = columnsText.indexOf(")");
      const columns = columnsText
        .slice(0, closeColumns)
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean);

      const againstRaw = sql.slice(start, end).replace(/[\s\S]*?AGAINST\s*\(/i, "");
      // The mode keywords are MySQL-only and carry no meaning here.
      const term = againstRaw
        .replace(/\)\s*$/, "")
        .replace(
          /\s+IN\s+(?:BOOLEAN|NATURAL\s+LANGUAGE)\s+MODE(?:\s+WITH\s+QUERY\s+EXPANSION)?\s*$/i,
          ""
        )
        .replace(/\s+WITH\s+QUERY\s+EXPANSION\s*$/i, "")
        .trim();

      if (!columns.length || !term) continue;

      // Which original placeholder the term is, and how many it becomes. The
      // column list holds identifiers, so every `?` before the construct
      // belongs to an earlier clause.
      const before = (mask.slice(0, start).match(/\?/g) || []).length;
      const inTerm = (codeMask(term).match(/\?/g) || []).length;

      // More than one placeholder in the term is not a shape this understands,
      // and guessing how to duplicate it would re-pair parameters.
      if (inTerm > 1) continue;

      found.push({ start, end, columns, term, before, inTerm });
    }

    if (!found.length) return { sql, expansions: [] };

    let out = sql;
    // Right to left, so an earlier replacement cannot move a later offset.
    for (let i = found.length - 1; i >= 0; i--) {
      const item = found[i];
      const clause = item.columns
        .map((column) => `${column} LIKE CONCAT('%', ${item.term}, '%')`)
        .join(" OR ");
      out = out.slice(0, item.start) + `(${clause})` + out.slice(item.end);
    }

    return {
      sql: out,
      expansions: found
        .filter((item) => item.inTerm === 1)
        .map((item) => ({ index: item.before, copies: item.columns.length })),
    };
  }

  function rewriteUpdateJoin(sql) {
    const mask = codeMask(sql);

    // ⚠️ Matched on `sql`, NOT `mask` — the same correction `rewriteDeleteLimit`
    // below already carries. `codeMask` blanks a backticked identifier, so the
    // `[`"[]?` groups in this pattern could never match the quoted form and
    // every backticked statement fell through untranslated. Backticks are the
    // default in FiveM and mysqldump output, so that was the common case, and
    // the suite missed it because every fixture used bare identifiers.
    //
    // Offsets stay valid: `codeMask` preserves length, so `head[0].length`
    // indexes `mask` and `sql` alike, and the clause scans below still use the
    // mask so a string literal cannot fool them. Safe unquoted because the
    // pattern is anchored at the statement start, where no literal can precede.
    const head =
      /^\s*UPDATE\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?)(?:\s+(?:AS\s+)?([A-Za-z0-9_$]+))?\s+(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|RIGHT\s+(?:OUTER\s+)?|CROSS\s+)?JOIN\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?)(?:\s+(?:AS\s+)?([A-Za-z0-9_$]+))?\s+ON\s+/i.exec(
        sql
      );
    if (!head) return { sql, order: null };

    const target = head[1];
    const targetAlias = head[2];
    const joined = head[3];
    const joinedAlias = head[4];

    // SET and the optional WHERE, found on the mask so a literal cannot fool it.
    const afterOn = head[0].length;
    const setMatch = /\s+SET\s+/i.exec(mask.slice(afterOn));
    if (!setMatch) return { sql, order: null };

    const onClause = sql.slice(afterOn, afterOn + setMatch.index).trim();
    const afterSet = afterOn + setMatch.index + setMatch[0].length;

    const whereMatch = /\s+WHERE\s+/i.exec(mask.slice(afterSet));
    const setClause = (
      whereMatch ? sql.slice(afterSet, afterSet + whereMatch.index) : sql.slice(afterSet)
    ).trim();
    const whereClause = whereMatch
      ? sql
          .slice(afterSet + whereMatch.index + whereMatch[0].length)
          .replace(/;\s*$/, "")
          .trim()
      : "";

    const joinedName = joined.replace(/[`"[\]]/g, "");
    const reads = new RegExp(
      `\\b(?:${joinedAlias ? `${joinedAlias}|` : ""}${joinedName})\\s*\\.`,
      "i"
    );
    if (reads.test(codeMask(setClause))) {
      throw new SQLTranslationError(
        `UPDATE ... JOIN that assigns from ${joinedName} is not translated: an EXISTS ` +
          "subquery cannot carry a value out of the joined table. Use a scalar " +
          "subquery per assigned column instead.",
        { sql, construct: "UPDATE ... JOIN assigning from the joined table" }
      );
    }

    // `a.x = ?` -> `x = ?`: SQLite's UPDATE names one table, so a qualified
    // target column is a parse error there.
    const unqualified = targetAlias
      ? setClause.replace(new RegExp(`\\b${targetAlias}\\s*\\.`, "gi"), "")
      : setClause.replace(new RegExp(`\\b${target.replace(/[`"[\]]/g, "")}\\s*\\.`, "gi"), "");

    const targetRef = targetAlias ? `${target} AS ${targetAlias}` : target;
    const joinedRef = joinedAlias ? `${joined} AS ${joinedAlias}` : joined;
    const condition = whereClause ? `${onClause} AND (${whereClause})` : onClause;

    // MySQL's text order is ON, SET, WHERE; the EXISTS form's is SET, ON,
    // WHERE. Placeholders are paired with the rewritten statement by POSITION,
    // so moving the ON clause past the SET list would re-pair every one of
    // them - which is why this used to be refused whenever the ON clause
    // carried a parameter (esx_core has exactly such a statement).
    //
    // Refusing was never necessary: the translator OWNS that mapping. `keys`
    // records which caller key each placeholder reads, in original order, so
    // reordering the text only requires reordering `keys` to match. The
    // permutation is returned here and applied in buildShape.
    const onCount = countPlaceholders(onClause);
    const setCount = countPlaceholders(unqualified);
    const whereCount = countPlaceholders(whereClause);

    const index = (start, length) => Array.from({ length }, (_, i) => start + i);
    const onIndices = index(0, onCount);
    const setIndices = index(onCount, setCount);
    const whereIndices = index(onCount + setCount, whereCount);

    return {
      sql:
        `UPDATE ${targetRef} SET ${unqualified} WHERE EXISTS ` +
        `(SELECT 1 FROM ${joinedRef} WHERE ${condition})`,
      // Output order: the SET list first, then the ON clause, then the WHERE.
      order: setIndices.concat(onIndices, whereIndices),
    };
  }

  /**
   * Multi-table DELETE, as an EXISTS subquery. Same reasoning as above.
   *
   *   DELETE w FROM a w JOIN b p ON <on>
   *   DELETE FROM a AS w WHERE EXISTS (SELECT 1 FROM b AS p WHERE <on>)
   */
  function rewriteDeleteJoin(sql) {
    const mask = codeMask(sql);

    // ⚠️ Matched on `sql`, NOT `mask` — the same correction `rewriteDeleteLimit`
    // below already carries. `codeMask` blanks a backticked identifier, so the
    // `[`"[]?` groups in this pattern could never match the quoted form and
    // every backticked statement fell through untranslated. Backticks are the
    // default in FiveM and mysqldump output, so that was the common case, and
    // the suite missed it because every fixture used bare identifiers.
    //
    // Offsets stay valid: `codeMask` preserves length, so `head[0].length`
    // indexes `mask` and `sql` alike, and the clause scans below still use the
    // mask so a string literal cannot fool them. Safe unquoted because the
    // pattern is anchored at the statement start, where no literal can precede.
    const head =
      /^\s*DELETE\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?)\s+FROM\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?)(?:\s+(?:AS\s+)?([A-Za-z0-9_$]+))?\s+(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|CROSS\s+)?JOIN\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?)(?:\s+(?:AS\s+)?([A-Za-z0-9_$]+))?\s+ON\s+/i.exec(
        sql
      );
    if (!head) return sql;

    // Quotes stripped here, not at the comparison: the alias group accepts a
    // backticked name now, and every use below is a bare-name comparison.
    const deleteAlias = head[1].replace(/[`"[\]]/g, "");
    const target = head[2];
    const targetAlias = head[3] || deleteAlias;
    const joined = head[4];
    const joinedAlias = head[5];

    // MySQL names which table to delete from. Deleting from the OTHER one would
    // be catastrophic and silent, so anything but the first is refused.
    const targetName = target.replace(/[`"[\]]/g, "");
    if (
      deleteAlias.toLowerCase() !== targetName.toLowerCase() &&
      (!head[3] || deleteAlias.toLowerCase() !== head[3].toLowerCase())
    ) {
      throw new SQLTranslationError(
        `multi-table DELETE naming ${deleteAlias} is not translated: SQLite deletes ` +
          `from one table and this statement does not delete from ${targetName}, the ` +
          "first one. Rewrite it as a DELETE from that table with a subquery.",
        { sql, construct: "multi-table DELETE of a non-leading table" }
      );
    }

    const rest = sql.slice(head[0].length);
    const whereMatch = /\s+WHERE\s+/i.exec(codeMask(rest));
    const onClause = (whereMatch ? rest.slice(0, whereMatch.index) : rest)
      .replace(/;\s*$/, "")
      .trim();
    const whereClause = whereMatch
      ? rest
          .slice(whereMatch.index + whereMatch[0].length)
          .replace(/;\s*$/, "")
          .trim()
      : "";

    const joinedRef = joinedAlias ? `${joined} AS ${joinedAlias}` : joined;
    const condition = whereClause ? `${onClause} AND (${whereClause})` : onClause;

    return (
      `DELETE FROM ${target} AS ${targetAlias} WHERE EXISTS ` +
      `(SELECT 1 FROM ${joinedRef} WHERE ${condition})`
    );
  }

  function rewriteDeleteLimit(sql) {
    const mask = codeMask(sql);

    // Matched on `sql`, NOT `mask`. codeMask blanks a backticked identifier, so
    // `DELETE FROM \`k9_search_log\` WHERE ...` masked to `DELETE FROM` plus
    // spaces - and the identifier group then matched the next real word, WHERE.
    // The rewrite became `DELETE FROM \`WHERE\` WHERE rowid IN (SELECT rowid
    // FROM \`WHERE\` searched_at < ...)`, which SQLite rejected with
    // `Expected RParen, got Lt`: a parse error naming nothing, for a valid
    // statement. K9Script's log prune is exactly this shape.
    //
    // Safe unquoted: the pattern is anchored at the start of the statement, and
    // a string literal cannot precede DELETE FROM. The mask is still used below
    // to find the top-level LIMIT, where a literal could otherwise match.
    const head = /^\s*DELETE\s+FROM\s+([`"\[]?)([A-Za-z0-9_$]+)\1/i.exec(sql);
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

  // Index of the first match outside any parentheses, or -1. Tells a statement's
  // own clause from one inside a subquery.
  function findTopLevel(mask, pattern) {
    const depths = parenDepths(mask);
    pattern.lastIndex = 0;

    let m;
    // The condition has to consume the match it tests: pattern is a /g regex
    // whose lastIndex advances per call, which is what terminates the loop.
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic /g exec() loop
    while ((m = pattern.exec(mask)) !== null) {
      if (depths[m.index] === 0) return m.index;
    }
    return -1;
  }

  // Parenthesis nesting depth at each character of a code-masked string.
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

  // Functions SQLite has no equivalent for, expressed in terms it does have.
  /**
   * `SHOW TABLES` -> a query against SQLite's catalogue.
   *
   * MySQL-only syntax that the transpiler cannot parse at all, so it came back
   * as "No adapter could handle export 'scalar'" -- a message that names the
   * export rather than the statement and reads like a tDB wiring fault.
   *
   * Measured 2026-10-13: night_shifts probes `SHOW TABLES LIKE ?` for each of
   * its tables as the first step of its startup migration, and gates
   * `playerConnecting` on that migration finishing. Every probe failed, the
   * migration never completed, and the server rejected every connection with
   * "currently migrating the database" -- indefinitely.
   *
   * The LIKE pattern carries through untouched, including its parameter, so a
   * `?` stays a `?` and the caller's params still line up. `sqlite_%` and the
   * PocketBase `_`-prefixed internals are excluded to match what MySQL would
   * have returned: the user's own tables, nothing else.
   *
   * The column is aliased because callers read it positionally or by a name
   * they never see here -- MySQL calls it `Tables_in_<db>`, which is not
   * reproducible, so `name` is the honest choice and a scalar read (the shape
   * night_shifts actually uses) takes the first column regardless.
   */
  function rewriteShowTables(sql) {
    // ⚠️ `substr`, NOT `NOT LIKE 'sqlite_%' ... ESCAPE '\'`.
    //
    // The output of this rewrite is still handed to the MySQL front end before
    // it reaches SQLite, and MySQL treats a backslash inside a string literal
    // as an escape -- so `ESCAPE '\'` tokenises as an unterminated string and
    // every SHOW TABLES died with "Tokenization error ... Unterminated string"
    // instead of translating. Measured 2026-10-13.
    //
    // substr avoids escaping entirely, and is exact where LIKE was not: `_` is
    // a single-character wildcard, so `'sqlite_%'` would also have matched a
    // table called `sqliteXfoo`.
    const base =
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 1) <> '_'";

    // SHOW [FULL] TABLES [FROM/IN db] [LIKE x | WHERE ...]
    return sql.replace(
      /^\s*SHOW\s+(?:FULL\s+)?TABLES\b(?:\s+(?:FROM|IN)\s+[`"]?[A-Za-z0-9_$]+[`"]?)?\s*(LIKE\s+(?:\?|'[^']*'|"[^"]*")|WHERE\s+[\s\S]+?)?\s*;?\s*$/i,
      (_m, filter) => {
        if (!filter) return `${base} ORDER BY name`;
        if (/^LIKE/i.test(filter)) return `${base} AND name ${filter} ORDER BY name`;
        // A WHERE on SHOW TABLES filters MySQL's own column name, which does
        // not exist here. Refusing is better than inventing a mapping.
        return _m;
      }
    );
  }

  /**
   * `information_schema.<X>` -> a derived table exposing the same column names.
   *
   * SQLite has no information schema; the equivalents are sqlite_master and the
   * pragma_* table functions. Rather than rewriting each query shape, the table
   * reference itself is swapped for a subquery whose columns are aliased to
   * MySQL's names. The caller's SELECT list, WHERE, GROUP BY and HAVING are then
   * left completely untouched, which matters for two reasons:
   *
   *   - Placeholder ORDER is preserved for free. normalizePlaceholders records
   *     parameter keys from the ORIGINAL statement and pairs them with the `?`s
   *     found in the REWRITTEN one by position, so any rewrite that reorders or
   *     drops a placeholder mispairs them silently.
   *   - It handles shapes nobody enumerated. esx_core alone issues four
   *     different projections over STATISTICS and COLUMNS, including a
   *     GROUP BY / HAVING over a nested SELECT.
   *
   * TABLE_SCHEMA is reported as 'main', which is what SQLite calls its primary
   * schema and what DATABASE() is already rewritten to, so `TABLE_SCHEMA =
   * DATABASE()` and `TABLE_SCHEMA IN (SELECT DATABASE())` both still match.
   *
   * Everything emitted here must stay parseable as MySQL, since it is still
   * handed to the MySQL front end before SQLite sees it.
   */
  function rewriteInformationSchema(sql) {
    if (!/\bINFORMATION_SCHEMA\s*\.\s*[A-Za-z_]+/i.test(sql)) return sql;

    // One row per table.
    const TABLES =
      "(SELECT 'main' AS `TABLE_SCHEMA`, name AS `TABLE_NAME`, " +
      "'BASE TABLE' AS `TABLE_TYPE`, 'InnoDB' AS `ENGINE` " +
      "FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_')";

    // One row per column. CHARACTER_MAXIMUM_LENGTH is read out of the declared
    // type, since pragma_table_info reports `varchar(60)` as a single string.
    const COLUMNS =
      "(SELECT 'main' AS `TABLE_SCHEMA`, m.name AS `TABLE_NAME`, " +
      "ti.name AS `COLUMN_NAME`, ti.cid + 1 AS `ORDINAL_POSITION`, " +
      // rtrim/ltrim rather than instr: the transpiler rewrites `instr` into
      // MySQL's `LOCATE`, which SQLite does not have, so the whole derived
      // table failed with "no such function: LOCATE". rtrim, ltrim, replace,
      // length, lower and LIKE all survive the round trip unchanged.
      "lower(rtrim(ti.type, '0123456789()')) AS `DATA_TYPE`, " +
      "ti.type AS `COLUMN_TYPE`, " +
      // The declared width, read by stripping the type name and the brackets.
      // NULL when there is no width, which is what MySQL reports.
      "CASE WHEN ti.type LIKE '%(%' THEN CAST(replace(replace(ltrim(ti.type, " +
      "'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '), '(', ''), ')', '') " +
      "AS INTEGER) ELSE NULL END AS `CHARACTER_MAXIMUM_LENGTH`, " +
      "CASE WHEN ti.`notnull` = 0 AND ti.pk = 0 THEN 'YES' ELSE 'NO' END AS `IS_NULLABLE`, " +
      "ti.dflt_value AS `COLUMN_DEFAULT`, " +
      "CASE WHEN ti.pk > 0 THEN 'PRI' ELSE '' END AS `COLUMN_KEY`, " +
      "NULL AS `COLLATION_NAME`, '' AS `EXTRA` " +
      "FROM sqlite_master m JOIN pragma_table_info(m.name) ti " +
      "WHERE m.type = 'table' AND substr(m.name, 1, 7) <> 'sqlite_')";

    // One row per indexed column. SUB_PART is always NULL: SQLite has no
    // prefix indexes, so there is no partial length to report.
    const STATISTICS =
      "(SELECT 'main' AS `TABLE_SCHEMA`, m.name AS `TABLE_NAME`, " +
      "il.name AS `INDEX_NAME`, ii.name AS `COLUMN_NAME`, " +
      "ii.seqno + 1 AS `SEQ_IN_INDEX`, " +
      "CASE WHEN il.`unique` = 1 THEN 0 ELSE 1 END AS `NON_UNIQUE`, " +
      "NULL AS `SUB_PART`, 'BTREE' AS `INDEX_TYPE` " +
      "FROM sqlite_master m JOIN pragma_index_list(m.name) il " +
      "JOIN pragma_index_info(il.name) ii " +
      "WHERE m.type = 'table')";

    // One row per foreign key column.
    const KEY_COLUMN_USAGE =
      "(SELECT 'main' AS `TABLE_SCHEMA`, m.name AS `TABLE_NAME`, " +
      "fk.`from` AS `COLUMN_NAME`, fk.`table` AS `REFERENCED_TABLE_NAME`, " +
      "fk.`to` AS `REFERENCED_COLUMN_NAME`, fk.seq + 1 AS `ORDINAL_POSITION`, " +
      "'FOREIGN' AS `CONSTRAINT_NAME` " +
      "FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk " +
      "WHERE m.type = 'table')";

    // One row per constraint, which is how a resource asks "does this foreign
    // key already exist" before adding it - sd-phone's migration does exactly
    // that and was refused outright, so its ALTER ran unconditionally.
    //
    // Three constraint types are reportable from SQLite's own catalogue: a
    // foreign key per pragma_foreign_key_list, a primary key per
    // pragma_table_info's pk flag, and UNIQUE per an index pragma_index_list
    // marks unique. CHECK is deliberately absent: it lives only in the
    // CREATE TABLE text, and parsing that to count constraints would be
    // guessing.
    const TABLE_CONSTRAINTS =
      "(SELECT 'main' AS `CONSTRAINT_SCHEMA`, 'main' AS `TABLE_SCHEMA`, " +
      "m.name AS `TABLE_NAME`, " +
      "'FOREIGN' AS `CONSTRAINT_NAME`, 'FOREIGN KEY' AS `CONSTRAINT_TYPE` " +
      "FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk " +
      "WHERE m.type = 'table' " +
      "UNION ALL " +
      "SELECT 'main', 'main', m.name, 'PRIMARY', 'PRIMARY KEY' " +
      "FROM sqlite_master m JOIN pragma_table_info(m.name) ti " +
      "WHERE m.type = 'table' AND ti.pk > 0 " +
      "UNION ALL " +
      "SELECT 'main', 'main', m.name, il.name, 'UNIQUE' " +
      "FROM sqlite_master m JOIN pragma_index_list(m.name) il " +
      "WHERE m.type = 'table' AND il.`unique` = 1)";

    // SQLite has no server and no other connections, so the honest answer is no
    // rows - not a refusal. qbxsql polls this to see whether anything else is
    // mid-migration; "nothing else is" is both true and what it wants to hear.
    // The columns are MySQL's so a caller's projection still resolves.
    const PROCESSLIST =
      "(SELECT NULL AS `ID`, NULL AS `USER`, NULL AS `HOST`, NULL AS `DB`, " +
      "NULL AS `COMMAND`, NULL AS `TIME`, NULL AS `STATE`, NULL AS `INFO` " +
      "WHERE 0)";

    const sources = {
      TABLES,
      COLUMNS,
      STATISTICS,
      KEY_COLUMN_USAGE,
      TABLE_CONSTRAINTS,
      PROCESSLIST,
    };

    // An alias is supplied so a bare `information_schema.COLUMNS` reference
    // still has a name to be qualified by if the caller used one.
    let out = sql.replace(
      /\b(?:`?INFORMATION_SCHEMA`?\s*\.\s*)`?([A-Za-z_]+)`?/gi,
      (whole, name) => {
        const source = sources[name.toUpperCase()];
        // Unknown view: leave it, so the gate refuses it by name instead of
        // this quietly producing something that looks right.
        return source ? `${source} AS \`${name}\`` : whole;
      }
    );

    // `TABLE_SCHEMA = <x>` becomes `<x> IS NOT NULL`.
    //
    // The derived tables report TABLE_SCHEMA as 'main', which is correct for
    // SQLite and matches `= DATABASE()`. But a script that passes its own MySQL
    // schema name - night_shifts does, as a bound parameter - would then match
    // nothing and get zero rows with no error. The operand is kept exactly
    // where it was so the placeholder still pairs with the right parameter;
    // only the comparison is neutralised. A real schema name is always
    // non-null, so this answers the question the caller was actually asking.
    out = out.replace(
      /\b(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?`?TABLE_SCHEMA`?\s*=\s*(\?|'[^']*'|"[^"]*"|DATABASE\s*\(\s*\)|[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)?)/gi,
      (_m, operand) => `${operand} IS NOT NULL`
    );

    return out;
  }

  /**
   * The rest of MySQL's introspection statements, which scripts run at boot to
   * check their own schema. SQLite has none of them; the equivalents are
   * sqlite_master and the pragma_* table functions.
   *
   * These all work on real MySQL, so they are a genuine drop-in gap rather than
   * a dialect nicety. Untranslated they also sail past the safety gate and
   * reach SQLite as "near SHOW: syntax error", which names nothing useful.
   *
   * Column names are aliased to MySQL's, because that is what callers read:
   * `Field` from SHOW COLUMNS, `Key_name`/`Column_name` from SHOW INDEX. Only
   * the columns scripts actually use are reproduced; inventing values for
   * MySQL-specific metadata would be worse than leaving it out.
   *
   * Everything emitted here has to stay parseable as MySQL, since it is still
   * handed to the MySQL front end. Hence backticked aliases and no backslashes.
   */
  function rewriteShowFamily(sql) {
    // Written out as literals rather than composed from a shared string: a
    // `\s` inside a double-quoted string collapses to a plain "s", which made
    // an earlier version of this silently match nothing at all.

    // SHOW COLUMNS FROM t / SHOW FULL COLUMNS FROM t / DESCRIBE t / DESC t
    const columns =
      /^\s*SHOW\s+(?:FULL\s+)?(?:COLUMNS|FIELDS)\s+(?:FROM|IN)\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?/i.exec(
        sql
      ) || /^\s*DESC(?:RIBE)?\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?\s*;?\s*$/i.exec(sql);

    if (columns) {
      const name = columns[1];
      // `pk` doubles as MySQL's Key for the primary key, which is the field
      // scripts check when they ask "is this the id column".
      return (
        "SELECT name AS `Field`, type AS `Type`, " +
        // A primary key is implicitly NOT NULL, but SQLite reports notnull = 0
        // for an INTEGER PRIMARY KEY because it is the rowid alias. MySQL says
        // NO there, and a script reading Null to decide whether a column is
        // required would otherwise get the wrong answer for the id.
        "CASE WHEN `notnull` = 0 AND pk = 0 THEN 'YES' ELSE 'NO' END AS `Null`, " +
        "CASE WHEN pk > 0 THEN 'PRI' ELSE '' END AS `Key`, " +
        "dflt_value AS `Default`, '' AS `Extra` " +
        `FROM pragma_table_info('${name}')`
      );
    }

    // SHOW INDEX / SHOW INDEXES / SHOW KEYS FROM t
    const indexes =
      /^\s*SHOW\s+(?:INDEX|INDEXES|KEYS)\s+(?:FROM|IN)\s+[`"[]?([A-Za-z0-9_$]+)[`"\]]?/i.exec(sql);

    if (indexes) {
      const name = indexes[1];
      return (
        `SELECT '${name}' AS \`Table\`, ` +
        "CASE WHEN il.`unique` = 1 THEN 0 ELSE 1 END AS `Non_unique`, " +
        "il.name AS `Key_name`, ii.seqno + 1 AS `Seq_in_index`, " +
        "ii.name AS `Column_name` " +
        `FROM pragma_index_list('${name}') il ` +
        "JOIN pragma_index_info(il.name) ii"
      );
    }

    // SHOW CREATE TABLE t
    const create = /^\s*SHOW\s+CREATE\s+TABLE\s+[`"\[]?([A-Za-z0-9_$]+)[`"\]]?\s*;?\s*$/i.exec(sql);
    if (create) {
      return (
        "SELECT name AS `Table`, sql AS `Create Table` FROM sqlite_master " +
        `WHERE type = 'table' AND name = '${create[1]}'`
      );
    }

    // SHOW DATABASES / SHOW SCHEMAS. SQLite's primary schema is named main.
    if (/^\s*SHOW\s+(?:DATABASES|SCHEMAS)\s*;?\s*$/i.test(sql)) {
      return "SELECT 'main' AS `Database`";
    }

    return sql;
  }

  /**
   * The index of the ")" closing the "(" at openIndex, ignoring parens inside
   * string literals and comments.
   */
  function matchingParen(sql, openIndex) {
    const mask = codeMask(sql);
    let depth = 0;

    for (let i = openIndex; i < sql.length; i++) {
      if (mask[i] === "(") depth++;
      else if (mask[i] === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * GROUP_CONCAT: keep the ORDER BY that MySQL puts inside the call.
   *
   * MySQL writes `GROUP_CONCAT(x ORDER BY y SEPARATOR s)`. The transpiler turns
   * the SEPARATOR into SQLite's second argument correctly but DROPS the ORDER
   * BY, so the result came back in arbitrary order with no error. Both real
   * uses in the corpus have it - sd-phone builds a last-message preview with
   * `SUBSTRING_INDEX(GROUP_CONCAT(body ORDER BY created_at DESC ...), ...)`,
   * where losing the order means showing the wrong message.
   *
   * SQLite has supported ORDER BY inside an aggregate since 3.44, and the
   * engine PocketBase 0.40.4 embeds is 3.53.4 - measured against the real
   * binary via tests/dev/probe-group-concat.js, not against node:sqlite, which
   * is a different build.
   *
   * The call becomes a marker the MySQL parser accepts as an ordinary 3-argument
   * function - the ORDER BY travels as a string literal - and is reassembled
   * after transpiling, the same trick TDB_JSON_TEXT uses.
   */
  function rewriteGroupConcat(sql) {
    const mask = codeMask(sql);
    const call = /\bGROUP_CONCAT\s*\(/gi;
    let out = sql;

    // Collected first, applied right-to-left, so an earlier rewrite cannot
    // shift the offsets of a later one.
    const edits = [];

    for (const match of mask.matchAll(call)) {
      const openIndex = match.index + match[0].length - 1;
      const closeIndex = matchingParen(sql, openIndex);
      if (closeIndex === -1) continue;

      const inner = sql.slice(openIndex + 1, closeIndex);
      const innerMask = mask.slice(openIndex + 1, closeIndex);

      const distinct = /^\s*DISTINCT\b/i.test(innerMask);
      const orderAt = innerMask.search(/\bORDER\s+BY\b/i);
      const sepAt = innerMask.search(/\bSEPARATOR\b/i);

      if (distinct && sepAt !== -1) {
        // SQLite: "DISTINCT aggregates must have exactly one argument", so the
        // separator cannot be passed at all. Measured against the real engine.
        throw new SQLTranslationError(
          "GROUP_CONCAT(DISTINCT ... SEPARATOR ...) has no SQLite form: a DISTINCT " +
            "aggregate takes exactly one argument, so the separator cannot be passed. " +
            "Use the default comma separator, or de-duplicate in a subquery.",
          { sql, construct: "GROUP_CONCAT(DISTINCT ... SEPARATOR ...)" }
        );
      }

      // No ORDER BY: the transpiler already handles SEPARATOR correctly, and a
      // plain DISTINCT is valid SQLite as-is. Leave it alone.
      if (orderAt === -1) continue;

      if (distinct) {
        throw new SQLTranslationError(
          "GROUP_CONCAT(DISTINCT ... ORDER BY ...) is not translated: SQLite accepts " +
            "ORDER BY in a DISTINCT aggregate only in the single-argument form, and " +
            "guessing which of the two the caller meant could reorder rows silently.",
          { sql, construct: "GROUP_CONCAT(DISTINCT ... ORDER BY ...)" }
        );
      }

      const expr = inner.slice(0, orderAt).trim();
      const orderBy = (
        sepAt !== -1 && sepAt > orderAt ? inner.slice(orderAt, sepAt) : inner.slice(orderAt)
      ).trim();
      // MySQL's default separator is a comma, and so is SQLite's one-argument
      // form - but the two-argument form is needed to carry the ORDER BY, so it
      // is always written out.
      const separator =
        sepAt !== -1 && sepAt > orderAt
          ? inner
              .slice(sepAt)
              .replace(/^\s*SEPARATOR\s*/i, "")
              .trim()
          : "','";

      // Placeholders in the ORDER BY would be REORDERED relative to the
      // separator: MySQL's text order is expr, order-by, separator and SQLite's
      // is expr, separator, order-by. Placeholders are paired with the
      // rewritten statement by POSITION, so a swap mispairs every later
      // parameter silently. Refused rather than risked; ordering by a bound
      // value is meaningless anyway.
      if (/\?/.test(codeMask(orderBy))) {
        throw new SQLTranslationError(
          "GROUP_CONCAT(... ORDER BY <placeholder> ...) is not translated: moving the " +
            "separator ahead of the ORDER BY would reorder the bound parameters.",
          { sql, construct: "GROUP_CONCAT ORDER BY with a bound parameter" }
        );
      }

      // Backticks inside the clause are invisible to the transpiler once the
      // clause is inside a literal, and would trip the backtick gate on the
      // output, so they are converted here.
      const clause = orderBy.replace(/`([A-Za-z0-9_$]+)`/g, '"$1"').replace(/'/g, "''");

      edits.push({
        from: match.index,
        to: closeIndex + 1,
        text: `TDB_GCONCAT(${expr}, ${separator}, '${clause}')`,
      });
    }

    for (const edit of edits.reverse()) {
      out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
    }
    return out;
  }

  /**
   * Put the ORDER BY back where SQLite wants it, after translation.
   */
  function restoreGroupConcat(sql) {
    const marker = /\bTDB_GCONCAT\s*\(/i;
    let out = sql;

    for (;;) {
      const found = marker.exec(out);
      if (!found) return out;

      const openIndex = found.index + found[0].length - 1;
      const closeIndex = matchingParen(out, openIndex);
      if (closeIndex === -1) return out;

      const inner = out.slice(openIndex + 1, closeIndex);
      const innerMask = codeMask(inner);

      // The ORDER BY clause is the last top-level argument, so the split is the
      // last top-level comma. Found by scanning rather than by splitting, since
      // the expression may contain commas of its own.
      let depth = 0;
      let lastComma = -1;
      for (let i = 0; i < inner.length; i++) {
        if (innerMask[i] === "(") depth++;
        else if (innerMask[i] === ")") depth--;
        else if (innerMask[i] === "," && depth === 0) lastComma = i;
      }
      if (lastComma === -1) return out;

      const head = inner.slice(0, lastComma).trim();
      const clause = inner
        .slice(lastComma + 1)
        .trim()
        .replace(/^'/, "")
        .replace(/'$/, "")
        .replace(/''/g, "'");

      out =
        out.slice(0, found.index) + `group_concat(${head} ${clause})` + out.slice(closeIndex + 1);
    }
  }

  function rewriteFunctions(sql) {
    let out = sql;

    // UNIX_TIMESTAMP() -> seconds since epoch, now.
    out = out.replace(/\bUNIX_TIMESTAMP\s*\(\s*\)/gi, "CAST(strftime('%s','now') AS INTEGER)");
    // UNIX_TIMESTAMP(expr) -> seconds since epoch for expr.
    out = out.replace(
      /\bUNIX_TIMESTAMP\s*\(([^()]*)\)/gi,
      (_m, arg) => `CAST(strftime('%s',${arg}) AS INTEGER)`
    );
    // FROM_UNIXTIME(expr) -> datetime text.
    out = out.replace(
      /\bFROM_UNIXTIME\s*\(([^()]*)\)/gi,
      (_m, arg) => `datetime(${arg},'unixepoch')`
    );
    // MySQL's two-argument IF() is SQLite's IIF().
    out = out.replace(/\bIF\s*\(/gi, "IIF(");

    // DATE_SUB/DATE_ADD(expr, INTERVAL n UNIT) -> datetime(expr, '±n units').
    //
    // qb-core prunes with `UNIX_TIMESTAMP(DATE_SUB(NOW(), INTERVAL 31 DAY))`,
    // which was refused outright. Done as a loop so the innermost call is
    // rewritten first and a nesting like that one resolves from the inside out;
    // a single pass cannot, because the pattern has to exclude parentheses to
    // know where its own argument ends.
    for (let depth = 0; depth < 4; depth++) {
      const before = out;
      out = out.replace(
        // CURDATE/CURRENT_DATE/UTC_DATE alongside NOW: the argument may be any
        // of MySQL's zero-argument clocks, and listing only NOW refused
        // `DATE_SUB(CURDATE(), INTERVAL 1 DAY)` - which is how ox_banking builds
        // the day axis of its account-activity chart, so the whole chart query
        // failed.
        /\bDATE_(ADD|SUB)\s*\(\s*((?:NOW\s*\(\s*\)|CURDATE\s*\(\s*\)|UTC_DATE\s*\(\s*\)|CURRENT_TIMESTAMP|CURRENT_DATE|[A-Za-z0-9_.`"]+|'[^']*'))\s*,\s*INTERVAL\s+'?(\d+)'?\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?\s*\)/gi,
        (_m, dir, expr, amount, unit) => {
          // A date-only clock keeps its date-only shape: MySQL's
          // DATE_SUB(CURDATE(), ...) yields a DATE, and date() rather than
          // datetime() is what matches it. Getting this wrong would append a
          // ' 00:00:00' that a string comparison against a DATE column misses.
          const dateOnly = /CURDATE\s*\(|CURRENT_DATE|UTC_DATE\s*\(/i.test(expr);
          const base = /NOW\s*\(|CURRENT_TIMESTAMP|CURDATE\s*\(|CURRENT_DATE|UTC_DATE\s*\(/i.test(
            expr
          )
            ? "'now'"
            : expr;
          const sign = dir.toUpperCase() === "SUB" ? "-" : "+";
          const fn = dateOnly ? "date" : "datetime";
          return `${fn}(${base},'${sign}${amount} ${unit.toLowerCase()}s')`;
        }
      );
      if (out === before) break;
    }

    // UNIX_TIMESTAMP(<one nested call>) -> seconds since epoch. The simple
    // single-argument form is handled further down; this covers the case where
    // the argument is itself a function call, which a no-parens pattern misses.
    out = out.replace(
      /\bUNIX_TIMESTAMP\s*\(\s*([A-Za-z_][A-Za-z0-9_]*\s*\([^()]*\))\s*\)/gi,
      (_m, inner) => `CAST(strftime('%s',${inner}) AS INTEGER)`
    );

    // The UNQUOTING half of MySQL's JSON access, carried across as a marker.
    //
    // MySQL distinguishes two things that SQLite also distinguishes:
    //   a -> p   / JSON_EXTRACT(a, p)              keep JSON quoting -> "Ada"
    //   a ->> p  / JSON_UNQUOTE(JSON_EXTRACT(a,p)) strip it          -> Ada
    //
    // The transpiler collapses BOTH onto SQLite's `->`, which keeps the quotes.
    // That made `WHERE charinfo ->> '$.firstname' = 'Ada'` match nothing at all
    // - no error, just zero rows - and JSON columns like charinfo and metadata
    // are how every modern framework stores player data. Measured on sd-phone.
    //
    // So the unquoting forms become a marker function here, which the parser
    // passes through untouched, and the marker is turned into json_extract
    // AFTER translation where the transpiler can no longer rewrite it.
    // json_extract is the right target: unlike `->` it returns a bare scalar.
    //
    // The quoting forms are left alone, because on those the two dialects agree.
    // Single OR double quoted. MySQL's default sql_mode has no ANSI_QUOTES, so
    // "$.name" is a string literal exactly like '$.name' - and the double form
    // is what qb-core (server/player.lua, 5 sites) and qbx_core
    // (server/storage/players.lua, every job/gang/metadata filter) actually
    // write. Accepting only the single form meant those statements skipped the
    // marker below, reached the transpiler, and came out as `->`, which keeps
    // the JSON quotes: every player search and every uniqueness check returned
    // nothing, silently. Measured against real rows.
    const jsonPath = "('(?:[^']|'')*'|\"(?:[^\"]|\"\")*\")";
    const jsonCol =
      '([`"]?[A-Za-z_][A-Za-z0-9_]*[`"]?(?:\\s*\\.\\s*[`"]?[A-Za-z_][A-Za-z0-9_]*[`"]?)?)';

    out = out.replace(
      new RegExp(
        `\\bJSON_UNQUOTE\\s*\\(\\s*JSON_EXTRACT\\s*\\(\\s*${jsonCol}\\s*,\\s*${jsonPath}\\s*\\)\\s*\\)`,
        "gi"
      ),
      (_m, column, path) => `TDB_JSON_TEXT(${column}, ${path})`
    );
    out = out.replace(
      new RegExp(`\\bJSON_UNQUOTE\\s*\\(\\s*${jsonCol}\\s*->>?\\s*${jsonPath}\\s*\\)`, "gi"),
      (_m, column, path) => `TDB_JSON_TEXT(${column}, ${path})`
    );
    out = out.replace(
      new RegExp(`${jsonCol}\\s*->>\\s*${jsonPath}`, "g"),
      (_m, column, path) => `TDB_JSON_TEXT(${column}, ${path})`
    );

    // JSON_VALUE is MySQL's and MariaDB's UNQUOTING accessor - the same meaning
    // as ->> - and had no rule, so it reached the transpiler and became `->`.
    // qbx_core's fetchIsUnique routes account numbers, phone numbers,
    // fingerprints, wallet ids and serial numbers through it, so the uniqueness
    // check always answered "unique" and the server issued duplicates with no
    // error anywhere. 45 call sites on disk.
    out = out.replace(
      new RegExp(`\\bJSON_VALUE\\s*\\(\\s*${jsonCol}\\s*,\\s*${jsonPath}\\s*\\)`, "gi"),
      (_m, column, path) => `TDB_JSON_TEXT(${column}, ${path})`
    );

    // Bare JSON_EXTRACT / -> IN A COMPARISON.
    //
    // MySQL's JSON_EXTRACT returns a JSON value, so `SELECT JSON_EXTRACT(...)`
    // yields `"police"` WITH quotes - which SQLite's `->` also does, so
    // projection already matched and must not change. But MySQL coerces a JSON
    // scalar when it is COMPARED, so `JSON_EXTRACT(job,'$.name') = 'police'`
    // matches, where `job -> '$.name' = 'police'` does not. Measured on real
    // rows: zero rows against MySQL's one.
    //
    // So the rewrite is comparison-scoped rather than blanket: only an operand
    // of =, !=, <>, <, >, <=, >=, LIKE, IN or IS becomes the unquoting form.
    // That keeps both halves faithful instead of trading one for the other.
    const comparison = "\\s*(?:=|!=|<>|<=|>=|<|>|\\bLIKE\\b|\\bNOT\\s+LIKE\\b|\\bIN\\b|\\bIS\\b)";

    out = out.replace(
      new RegExp(
        `\\bJSON_EXTRACT\\s*\\(\\s*${jsonCol}\\s*,\\s*${jsonPath}\\s*\\)(?=${comparison})`,
        "gi"
      ),
      (_m, column, path) => `TDB_JSON_TEXT(${column}, ${path})`
    );

    out = out.replace(
      new RegExp(`${jsonCol}\\s*->\\s*${jsonPath}(?=${comparison})`, "g"),
      (_m, column, path) => `TDB_JSON_TEXT(${column}, ${path})`
    );

    // NOW() - INTERVAL 6 MONTH -> datetime('now','-6 months').
    //
    // Rewritten here, before the transpiler, because the transpiler turns the
    // literal into INTERVAL '6' MONTH - which slips past the gate's INTERVAL
    // pattern (it expects an unquoted number) and then fails at SQLite with
    // "near '6'". ox_inventory prunes stale stashes with exactly this.
    out = out.replace(
      /\b(?:NOW\s*\(\s*\)|CURRENT_TIMESTAMP)\s*([-+])\s*INTERVAL\s+'?(\d+)'?\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?\b/gi,
      (_m, sign, amount, unit) => `datetime('now','${sign}${amount} ${unit.toLowerCase()}s')`
    );

    // DATABASE()/SCHEMA() -> the name SQLite gives its primary schema. Polyglot
    // rewrites DATABASE() to the MySQL synonym SCHEMA(), which SQLite has no
    // more than the original, so both are handled here instead.
    out = out.replace(/\b(?:DATABASE|SCHEMA)\s*\(\s*\)/gi, "'main'");

    // VERSION() -> the real engine's version. Deliberately not spoofed as
    // MySQL: a script that version-gates on MariaDB should take its own
    // not-MariaDB branch rather than be told what it wants to hear.
    out = out.replace(/\bVERSION\s*\(\s*\)/gi, "sqlite_version()");

    return out;
  }

  // Strip the MySQL-only parts of a CREATE TABLE, handing back the indexes and
  // triggers that have to become separate statements.
  function rewriteCreateTable(sql) {
    const mask = codeMask(sql);
    const extraStatements = [];

    if (!/^\s*CREATE\s+(TEMPORARY\s+)?TABLE\b/i.exec(mask)) {
      return { sql, extraStatements };
    }

    // Read the name off the original, not the mask: codeMask blanks quoted
    // identifiers, leaving the name group to backtrack out of IF NOT EXISTS and
    // capture "IF". Safe unmasked because a string literal cannot precede CREATE.
    const tableMatch =
      /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"\[]([^`"\]]+)[`"\]]|([A-Za-z0-9_$]+))/i.exec(
        sql
      );
    const table = tableMatch ? tableMatch[1] || tableMatch[2] : null;

    let out = sql;

    // `USING BTREE` / `USING HASH` is a MySQL index-type hint with no SQLite
    // counterpart. It is written after the column list, so the inline-index
    // stripper below ends before it and left it stranded in the column list -
    // SQLite then rejected the whole CREATE TABLE with "near INDEX". Both
    // ox_mdt and ox_property declare their indexes this way.
    out = out.replace(/\s+USING\s+(?:BTREE|HASH|RTREE)\b/gi, "");

    // MySQL allows inline index definitions; SQLite needs CREATE INDEX after.
    //
    // FULLTEXT and SPATIAL are accepted here and become ordinary indexes.
    // SQLite's full-text search is a virtual table with its own syntax, so the
    // index cannot be reproduced faithfully - but the queries that would use it
    // (MATCH ... AGAINST) are refused by name anyway, and emitting a plain index
    // keeps the table creatable instead of failing the whole statement.
    out = out.replace(
      /,\s*(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+([`"]?)([A-Za-z0-9_$]+)\2\s*\(([^)]*)\)/gi,
      (_m, unique, _q, name, cols) => {
        if (table) {
          const columns = cols
            .split(",")
            .map(
              (c) =>
                `"${c
                  .trim()
                  .replace(/[`"]/g, "")
                  .replace(/\s*\(\d+\)$/, "")}"`
            )
            .join(", ");
          // Only UNIQUE earns UNIQUE: the captured prefix may also be FULLTEXT
          // or SPATIAL, and treating either as unique would reject rows MySQL
          // accepted.
          const isUnique = /UNIQUE/i.test(unique || "");
          extraStatements.push(
            `CREATE ${isUnique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${table}_${name}" ON "${table}" (${columns})`
          );
        }
        return "";
      }
    );

    // ON UPDATE CURRENT_TIMESTAMP has no column-level equivalent, so it becomes
    // a trigger: capture the column, drop the clause.
    // `CURRENT_TIMESTAMP` and `current_timestamp()` are both written in the
    // wild - ox_inventory and esx_core's players table use the parenthesised
    // lowercase form, which an earlier pattern missed, so those tables were
    // refused outright instead of getting their trigger.
    out = out.replace(
      // The gap between the column name and ON UPDATE has to tolerate a
      // parenthesised call, because `DEFAULT current_timestamp()` sits there in
      // ox_inventory's and esx_core's schemas. A `[^,)]` run stops at that
      // first `)`, which is why those tables were refused rather than rewritten.
      /([`"]?)([A-Za-z0-9_$]+)\1(\s+[A-Za-z]+(?:\([^)]*\))?(?:[^,()]|\([^)]*\))*?)\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\s*\(\s*\))?/gi,
      (_m, _q, col, rest) => {
        if (table) {
          extraStatements.push(
            `CREATE TRIGGER IF NOT EXISTS "${table}_${col}_onupdate" ` +
              `AFTER UPDATE ON "${table}" FOR EACH ROW BEGIN ` +
              `UPDATE "${table}" SET "${col}" = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid; END`
          );
        }
        return `${col}${rest}`;
      }
    );

    // SQLite takes AUTOINCREMENT only on a column declared exactly INTEGER
    // PRIMARY KEY; a display width is a different type token and the statement is
    // rejected. mysqldump writes `int(11) NOT NULL AUTO_INCREMENT` everywhere, so
    // strip the width - but only there, elsewhere it documents the source schema.
    out = out.replace(
      /\b(INT|INTEGER|BIGINT|MEDIUMINT|SMALLINT|TINYINT)\s*\(\s*\d+\s*\)([^,)]*?\bAUTO_INCREMENT\b)/gi,
      (_m, type, rest) => `${type}${rest}`
    );

    // Same rule, same reason: INTEGER UNSIGNED is a different type token, so
    // AUTOINCREMENT is rejected on it too. Scoped to the auto-increment column
    // because SQLite reads any type containing INT as INTEGER affinity, so
    // elsewhere UNSIGNED is harmless and still documents the source schema.
    out = out.replace(
      /\b(INT|INTEGER|BIGINT|MEDIUMINT|SMALLINT|TINYINT)\s+UNSIGNED\b([^,)]*?\bAUTO_INCREMENT\b)/gi,
      (_m, _type, rest) => `INTEGER${rest}`
    );

    // Any other integer width carrying AUTO_INCREMENT also has to become a
    // plain INTEGER: SQLite rejects `BIGINT ... AUTOINCREMENT` with
    // "AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY".
    // ox_property's decorations table declares BIGINT.
    out = out.replace(
      /\b(BIGINT|MEDIUMINT|SMALLINT|TINYINT)(\s*\(\s*\d+\s*\))?([^,)]*?\bAUTO_INCREMENT\b)/gi,
      (_m, _type, _width, rest) => `INTEGER${rest}`
    );

    // MySQL accepts AUTO_INCREMENT and PRIMARY KEY in EITHER order on a column.
    // SQLite accepts AUTOINCREMENT only IMMEDIATELY AFTER PRIMARY KEY, so one of
    // those two orders translates and the other does not.
    //
    // Measured 2026-10-13: night_shifts' schema writes
    //     id INTEGER AUTO_INCREMENT PRIMARY KEY
    // which came out the far side as `INTEGER AUTOINCREMENT PRIMARY KEY` and was
    // rejected with `near "AUTOINCREMENT": syntax error`. That failed the import,
    // the whole file rolled back, and because night_shifts gates `playerConnecting`
    // on its migration finishing, NOBODY COULD JOIN THE SERVER -- the deferral
    // said "the server is currently migrating the database" forever.
    //
    // Fixed here rather than in the .sql file because the file is a vendor
    // schema that an update overwrites, and because both orders are valid MySQL:
    // any dump may use either, so this is the general case, not one resource's
    // quirk. Reordering two adjacent keywords changes no semantics.
    //
    // This runs BEFORE the composite-key narrowing below, which only looks at
    // the `PRIMARY KEY (cols)` table-constraint form and is unaffected.
    out = out.replace(/\bAUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, "PRIMARY KEY AUTO_INCREMENT");

    // MySQL allows AUTO_INCREMENT on a column of a composite primary key;
    // SQLite takes AUTOINCREMENT only on a lone INTEGER PRIMARY KEY. Narrowing
    // the key to that column loses no constraint: an auto-increment column is
    // already unique on its own, so it subsumes the tuple's uniqueness. The
    // index the wider key provided is re-created separately, since queries
    // filtering on the trailing columns were relying on it.
    // Anchored on the column-list delimiter: without it the identifier group
    // backtracks all the way to CREATE, since nothing between there and the
    // first column contains a comma.
    const autoIncCol = /[(,]\s*[`"]?([A-Za-z0-9_$]+)[`"]?[^,()]*?\bAUTO_INCREMENT\b/i.exec(out);

    if (autoIncCol) {
      const col = autoIncCol[1];

      out = out.replace(/\bPRIMARY\s+KEY\s*\(([^)]*)\)/i, (whole, cols) => {
        const names = cols.split(",").map((c) =>
          c
            .trim()
            .replace(/[`"]/g, "")
            .replace(/\s*\(\d+\)$/, "")
        );

        if (names.length < 2 || !names.includes(col)) return whole;

        if (table) {
          const rest = names.filter((n) => n !== col);
          extraStatements.push(
            `CREATE INDEX IF NOT EXISTS "${table}_${rest.join("_")}" ` +
              `ON "${table}" (${rest.map((n) => `"${n}"`).join(", ")})`
          );
        }
        return `PRIMARY KEY (\`${col}\`)`;
      });

      // MySQL allows AUTO_INCREMENT on a column that is not the primary key, so
      // long as it is indexed. SQLite only allows AUTOINCREMENT on the INTEGER
      // PRIMARY KEY, and qb-core's `players` table - the most widely deployed
      // table in the ecosystem - does exactly this: AUTO_INCREMENT on `id`
      // while the PRIMARY KEY is `citizenid`. Translated naively it produced
      // `"id" INTEGER NOT NULL AUTOINCREMENT`, which SQLite rejects outright.
      //
      // So the column keeps its type and gives up the keyword, and a trigger
      // supplies the next value when an insert leaves it NULL. NOT NULL has to
      // go with it, or there is no way to omit the column in the first place.
      const pk = /\bPRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(out);
      const pkNames = pk ? pk[1].split(",").map((c) => c.trim().replace(/[`"]/g, "")) : [];
      const columnIsPk =
        pkNames.includes(col) ||
        new RegExp(`[(,]\\s*[\`"]?${col}[\`"]?[^,()]*?\\bPRIMARY\\s+KEY\\b`, "i").test(out);

      if (table && !columnIsPk) {
        out = out.replace(
          new RegExp(`([(,]\\s*[\`"]?${col}[\`"]?)([^,()]*?)\\bAUTO_INCREMENT\\b`, "i"),
          (_m, head, rest) => `${head}${rest.replace(/\bNOT\s+NULL\b/i, "")}`
        );

        extraStatements.push(
          `CREATE TRIGGER IF NOT EXISTS "${table}_${col}_autoinc" ` +
            `AFTER INSERT ON "${table}" FOR EACH ROW WHEN NEW."${col}" IS NULL BEGIN ` +
            `UPDATE "${table}" SET "${col}" = ` +
            `(SELECT IFNULL(MAX("${col}"), 0) + 1 FROM "${table}") ` +
            `WHERE rowid = NEW.rowid; END`
        );
      }
    }

    // Per-column CHARACTER SET, and the UNSIGNED / ZEROFILL qualifiers. These
    // survived translation and SQLite then rejected the whole statement with
    // "near SET" or "near UNSIGNED" - qbx_core's player_vehicles and
    // player_groups both die on it. Column collation is applied separately by
    // applyTextCollation, so dropping the MySQL spelling here is safe.
    out = out.replace(/\s+CHARACTER\s+SET\s+[A-Za-z0-9_]+/gi, "");
    out = out.replace(
      /\b(INT|INTEGER|BIGINT|MEDIUMINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|FLOAT|DOUBLE)(\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?\s+UNSIGNED\b/gi,
      (_m, type, width) => `${type}${width || ""}`
    );
    out = out.replace(/\s+ZEROFILL\b/gi, "");

    // ENUM('a','b') has no SQLite type, and qb-banking's bank_accounts uses
    // one. TEXT keeps the values readable and writable; a CHECK constraint
    // would reject rows MySQL accepted, since MySQL only warns on an
    // out-of-range enum in its default mode.
    out = out.replace(/\bENUM\s*\([^)]*\)/gi, "TEXT");

    // Table options SQLite has no concept of.
    out = out.replace(
      /\)\s*(ENGINE\s*=\s*\w+|DEFAULT\s+CHARSET\s*=\s*\w+|CHARACTER\s+SET\s+\w+|COLLATE\s*=?\s*\w+|AUTO_INCREMENT\s*=\s*\d+|ROW_FORMAT\s*=\s*\w+|COMMENT\s*=\s*'[^']*'|\s)*\s*;?\s*$/i,
      ")"
    );

    // Clean up any empty column-list entries left by the removals above.
    out = out
      .replace(/,\s*,/g, ",")
      .replace(/\(\s*,/g, "(")
      .replace(/,\s*\)/g, ")");

    return { sql: out, extraStatements };
  }

  // Text types whose MySQL default collation compares case-insensitively.
  const TEXT_TYPE =
    /\b(?:CHARACTER\s+VARYING|VARCHAR|NVARCHAR|VARCHAR2|NCHAR|CHAR|TINYTEXT|MEDIUMTEXT|LONGTEXT|TEXT|CLOB|ENUM)\b(\s*\([^)]*\))?/i;

  // Entries in a column list that define a constraint rather than a column.
  const TABLE_CONSTRAINT =
    /^\s*(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|KEY|INDEX)\b/i;

  // A column the author deliberately made byte-exact. MySQL's own way of
  // asking for case-sensitivity, so it must be honoured, not overridden.
  const EXPLICIT_BINARY = /\b(?:BINARY|COLLATE\s+\w*(?:_bin|_cs|BINARY)\w*)\b/i;

  // The only three collations SQLite knows.
  const SQLITE_COLLATIONS = /^(?:BINARY|NOCASE|RTRIM)$/i;

  /**
   * Nearest SQLite collation. `COLLATE utf8mb4_bin` is valid MySQL so it passes
   * the safety gate, but SQLite raises "no such collating sequence" the moment
   * the table is used. The suffix carries the only intent there ever is here:
   * compare exactly, or compare case-insensitively.
   */
  function mapCollation(entry) {
    return entry.replace(/\bCOLLATE\s+([A-Za-z0-9_]+)/gi, (whole, name) => {
      if (SQLITE_COLLATIONS.test(name)) return whole;
      if (/(?:_bin|_cs)$/i.test(name)) return "COLLATE BINARY";
      return "COLLATE NOCASE";
    });
  }

  /**
   * MySQL's default collation (utf8mb4_general_ci and friends) is
   * case-insensitive, so `WHERE license = 'LICENSE:AB12'` matches a stored
   * 'license:ab12'; SQLite compares TEXT byte-for-byte and returns nothing, with
   * no error. COLLATE NOCASE on the column restores that for =, IN, LIKE, ORDER
   * BY, GROUP BY and unique indexes alike.
   *
   * Limits: NOCASE folds ASCII only, so 'Ä' and 'ä' still differ where MySQL
   * would fold them (FiveM identifiers - licenses, citizen ids, plates - are
   * ASCII in practice), and this applies at CREATE TABLE, so a table that
   * predates it keeps binary collation until recreated. A column explicitly
   * asking for BINARY or a _bin/_cs collation is left alone.
   */
  function applyTextCollation(sql) {
    const mask = codeMask(sql);

    if (!/^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(mask)) return sql;

    const open = mask.indexOf("(");
    if (open === -1) return sql;

    const depths = parenDepths(mask);

    // Matching close paren for the column list.
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
      const end = bounds[b + 1] - 1; // Up to, but not including, the separator.
      const entry = sql.slice(start, end);

      out += sql.slice(cursor, start);
      cursor = end;

      if (/\bCOLLATE\b/i.test(entry)) {
        // Already spoken for; only make the name one SQLite recognises.
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

  // The safety gate. Polyglot reports success while passing several of these
  // through untouched, so this list is what stands between a bad translation and
  // corrupt data.
  const UNTRANSLATED = [
    [/\bON\s+DUPLICATE\s+KEY\b/i, "ON DUPLICATE KEY UPDATE"],
    [/\bUNIX_TIMESTAMP\s*\(/i, "UNIX_TIMESTAMP()"],
    [/\bFROM_UNIXTIME\s*\(/i, "FROM_UNIXTIME()"],
    [/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\s*(?:\(\s*\))?/i, "ON UPDATE CURRENT_TIMESTAMP"],
    // Both anchored to ALTER TABLE, for the reason ENGINE= below is: these are
    // ordinary words. Unanchored, `\bMODIFY\s+\S` matched the `modify = ?` in
    // `UPDATE perms SET modify = ? WHERE job = ?` and refused it outright.
    // `last_modify` was always safe (\b does not break on `_`); a column named
    // exactly `modify` was not.
    [/^\s*ALTER\s+TABLE\b[\s\S]*\bMODIFY\s+(?:COLUMN\s+)?\S/i, "ALTER TABLE ... MODIFY COLUMN"],
    [/^\s*ALTER\s+TABLE\b[\s\S]*\bCHANGE\s+COLUMN\b/i, "ALTER TABLE ... CHANGE COLUMN"],
    // Server features SQLite has no counterpart for at all. Each of these
    // passed the transpiler untouched and then failed at SQLite with "near
    // PROCEDURE/CALL/SET", which names a token rather than the feature.
    // Found in esx_core's hardening migration and a community house script.
    [/^\s*(?:CREATE|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?PROCEDURE\b/i, "stored procedure"],
    [/^\s*(?:CREATE|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?FUNCTION\b/i, "stored function"],
    [/^\s*CALL\s+[A-Za-z_]/i, "CALL (stored procedure)"],
    [/^\s*(?:PREPARE|EXECUTE|DEALLOCATE)\b/i, "PREPARE/EXECUTE (server-side prepared statement)"],
    [/^\s*SET\s+@/i, "SET @variable (session variable)"],
    [/^\s*(?:LOCK|UNLOCK)\s+TABLES\b/i, "LOCK TABLES"],
    [/\bSIGNAL\s+SQLSTATE\b/i, "SIGNAL SQLSTATE"],
    // SQLite cannot add a foreign key in place, so an ALTER that does is routed
    // to the table rebuild instead - see parseRebuildActions. This entry stays
    // for the shapes that are NOT an ALTER (a bare ADD FOREIGN KEY inside some
    // other statement), anchored so it cannot shadow the supported path.
    [
      /^(?!\s*ALTER\s+TABLE)[\s\S]*\bADD\s+(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\b/i,
      "ALTER TABLE ... ADD FOREIGN KEY",
    ],
    // No entry for MATCH ... AGAINST any more: rewriteMatchAgainst turns it into
    // a substring search across the same columns, which is a stated
    // approximation documented there and in the compatibility docs. The shapes
    // it cannot take - more than one placeholder in the search term - are left
    // for the transpiler to reject by position.
    // Multi-table DELETE, as in `DELETE a FROM a JOIN b ...`. SQLite deletes
    // from exactly one table and has no USING clause.
    [/^\s*DELETE\s+[A-Za-z_][A-Za-z0-9_]*\s+FROM\b/i, "multi-table DELETE"],
    [/^\s*DELETE\b[^;]*?\bUSING\b/i, "DELETE ... USING"],
    [/\bAUTO_INCREMENT\b/i, "AUTO_INCREMENT"],
    // Anchored to DDL, because `engine` is an ordinary column name: qbx_core
    // and qb-garages both run `UPDATE player_vehicles SET ... engine = ? ...`,
    // and an unanchored pattern refused those outright. Refusing valid SQL is
    // the worst outcome available here, so the statement type gates it.
    [/^\s*(?:CREATE|ALTER)\b[\s\S]*\bENGINE\s*=/i, "ENGINE="],
    [/\bDEFAULT\s+CHARSET\b/i, "DEFAULT CHARSET"],
    [/\b(UNIQUE\s+)?KEY\s+[`"]?[A-Za-z0-9_$]+[`"]?\s*\(/i, "inline KEY/INDEX definition"],
    // No entry for GROUP_CONCAT ... SEPARATOR any more. It was refusing
    // statements the transpiler already translates correctly: measured,
    // `GROUP_CONCAT(name SEPARATOR ', ')` becomes `GROUP_CONCAT(name, ', ')`,
    // which the real engine accepts and answers correctly. The two forms that
    // genuinely do not work - DISTINCT with a separator, and a bound parameter
    // in the ORDER BY - are refused by name in rewriteGroupConcat, and the
    // ORDER BY form that used to be dropped silently is now translated.
    [/\bSTRAIGHT_JOIN\b/i, "STRAIGHT_JOIN"],
    // SQLite's catalogue is sqlite_master and the pragma_* table functions, and
    // the column set here has no equivalent. Refused by name because otherwise
    // it reaches SQLite as "no such table", which names nothing useful.
    [/\bINFORMATION_SCHEMA\b/i, "INFORMATION_SCHEMA"],
    // SQLite cannot drop a constraint at all; the table has to be rebuilt.
    [/\bDROP\s+FOREIGN\s+KEY\b/i, "ALTER TABLE ... DROP FOREIGN KEY"],
    // SQLite's ALTER TABLE cannot add a constraint or retype a column; the
    // table has to be rebuilt. Each of these translated cleanly and then
    // failed at SQLite, which is the failure mode worth turning into a
    // refusal. 13 occurrences across esx_core and qbx_core.
    [/\bADD\s+(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\b/i, "ALTER TABLE ... ADD PRIMARY KEY"],
    // Procedural trigger bodies. SQLite triggers have no local variables, and
    // Polyglot passes all three through untouched, so without these the
    // operator gets SQLite's "near DECLARE/JOIN: syntax error" instead of the
    // name of the thing that needs rewriting. Each one is expressible by hand
    // (a scalar subquery, or a WHERE ... IN), which is why they are refused
    // rather than guessed at: these maintain counters, and a silently wrong
    // rewrite corrupts them for good.
    // A column-list-free INSERT is positional, and once PocketBase owns a table
    // the column order is PocketBase's, not the dump's: it sorts them. Measured
    // on phone_message_messages, where `id,channel_id,sender,content,...` became
    // `attachments,channel_id,content,id,...`. Every column survives, but values
    // written positionally would land in the wrong ones, silently. Naming the
    // columns is the fix, so say that rather than corrupting data.
    [
      // The gate matches against the code-masked statement, which blanks a
      // quoted table name to spaces, so this keys off the absence of a column
      // list: an identifier (or nothing, when it was quoted) and then VALUES,
      // with no "(" in between.
      //
      // The identifier is matched CHARACTER BY CHARACTER rather than with
      // `[^(]*?`. That lazy form read "any run of non-paren characters", which
      // a table name ending in `values` satisfies all by itself: it refused
      // `INSERT INTO fxsql_values (name, enabled, payload) VALUES (...)` -- a
      // fully named INSERT -- as having no column list, and the same for
      // `qbxsql_benchmark_values`. Both are real statements in Qbox-project's
      // qbxsql. Refusing valid SQL is the worst outcome available here, and
      // this one hid behind codeMask: a BACKTICKED `\`fxsql_values\`` is
      // blanked before the gate runs and passed, so it only bit unquoted names.
      //
      // `OR IGNORE` as well as `IGNORE`: the gate runs after INSERT IGNORE has
      // already been rewritten to SQLite's INSERT OR IGNORE.
      /^\s*(?:INSERT(?:\s+(?:OR\s+)?IGNORE)?|REPLACE)\s+INTO\s+[A-Za-z0-9_$.]*\s+VALUES\b/i,
      "INSERT without a column list (name the columns)",
    ],
    // Scoped to a CREATE body, which is the only place a procedural DECLARE can
    // appear. The bare word refused `SELECT declare FROM customs WHERE id = ?`.
    // Anchoring on the statement type rather than on what follows DECLARE,
    // because `DECLARE <name> <type>` and `declare FROM <table>` are the same
    // shape -- word, word, word -- so no lookahead can separate them.
    [/^\s*CREATE\b[\s\S]*\bDECLARE\b/i, "DECLARE (procedural trigger body)"],
    [/\bSELECT\b[^;]*?\s\bINTO\s+[`"]?[A-Za-z0-9_$]+/i, "SELECT ... INTO (variable)"],
    // JOIN before SET, so a join inside a SET subquery stays legal.
    [/\bUPDATE\b[^;]*?\bJOIN\b[^;]*?\bSET\b/i, "UPDATE ... JOIN (multi-table UPDATE)"],
    [/\bSQL_CALC_FOUND_ROWS\b/i, "SQL_CALC_FOUND_ROWS"],
    [/\bDATE_ADD\s*\(|\bDATE_SUB\s*\(/i, "DATE_ADD()/DATE_SUB()"],
    [/\bINTERVAL\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\b/i, "INTERVAL"],
    [/`/, "backtick-quoted identifier"],
  ];

  // Only a top-level LIMIT is a problem; the rowid rewrite above puts a
  // perfectly legal one inside a subquery.
  function hasTopLevelWriteLimit(mask) {
    if (!/^\s*(DELETE|UPDATE)\b/i.test(mask)) return false;
    return findTopLevel(mask, /\bLIMIT\b/gi) !== -1;
  }

  // Throws SQLTranslationError if MySQL-only syntax survived translation.
  function assertTranslated(translated, originalSql) {
    const mask = codeMask(translated);

    for (const [pattern, construct] of UNTRANSLATED) {
      if (pattern.test(mask)) {
        throw new SQLTranslationError(
          `Cannot translate MySQL to SQLite: unsupported construct ${construct}. ` +
            `Rewrite the query, or use the PocketBase exports directly.`,
          { sql: originalSql, construct, translated }
        );
      }
    }

    if (hasTopLevelWriteLimit(mask)) {
      throw new SQLTranslationError(
        "Cannot translate MySQL to SQLite: unsupported construct DELETE/UPDATE ... LIMIT. " +
          "Rewrite the query, or use the PocketBase exports directly.",
        { sql: originalSql, construct: "DELETE/UPDATE ... LIMIT", translated }
      );
    }
  }

  const cache = new Map();
  const MAX_CACHE_ENTRIES = 2000;

  /**
   * Translate a MySQL statement into SQLite with PocketBase bind syntax.
   * options.resolveConflictTarget maps a table name to its primary/unique key
   * columns and is required only for ON DUPLICATE KEY UPDATE. Throws
   * SQLTranslationError when faithful translation is not possible.
   */
  function translate(sql, params, options = {}) {
    if (typeof sql !== "string" || sql.trim() === "") {
      throw new SQLTranslationError("Empty SQL statement", { sql });
    }

    if (!isReady()) {
      throw new SQLTranslationError("SQL translator is not initialised yet - await init() first", {
        sql,
      });
    }

    // Parameters are bound separately, so one shape always translates the same.
    const cacheKey = sql;
    let shape = cache.get(cacheKey);

    if (!shape) {
      shape = buildShape(sql, options);

      if (cache.size >= MAX_CACHE_ENTRIES) {
        // FIFO. Shapes are stable, so this only trims pathological cases such as
        // unparameterised generated SQL.
        cache.delete(cache.keys().next().value);
      }
      cache.set(cacheKey, shape);
    }

    const bound = toPocketBaseParams(shape.sql, shape.keys, params);

    return {
      sql: bound.sql,
      params: bound.params,
      extraStatements: shape.extraStatements,
      // Present only for an ALTER that needs a table rebuild. The caller has to
      // act on it: `sql` is the untranslated original and must not be executed.
      rebuild: shape.rebuild,
    };
  }

  // Transpile MySQL to SQLite, turning a parse failure into our own error.
  function transpileOrThrow(sql, originalSql) {
    const result = polyglot.transpile(sql, "mysql", "sqlite");

    if (!result.success || !result.sql || !result.sql[0]) {
      throw new SQLTranslationError(`Could not parse SQL as MySQL: ${result.error}`, {
        sql: originalSql,
      });
    }
    return result.sql[0];
  }

  // Pull the assignment list back out of a transpiled dummy UPDATE.
  function extractSetClause(updateSql, originalSql) {
    const mask = codeMask(updateSql);
    const setIndex = findTopLevel(mask, /\bSET\b/gi);

    if (setIndex === -1) {
      throw new SQLTranslationError(
        "Could not translate the ON DUPLICATE KEY UPDATE assignment list",
        { sql: originalSql, construct: "ON DUPLICATE KEY UPDATE" }
      );
    }
    return updateSql.slice(setIndex + "SET".length).trim();
  }

  // Run the full pipeline for one query shape.
  // Statement types MySQL has and SQLite does not, checked against the
  // original text before anything rewrites it.
  //
  // These cannot live in the gate below, which inspects the TRANSLATED
  // statement: by then `SET @var = ...` has had its `@var` turned into a bind
  // placeholder, so the pattern no longer matches and the statement sailed
  // through to fail at SQLite with "near SET". Found in esx_core's hardening
  // migration, which drives itself with session variables and PREPARE.
  const UNSUPPORTED_STATEMENTS = [
    [/^\s*(?:CREATE|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?PROCEDURE\b/i, "stored procedure"],
    [/^\s*(?:CREATE|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?FUNCTION\b/i, "stored function"],
    [/^\s*CALL\s+[A-Za-z_]/i, "CALL (stored procedure)"],
    [/^\s*(?:PREPARE|EXECUTE|DEALLOCATE)\b/i, "PREPARE/EXECUTE (server-side prepared statement)"],
    [/^\s*SET\s+@/i, "SET @variable (session variable)"],
    [/^\s*(?:LOCK|UNLOCK)\s+TABLES\b/i, "LOCK TABLES"],
    [/\bSIGNAL\s+SQLSTATE\b/i, "SIGNAL SQLSTATE"],
    // mysqldump wraps version-gated directives in /*!NNNNN ... */, which is a
    // MySQL extension carrying real statements, not a comment.
    [/\/\*![0-9]{5}/, "mysqldump conditional directive"],
  ];

  // Not valid MySQL either - a server rejects these too. They are named here
  // rather than left to the parser because the parser's complaint identifies a
  // TOKEN (`Expected identifier, got "Comma"`, `Unexpected token: Where`),
  // which tells an operator nothing about what to change. Checked against the
  // ORIGINAL text, because a statement that cannot be parsed never reaches the
  // output gate at all - which is where putting them first failed.
  const MALFORMED_STATEMENTS = [
    // A fragment beginning with WHERE: a piece of a statement rather than a
    // statement, usually a builder that concatenated its clauses in the wrong
    // order. qbx_core's handleSearchFilters returns a bare ' WHERE ' when it
    // has no filters to add.
    [/^\s*WHERE\b/i, "a statement beginning with WHERE (an incomplete fragment)"],
  ];

  /**
   * Two commas with nothing between them, as in
   * `ADD COLUMN x varchar(500) DEFAULT 'resimsiz',, AFTER y`.
   *
   * Not a regex over the code mask, which is what the first attempt was and
   * what made it fire on 13 valid statements: codeMask blanks a literal's
   * CONTENT, so `a, 'x', b` masks to `a,` + spaces + `,` and reads as a
   * doubled comma. The mask still says which commas are code; whether the gap
   * between two of them is really empty has to be read off the ORIGINAL, where
   * a blanked literal is still `'x'` and not whitespace.
   */
  function hasEmptyListEntry(sql) {
    const mask = codeMask(sql);
    let previous = -1;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== ",") continue;
      if (previous !== -1 && sql.slice(previous + 1, i).trim() === "") return true;
      previous = i;
    }

    return false;
  }

  function assertStatementSupported(sql) {
    const mask = codeMask(sql);

    if (/^\s*(?:CREATE|ALTER)\b/i.test(mask) && hasEmptyListEntry(sql)) {
      const construct = "an empty entry in the column list (a duplicated comma)";
      throw new SQLTranslationError(
        `This is not a valid statement: ${construct}. MySQL would reject it too, ` +
          `so it is reported here rather than as a parse error naming a token.`,
        { sql, construct }
      );
    }

    for (const [pattern, construct] of MALFORMED_STATEMENTS) {
      if (pattern.test(mask)) {
        throw new SQLTranslationError(
          `This is not a valid statement: ${construct}. MySQL would reject it too, ` +
            `so it is reported here rather than as a parse error naming a token.`,
          { sql, construct }
        );
      }
    }

    for (const [pattern, construct] of UNSUPPORTED_STATEMENTS) {
      if (pattern.test(sql)) {
        throw new SQLTranslationError(
          `Cannot translate MySQL to SQLite: unsupported construct ${construct}. ` +
            `SQLite has no equivalent, so there is nothing to translate it to.`,
          { sql, construct }
        );
      }
    }
  }

  function buildShape(originalSql, options) {
    // Before the gate, because the gate refuses MODIFY/CHANGE by name and this
    // is what makes them work. The statement itself is not translated: a
    // rebuild needs the live schema, so the executor plans it from this
    // descriptor and never runs `sql`.
    const rebuild = parseRebuildActions(originalSql);
    if (rebuild) {
      return { sql: originalSql, keys: [], extraStatements: [], rebuild };
    }

    assertStatementSupported(originalSql);

    const normalized = normalizePlaceholders(originalSql);

    let working = normalized.sql;
    let extraStatements = [];
    // Set when a CREATE OR REPLACE VIEW needs a DROP emitted ahead of it.
    let replacedView = null;

    // Two spellings the MySQL front end will not parse, normalised before it
    // sees them. Both are valid MySQL and both appear in shipped schemas.

    // `INT (10)` with a space before the width. ox_mdt writes every column
    // this way, and the parse failure took its whole schema with it.
    working = working.replace(
      /\b(INT|INTEGER|BIGINT|MEDIUMINT|SMALLINT|TINYINT|VARCHAR|CHAR|DECIMAL|NUMERIC|FLOAT|DOUBLE)\s+\(/gi,
      "$1("
    );

    // `UPDATE IGNORE`. The transpiler rejects the keyword outright, so it is
    // taken off here and SQLite's `OR IGNORE` is put back after translation.
    const updateIgnore = /^\s*UPDATE\s+IGNORE\s+/i.test(working);
    if (updateIgnore) {
      working = working.replace(/^(\s*UPDATE)\s+IGNORE\s+/i, "$1 ");
    }

    // `FOREIGN KEY `idx_name` (cols) REFERENCES ...` - MySQL allows an index
    // name between the keyword and the column list, which the transpiler does
    // not accept. The name only names the implicit index, so dropping it keeps
    // the constraint. qbx_vehicleshop's vehicle_financing writes it this way.
    working = working.replace(/\bFOREIGN\s+KEY\s+[`"][A-Za-z0-9_$]+[`"]\s*\(/gi, "FOREIGN KEY (");

    // `DROP INDEX name ON table` -> `DROP INDEX name`. MySQL names the table,
    // SQLite does not, and index names are global there anyway. qbx_weed drops
    // its index this way.
    working = working.replace(
      /^(\s*DROP\s+INDEX\s+[`"[]?[A-Za-z0-9_$]+[`"\]]?)\s+ON\s+[`"[]?[A-Za-z0-9_$]+[`"\]]?/i,
      "$1"
    );

    // `DROP COLUMN IF EXISTS c` -> `DROP COLUMN c`. MariaDB accepts the guard,
    // SQLite does not, and src-phone writes it.
    working = working.replace(/\bDROP\s+COLUMN\s+IF\s+EXISTS\s+/gi, "DROP COLUMN ");

    // `CREATE OR REPLACE VIEW v AS ...` -> a DROP plus a CREATE. SQLite has no
    // OR REPLACE for views. anpr-for-wk_wars2x defines its view this way.
    const replaceView = /^\s*CREATE\s+OR\s+REPLACE\s+VIEW\s+([`"[]?[A-Za-z0-9_$]+[`"\]]?)/i.exec(
      working
    );
    if (replaceView) {
      replacedView = replaceView[1].replace(/[`"\[\]]/g, "");
      working = working.replace(/^(\s*CREATE)\s+OR\s+REPLACE\s+VIEW\b/i, "$1 VIEW");
    }

    // MySQL-side rewrites, before the transpiler sees the statement.
    // SHOW TABLES first: it is a whole-statement replacement, and the rewrites
    // below operate on expressions inside a statement the transpiler can read.
    working = rewriteShowTables(working);
    working = rewriteInformationSchema(working);
    working = rewriteShowFamily(working);
    working = expandValuesInsert(working, options.resolveColumnOrder);
    // A rewrite may REORDER or DUPLICATE placeholders. When it does it says how,
    // and the key list is rebuilt to match - see rewriteUpdateJoin and
    // rewriteMatchAgainst. Composed in the order the rewrites run.
    let keyOrder = null;

    const matched = rewriteMatchAgainst(working);
    working = matched.sql;
    if (matched.expansions.length) {
      const total = (codeMask(normalized.sql).match(/\?/g) || []).length;
      const grown = [];
      for (let i = 0; i < total; i++) {
        const expansion = matched.expansions.find((e) => e.index === i);
        const copies = expansion ? expansion.copies : 1;
        for (let c = 0; c < copies; c++) grown.push(i);
      }
      keyOrder = grown;
    }

    const updateJoined = rewriteUpdateJoin(working);
    working = updateJoined.sql;
    if (updateJoined.order) {
      // Composed: the JOIN rewrite's order indexes the list as it stands now,
      // which is already the expanded one when a MATCH ran first.
      keyOrder = keyOrder ? updateJoined.order.map((at) => keyOrder[at]) : updateJoined.order;
    }
    working = rewriteDeleteJoin(working);
    working = rewriteGroupConcat(working);
    working = rewriteFunctions(working);
    working = rewriteDeleteLimit(working);

    const created = rewriteCreateTable(working);
    working = created.sql;
    extraStatements = created.extraStatements;

    const altered = rewriteAlterTable(working);
    working = altered.sql;
    extraStatements = extraStatements.concat(altered.extraStatements);

    // Polyglot's MySQL front end cannot parse CREATE TRIGGER IF NOT EXISTS,
    // though both MariaDB and SQLite accept it. Drop it for the parser and put
    // it back on the output, so re-importing a dump stays idempotent.
    const triggerIfNotExists = /^\s*CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\b/i.test(working);

    if (triggerIfNotExists) {
      working = working.replace(/^(\s*CREATE\s+TRIGGER)\s+IF\s+NOT\s+EXISTS\b/i, "$1");
    }

    // ON CONFLICT is not MySQL syntax, so the upsert cannot be assembled before
    // transpiling: the MySQL parser would reject its own output. Translate the
    // INSERT and the assignment list separately, then join them.
    const upsert = splitUpsert(working, options.resolveConflictTarget);

    let translated;
    if (upsert && upsert.plainInsert) {
      translated = transpileOrThrow(upsert.insert, originalSql);
    } else if (upsert) {
      const insertSql = transpileOrThrow(upsert.insert, originalSql);
      const setSql = extractSetClause(
        transpileOrThrow(`UPDATE \`${upsert.table}\` SET ${upsert.assignments}`, originalSql),
        originalSql
      );

      const targetList = upsert.target.map((c) => `"${c}"`).join(", ");
      translated = `${insertSql} ON CONFLICT (${targetList}) DO UPDATE SET ${setSql}`;
    } else {
      translated = transpileOrThrow(working, originalSql);
    }

    // MySQL's INSERT IGNORE is SQLite's INSERT OR IGNORE. Polyglot passes the
    // keyword through untouched and SQLite then fails with "near IGNORE".
    // ox_inventory seeds its items table with exactly this.
    translated = translated.replace(/^(\s*INSERT)\s+IGNORE\s+INTO\b/i, "$1 OR IGNORE INTO");

    // The unquoting marker, now that the transpiler is done and cannot collapse
    // it back onto `->`. json_extract returns a bare scalar, which is what
    // MySQL's ->> and JSON_UNQUOTE promise.
    translated = translated.replace(/\bTDB_JSON_TEXT\s*\(/gi, "json_extract(");

    // And the GROUP_CONCAT marker, with its ORDER BY moved to where SQLite
    // takes it. Also after transpiling, for the same reason.
    translated = restoreGroupConcat(translated);

    // The keyword was removed before the parser saw it; restore it as SQLite
    // spells it.
    if (updateIgnore) {
      translated = translated.replace(/^(\s*UPDATE)\s+/i, "$1 OR IGNORE ");
    }

    // `FOR UPDATE` is dropped rather than refused. It asks MySQL to hold a row
    // lock for the rest of the transaction; SQLite serialises writers with a
    // single write lock per database, so the guarantee the caller wanted is
    // already in force and the clause has nothing left to express. ox_banking
    // uses it when moving money.
    translated = translated.replace(/\s+FOR\s+UPDATE\s*(?=;?\s*$)/i, "");

    if (triggerIfNotExists) {
      translated = translated.replace(/^(\s*CREATE\s+TRIGGER)\b/i, "$1 IF NOT EXISTS");
    }

    // The DROP has to precede the CREATE, and extraStatements run after the
    // main statement, so it is prepended to the batch by the caller instead.
    if (replacedView) {
      extraStatements = [`DROP VIEW IF EXISTS "${replacedView}"`].concat(extraStatements);
    }

    assertTranslated(translated, originalSql);

    // After the gate: it deliberately introduces a COLLATE clause the MySQL-side
    // checks have no reason to expect.
    if (options.textCollation !== false) {
      translated = applyTextCollation(translated);
    }

    // The permutation is applied last, so it describes the ORIGINAL placeholder
    // positions regardless of what else ran in between. A malformed order is
    // ignored rather than trusted: silently re-pairing parameters is the exact
    // failure this machinery exists to avoid.
    // A permutation has the same length; an expansion is longer. Either is
    // fine - what is not is an entry pointing outside the original list, which
    // would bind the wrong value, so that is checked rather than trusted.
    let keys = normalized.keys;
    if (keyOrder && keyOrder.every((from) => from >= 0 && from < keys.length)) {
      keys = keyOrder.map((from) => keys[from]);
    }

    return {
      sql: translated,
      keys,
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
    // Exposed for tests. Eleven other helpers were listed here and none of
    // them was ever read - the suite reaches everything else through
    // translate(), which is the better test anyway because it exercises the
    // ordering between the rewrites rather than one in isolation. Add a name
    // back when a test actually needs it.
    _internal: { normalizePlaceholders },
  };
})();
