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
// rewrite would corrupt them silently and permanently - refusing is cheap and a
// wrong answer is not.
//
// Nothing here touches FiveM or the database. translateStatement is injected so
// the body still gets ordinary MySQL-to-SQLite treatment for functions.
module.exports = (function () {
  const HEADER =
    /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_$]+)[`"]?\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+[`"]?([A-Za-z0-9_$]+)[`"]?\s+FOR\s+EACH\s+ROW\s+BEGIN\s+([\s\S]*?)\s*END\s*;?\s*$/i;

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
  function rewriteDeclare(statements) {
    const declares = statements.filter((s) => /^\s*DECLARE\b/i.test(s));
    if (!declares.length) return statements;
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
    if (!remaining.some((s) => uses.test(s))) return null;

    return remaining.map((s) => s.replace(new RegExp(`\\b${variable}\\b`, "gi"), subquery));
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
    const branches = splitIfElse(parsed.body) || [{ suffix: "", when: null, body: parsed.body }];
    if (branches.length > 1) shapes.push("IF/ELSE");

    const statements = [];

    for (const branch of branches) {
      let pieces = splitBody(branch.body);
      if (!pieces.length) return { handled: false };

      const collapsed = rewriteDeclare(pieces);
      if (collapsed === null) return { handled: false };
      if (collapsed !== pieces) {
        shapes.push("DECLARE");
        pieces = collapsed;
      }

      const translated = [];
      for (const piece of pieces) {
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
      const guard = branch.when ? ` WHEN ${branch.when}` : "";

      statements.push(
        `CREATE TRIGGER ${ifNotExists ? "IF NOT EXISTS " : ""}"${name}" ` +
          `${parsed.timing} ${parsed.event} ON "${parsed.table}" ` +
          `FOR EACH ROW${guard} BEGIN ${translated.join("; ")}; END`
      );
    }

    if (!shapes.length) return { handled: false };

    return { handled: true, statements, shapes: [...new Set(shapes)] };
  }

  return { rewrite };
})();
