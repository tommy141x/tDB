// SQLite's ALTER TABLE cannot retype a column, change a default, add or remove
// NOT NULL, or add a constraint. The documented workaround is the 12-step table
// rebuild, and this plans it: a pure function from live introspection plus the
// parsed ALTER to an ordered list of SQLite statements.
//
// Everything below was measured against the SQLite that ships inside
// node:sqlite on this machine (3.53.0, one patch behind PocketBase 0.40.4's
// 3.53.4) before it was written. Four of those measurements contradict the
// obvious implementation:
//
//   * `INSERT OR REPLACE INTO sqlite_sequence` does NOT set a sequence. There
//     is no unique index on sqlite_sequence.name - the table is declared
//     `CREATE TABLE sqlite_sequence(name,seq)` with no index at all - so OR
//     REPLACE has nothing to conflict with and simply appends a second row.
//     Measured: after that, the next id was 2, not 9. DELETE then INSERT.
//
//   * `PRAGMA foreign_keys` is a no-op inside a transaction, so the documented
//     off/rebuild/on bracket cannot live inside the caller's transaction.
//     `PRAGMA defer_foreign_keys=ON` does take effect inside one, and is still
//     wrong: a rebuild under it left `PRAGMA foreign_key_check` empty and then
//     failed at COMMIT with "FOREIGN KEY constraint failed", leaving the
//     transaction open. See the note above PRAGMA_OFF.
//
//   * Dropping a table does not drop triggers on OTHER tables that reference
//     it, and the final `ALTER TABLE ... RENAME TO` reparses the whole schema -
//     so that rename dies with "error in trigger <t>: no such table" unless
//     every trigger comes off first and goes back on afterwards. Same trap
//     pb-adopt.js hit on lb-phone's schema, reached here from the other end.
//
//   * pragma_table_info cannot describe a table well enough to rebuild it. It
//     reports name/type/notnull/dflt_value/pk and loses COLLATE, UNIQUE, CHECK,
//     FOREIGN KEY and AUTOINCREMENT - all four were measured missing from a
//     table that has them. Rebuilding from the pragma alone therefore silently
//     drops constraints, so this module requires the original CREATE TABLE text
//     and patches that in place instead. See planRebuild's doc comment.
//
// The caller does the introspection and the execution; this only decides what
// to run.
module.exports = (() => {
  // Double quotes, NOT backticks. The opposite of pb-adopt.js's quote(), and
  // deliberately: pb-adopt sends its statements through the oxmysql path, where
  // MySQL reads "x" as a string literal. These statements are already SQLite
  // and must not be translated again, exactly like the trigger restores at the
  // end of pb-adopt's adopt().
  function quote(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  function literal(text) {
    return `'${String(text).replace(/'/g, "''")}'`;
  }

  const WORKING_SUFFIX = "__tdb_rebuild";
  const GUARD_TABLE = "tdb_rebuild_guard";

  // Emitted as the first and last statements, and the caller has to run those
  // two OUTSIDE its transaction, because the pragma is silently ignored inside
  // one (measured: it still read 1 after being set to 0 mid-transaction).
  //
  // They are emitted anyway rather than left to the caller because getting this
  // wrong is safe in the only direction that matters: with foreign keys still
  // enforced, the DROP TABLE below fails with "FOREIGN KEY constraint failed"
  // and the transaction rolls back with the data untouched. Loud and lossless.
  //
  // PRAGMA foreign_key_check is NOT emitted. It reports violations as result
  // rows rather than as an error, so a statement list executed for effect
  // cannot act on it - it would be theatre. The caller that wants the check can
  // run it itself between the rebuild and the re-enable.
  const PRAGMA_OFF = "PRAGMA foreign_keys = OFF";
  const PRAGMA_ON = "PRAGMA foreign_keys = ON";

  function refuse(message, construct) {
    const error = new Error(message);
    error.construct = construct;
    return error;
  }

  /**
   * SQLite's own affinity rules, in their documented order, plus one MySQL
   * correction.
   *
   * This is the single biggest simplification in the module. SQLite has no
   * column widths, no character sets and no per-type storage classes: a
   * declared type is only a hint that picks one of five affinities. So
   * VARCHAR(11), VARCHAR(50) and MEDIUMTEXT are all exactly TEXT, and an ALTER
   * that changes nothing but a width, a CHARACTER SET or a case-insensitive
   * COLLATE asks for a table that SQLite already has - no rebuild, no
   * statements, nothing to do. Five of the twelve harvested statements are that
   * case.
   *
   * The correction: by rule 5, MySQL's ENUM and SET would land on NUMERIC,
   * which would make `enum('a','b')` compare as a number. They are text, and
   * SQLite cannot even parse the parenthesised member list - measured, `CREATE
   * TABLE c (x enum('a','b'))` is a syntax error - so they are mapped to TEXT
   * before the generic rules run.
   */
  function affinityOf(declared) {
    const type = String(declared == null ? "" : declared).toUpperCase();

    if (/^\s*(?:ENUM|SET)\b/.test(type)) return "TEXT";
    if (type.includes("INT")) return "INTEGER";
    if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT";
    if (!type.trim() || type.includes("BLOB")) return "BLOB";
    if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "REAL";
    return "NUMERIC";
  }

  const TOKEN =
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|--[^\n]*|\/\*[\s\S]*?\*\/|\S/g;

  function tokenise(text) {
    const out = [];
    const re = new RegExp(TOKEN.source, "g");
    let m = re.exec(text);
    while (m) {
      out.push({ text: m[0], at: m.index, end: m.index + m[0].length });
      m = re.exec(text);
    }
    return out;
  }

  const keyword = (token, word) => !!token && token.text.toUpperCase() === word;

  function unquoteIdentifier(text) {
    const first = text[0];
    if (first === '"' || first === "`") return text.slice(1, -1).replace(first + first, first);
    if (first === "[") return text.slice(1, -1);
    return text;
  }

  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  // Split a parenthesised list on commas at depth 0, quotes respected. Same
  // shape as trigger-rewrite's splitBody, on commas instead of semicolons.
  function splitTopLevel(body) {
    const out = [];
    let depth = 0;
    let quoteChar = null;
    let current = "";

    for (const ch of body) {
      if (quoteChar) {
        current += ch;
        if (ch === quoteChar) quoteChar = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quoteChar = ch;
        current += ch;
        continue;
      }
      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        out.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    out.push(current);
    return out;
  }

  const DEFAULT_NOW =
    /^(?:CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i;

  /**
   * Parse one MySQL column definition body - the text AFTER the column name -
   * into a normalised shape.
   *
   * Anything not recognised is refused by name rather than ignored. An ignored
   * keyword is the dangerous outcome here: `GENERATED ALWAYS AS` or `ON UPDATE
   * CURRENT_TIMESTAMP` silently dropped produces a table that accepts every
   * write and holds the wrong values.
   */
  function parseColumnDef(text) {
    const src = String(text == null ? "" : text).trim();

    const head = /^([A-Za-z_][A-Za-z0-9_]*(?:\s+(?:PRECISION|VARYING))?)\s*(\(\s*[^)]*\))?/.exec(
      src
    );
    if (!head) {
      throw refuse(`a column definition with no type: "${src}"`, "column definition with no type");
    }

    const type = head[1].replace(/\s+/g, " ") + (head[2] ? head[2].replace(/\s+/g, "") : "");
    const tokens = tokenise(src.slice(head[0].length));

    const def = {
      type,
      affinity: affinityOf(type),
      notNull: null,
      hasDefault: false,
      dflt: null,
      autoIncrement: false,
      // Additive, beyond the documented six. Each one changes the SQLite
      // declaration that has to come out the other end, so dropping it would
      // be the silent-wrong-table outcome described above.
      collate: null,
      binaryCollation: false,
      primaryKey: false,
      unique: false,
      after: null,
      first: false,
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const word = token.text.toUpperCase();

      if (word === "UNSIGNED" || word === "SIGNED" || word === "ZEROFILL") continue;

      if (word === "NOT" && keyword(tokens[i + 1], "NULL")) {
        def.notNull = true;
        i++;
        continue;
      }
      if (word === "NULL") {
        def.notNull = false;
        continue;
      }
      if (word === "AUTO_INCREMENT") {
        def.autoIncrement = true;
        continue;
      }
      if (word === "PRIMARY" && keyword(tokens[i + 1], "KEY")) {
        def.primaryKey = true;
        i++;
        continue;
      }
      if (word === "UNIQUE") {
        if (keyword(tokens[i + 1], "KEY")) i++;
        def.unique = true;
        continue;
      }
      if ((word === "CHARACTER" && keyword(tokens[i + 1], "SET")) || word === "CHARSET") {
        // A character set has no SQLite counterpart at all: text is stored as
        // the bytes given, and affinity does not depend on the encoding.
        i += word === "CHARSET" ? 1 : 2;
        continue;
      }
      if (word === "COLLATE") {
        const name = tokens[i + 1] ? unquoteIdentifier(tokens[i + 1].text) : "";
        if (!name) throw refuse("COLLATE with no collation name", "COLLATE");
        def.collate = name;
        // MySQL's own way of asking for byte-exact comparison, and the only
        // collation difference SQLite can actually express. Mirrors
        // sql-translator's EXPLICIT_BINARY / mapCollation pair.
        def.binaryCollation = /(?:_bin|_cs)$/i.test(name) || /^(?:BINARY)$/i.test(name);
        i++;
        continue;
      }
      if (word === "COMMENT") {
        i++;
        continue;
      }
      if (word === "AFTER") {
        if (!tokens[i + 1]) throw refuse("AFTER with no column name", "AFTER");
        def.after = unquoteIdentifier(tokens[i + 1].text);
        i++;
        continue;
      }
      if (word === "FIRST") {
        def.first = true;
        continue;
      }
      if (word === "DEFAULT") {
        const consumed = parseDefault(tokens, i + 1);
        def.hasDefault = true;
        def.dflt = consumed.sql;
        i = consumed.next - 1;
        continue;
      }
      if (word === "ON" && keyword(tokens[i + 1], "UPDATE")) {
        throw refuse(
          "ON UPDATE CURRENT_TIMESTAMP has no SQLite form; a trigger is needed",
          "ON UPDATE CURRENT_TIMESTAMP"
        );
      }
      if (word === "GENERATED" || word === "AS") {
        throw refuse("a generated column cannot be reproduced here", "generated column");
      }
      if (word === "REFERENCES") {
        throw refuse(
          "an inline REFERENCES in a MODIFY/CHANGE cannot be reproduced here",
          "inline REFERENCES"
        );
      }

      throw refuse(
        `unrecognised keyword "${token.text}" in the column definition "${src}"`,
        `column definition keyword ${token.text.toUpperCase()}`
      );
    }

    return def;
  }

  // Turns a MySQL default into SQLite's own SQL text. Only forms that mean the
  // same thing in both engines are accepted.
  function parseDefault(tokens, start) {
    const token = tokens[start];
    if (!token) throw refuse("DEFAULT with no value", "DEFAULT");

    const text = token.text;
    const word = text.toUpperCase();

    if (word === "NULL") return { sql: "NULL", next: start + 1 };
    if (word === "TRUE") return { sql: "1", next: start + 1 };
    if (word === "FALSE") return { sql: "0", next: start + 1 };

    if (DEFAULT_NOW.test(word)) {
      // MySQL writes `CURRENT_TIMESTAMP`, `CURRENT_TIMESTAMP()` and `NOW()`;
      // SQLite has only the bare keyword and no NOW at all.
      let next = start + 1;
      if (tokens[next] && tokens[next].text === "(") {
        if (!tokens[next + 1] || tokens[next + 1].text !== ")") {
          throw refuse(`DEFAULT ${text} with arguments`, "DEFAULT with a function call");
        }
        next += 2;
      }
      return { sql: "CURRENT_TIMESTAMP", next };
    }

    if (text[0] === "'") {
      if (text.includes("\\")) {
        // MySQL reads \' and \\ inside a string literal; SQLite does not, so
        // the same bytes would mean something different. Refusing beats
        // guessing which engine's rules the dump was written for.
        throw refuse(
          `DEFAULT ${text} uses a backslash escape, which SQLite does not read`,
          "DEFAULT with a backslash escape"
        );
      }
      return { sql: text, next: start + 1 };
    }

    if (/^\d/.test(text)) return { sql: text, next: start + 1 };

    if (text === "-" || text === "+") {
      const number = tokens[start + 1];
      if (!number || !/^\d/.test(number.text)) {
        throw refuse(`DEFAULT ${text}${number ? number.text : ""}`, "DEFAULT");
      }
      return { sql: `${text}${number.text}`, next: start + 2 };
    }

    // MySQL's bit literal, as emitted for BOOLEAN columns: DEFAULT b'0'.
    if (/^b$/i.test(text) && tokens[start + 1] && tokens[start + 1].text[0] === "'") {
      const bits = tokens[start + 1].text.slice(1, -1);
      if (!/^[01]+$/.test(bits)) throw refuse(`DEFAULT b'${bits}'`, "DEFAULT bit literal");
      return { sql: String(Number.parseInt(bits, 2)), next: start + 2 };
    }

    if (text === "(") {
      throw refuse(
        "a DEFAULT (expression) cannot be reproduced without parsing it",
        "DEFAULT (expression)"
      );
    }

    throw refuse(`DEFAULT ${text} is not a form this understands`, `DEFAULT ${word}`);
  }

  const TABLE_CONSTRAINT =
    /^\s*(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|KEY|INDEX)\b/i;

  function parseCreateTable(sql) {
    const text = String(sql || "");
    const open = text.indexOf("(");
    if (open === -1) throw refuse("the CREATE TABLE text has no column list", "CREATE TABLE text");

    let depth = 0;
    let quoteChar = null;
    let close = -1;

    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (quoteChar) {
        if (ch === quoteChar) quoteChar = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quoteChar = ch;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) {
      throw refuse("the CREATE TABLE text has an unbalanced column list", "CREATE TABLE text");
    }

    const entries = splitTopLevel(text.slice(open + 1, close)).map((entry) => {
      if (TABLE_CONSTRAINT.test(entry)) return { text: entry, name: null };
      const tokens = tokenise(entry);
      if (!tokens.length) return { text: entry, name: null };
      return { text: entry, name: unquoteIdentifier(tokens[0].text), nameToken: tokens[0] };
    });

    return { entries, tail: text.slice(close + 1) };
  }

  /**
   * Strip NOT NULL / NULL / DEFAULT / COLLATE out of an existing column entry's
   * flag text, keeping everything else verbatim.
   *
   * MySQL's MODIFY replaces exactly those four; the primary key, AUTOINCREMENT,
   * UNIQUE, CHECK and REFERENCES survive a MODIFY in MySQL and so must survive
   * it here. Carrying the remaining text through unparsed is what keeps a CHECK
   * expression or a composite REFERENCES byte-identical instead of
   * reconstructed.
   */
  function carriedFlags(entry, nameEnd) {
    const flags = entry.slice(nameEnd);
    const tokens = tokenise(flags);

    // The first token is the declared type, which the new definition replaces.
    let cursor = 0;
    if (tokens.length && /^[A-Za-z_]/.test(tokens[0].text)) {
      cursor = 1;
      if (tokens[1] && (keyword(tokens[1], "PRECISION") || keyword(tokens[1], "VARYING"))) {
        cursor = 2;
      }
      if (tokens[cursor] && tokens[cursor].text === "(") {
        let depth = 0;
        while (tokens[cursor]) {
          if (tokens[cursor].text === "(") depth++;
          if (tokens[cursor].text === ")") {
            depth--;
            if (depth === 0) {
              cursor++;
              break;
            }
          }
          cursor++;
        }
      }
    }

    const kept = [];
    for (let i = cursor; i < tokens.length; i++) {
      const word = tokens[i].text.toUpperCase();

      if (word === "NOT" && keyword(tokens[i + 1], "NULL")) {
        i++;
        continue;
      }
      if (word === "NULL") continue;
      if (word === "COLLATE") {
        i++;
        continue;
      }
      if (word === "DEFAULT") {
        let j = i + 1;
        if (tokens[j] && tokens[j].text === "(") {
          let depth = 0;
          while (tokens[j]) {
            if (tokens[j].text === "(") depth++;
            if (tokens[j].text === ")") {
              depth--;
              if (depth === 0) {
                j++;
                break;
              }
            }
            j++;
          }
        } else {
          j++;
          // CURRENT_TIMESTAMP and friends are bare; a function call is not.
          if (tokens[j] && tokens[j].text === "(") {
            let depth = 0;
            while (tokens[j]) {
              if (tokens[j].text === "(") depth++;
              if (tokens[j].text === ")") {
                depth--;
                if (depth === 0) {
                  j++;
                  break;
                }
              }
              j++;
            }
          }
        }
        i = j - 1;
        continue;
      }

      kept.push(tokens[i]);
    }

    if (!kept.length) return "";
    return flags.slice(kept[0].at, kept[kept.length - 1].end).trim();
  }

  function declareColumn(name, def, carried) {
    const parts = [quote(name), def.affinity];

    if (def.affinity === "TEXT") {
      // Matches what sql-translator does at CREATE TABLE: MySQL's default
      // collation is case-insensitive, SQLite's is byte-exact, so a text column
      // rebuilt without NOCASE would stop matching rows it used to match. The
      // existing table's collation cannot be read back - pragma_table_info does
      // not report it, measured - so the house convention is reapplied rather
      // than guessed at from the pragma.
      parts.push(def.binaryCollation ? "COLLATE BINARY" : "COLLATE NOCASE");
    }
    if (def.notNull === true) parts.push("NOT NULL");
    if (def.hasDefault) parts.push(`DEFAULT ${def.dflt}`);
    if (def.primaryKey && !/\bPRIMARY\s+KEY\b/i.test(carried || "")) parts.push("PRIMARY KEY");
    if (def.unique && !/\bUNIQUE\b/i.test(carried || "")) parts.push("UNIQUE");
    if (carried) parts.push(carried);

    return parts.join(" ");
  }

  /**
   * Substitute one column name inside a stored index or trigger definition.
   *
   * SQLite does this itself and correctly for `ALTER TABLE ... RENAME COLUMN` -
   * measured, both the index SQL and the trigger body came back rewritten - but
   * a rebuild drops the table, which takes its indexes with it and forces the
   * final rename, which forces every trigger off and back on. So the stored
   * text has to be rewritten here, from the definitions captured before the
   * rebuild started.
   *
   * The hazard is a same-named column on a different table: a trigger body like
   * `INSERT INTO log (building) VALUES (NEW.building)` must rename the second
   * and not the first. Qualified references (NEW./OLD./<table>.) are
   * unambiguous. A bare one is only safe when the definition touches no other
   * table, so anything else is refused rather than guessed - a wrongly renamed
   * trigger would either fail to create or write to the wrong column forever.
   */
  function renameInDefinition(sql, table, from, to, kind) {
    const text = String(sql || "");
    const tokens = tokenise(text);

    const OTHER_TABLE_INTRO = /^(?:FROM|JOIN|INTO|UPDATE)$/i;
    const touchesOther = tokens.some((token, i) => {
      if (!OTHER_TABLE_INTRO.test(token.text)) return false;
      const next = tokens[i + 1];
      if (!next || !/^["`[A-Za-z_]/.test(next.text)) return false;
      return !same(unquoteIdentifier(next.text), table);
    });

    let out = "";
    let cursor = 0;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const raw = token.text;

      // Never reach inside a string literal or a comment.
      if (raw[0] === "'" || raw.startsWith("--") || raw.startsWith("/*")) continue;

      const bare = /^[A-Za-z_]/.test(raw) || raw[0] === '"' || raw[0] === "`" || raw[0] === "[";
      if (!bare) continue;
      if (!same(unquoteIdentifier(raw), from)) continue;

      const previous = tokens[i - 1];
      const qualifier = previous && previous.text === "." ? tokens[i - 2] : null;
      const owner = qualifier ? unquoteIdentifier(qualifier.text) : null;
      const qualified = !!owner && (same(owner, "NEW") || same(owner, "OLD") || same(owner, table));

      if (!qualified && kind === "trigger" && touchesOther) {
        throw refuse(
          `the trigger definition references "${from}" without saying which table it belongs to, ` +
            `and it touches more than one table; rename it by hand`,
          "CHANGE COLUMN with an ambiguous trigger reference"
        );
      }

      out += text.slice(cursor, token.at) + quote(to);
      cursor = token.end;
    }

    return out + text.slice(cursor);
  }

  function findColumn(columns, name) {
    return (columns || []).find((column) => same(column.name, name)) || null;
  }

  // A missing DEFAULT and `DEFAULT NULL` are the same thing on a nullable
  // column: omit the value and NULL is stored either way. Measured, and worth
  // normalising because dumps write both - treating them as different would
  // rebuild `weed_plants` for nothing.
  function defaultText(column) {
    const value = column.dflt_value;
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text.toUpperCase() === "NULL" ? null : text;
  }

  function wantedDefault(def) {
    if (!def.hasDefault) return null;
    return def.dflt === "NULL" ? null : def.dflt;
  }

  /**
   * An INTEGER PRIMARY KEY is NOT NULL whatever the pragma says.
   *
   * pragma_table_info reports notnull 0 for it - measured on `id INTEGER
   * PRIMARY KEY` - because the column is the rowid and a supplied NULL means
   * "pick the next one" rather than "store NULL". Reading that 0 literally made
   * `MODIFY id int(11) NOT NULL AUTO_INCREMENT`, the single most common line in
   * a converted dump, look like it was adding NOT NULL and rebuild the table
   * for nothing.
   */
  function existingNotNull(column) {
    if (Number(column.notnull) === 1) return true;
    return Number(column.pk) === 1 && affinityOf(column.type) === "INTEGER";
  }

  // MySQL's MODIFY and CHANGE replace the whole definition, so a definition
  // that does not say NOT NULL is asking for a nullable column rather than
  // leaving the existing constraint alone. "Not stated" therefore means
  // nullable here, which is also what declareColumn emits - the two have to
  // agree or needsRebuild would report no change while the plan made one.
  const wantedNotNull = (def) => def.notNull === true;

  // Does this one action need the table rebuilt?
  function actionNeedsRebuild(action, columns) {
    if (!action || typeof action !== "object") return false;

    if (action.kind === "autoIncrementStart") return false;

    // A table-level constraint can only be added by writing the table out
    // again: SQLite's ALTER TABLE has no ADD CONSTRAINT at all.
    if (action.kind === "addForeignKey") return true;

    if (action.kind === "addColumn") {
      const existing = findColumn(columns, action.column);
      if (existing) return false;
      const def = parseColumnDef(action.definition);
      // SQLite's ADD COLUMN refuses exactly these three, so they are the only
      // reason an added column needs the long way round.
      if (def.primaryKey || def.unique) return true;
      if (def.notNull === true && !def.hasDefault) return true;
      return false;
    }

    if (action.kind !== "modify" && action.kind !== "change") return false;

    const name = action.kind === "change" ? action.from : action.column;
    const existing = findColumn(columns, name);
    if (!existing) {
      throw refuse(
        `there is no column "${name}" to alter`,
        `ALTER TABLE ... ${action.kind === "change" ? "CHANGE" : "MODIFY"} of a missing column`
      );
    }

    const def = parseColumnDef(action.definition);

    // Checked before anything can return, so an AUTO_INCREMENT that cannot be
    // reproduced is refused rather than hidden behind a change that does need a
    // rebuild for some other reason.
    if (def.autoIncrement) {
      const isIntegerKey = Number(existing.pk) === 1 && affinityOf(existing.type) === "INTEGER";
      if (!isIntegerKey) {
        throw refuse(
          `AUTO_INCREMENT on "${name}" cannot be reproduced: SQLite only accepts AUTOINCREMENT ` +
            `on a column declared exactly INTEGER PRIMARY KEY, and this one is not`,
          "AUTO_INCREMENT on a column that is not the INTEGER primary key"
        );
      }
    }

    if (def.affinity !== affinityOf(existing.type)) return true;
    if (wantedNotNull(def) !== existingNotNull(existing)) return true;
    if (wantedDefault(def) !== defaultText(existing)) return true;
    // A case-sensitive collation is the one COLLATE change SQLite can express,
    // and the only one that is not a no-op.
    if (def.binaryCollation) return true;

    return false;
  }

  /**
   * True when the actions need no rebuild at all.
   *
   * Calling planRebuild unconditionally is still correct - it emits the cheap
   * statements itself when they are enough. This exists so a caller can tell
   * the difference without reading the plan, and so the cheap path can skip
   * reading indexes, triggers and the CREATE TABLE text at all.
   */
  function needsRebuild({ actions, columns }) {
    return (actions || []).some((action) => actionNeedsRebuild(action, columns));
  }

  /**
   * MySQL's `AUTO_INCREMENT=9` as SQLite's sqlite_sequence row.
   *
   * sqlite_sequence stores the LAST used value, so a MySQL start of 9 is a seq
   * of 8 - confirmed: with seq set to 8 the next insert landed on id 9.
   *
   * DELETE then INSERT, not INSERT OR REPLACE. sqlite_sequence has no index on
   * `name`, so OR REPLACE conflicts with nothing and appends a duplicate row;
   * measured, the sequence then kept its old value and the next id was 2.
   *
   * And the row only matters when the table was declared AUTOINCREMENT: setting
   * seq on a plain INTEGER PRIMARY KEY had no effect at all (next id 1, not 9).
   * That is not a gap in practice - a plain INTEGER PRIMARY KEY hands out
   * max(id)+1, which is what `AUTO_INCREMENT=N` means in a dump, where N is
   * always one past the last row just inserted. It IS a gap for a hand-written
   * `AUTO_INCREMENT=` far above the data, which would silently start lower. The
   * limit is stated here rather than approximated with a dummy row.
   */
  function sequenceStatements(table, value, isAutoincrement) {
    const start = Number(value);
    if (!Number.isInteger(start) || start < 1) {
      throw refuse(`AUTO_INCREMENT=${value} is not a usable start value`, "AUTO_INCREMENT=");
    }
    if (!isAutoincrement) return [];

    return [
      `DELETE FROM sqlite_sequence WHERE name = ${literal(table)}`,
      `INSERT INTO sqlite_sequence (name, seq) VALUES (${literal(table)}, ${start - 1})`,
    ];
  }

  /**
   * Fail the rebuild with a sentence, before a row is touched, when a column
   * gaining NOT NULL still holds NULL.
   *
   * SQLite's own complaint is `NOT NULL constraint failed:
   * players__tdb_rebuild.name`, which names a table the operator has never
   * heard of and gives no reason. A CHECK constraint's name is echoed verbatim
   * in its error - measured, including inside a transaction - so a temp table
   * whose constraint is named with the explanation turns the failure into that
   * explanation. The INSERT selects at most one row and only where the column
   * is NULL, so a clean column costs nothing and inserts nothing.
   */
  function nullGuard(table, column) {
    const message =
      `tDB cannot add NOT NULL to ${table}.${column}: the column still holds NULL in existing ` +
      `row(s). Give those rows a value, or add a DEFAULT and set them, then retry.`;

    return [
      `DROP TABLE IF EXISTS temp.${quote(GUARD_TABLE)}`,
      `CREATE TEMP TABLE ${quote(GUARD_TABLE)} (ok INTEGER, CONSTRAINT ${quote(message)} CHECK (ok = 1))`,
      `INSERT INTO temp.${quote(GUARD_TABLE)} (ok) SELECT 0 FROM ${quote(table)} ` +
        `WHERE ${quote(column)} IS NULL LIMIT 1`,
      `DROP TABLE IF EXISTS temp.${quote(GUARD_TABLE)}`,
    ];
  }

  /**
   * Plan a rebuild. PURE: returns an ordered array of SQLite statement strings.
   *
   * schema is live introspection the caller supplies:
   *   tableSql: the original `CREATE TABLE` text from sqlite_master
   *   columns:  [{ name, type, notnull, dflt_value, pk }]  (pragma_table_info order)
   *   indexes:  [{ name, sql }]   type='index' on this table, sql not null
   *   triggers: [{ name, sql }]   EVERY trigger in the schema, not only this
   *                               table's - see the module header
   *
   * `tableSql` is required and is NOT in pragma_table_info. The pragma reports
   * name/type/notnull/dflt_value/pk and nothing else: measured against a table
   * declared `(id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT UNIQUE, y TEXT
   * CHECK (y <> ''), FOREIGN KEY (x) REFERENCES t(a))`, it reported none of the
   * AUTOINCREMENT, the UNIQUE, the CHECK or the foreign key. A rebuild driven
   * by the pragma alone would therefore drop all four without a word, which is
   * the exact failure mode this module exists to avoid. So the original text is
   * patched in place instead, and only the entries an action names are touched.
   *
   * actions is what the translator parsed out of the ALTER:
   *   { kind: 'modify', column: 'ssn', definition: 'VARCHAR(11) NOT NULL' }
   *   { kind: 'change', from: 'building', to: 'property', definition: 'varchar(30) NULL' }
   *   { kind: 'addColumn', column: 'x', definition: 'int DEFAULT 0', ifNotExists: true }
   *   { kind: 'autoIncrementStart', value: 9 }
   *
   * Throws an Error with a `.construct` property naming the construct when an
   * action cannot be reproduced faithfully. Never guesses.
   */
  function planRebuild({ table, actions, columns, indexes, triggers, tableSql }) {
    if (!table) throw refuse("no table name given", "table rebuild");
    const actionList = actions || [];
    const columnList = columns || [];

    const rebuild = actionList.some((action) => actionNeedsRebuild(action, columnList));
    const sequence = actionList.find((action) => action && action.kind === "autoIncrementStart");

    if (!rebuild) return cheapPlan(table, actionList, columnList, tableSql, sequence);

    if (!tableSql) {
      throw refuse(
        `rebuilding ${table} needs its original CREATE TABLE text; pragma_table_info does not ` +
          `report COLLATE, UNIQUE, CHECK, FOREIGN KEY or AUTOINCREMENT, so a rebuild without it ` +
          `would drop them silently`,
        "table rebuild without the original CREATE TABLE text"
      );
    }

    const parsed = parseCreateTable(tableSql);
    const working = `${table}${WORKING_SUFFIX}`;
    const statements = [PRAGMA_OFF];

    // name in the new table -> name it comes from in the old one. An added
    // column gets no entry, which is what keeps it out of the copy so its
    // DEFAULT applies.
    const sourceFor = new Map();
    const renames = [];
    const added = [];
    // Table-level constraints to append, which are entries in the column list
    // rather than columns.
    const constraints = [];

    const entries = parsed.entries.map((entry) => ({ ...entry }));
    const consumed = new Set();

    for (const action of actionList) {
      if (!action || action.kind === "autoIncrementStart") continue;

      if (action.kind === "addColumn") {
        if (findColumn(columnList, action.column)) {
          // SQLite has no `ADD COLUMN IF NOT EXISTS`, and MySQL's means exactly
          // this: the column is already there, so there is nothing to add.
          if (action.ifNotExists) continue;
          throw refuse(
            `the column "${action.column}" already exists on ${table}`,
            "ALTER TABLE ... ADD COLUMN of an existing column"
          );
        }
        const def = parseColumnDef(action.definition);
        added.push({
          name: action.column,
          text: declareColumn(action.column, def, ""),
          after: action.after || def.after || null,
          first: def.first,
        });
        continue;
      }

      if (action.kind === "addForeignKey") {
        // Carried through verbatim. The clause is already valid SQLite -
        // `FOREIGN KEY (a) REFERENCES t(b) ON DELETE CASCADE` is spelled the
        // same in both dialects - so the only MySQL-ism to drop is a
        // `CONSTRAINT <name>` prefix, which SQLite's table-level syntax does
        // accept but which names an index MySQL creates and SQLite does not.
        constraints.push(action.definition);
        continue;
      }

      if (action.kind !== "modify" && action.kind !== "change") {
        throw refuse(`unknown action "${action.kind}"`, `ALTER TABLE action ${action.kind}`);
      }

      const from = action.kind === "change" ? action.from : action.column;
      const to = action.kind === "change" ? action.to : action.column;
      const existing = findColumn(columnList, from);
      const index = entries.findIndex((entry) => entry.name && same(entry.name, from));
      if (index === -1 || !existing) {
        throw refuse(
          `there is no column "${from}" to alter on ${table}`,
          `ALTER TABLE ... ${action.kind === "change" ? "CHANGE" : "MODIFY"} of a missing column`
        );
      }
      if (consumed.has(index)) {
        throw refuse(
          `two actions alter "${from}" in one statement`,
          "ALTER TABLE with two actions on one column"
        );
      }
      consumed.add(index);

      const def = parseColumnDef(action.definition);
      const entry = entries[index];
      const carried = carriedFlags(entry.text, entry.nameToken.end);

      // AUTO_INCREMENT on a column that already is the INTEGER primary key is a
      // no-op (checked in actionNeedsRebuild); the AUTOINCREMENT keyword, if the
      // table has it, rides along in `carried` rather than being re-derived.
      entries[index] = { ...entry, text: ` ${declareColumn(to, def, carried)}`, name: to };

      sourceFor.set(to.toLowerCase(), from);
      if (!same(from, to)) renames.push({ from, to });

      if (def.notNull === true && !existingNotNull(existing)) {
        statements.push(...nullGuard(table, from));
      }
    }

    const addedNames = new Set(added.map((column) => column.name.toLowerCase()));

    // Column order follows the original table, then MySQL's AFTER/FIRST for
    // anything new. SQLite has no AFTER, so the only way to honour it is to
    // place the entry while the table is being written out - which is free
    // here, and keeps `SELECT *` reading the way the resource's author meant.
    for (const column of added) {
      const text = ` ${column.text}`;
      if (column.first) {
        entries.unshift({ text, name: column.name });
        continue;
      }
      const at = column.after
        ? entries.findIndex((entry) => entry.name && same(entry.name, column.after))
        : -1;
      if (at === -1) entries.push({ text, name: column.name });
      else entries.splice(at + 1, 0, { text, name: column.name });
    }

    // Constraints last in the column list, which is where SQLite expects a
    // table-level one and where mysqldump writes it too.
    for (const constraint of constraints) {
      entries.push({ text: ` ${constraint}`, name: null });
    }

    // Every trigger off first. The final rename reparses the whole schema, so a
    // trigger left in place that mentions this table dies with "error in
    // trigger <name>: no such table" and takes the rebuild with it - measured,
    // and it happens even for a trigger on an unrelated table.
    for (const trigger of triggers || []) {
      if (!trigger?.name) continue;
      statements.push(`DROP TRIGGER IF EXISTS ${quote(trigger.name)}`);
    }

    // A previous run that failed between the CREATE and the rename leaves this
    // behind, and the CREATE would then collide with its own debris.
    statements.push(`DROP TABLE IF EXISTS ${quote(working)}`);
    statements.push(
      `CREATE TABLE ${quote(working)} (${entries.map((entry) => entry.text).join(",")})${parsed.tail}`
    );

    // Named explicitly in both lists, never `SELECT *`: this rebuild can
    // reorder columns, and `INSERT INTO new SELECT * FROM old` would then move
    // every value one column sideways with no error at all. The lists are
    // walked in the NEW table's order, which is also the order a reader will
    // compare them in.
    const copy = entries
      .filter((entry) => entry.name && !addedNames.has(entry.name.toLowerCase()))
      .map((entry) => ({
        to: entry.name,
        from: sourceFor.get(entry.name.toLowerCase()) || entry.name,
      }));

    statements.push(
      `INSERT INTO ${quote(working)} (${copy.map((pair) => quote(pair.to)).join(", ")}) ` +
        `SELECT ${copy.map((pair) => quote(pair.from)).join(", ")} FROM ${quote(table)}`
    );

    statements.push(`DROP TABLE ${quote(table)}`);
    statements.push(`ALTER TABLE ${quote(working)} RENAME TO ${quote(table)}`);

    // Indexes went with the table; triggers went off above. Both come back
    // carrying any column rename, because the stored text still names the old
    // column and SQLite would reject `CREATE INDEX ... (building)` outright.
    for (const index of indexes || []) {
      if (!index?.sql) continue;
      let sql = index.sql;
      for (const rename of renames)
        sql = renameInDefinition(sql, table, rename.from, rename.to, "index");
      statements.push(sql);
    }
    for (const trigger of triggers || []) {
      if (!trigger?.sql) continue;
      let sql = trigger.sql;
      // Only a definition that mentions this table can be talking about its
      // columns; another table's same-named column must be left alone.
      if (mentionsTable(sql, table)) {
        for (const rename of renames) {
          sql = renameInDefinition(sql, table, rename.from, rename.to, "trigger");
        }
      }
      statements.push(sql);
    }

    if (sequence) {
      statements.push(...sequenceStatements(table, sequence.value, isAutoincrement(tableSql)));
    }

    statements.push(PRAGMA_ON);
    return statements;
  }

  function mentionsTable(sql, table) {
    return tokenise(String(sql || "")).some(
      (token) => /^["`[A-Za-z_]/.test(token.text) && same(unquoteIdentifier(token.text), table)
    );
  }

  function isAutoincrement(tableSql) {
    return /\bAUTOINCREMENT\b/i.test(String(tableSql || ""));
  }

  // The statements for actions SQLite can do in place.
  function cheapPlan(table, actions, columns, tableSql, sequence) {
    const statements = [];

    for (const action of actions) {
      if (!action || action.kind === "autoIncrementStart") continue;

      if (action.kind === "addColumn") {
        if (findColumn(columns, action.column)) continue;
        const def = parseColumnDef(action.definition);
        // SQLite appends; MySQL's AFTER cannot be honoured without a rebuild,
        // and column position carries no meaning for any statement that names
        // its columns - which is the only kind this module emits.
        statements.push(
          `ALTER TABLE ${quote(table)} ADD COLUMN ${declareColumn(action.column, def, "")}`
        );
        continue;
      }

      if (action.kind === "change" && !same(action.from, action.to)) {
        // The cheap path, and the reason to look for it: SQLite rewrites every
        // index, trigger and view that referenced the old name itself, which no
        // rebuild can do as well. Measured on both an index and a trigger body.
        statements.push(
          `ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(action.from)} TO ${quote(action.to)}`
        );
        continue;
      }

      // A modify or a same-name change whose every difference is a width, a
      // CHARACTER SET or a case-insensitive COLLATE: SQLite already has the
      // table being asked for, so there is nothing to emit.
      if (action.kind === "modify" || action.kind === "change") continue;

      // Not silently ignored. actionNeedsRebuild answers false for a kind it
      // does not know, so without this an unrecognised action would reach here
      // and be dropped - the ALTER would report success having done nothing.
      throw refuse(`unknown action "${action.kind}"`, `ALTER TABLE action ${action.kind}`);
    }

    if (sequence) {
      statements.push(...sequenceStatements(table, sequence.value, isAutoincrement(tableSql)));
    }

    return statements;
  }

  return { parseColumnDef, planRebuild, needsRebuild };
})();
