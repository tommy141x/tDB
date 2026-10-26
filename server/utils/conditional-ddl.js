// MySQL's procedural detour around a missing `IF NOT EXISTS`.
//
// MySQL has `CREATE TABLE IF NOT EXISTS` and `DROP INDEX IF EXISTS` but no
// `ALTER TABLE ... ADD INDEX IF NOT EXISTS` and no `ADD COLUMN IF NOT EXISTS`
// before 8.0.29. So every shipped migration that wants to be re-runnable walks
// around it, in exactly two spellings:
//
//   A  SET @v := (SELECT IF(<cond>, '<ddl>', 'SELECT 1'));
//      PREPARE s FROM @v; EXECUTE s; DEALLOCATE PREPARE s;
//
//   B  CREATE PROCEDURE p() BEGIN IF <cond> THEN <ddl>; END IF; END
//      CALL p(); DROP PROCEDURE p;
//
// Both are refused by name by the translator's gate, which fails the whole
// import, which leaves the resource with no schema at all - so these are not
// optional to understand.
//
// THE DESIGN DECISION: evaluate, never pattern-match.
//
// Every condition in both spellings is an ordinary SELECT over
// information_schema.COLUMNS / .STATISTICS / .TABLES / .TABLE_CONSTRAINTS, and
// sql-translator's rewriteInformationSchema already turns all four into real
// SQLite over sqlite_master and the pragma_* table functions. Measured: all
// five conditions harvested from ESX, K9Script and esx_core translate and
// return a value. So the condition is HANDED TO THE DATABASE and the real
// answer decides the branch, exactly as MySQL would. Nothing here reads a
// condition and infers what it probably means.
//
// That is what makes this safe rather than a guess. A condition tDB happens to
// evaluate differently from MySQL - because SQLite reports no CHECK
// constraints, say - then produces a different but honest outcome, not a wrong
// one: the branch that ran is the branch the live database called for.
//
// Anything outside the two spellings is refused with the construct named, never
// approximated. A half-understood procedure body is the one outcome worse than
// a failed import: it reports success having built the wrong schema.
//
// Plain CommonJS, no FiveM globals, no I/O of its own - `scalar` and `exec` are
// injected, so the whole thing is testable offline against node:sqlite.
module.exports = (function () {
  function refuse(message, construct) {
    const error = new Error(message);
    error.construct = construct;
    return error;
  }

  function unquote(text) {
    const first = String(text || "")[0];
    if (first === "`" || first === '"') return text.slice(1, -1).replace(first + first, first);
    return String(text || "");
  }

  // Split on semicolons at depth 0 with quotes respected, same scanner as
  // trigger-rewrite's splitBody. A procedure body's statements are separated by
  // semicolons that the caller's DELIMITER handling deliberately did NOT split
  // on, so they arrive here still inside one string.
  function splitTopLevel(text, separator) {
    const out = [];
    let depth = 0;
    let quote = null;
    let current = "";

    for (const ch of String(text || "")) {
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === separator && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }

    if (current.trim()) out.push(current.trim());
    return out;
  }

  const CLAIMS = [
    [/^\s*SET\s+@/i, "setVariable"],
    [/^\s*PREPARE\b/i, "prepare"],
    [/^\s*EXECUTE\b/i, "execute"],
    [/^\s*DEALLOCATE\b/i, "deallocate"],
    [/^\s*CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?PROCEDURE\b/i, "createProcedure"],
    [/^\s*CALL\b/i, "call"],
    [/^\s*DROP\s+PROCEDURE\b/i, "dropProcedure"],
  ];

  /**
   * Does this statement belong to a conditional-DDL sequence?
   *
   * Cheap and synchronous - the importer calls it once per statement in every
   * file, so it does no work beyond seven anchored patterns.
   *
   * Returns false, or one of "setVariable" | "prepare" | "execute" |
   * "deallocate" | "createProcedure" | "call" | "dropProcedure".
   */
  function claims(sql) {
    const text = String(sql == null ? "" : sql);
    for (const [pattern, tag] of CLAIMS) {
      if (pattern.test(text)) return tag;
    }
    return false;
  }

  // MySQL's own rule, which is not JavaScript's: a string in boolean context is
  // read as a number and anything unparseable is false, so IF('abc', a, b)
  // takes the ELSE branch. Every condition here returns 0 or 1 in practice; the
  // rule is applied rather than assumed so a surprising value is not read as
  // true by accident.
  function truthy(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return value !== 0n;
    if (typeof value === "number") return value !== 0;

    const text = String(value).trim();
    if (!text) return false;
    const number = Number(text);
    return Number.isNaN(number) ? false : number !== 0;
  }

  const NO_OP = /^\s*SELECT\s+1\s*;?\s*$/i;

  // Characteristics MySQL allows between the parameter list and the body. None
  // of them affect what the body does, so they are skipped - but only by name,
  // because the alternative is skipping something that does.
  const CHARACTERISTIC =
    /^(?:(?:NOT\s+)?DETERMINISTIC|CONTAINS\s+SQL|NO\s+SQL|(?:READS|MODIFIES)\s+SQL\s+DATA|SQL\s+SECURITY\s+(?:DEFINER|INVOKER)|LANGUAGE\s+SQL|COMMENT\s+'(?:[^']|'')*')\s*/i;

  // Body statements that are refused by name. Every one of them means the body
  // does something this interpreter cannot reproduce, and silently dropping any
  // of them produces a schema that looks migrated and is not.
  const REFUSED_IN_BODY = [
    [/^DECLARE\b/i, "DECLARE"],
    [/^ELSEIF\b/i, "ELSEIF"],
    [/^ELSE\b/i, "ELSE"],
    [/^WHILE\b/i, "WHILE"],
    [/^REPEAT\b/i, "REPEAT"],
    [/^(?:[A-Za-z_][A-Za-z0-9_$]*\s*:\s*)?LOOP\b/i, "LOOP"],
    [/^(?:OPEN|FETCH|CLOSE)\b/i, "cursor"],
    [/^IF\b/i, "nested IF"],
    [/^CASE\b/i, "CASE"],
    [/^SET\b/i, "SET of a local variable"],
    [/^(?:LEAVE|ITERATE)\b/i, "LEAVE/ITERATE"],
    [/^(?:PREPARE|EXECUTE|DEALLOCATE)\b/i, "PREPARE inside a procedure body"],
    [/^(?:CREATE|DROP)\s+(?:DEFINER\s*=\s*\S+\s+)?PROCEDURE\b/i, "nested CREATE PROCEDURE"],
  ];

  const SIGNAL =
    /^SIGNAL\s+SQLSTATE\s+(?:VALUE\s+)?'([^']*)'\s*(?:SET\s+MESSAGE_TEXT\s*=\s*'((?:[^']|'')*)')?\s*$/i;

  function signalError(statement) {
    const m = SIGNAL.exec(statement);
    if (!m) {
      throw refuse(
        `a SIGNAL this does not understand: "${statement}"`,
        "SIGNAL SQLSTATE in a form this does not parse"
      );
    }

    // The message IS the point. These guard a data precondition - duplicate
    // rows that a UNIQUE index about to be added would reject - and the
    // migration is telling the operator to reconcile them first. Swallowing it
    // would turn "fix your data" into a constraint violation later, or into a
    // missing index nobody notices.
    const message = (m[2] === undefined ? "" : m[2]).replace(/''/g, "'");
    throw refuse(
      `the migration aborted itself with SIGNAL SQLSTATE '${m[1]}': ${message}`,
      "SIGNAL SQLSTATE"
    );
  }

  /**
   * Group a procedure body's statements into blocks, refusing anything the
   * interpreter cannot reproduce.
   *
   * A body is a sequence of `IF <cond> THEN <statements> END IF` blocks and bare
   * statements, in any order - esx_core's hardening procedure has two IF blocks
   * back to back. Each block is returned as { condition, body }, condition null
   * for a bare statement.
   *
   * ELSE is deliberately absent. No real statement uses it, and a branch this
   * guessed at would run DDL the migration never asked for.
   *
   * The refusals happen HERE, not while the body runs. Checking a statement
   * only when its branch is taken means a body containing ELSE passes silently
   * whenever the condition comes back false, which for an idempotent migration
   * is the second run and every run after it. Measured: an ELSE body and a
   * nested IF both sailed through that way.
   */
  function parseBlocks(pieces, name) {
    const blocks = [];
    const isEndIf = (piece) => /^END\s+IF\s*$/i.test(piece);
    let i = 0;

    while (i < pieces.length) {
      const piece = pieces[i];

      if (isEndIf(piece)) {
        throw refuse("an END IF with no IF before it", "END IF without IF");
      }

      const head = /^IF\s+([\s\S]+?)\s+THEN\b([\s\S]*)$/i.exec(piece);
      if (!head) {
        blocks.push({ condition: null, body: assertBody([piece], name) });
        i++;
        continue;
      }

      const body = [];
      // The first body statement shares a piece with the IF header, because the
      // semicolon that ends it is the first top-level one in the block.
      if (head[2].trim()) body.push(head[2].trim());
      i++;

      let closed = false;
      while (i < pieces.length) {
        if (isEndIf(pieces[i])) {
          closed = true;
          i++;
          break;
        }
        body.push(pieces[i]);
        i++;
      }

      // Checked before the missing-END-IF complaint: a nested IF consumes the
      // inner END IF as its own, so the outer block always looks unterminated
      // and "IF without END IF" would name the wrong problem.
      assertBody(body, name);

      if (!closed) {
        throw refuse(`an IF ... THEN with no END IF: "${piece}"`, "IF without END IF");
      }

      blocks.push({ condition: head[1].trim(), body });
    }

    return blocks;
  }

  function assertBody(body, name) {
    for (const statement of body) {
      // Not refused: it is the one body statement whose whole purpose is to
      // fail, and only when its condition says so.
      if (/^SIGNAL\b/i.test(statement)) continue;

      for (const [pattern, construct] of REFUSED_IN_BODY) {
        if (pattern.test(statement)) {
          throw refuse(
            `the procedure ${name} uses ${construct}, which this does not reproduce: ` +
              `"${statement.replace(/\s+/g, " ").slice(0, 120)}"`,
            construct
          );
        }
      }

      if (/^CALL\b/i.test(statement)) {
        throw refuse(
          `the procedure ${name} calls another procedure, which this does not follow`,
          "CALL inside a procedure body"
        );
      }
    }

    return body;
  }

  function parseProcedure(sql) {
    const head =
      /^\s*CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?PROCEDURE\s+(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*\(([\s\S]*?)\)\s*([\s\S]*)$/i.exec(
        sql
      );
    if (!head) {
      throw refuse(
        "a CREATE PROCEDURE whose header this does not parse",
        "CREATE PROCEDURE header"
      );
    }

    if (head[2].trim()) {
      // CALL in both spellings passes no arguments, so a parameter list means
      // this is a real procedure the resource intends to keep, not a migration
      // wrapper - and binding parameters is a different problem.
      throw refuse(
        `the procedure ${unquote(head[1])} takes parameters, which this does not bind`,
        "CREATE PROCEDURE with parameters"
      );
    }

    let rest = head[3].trim();
    while (rest && CHARACTERISTIC.test(rest)) {
      rest = rest.replace(CHARACTERISTIC, "").trim();
    }

    const begin = /^BEGIN\b/i.exec(rest);
    let body;
    if (begin) {
      const end = rest.search(/\bEND\s*;?\s*$/i);
      if (end === -1) {
        throw refuse(
          `the procedure ${unquote(head[1])} has a BEGIN with no matching END; the caller's ` +
            `statement splitter has to hand the whole CREATE PROCEDURE over as one statement`,
          "CREATE PROCEDURE with no END"
        );
      }
      body = rest.slice(begin[0].length, end);
    } else {
      if (!rest) {
        throw refuse(
          `the procedure ${unquote(head[1])} has no body`,
          "CREATE PROCEDURE with no body"
        );
      }
      // MySQL allows a single-statement body with no BEGIN/END at all.
      body = rest.replace(/;\s*$/, "");
    }

    return { name: unquote(head[1]), body };
  }

  /**
   * A stateful interpreter for ONE file.
   *
   * The importer creates one per file and feeds it, in order, every statement
   * `claims` returned a tag for. State is per file on purpose: a session
   * variable or a procedure defined in one migration must not be visible to the
   * next, which is also how MySQL behaves for a procedure the file drops again.
   */
  function createSession() {
    const variables = new Map();
    const prepared = new Map();
    const procedures = new Map();

    // MySQL user variable and procedure names are case-insensitive.
    const key = (name) => String(name).toLowerCase();

    async function runBody(name, body, deps) {
      const blocks = parseBlocks(splitTopLevel(body, ";"), name);
      const ran = [];
      const notes = [];

      for (const block of blocks) {
        if (block.condition !== null) {
          const value = await deps.scalar(`SELECT ${block.condition}`);
          if (!truthy(value)) {
            notes.push(`condition false, skipped: ${block.condition.replace(/\s+/g, " ")}`);
            continue;
          }
        }

        for (const statement of block.body) {
          if (/^SIGNAL\b/i.test(statement)) signalError(statement);
          await deps.exec(statement);
          ran.push(statement);
        }
      }

      const note = notes.length ? notes.join("; ") : undefined;
      return note ? { ran, note } : { ran };
    }

    return {
      /**
       * Feed one statement.
       *
       * deps = {
       *   scalar: async (sql) => value,   // a SELECT; first column of the first row
       *   exec:   async (sql) => void,    // one statement for effect; MySQL text,
       *                                   // translated by the caller
       * }
       *
       * Resolves to { ran: [<sql actually executed>], note?: string }. `ran` is
       * empty when the statement only moved interpreter state (SET, CREATE
       * PROCEDURE, DEALLOCATE, DROP PROCEDURE) or when every condition in a
       * procedure body came back false - which is exactly what the second run of
       * an idempotent migration looks like.
       *
       * Throws an Error with `.construct` naming the construct when the shape is
       * not one of the two supported ones.
       */
      async feed(sql, deps) {
        const text = String(sql == null ? "" : sql).trim();
        const tag = claims(text);

        if (!tag) {
          throw refuse(
            `this is not part of a conditional-DDL sequence: "${text.slice(0, 120)}"`,
            "unclaimed statement"
          );
        }

        if (tag === "setVariable") {
          const parts = splitTopLevel(text.replace(/^\s*SET\s+/i, ""), ",");
          if (parts.length !== 1) {
            throw refuse(
              `a SET assigning ${parts.length} variables at once: "${text.slice(0, 120)}"`,
              "SET of more than one session variable"
            );
          }

          const m = /^@([A-Za-z0-9_$.]+)\s*:?=\s*([\s\S]+?);?\s*$/.exec(parts[0]);
          if (!m) {
            throw refuse(
              `a SET @variable whose shape this does not parse: "${text.slice(0, 120)}"`,
              "SET @variable"
            );
          }

          // Evaluated here, not at EXECUTE, because that is when MySQL
          // evaluates it: the value is frozen before the first branch runs, so
          // DDL earlier in the file cannot change which branch a later EXECUTE
          // takes.
          variables.set(key(m[1]), await deps.scalar(`SELECT ${m[2]}`));
          return { ran: [] };
        }

        if (tag === "prepare") {
          const m = /^PREPARE\s+(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s+FROM\s+([\s\S]+)$/i.exec(text);
          if (!m) {
            throw refuse(
              `a PREPARE whose shape this does not parse: "${text.slice(0, 120)}"`,
              "PREPARE"
            );
          }

          const source = m[2].trim().replace(/;\s*$/, "");
          const variable = /^@([A-Za-z0-9_$.]+)$/.exec(source);

          if (variable) {
            if (!variables.has(key(variable[1]))) {
              // Running nothing would be the dangerous answer: the EXECUTE that
              // follows is the only thing that applies the migration's DDL, so
              // a silent no-op here leaves the schema unmigrated and the import
              // reporting success.
              throw refuse(
                `PREPARE reads @${variable[1]}, which nothing in this file has SET`,
                "PREPARE FROM an unset session variable"
              );
            }
            const value = variables.get(key(variable[1]));
            if (value === null || value === undefined) {
              throw refuse(
                `@${variable[1]} is NULL, so there is no statement to prepare`,
                "PREPARE FROM a NULL session variable"
              );
            }
            prepared.set(key(unquote(m[1])), String(value));
            return { ran: [] };
          }

          if (source[0] === "'") {
            prepared.set(key(unquote(m[1])), source.slice(1, -1).replace(/''/g, "'"));
            return { ran: [] };
          }

          throw refuse(
            `PREPARE ... FROM ${source.slice(0, 60)} is neither a session variable nor a literal`,
            "PREPARE FROM an expression"
          );
        }

        if (tag === "execute") {
          const m = /^EXECUTE\s+(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*([\s\S]*)$/i.exec(text);
          if (!m) {
            throw refuse(
              `an EXECUTE whose shape this does not parse: "${text.slice(0, 120)}"`,
              "EXECUTE"
            );
          }
          if (m[2].trim().replace(/;\s*$/, "")) {
            throw refuse(
              `EXECUTE with ${m[2].trim()}, whose parameters this does not bind`,
              "EXECUTE ... USING"
            );
          }

          const name = key(unquote(m[1]));
          if (!prepared.has(name)) {
            throw refuse(
              `EXECUTE ${unquote(m[1])} was never PREPAREd in this file`,
              "EXECUTE of a statement that was never PREPAREd"
            );
          }

          const statement = prepared.get(name);
          await deps.exec(statement);

          // Still reported in `ran`: MySQL really does execute it, and saying
          // so is how an operator reading the log can tell "the column was
          // already there" apart from "the statement never ran".
          if (NO_OP.test(statement)) {
            return { ran: [statement], note: "the condition chose the no-op branch" };
          }
          return { ran: [statement] };
        }

        if (tag === "deallocate") {
          const m = /^DEALLOCATE\s+PREPARE\s+(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*;?\s*$/i.exec(text);
          if (!m) {
            throw refuse(
              `a DEALLOCATE whose shape this does not parse: "${text.slice(0, 120)}"`,
              "DEALLOCATE PREPARE"
            );
          }
          // An unknown name is not refused. MySQL errors on it, but dropping a
          // handle that was never there cannot produce a wrong schema, and
          // failing the import over it would be the worse outcome.
          prepared.delete(key(unquote(m[1])));
          return { ran: [] };
        }

        if (tag === "createProcedure") {
          const parsed = parseProcedure(text);
          // Parsed now rather than at CALL so a body this cannot reproduce is
          // reported at the statement that contains it, which is the one with a
          // line number in the file.
          parseBlocks(splitTopLevel(parsed.body, ";"), parsed.name);
          procedures.set(key(parsed.name), parsed);
          return { ran: [] };
        }

        if (tag === "call") {
          const m =
            /^CALL\s+(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*(?:\(\s*([\s\S]*?)\s*\))?\s*;?\s*$/i.exec(
              text
            );
          if (!m) {
            throw refuse(`a CALL whose shape this does not parse: "${text.slice(0, 120)}"`, "CALL");
          }
          if ((m[2] || "").trim()) {
            throw refuse(
              `CALL ${unquote(m[1])} passes arguments, which this does not bind`,
              "CALL with arguments"
            );
          }

          const name = unquote(m[1]);
          const procedure = procedures.get(key(name));
          if (!procedure) {
            // It could be a procedure the DBA created out of band, in which
            // case nobody can tell from here what it would do. Refusing names
            // it; running nothing would report a migration that did not happen.
            throw refuse(
              `CALL ${name}, which no CREATE PROCEDURE in this file defines`,
              "CALL of a procedure not defined in this file"
            );
          }

          return runBody(name, procedure.body, deps);
        }

        const m =
          /^DROP\s+PROCEDURE\s+(?:IF\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)\s*;?\s*$/i.exec(
            text
          );
        if (!m) {
          throw refuse(
            `a DROP PROCEDURE whose shape this does not parse: "${text.slice(0, 120)}"`,
            "DROP PROCEDURE"
          );
        }
        procedures.delete(key(unquote(m[1])));
        return { ran: [] };
      },

      /**
       * The session variables this file has SET so far, lower-cased.
       *
       * Exposed because a variable is not always consumed by PREPARE: esx's
       * addons set `@mechanic_skin_male` to a JSON literal and then read it in
       * an ordinary `UPDATE job_grades SET skin_male = @mechanic_skin_male`.
       * The importer substitutes it there, which MySQL does for free.
       *
       * The caller must substitute ONLY names this returns. `@name` in a
       * runtime query is a named PLACEHOLDER bound by the caller - 8 of the 9
       * corpus statements that mention an `@` are that, not this - and
       * substituting those would replace a caller's parameter with a literal.
       */
      variables() {
        const out = {};
        for (const [name, value] of variables) out[name] = value;
        return out;
      },
    };
  }

  return { claims, createSession };
})();
