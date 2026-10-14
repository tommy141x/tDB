/// <reference path="../pb_data/types.d.ts" />

// SQL routes backing the oxmysql compatibility layer.
//
// Superuser-gated, not requireAuth(): that accepts any record from any auth
// collection, so on a server with open signup a player token could run
// arbitrary SQL here. Handlers run in a pooled runtime with no file scope,
// hence the require() inside each one.

// Body: { sql, params? } -> { success, columns, rows, rowCount }
// The caller does not declare the result shape; it is discovered and cached.
routerAdd(
  "POST",
  "/api/tdb/query",
  (e) => {
    const sqlLib = require(`${__hooks}/tdb-sql.js`);

    try {
      const body = e.requestInfo().body;
      if (!body || !body.sql) {
        throw new BadRequestError("SQL query is required");
      }

      const result = sqlLib.selectRows($app.db(), body.sql, body.params);

      return e.json(200, {
        success: true,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rows.length,
      });
    } catch (error) {
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth()
);

// Body: { sql, params? } -> { success, affectedRows, insertId }
// Counters come from the driver's own result. A separate
// `SELECT last_insert_rowid()` lands on a different connection and returns 0.
routerAdd(
  "POST",
  "/api/tdb/execute",
  (e) => {
    const sqlLib = require(`${__hooks}/tdb-sql.js`);

    try {
      const body = e.requestInfo().body;
      if (!body || !body.sql) {
        throw new BadRequestError("SQL statement is required");
      }

      const result = sqlLib.executeStatement($app.db(), body.sql, body.params);

      return e.json(200, {
        success: true,
        affectedRows: result.affectedRows,
        insertId: result.insertId,
      });
    } catch (error) {
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth()
);

// Body: { statements: [{ sql, params?, expect? }], transaction?: boolean }
// -> { success, results: [...] }
// `expect` is "rows" or "result", default "result". Transactional unless
// transaction:false, so oxmysql's transaction export is atomic, not best-effort.
routerAdd(
  "POST",
  "/api/tdb/batch",
  (e) => {
    const sqlLib = require(`${__hooks}/tdb-sql.js`);

    try {
      const body = e.requestInfo().body;
      const statements = body && body.statements;

      if (!statements || !statements.length) {
        throw new BadRequestError("At least one statement is required");
      }

      const runAll = (db) => {
        const results = [];
        for (let i = 0; i < statements.length; i++) {
          const statement = statements[i];
          if (!statement || !statement.sql) {
            throw new BadRequestError(`Statement ${i} has no sql`);
          }

          // Name the failing statement. Importing a 900-line dump, a bare
          // "near FULLTEXT: syntax error" is not actionable.
          try {
            results.push(
              statement.expect === "rows"
                ? sqlLib.selectRows(db, statement.sql, statement.params)
                : sqlLib.executeStatement(db, statement.sql, statement.params)
            );
          } catch (statementError) {
            throw new Error(
              `Statement ${i + 1} of ${statements.length}: ` +
                (statementError.message || String(statementError))
            );
          }
        }
        return results;
      };

      let results;
      if (body.transaction === false) {
        results = runAll($app.db());
      } else {
        $app.runInTransaction((txApp) => {
          results = runAll(txApp.db());
        });
      }

      return e.json(200, { success: true, results: results });
    } catch (error) {
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth()
);

// Body: { table } -> { success, table, columns, primaryKey, uniqueIndexes }
// Resolves the conflict target SQLite's ON CONFLICT requires and MySQL's
// ON DUPLICATE KEY UPDATE never states.
routerAdd(
  "POST",
  "/api/tdb/schema",
  (e) => {
    const sqlLib = require(`${__hooks}/tdb-sql.js`);

    try {
      const body = e.requestInfo().body;
      if (!body || !body.table) {
        throw new BadRequestError("Table name is required");
      }

      const schema = sqlLib.describeTable($app.db(), body.table);
      if (!schema) {
        return e.json(404, {
          success: false,
          error: `Table not found: ${body.table}`,
        });
      }

      return e.json(200, {
        success: true,
        table: body.table,
        columns: schema.columns,
        sourceColumns: schema.sourceColumns,
        primaryKey: schema.primaryKey,
        uniqueIndexes: schema.uniqueIndexes,
      });
    } catch (error) {
      return e.json(400, {
        success: false,
        error: error.message || String(error),
      });
    }
  },
  $apis.requireSuperuserAuth()
);
