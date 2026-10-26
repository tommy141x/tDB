/// <reference path="../pb_data/types.d.ts" />

// Raw SQL execution for the oxmysql compatibility layer.
//
// oxmysql callers send arbitrary SQL, so the result shape is unknown up front,
// but PocketBase's JSVM (measured on 0.40.3) only scans into a DynamicModel
// with its fields declared: scanMap() silently yields {}, a field declared null
// panics the runtime, every typed field fails to scan a NULL so every LEFT JOIN
// breaks, and the built-in POST /api/sql rejects bind parameters. What works is
// to ask SQLite to describe the result and re-project it through json_object(),
// letting SQLite carry types and NULLs across as JSON text: one fixed string
// field to scan into, bind parameters intact.
//
// Hook handlers run in a pooled runtime that cannot see file scope, so callers
// must require() this module INSIDE the handler.

// Alias for the JSON-encoded row. Leading underscores panic DynamicModel.
const ROW_ALIAS = "tdbrow";

// Statements that cannot be wrapped in a subquery to discover their shape.
const WRITE_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "REPLACE"];

// Describing a shape costs an extra (row-less) execution, so remember it. The
// cache is per goja runtime; with a pooled runtime each one warms independently.
const shapeCache = new Map();
const MAX_SHAPE_CACHE = 500;

function stripTrailingSemicolon(sql) {
  return String(sql).replace(/;\s*$/, "");
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function quoteLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function bindTo(query, params) {
  return params && Object.keys(params).length ? query.bind(params) : query;
}

// Strip leading whitespace and comments so the opening keyword can be read.
function leadingKeyword(sql) {
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
    const match = trimmed.match(/^[a-zA-Z]+/);
    return match ? match[0].toUpperCase() : "";
  }
}

// SQLite's schema cookie, bumped by every DDL statement. It goes in the shape
// cache key so an ALTER TABLE cannot keep serving the old column list, which
// matters because frameworks migrate at boot and query immediately after. Also
// catches schema changes made on another connection.
function schemaVersion(db) {
  const holder = new DynamicModel({ schema_version: 0 });
  db.newQuery("PRAGMA schema_version").one(holder);
  return JSON.parse(JSON.stringify(holder)).schema_version;
}

// Column names and declared types for a query, no rows fetched. Expression
// columns report "", which is fine: the type is only consulted to spot BLOBs,
// and json_object() types the values itself.
function describe(db, sql, params) {
  const cacheKey = schemaVersion(db) + "\0" + sql;

  const cached = shapeCache.get(cacheKey);
  if (cached) return cached;

  const probe = bindTo(
    db.newQuery("SELECT * FROM (" + stripTrailingSemicolon(sql) + ") LIMIT 0"),
    params
  ).rows();

  let shape;
  try {
    shape = {
      columns: probe.columns().slice(),
      types: probe.columnTypes().map((c) => String(c.databaseTypeName() || "")),
    };
  } finally {
    probe.close();
  }

  if (shapeCache.size >= MAX_SHAPE_CACHE) {
    shapeCache.delete(shapeCache.keys().next().value);
  }
  shapeCache.set(cacheKey, shape);

  return shape;
}

// How a declared type must be handed to Lua.
//
// oxmysql's consumers depend on the shapes mysql2 gives them, and SQLite throws
// the declaration away - so each rule here exists because a real idiom breaks
// without it. Measured against oxmysql's src/utils/typeCast.ts.
function castFor(declared) {
  const type = String(declared || "").toUpperCase();

  // JSON cannot hold a BLOB. Projected as hex and turned into a byte array in
  // selectRows, because oxmysql hands over `[...buffer]` and callers unpack it
  // with string.char(table.unpack(row.raw)). Hex alone was wrong twice: that
  // idiom throws on a string, and `#row.raw` read 10 for 5 bytes.
  if (type.indexOf("BLOB") !== -1) return "blob";

  // TINYINT(1) is THE boolean idiom in FiveM schemas, and oxmysql casts it to a
  // real boolean when the DISPLAY WIDTH is 1 (`field.length !== 1` keeps
  // TINYINT(4) numeric). Without this, 0 reaches Lua as the number 0 - which is
  // TRUTHY - so `if row.banned then` fires for an unbanned player and
  // `if not row.whitelisted then` admits everyone - an authorization inversion
  // in both directions.
  //
  // Compared against 1 exactly, matching oxmysql's `value === '1'`: a column
  // holding 2 is false there, so it is false here.
  if (type === "TINYINT(1)" || type === "BOOLEAN" || type === "BOOL") return "bool";

  // DECIMAL has no SQLite type, so it lands in a REAL and returns a float:
  // 99999999999999.99 came back as 99999999999999.984, and tostring rendered it
  // `1e+14`. oxmysql returns the exact text, so money keeps its cents.
  //
  // Bare NUMERIC is deliberately NOT included: that is the type PocketBase
  // declares for its own number fields, so matching it turned every numeric
  // column on an adopted table into a string. Only a DECIMAL, or a NUMERIC
  // carrying an explicit precision, is a fixed-point money column.
  if (type.indexOf("DECIMAL") === 0 || type.indexOf("NUMERIC(") === 0) return "text";

  // BIGINT past 2^53 cannot survive a JS double: 9223372036854775807 came back
  // as 9.2233720368548e+18 and `==` against the literal was false. Discord
  // snowflakes live in these columns. Conditional, not blanket, matching
  // oxmysql's supportBigNumbers-without-bigNumberStrings: a string only when
  // the value does not fit a double, or `row.id + 1` would break where it works.
  if (type.indexOf("BIGINT") === 0) return "bigint";

  return null;
}

// Re-project a query so every row arrives as one JSON object.
function project(sql, shape) {
  const pairs = shape.columns.map((column, i) => {
    // The CTE's generated handle, so a duplicated name still resolves to its
    // own column. See the WITH below.
    const ref = "c" + i;
    // Duplicate output column names, last-wins.
    //
    // mysql2 assigns each field into one object in order, so `SELECT a.id, b.id`
    // leaves row.id holding B's. PocketBase's driver instead disambiguates to
    // `id` and `id:1`, and projecting those verbatim made row.id hold A's and
    // leaked a `:1` key into every row. Measured: the wrong id then drives
    // `DELETE FROM vehicles WHERE id = row.id`, hitting a different row with no
    // error. Stripping the suffix restores mysql2's key set, because a later
    // pair in json_object() overwrites an earlier one with the same key.
    const name = column.replace(/:\d+$/, "");
    const cast = castFor(shape.types[i]);
    let value = ref;

    if (cast === "blob") {
      // hex(NULL) is '' in SQLite, which would turn a NULL blob into an empty
      // string, so the NULL is guarded.
      value = "CASE WHEN " + ref + " IS NULL THEN NULL ELSE hex(" + ref + ") END";
    } else if (cast === "bool") {
      // json(...) so the value lands as a JSON boolean rather than the text
      // "true", which would reach Lua as a truthy string either way.
      value =
        "CASE WHEN " +
        ref +
        " IS NULL THEN NULL ELSE json(CASE WHEN " +
        ref +
        " = 1 THEN 'true' ELSE 'false' END) END";
    } else if (cast === "text") {
      value = "CASE WHEN " + ref + " IS NULL THEN NULL ELSE CAST(" + ref + " AS TEXT) END";
    } else if (cast === "bigint") {
      // 9007199254740991 is Number.MAX_SAFE_INTEGER.
      value =
        "CASE WHEN " +
        ref +
        " IS NULL THEN NULL WHEN abs(" +
        ref +
        ") > 9007199254740991 THEN CAST(" +
        ref +
        " AS TEXT) ELSE " +
        ref +
        " END";
    }

    return quoteLiteral(name) + ", " + value;
  });

  // Wrapped as a CTE WITH COLUMN ALIASES, not as a plain subquery.
  //
  // A subquery projection has to name its columns, so `SELECT a.id, b.id`
  // produced `json_object('id', "id", 'id', "id")` - both halves resolving to
  // the SAME first column, which silently returned A's id for both.
  //
  // `WITH tdbq(c0, c1, ...) AS (<query>)` gives every output column a unique
  // handle regardless of its real name, so each json_object pair can reference
  // exactly the column it belongs to. The duplicate keys then survive into the
  // JSON text and JSON.parse resolves them last-wins, which is mysql2's rule
  // exactly. Measured, including with a query that already carries its own WITH.
  const handles = shape.columns.map((_column, i) => "c" + i);

  return (
    "WITH tdbq(" +
    handles.join(", ") +
    ") AS (" +
    stripTrailingSemicolon(sql) +
    ") SELECT json_object(" +
    pairs.join(", ") +
    ") AS " +
    ROW_ALIAS +
    " FROM tdbq"
  );
}

function selectRows(db, sql, params) {
  // Shape discovery wraps the statement in a subquery, which SQLite rejects for
  // DML, and re-running an INSERT to learn its shape would insert twice. Refuse
  // clearly rather than surfacing "near INSERT: syntax error". Costs oxmysql
  // callers nothing: MySQL has no RETURNING.
  const keyword = leadingKeyword(sql);
  if (WRITE_KEYWORDS.indexOf(keyword) !== -1) {
    throw new BadRequestError(
      `${keyword} cannot return rows here - use the execute route. ` +
        "RETURNING is unsupported because it has no MySQL equivalent."
    );
  }

  const shape = describe(db, sql, params);

  // A query selecting no columns has no rows worth reading.
  if (shape.columns.length === 0) {
    return { columns: [], rows: [] };
  }

  const container = arrayOf(new DynamicModel({ tdbrow: "" }));
  bindTo(db.newQuery(project(sql, shape)), params).all(container);

  const encoded = JSON.parse(JSON.stringify(container));

  // Which output names carry a BLOB, under the name the projection emitted
  // (the `:N` suffix is stripped there, so it must be stripped here too).
  const blobColumns = [];
  for (let i = 0; i < shape.columns.length; i++) {
    if (castFor(shape.types[i]) === "blob") {
      blobColumns.push(shape.columns[i].replace(/:\d+$/, ""));
    }
  }

  const rows = [];
  for (let i = 0; i < encoded.length; i++) {
    const row = JSON.parse(encoded[i][ROW_ALIAS]);

    // Hex to the array of byte values oxmysql returns, so
    // string.char(table.unpack(row.raw)) works and #row.raw is the byte count.
    for (let c = 0; c < blobColumns.length; c++) {
      const key = blobColumns[c];
      const hex = row[key];
      if (typeof hex !== "string") continue;
      const bytes = [];
      for (let b = 0; b + 1 < hex.length; b += 2) {
        bytes.push(parseInt(hex.substr(b, 2), 16));
      }
      row[key] = bytes;
    }

    rows.push(row);
  }

  // Reported under the same names the rows carry, or a caller reading
  // columns[] and then row[name] would miss.
  const names = shape.columns.map((column) => column.replace(/:\d+$/, ""));

  return { columns: names, rows: rows };
}

// Run a statement for its effect, reporting the counters oxmysql callers expect.
function executeStatement(db, sql, params) {
  const result = bindTo(db.newQuery(stripTrailingSemicolon(sql)), params).execute();

  return {
    affectedRows: Number(result.rowsAffected()),
    insertId: Number(result.lastInsertId()),
  };
}

// Candidate conflict targets: SQLite's `ON CONFLICT (...) DO UPDATE` needs one
// named explicitly, and MySQL's `ON DUPLICATE KEY UPDATE` never states it.
function describeTable(db, table) {
  const columns = selectRows(
    db,
    'SELECT name, type, pk, "notnull" FROM pragma_table_info(' + quoteLiteral(table) + ")"
  ).rows;

  if (columns.length === 0) {
    return null;
  }

  const primaryKey = columns
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => c.name);

  const uniqueIndexes = [];
  const indexes = selectRows(
    db,
    "SELECT name FROM pragma_index_list(" + quoteLiteral(table) + ') WHERE "unique" = 1'
  ).rows;

  for (let i = 0; i < indexes.length; i++) {
    const indexColumns = selectRows(
      db,
      "SELECT name FROM pragma_index_info(" + quoteLiteral(indexes[i].name) + ") ORDER BY seqno"
    ).rows;

    // A partial or expression index has null column names and cannot serve as
    // a conflict target.
    const names = indexColumns.map((c) => c.name);
    if (names.every((n) => n !== null && n !== undefined)) {
      uniqueIndexes.push(names);
    }
  }

  // The order the table had BEFORE adoption, recorded by pb-adopt.
  //
  // Adoption reorders columns - PocketBase sorts them - so a positional
  // `INSERT INTO t VALUES (...)` written against the original schema would put
  // every value in the wrong column. pragma_table_info reports the CURRENT
  // order, which is no longer the one the caller means, so the source order has
  // to come from the registry.
  //
  // Absent for a table that was never adopted, where the current order IS the
  // source order, and absent on an install whose registry predates the column.
  let sourceColumns = null;
  try {
    const recorded = selectRows(
      db,
      "SELECT source_columns FROM tdb_adopted WHERE table_name = " + quoteLiteral(table)
    ).rows;
    if (recorded.length && recorded[0].source_columns) {
      const parsed = JSON.parse(recorded[0].source_columns);
      if (Array.isArray(parsed) && parsed.length) sourceColumns = parsed;
    }
  } catch (_) {
    // No registry yet, or no row for this table. Not an error: it means the
    // table is not adopted and the live order is the right one.
  }

  return {
    sourceColumns,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      notNull: Number(c.notnull) === 1,
      primaryKey: Number(c.pk) > 0,
    })),
    primaryKey: primaryKey,
    uniqueIndexes: uniqueIndexes,
  };
}

module.exports = {
  selectRows,
  executeStatement,
  describeTable,
};
