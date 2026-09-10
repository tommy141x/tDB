/// <reference path="../pb_data/types.d.ts" />

/**
 * SQL routes backing the oxmysql compatibility layer.
 *
 * Every route is superuser-gated. $apis.requireAuth() would not be enough: it
 * accepts any authenticated record from any auth collection, so on a server with
 * an open signup collection a player token could run arbitrary SQL here.
 *
 * Handlers run in a pooled runtime with no access to file scope, so the shared
 * helpers are require()d inside each handler rather than at the top of the file.
 */

// ============================================================================
// Rows
// ============================================================================

/**
 * Run a row-returning statement.
 * POST /api/tdb/query
 * Body: { sql: string, params?: object }
 * -> { success, columns, rows, rowCount }
 *
 * Unlike the older /api/sql/query, the caller does not declare the result
 * shape - it is discovered per query and cached.
 */
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
  $apis.requireSuperuserAuth(),
);

// ============================================================================
// Writes
// ============================================================================

/**
 * Run a statement for its effect.
 * POST /api/tdb/execute
 * Body: { sql: string, params?: object }
 * -> { success, affectedRows, insertId }
 *
 * The counters come from the driver's own result. The previous implementation
 * issued a separate `SELECT last_insert_rowid()` on a different connection and
 * always reported 0.
 */
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
  $apis.requireSuperuserAuth(),
);

// ============================================================================
// Batches
// ============================================================================

/**
 * Run several statements, optionally as one atomic transaction.
 * POST /api/tdb/batch
 * Body: { statements: [{ sql, params?, expect? }], transaction?: boolean }
 * -> { success, results: [...] }
 *
 * `expect` is "rows" or "result" and decides which path a statement takes;
 * it defaults to "result".
 *
 * With transaction:true, any failure rolls the whole batch back - which is what
 * makes oxmysql's transaction export honest rather than best-effort.
 */
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

          results.push(
            statement.expect === "rows"
              ? sqlLib.selectRows(db, statement.sql, statement.params)
              : sqlLib.executeStatement(db, statement.sql, statement.params),
          );
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
  $apis.requireSuperuserAuth(),
);

// ============================================================================
// Schema
// ============================================================================

/**
 * Describe a table's columns and unique keys.
 * POST /api/tdb/schema
 * Body: { table: string }
 * -> { success, table, columns, primaryKey, uniqueIndexes }
 *
 * Used to resolve the conflict target that SQLite's ON CONFLICT requires but
 * MySQL's ON DUPLICATE KEY UPDATE never states.
 */
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
  $apis.requireSuperuserAuth(),
);
