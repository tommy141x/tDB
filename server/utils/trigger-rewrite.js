// MySQL trigger bodies that SQLite can express, but not in the same words.
//
// Three shapes come up in real dumps, and all three were measured against
// SQLite 3.53 with row-level assertions before any of this was written:
//
//   A  IF c THEN a; ELSE b; END IF;   -> two triggers with WHEN guards.
//      SQLite triggers have no IF statement, but they do have WHEN.
//
//   B  DECLARE v T; SELECT e INTO v ...; ... v ...
//      -> the variable collapses into a correlated subquery. Only valid when it
//      is assigned once and read, which is the only way dumps use it.
//
//   C  UPDATE t JOIN u ON c SET a WHERE w
//      -> UPDATE t SET a FROM u WHERE c AND w. UPDATE ... FROM is SQLite 3.33+.
//
// The contract is all-or-nothing: anything that does not match a shape exactly
// returns { handled: false } and the caller falls back to skipping the trigger
// and saying so. These statements maintain counters, so a half-understood
// rewrite would corrupt them silently and permanently.
//
// translateStatement is injected, so the body still gets ordinary
// MySQL-to-SQLite treatment for functions.
module.exports = (function () {
  const HEADER =
    /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_$]+)[`"]?\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+[`"]?([A-Za-z0-9_$]+)[`"]?\s+FOR\s+EACH\s+ROW\s+BEGIN\s+([\s\S]*?)\s*END\s*(?:\$\$|\/\/|;)?\s*$/i;

  function parse(sql) {
    const m = HEADER.exec(sql);
    if (!m) return null;

    return {
      name: m[1],
      timing: m[2].toUpperCase(),
      event: m[3].toUpperCase(),
      table: m[4],
      body: m[5],
    };
  }

  // Split a body on top-level semicolons. Parens and quotes are tracked so a
  // semicolon inside either does not end a statement.
  function splitBody(body) {
    const out = [];
    let depth = 0;
    let quote = null;
    let current = "";

    for (let i = 0; i < body.length; i++) {
      const ch = body[i];

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

      if (ch === ";" && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }

    if (current.trim()) out.push(current.trim());
    return out;
  }

  // Shape C. Returns the rewritten statement, or null when it is not this shape.
  function rewriteUpdateJoin(statement) {
    const m =
      /^\s*UPDATE\s+[`"]?([A-Za-z0-9_$]+)[`"]?\s+(?:INNER\s+|LEFT\s+|CROSS\s+)?JOIN\s+[`"]?([A-Za-z0-9_$]+)[`"]?\s+ON\s+([\s\S]+?)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(
        statement
      );
    if (!m) return null;

    const [, target, joined, on, assignments, where] = m;

    // A second JOIN is a different problem and is not handled.
    if (/\bJOIN\b/i.test(`${on} ${assignments} ${where || ""}`)) return null;

    // SQLite's UPDATE ... SET takes bare column names on the left, so an
    // assignment qualified with another table is not this shape.
    const stripped = assignments.replace(new RegExp(`\\b${target}\\s*\\.\\s*`, "gi"), "");
    const lhs = stripped.split(",").map((part) => part.split("=")[0].trim());

    if (lhs.some((name) => name.includes("."))) return null;

    const conditions = where ? `${on} AND ${where}` : on;
    return `UPDATE "${target}" SET ${stripped} FROM "${joined}" WHERE ${conditions}`;
  }

  // Shape B. Collapses one DECLARE + SELECT ... INTO into a subquery.
  /**
   * Collapse `DECLARE v; SELECT e INTO v;` into a subquery wherever v is read.
   *
   * `guard` is the trigger's WHEN condition, substituted alongside the body
   * because a DECLARE frequently exists ONLY for the condition to read: the
   * capacity-check triggers compute `cap` and then test
   * `NEW.slot_index > cap`, with the body never mentioning it. Checking only
   * the body for a use rejected the whole shape as "hiding a dead statement".
   *
   * Returns { statements, guard }, or null when the shape is not understood.
   */
  function rewriteDeclare(statements, guard) {
    const declares = statements.filter((s) => /^\s*DECLARE\b/i.test(s));
    if (!declares.length) return { statements, guard };
    // One variable only. More than one is not a shape we claim to understand.
    if (declares.length > 1) return null;

    const declared = /^\s*DECLARE\s+([A-Za-z0-9_$]+)\b/i.exec(declares[0]);
    if (!declared) return null;
    const variable = declared[1];
    const uses = new RegExp(`\\b${variable}\\b`, "gi");

    const rest = statements.filter((s) => !/^\s*DECLARE\b/i.test(s));

    // Exactly one assignment, and it must be a SELECT ... INTO.
    const assignments = rest.filter((s) => new RegExp(`\\bINTO\\s+${variable}\\b`, "i").test(s));
    if (assignments.length !== 1) return null;

    const select =
      new RegExp(
        `^\\s*SELECT\\s+([\\s\\S]+?)\\s+INTO\\s+${variable}\\s+(FROM[\\s\\S]*)$`,
        "i"
      ).exec(assignments[0]) || null;
    if (!select) return null;

    // A SET of the variable after the fact would mean the value changes, and
    // then a single subquery is not equivalent.
    if (rest.some((s) => new RegExp(`\\bSET\\s+${variable}\\b`, "i").test(s))) {
      return null;
    }

    const subquery = `(SELECT ${select[1].trim()} ${select[2].trim()})`;
    const remaining = rest.filter((s) => s !== assignments[0]);

    // It has to actually be read, or the rewrite is hiding a dead statement.
    // The guard counts as a reader; see the note above.
    const readers = remaining.concat(guard ? [guard] : []);
    if (!readers.some((s) => uses.test(s))) return null;

    const substitute = (text) =>
      String(text).replace(new RegExp(`\\b${variable}\\b`, "gi"), subquery);

    return {
      statements: remaining.map(substitute),
      guard: guard ? substitute(guard) : guard,
    };
  }

  /**
   * `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '<msg>'` -> SQLite's RAISE.
   *
   * A direct equivalent: inside a trigger SQLite has
   * `SELECT RAISE(ABORT, '<msg>')`, which aborts the statement with that text
   * exactly as MySQL's SIGNAL does. The SQLSTATE itself has no SQLite
   * counterpart and is dropped - nothing can read it back here, and the message
   * is the part an operator sees.
   */
  function rewriteSignal(statement) {
    const m =
      /^\s*SIGNAL\s+SQLSTATE\s+(?:VALUE\s+)?'[^']*'\s*SET\s+MESSAGE_TEXT\s*=\s*'((?:[^']|'')*)'\s*;?\s*$/i.exec(
        statement
      );
    if (!m) return null;

    return `SELECT RAISE(ABORT, '${m[1]}')`;
  }

  // Shape A. One trigger with IF/ELSE becomes two with WHEN.
  function splitIfElse(body) {
    const m =
      /^\s*IF\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)\s+ELSE\s+([\s\S]+?)\s+END\s+IF\s*;?\s*$/i.exec(body);
    if (!m) return null;

    const [, condition, whenTrue, whenFalse] = m;

    // A nested IF is not this shape.
    if (/\bIF\b/i.test(`${condition} ${whenTrue} ${whenFalse}`)) return null;

    return [
      { suffix: "", when: condition.trim(), body: whenTrue },
      { suffix: "_else", when: `NOT (${condition.trim()})`, body: whenFalse },
    ];
  }

  // Shape D. `IF c THEN a; END IF;` with no ELSE becomes ONE trigger with a
  // WHEN guard. Any statements BEFORE the IF stay in the body text so
  // rewriteDeclare can collapse them; it drops the DECLARE and its assignment
  // itself, leaving only what the THEN branch actually runs.
  function splitIfOnly(body) {
    const m = /^([\s\S]*?)\bIF\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)\s+END\s+IF\s*;?\s*$/i.exec(body);
    if (!m) return null;

    const [, prelude, condition, whenTrue] = m;

    // A second IF anywhere means this is not the shape. Checked across all
    // three parts, and before anything else, because an inner IF consumes the
    // inner END IF and the outer block then looks unterminated instead.
    if (/\bIF\b/i.test(`${condition} ${whenTrue}`) || /\bIF\b/i.test(prelude)) return null;
    if (/\bELSE\b/i.test(whenTrue)) return null;

    const head = prelude.trim().replace(/;\s*$/, "");

    return [
      {
        suffix: "",
        when: condition.trim(),
        body: head ? `${head}; ${whenTrue}` : whenTrue,
      },
    ];
  }

  /**
   * Rewrite a MySQL CREATE TRIGGER into one or more SQLite ones.
   *
   * translateStatement(sql) applies the ordinary MySQL-to-SQLite treatment to a
   * single body statement and may throw.
   *
   * Returns { handled: false } when the trigger is not a shape this understands,
   * or { handled: true, statements: [...], shapes: [...] }.
   */
  function rewrite(sql, translateStatement) {
    const parsed = parse(sql);
    if (!parsed) return { handled: false };

    const ifNotExists = /CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS/i.test(sql);
    const shapes = [];

    // Shape A first: it decides how many triggers come out.
    let branches = splitIfElse(parsed.body);
    if (branches) {
      shapes.push("IF/ELSE");
    } else {
      branches = splitIfOnly(parsed.body);
      if (branches) shapes.push("IF/THEN");
    }
    if (!branches) branches = [{ suffix: "", when: null, body: parsed.body }];

    const statements = [];

    for (const branch of branches) {
      let pieces = splitBody(branch.body);
      if (!pieces.length) return { handled: false };

      let guard = branch.when;
      const collapsed = rewriteDeclare(pieces, guard);
      if (collapsed === null) return { handled: false };
      if (collapsed.statements !== pieces) {
        shapes.push("DECLARE");
        pieces = collapsed.statements;
        guard = collapsed.guard;
      }

      const translated = [];
      for (const piece of pieces) {
        const raised = rewriteSignal(piece);
        if (raised) {
          shapes.push("SIGNAL");
          // Already SQLite, and the MySQL parser has no RAISE.
          translated.push(raised);
          continue;
        }
        const joined = rewriteUpdateJoin(piece);
        if (joined) {
          shapes.push("UPDATE/JOIN");
          // Already SQLite, and MySQL's parser would reject UPDATE ... FROM.
          translated.push(joined);
          continue;
        }
        try {
          translated.push(translateStatement(piece));
        } catch (_) {
          return { handled: false };
        }
      }

      const name = `${parsed.name}${branch.suffix}`;
      const when = guard ? ` WHEN ${guard}` : "";

      statements.push(
        `CREATE TRIGGER ${ifNotExists ? "IF NOT EXISTS " : ""}"${name}" ` +
          `${parsed.timing} ${parsed.event} ON "${parsed.table}" ` +
          `FOR EACH ROW${when} BEGIN ${translated.join("; ")}; END`
      );
    }

    if (!shapes.length) return { handled: false };

    return { handled: true, statements, shapes: [...new Set(shapes)] };
  }

  return { rewrite };
})();
