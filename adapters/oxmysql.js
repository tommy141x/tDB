/**
 * OxMySQL Compatibility Adapter
 *
 * Handles SQL-based calls with oxmysql signatures:
 * - update(query, parameters, callback?)
 * - insert(query, parameters, callback?)
 * - query(query, parameters, callback?)
 * - execute(query, parameters, callback?)
 * etc.
 *
 * Translates SQL queries to PocketBase operations.
 */

class OxMySQLAdapter {
  constructor(pb, wrapAsync, logger) {
    this.name = "OxMySQL";
    this.pb = pb;
    this.wrapAsync = wrapAsync;
    this.logger = logger || console;

    // Define which exports this adapter supports
    this.supportedExports = [
      "update",
      "update_async",
      "insert",
      "insert_async",
      "query",
      "query_async",
      "execute",
      "execute_async",
      "single",
      "single_async",
      "scalar",
      "scalar_async",
      "prepare",
      "prepare_async",
      "rawExecute",
      "rawExecute_async",
      "transaction",
      "transaction_async",
    ];

    // SQL query parser patterns
    this.sqlPatterns = {
      update: /^\s*UPDATE\s+`?(\w+)`?\s+SET\s+(.+?)\s+WHERE\s+(.+)/i,
      insert: /^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\((.+?)\)\s*VALUES\s*\((.+?)\)/i,
      select:
        /^\s*SELECT\s+(.+?)\s+FROM\s+`?(\w+)`?(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(.+?))?$/i,
      delete: /^\s*DELETE\s+FROM\s+`?(\w+)`?\s+WHERE\s+(.+)/i,
    };
  }

  /**
   * Detect if this adapter should handle the call
   * OxMySQL signatures:
   * - update(query: string, parameters: array|object, callback?: function)
   * - insert(query: string, parameters: array|object, callback?: function)
   * - query(query: string, parameters: array|object, callback?: function)
   */
  canHandle(exportName, args) {
    // Remove _async suffix for checking
    const baseName = exportName.replace(/_async$/, "");

    if (!this.supportedExports.includes(exportName)) {
      return false;
    }

    // Special case: transaction takes an array of queries
    if (baseName === "transaction") {
      return Array.isArray(args[0]);
    }

    // First argument must be a string (SQL query)
    if (typeof args[0] !== "string") {
      return false;
    }

    const query = args[0].trim().toUpperCase();

    // Check if it looks like a SQL query
    const sqlKeywords = [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "CREATE",
      "DROP",
      "ALTER",
      "REPLACE",
    ];
    if (!sqlKeywords.some((keyword) => query.startsWith(keyword))) {
      return false;
    }

    // OxMySQL signature: 2nd argument should be array/object (parameters) or undefined
    // 3rd argument should be function (callback) or undefined
    const secondArg = args[1];
    const thirdArg = args[2];

    // Valid patterns:
    // - (query) - just query, no params
    // - (query, params) - query with params
    // - (query, callback) - query with callback (no params)
    // - (query, params, callback) - query with params and callback

    if (secondArg === undefined) {
      // Just query
      return true;
    }

    if (typeof secondArg === "function") {
      // (query, callback)
      return true;
    }

    if (
      Array.isArray(secondArg) ||
      (typeof secondArg === "object" && secondArg !== null)
    ) {
      // (query, params) or (query, params, callback)
      return thirdArg === undefined || typeof thirdArg === "function";
    }

    return false;
  }

  /**
   * Handle the export call
   */
  handle(exportName, args) {
    const baseName = exportName.replace(/_async$/, "");
    const isAsync = exportName.endsWith("_async");

    // Parse arguments: (query, parameters?, callback?)
    const query = args[0];
    let parameters = [];
    let callback = null;

    // Determine parameters and callback
    if (args.length === 1) {
      // Just query
      parameters = [];
    } else if (args.length === 2) {
      if (typeof args[1] === "function") {
        // (query, callback)
        callback = args[1];
      } else {
        // (query, parameters)
        parameters = args[1];
      }
    } else if (args.length >= 3) {
      // (query, parameters, callback)
      parameters = args[1];
      callback = args[2];
    }

    // Route to appropriate handler
    switch (baseName) {
      case "update":
      case "execute":
        return this.executeUpdate(query, parameters, callback);

      case "insert":
        return this.executeInsert(query, parameters, callback);

      case "query":
        return this.executeQuery(query, parameters, callback);

      case "single":
        return this.executeSingle(query, parameters, callback);

      case "scalar":
        return this.executeScalar(query, parameters, callback);

      case "prepare":
        return this.executePrepare(query, parameters, callback);

      case "rawExecute":
        return this.executeRawExecute(query, parameters, callback);

      case "transaction":
        return this.executeTransaction(query, parameters, callback);

      default:
        throw new Error(
          `OxMySQL adapter does not support export: ${exportName}`,
        );
    }
  }

  /**
   * Parse SQL query to extract collection and operations
   */
  parseQuery(query, parameters) {
    query = query.trim();

    // Try UPDATE
    let match = this.sqlPatterns.update.exec(query);
    if (match) {
      return {
        type: "update",
        collection: match[1],
        setClause: match[2],
        whereClause: match[3],
        parameters,
      };
    }

    // Try INSERT
    match = this.sqlPatterns.insert.exec(query);
    if (match) {
      return {
        type: "insert",
        collection: match[1],
        columns: match[2].split(",").map((c) => c.trim().replace(/`/g, "")),
        values: match[3],
        parameters,
      };
    }

    // Try SELECT - handle both simple and complex queries
    // First try to extract collection name from FROM clause
    const fromMatch = query.match(/FROM\s+`?(\w+)`?/i);
    if (!fromMatch) {
      throw new Error("Could not parse collection name from SELECT query");
    }

    const collection = fromMatch[1];
    const whereMatch = query.match(
      /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
    );
    const orderMatch = query.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);
    const limitMatch = query.match(/LIMIT\s+(\d+)/i);
    const columnsMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);

    return {
      type: "select",
      columns: columnsMatch ? columnsMatch[1] : "*",
      collection: collection,
      whereClause: whereMatch ? whereMatch[1] : null,
      orderBy: orderMatch ? orderMatch[1] : null,
      limit: limitMatch ? limitMatch[1] : null,
      parameters,
    };
  }

  /**
   * Replace ? placeholders with actual values
   */
  replacePlaceholders(text, parameters) {
    if (!text) {
      return text;
    }

    if (!parameters || (Array.isArray(parameters) && parameters.length === 0)) {
      return text;
    }

    let paramIndex = 0;
    const params = Array.isArray(parameters)
      ? parameters
      : Object.values(parameters);

    const result = text.replace(/\?/g, () => {
      if (paramIndex >= params.length) {
        throw new Error("Not enough parameters for placeholders");
      }
      const value = params[paramIndex++];

      // Convert to PocketBase filter format
      if (typeof value === "string") {
        return `"${value}"`;
      } else if (value === null) {
        return "null";
      } else if (typeof value === "boolean") {
        return value ? "true" : "false";
      } else {
        return String(value);
      }
    });

    return result;
  }

  /**
   * Convert SQL WHERE clause to PocketBase filter
   */
  convertWhereToFilter(whereClause, parameters) {
    if (!whereClause) {
      return "";
    }

    // Replace ? with actual values FIRST
    let filter = this.replacePlaceholders(whereClause, parameters);

    // Remove backticks
    filter = filter.replace(/`/g, "");

    // Convert SQL operators to PocketBase filter syntax
    filter = filter
      .replace(/\s*=\s*/g, " = ") // Normalize equals spacing
      .replace(/!=|<>/g, " != ") // Not equals
      .replace(/\bAND\b/gi, " && ") // AND to &&
      .replace(/\bOR\b/gi, " || "); // OR to ||

    const finalFilter = filter.trim();

    // Debug log
    this.logger.debug(`WHERE clause: ${whereClause}`);
    this.logger.debug(`Parameters: ${JSON.stringify(parameters)}`);
    this.logger.debug(`Converted filter: ${finalFilter}`);

    return finalFilter;
  }

  /**
   * Execute UPDATE query
   * Returns: number of affected rows (for compatibility with oxmysql)
   */
  executeUpdate(query, parameters, callback) {
    const handler = async () => {
      try {
        const parsed = this.parseQuery(query, parameters);

        if (parsed.type !== "update") {
          throw new Error("Expected UPDATE query");
        }

        // Parse SET clause to get data
        const setData = {};
        const setParts = parsed.setClause.split(",").map((s) => s.trim());

        let paramIndex = 0;
        const params = Array.isArray(parameters)
          ? parameters
          : Object.values(parameters);

        for (const part of setParts) {
          const [key, valuePart] = part.split("=").map((s) => s.trim());
          const cleanKey = key.replace(/`/g, "");

          if (valuePart === "?") {
            setData[cleanKey] = params[paramIndex++];
          } else {
            // Try to parse literal value
            setData[cleanKey] = valuePart.replace(/['"]/g, "");
          }
        }

        // Convert WHERE clause to filter
        const remainingParams = params.slice(paramIndex);
        const filter = this.convertWhereToFilter(
          parsed.whereClause,
          remainingParams,
        );

        // Get records matching filter
        const records = await this.pb
          .collection(parsed.collection)
          .getFullList({
            filter: filter,
          });

        // Update each record
        let affectedRows = 0;
        for (const record of records) {
          await this.pb
            .collection(parsed.collection)
            .update(record.id, setData);
          affectedRows++;
        }

        // Return affected rows count (oxmysql compatibility)
        const result = affectedRows;

        if (callback) {
          callback(result);
          return undefined;
        }
        return result;
      } catch (error) {
        this.logger.error(`OxMySQL UPDATE error: ${error.message}`);
        if (callback) {
          callback(null);
          return undefined;
        }
        throw error;
      }
    };

    return this.wrapAsync(handler)();
  }

  /**
   * Execute INSERT query
   * Returns: insertId (for compatibility with oxmysql)
   */
  executeInsert(query, parameters, callback) {
    const handler = async () => {
      try {
        const parsed = this.parseQuery(query, parameters);

        if (parsed.type !== "insert") {
          throw new Error("Expected INSERT query");
        }

        // Build data object from columns and parameters
        const data = {};
        const params = Array.isArray(parameters)
          ? parameters
          : Object.values(parameters);

        for (let i = 0; i < parsed.columns.length; i++) {
          if (i < params.length) {
            data[parsed.columns[i]] = params[i];
          }
        }

        // Create record
        const record = await this.pb.collection(parsed.collection).create(data);

        // Return insertId (record.id for oxmysql compatibility)
        const result = record.id;

        if (callback) {
          callback(result);
          return undefined;
        }
        return result;
      } catch (error) {
        this.logger.error(`OxMySQL INSERT error: ${error.message}`);
        if (callback) {
          callback(null);
          return undefined;
        }
        throw error;
      }
    };

    return this.wrapAsync(handler)();
  }

  /**
   * Execute SELECT query
   * Returns: array of rows
   */
  executeQuery(query, parameters, callback) {
    const handler = async () => {
      try {
        const parsed = this.parseQuery(query, parameters);

        if (parsed.type !== "select") {
          throw new Error("Expected SELECT query");
        }

        // Convert WHERE clause to filter
        const filter = this.convertWhereToFilter(
          parsed.whereClause,
          parsed.parameters,
        );

        // Build options
        const options = {};
        if (filter) {
          options.filter = filter;
        }
        if (parsed.orderBy) {
          options.sort = parsed.orderBy.replace(/`/g, "").trim();
        }

        this.logger.debug(`Query options: ${JSON.stringify(options)}`);

        // Get records
        let records;
        if (parsed.limit) {
          const limit = parseInt(parsed.limit);
          records = await this.pb
            .collection(parsed.collection)
            .getList(1, limit, options);
          records = records.items || [];
        } else {
          records = await this.pb
            .collection(parsed.collection)
            .getFullList(options);
        }

        this.logger.debug(`Query returned ${records.length} records`);

        // Handle column selection
        if (parsed.columns && parsed.columns !== "*") {
          const columns = parsed.columns.split(",").map((c) =>
            c
              .trim()
              .replace(/`/g, "")
              .replace(/\s+as\s+/i, " "),
          );
          records = records.map((record) => {
            const filtered = {};
            for (const col of columns) {
              const colName = col.includes(".") ? col.split(".").pop() : col;
              filtered[colName] = record[colName];
            }
            return filtered;
          });
        }

        if (callback) {
          callback(records);
          return undefined;
        }
        return records;
      } catch (error) {
        this.logger.error(`OxMySQL QUERY error: ${error.message}`);
        if (callback) {
          callback([]);
          return undefined;
        }
        throw error;
      }
    };

    return this.wrapAsync(handler)();
  }

  /**
   * Execute query and return single row
   */
  executeSingle(query, parameters, callback) {
    const handler = async () => {
      try {
        const rows = await this.executeQuery(query, parameters, null);
        const result = rows && rows.length > 0 ? rows[0] : null;

        if (callback) {
          callback(result);
          return undefined;
        }
        return result;
      } catch (error) {
        this.logger.error(`OxMySQL SINGLE error: ${error.message}`);
        if (callback) {
          callback(null);
          return undefined;
        }
        throw error;
      }
    };

    return this.wrapAsync(handler)();
  }

  /**
   * Execute query and return single scalar value
   */
  executeScalar(query, parameters, callback) {
    const handler = async () => {
      try {
        // For COUNT queries, use countRecords instead of parsing SQL
        if (query.trim().toUpperCase().includes("COUNT(")) {
          const fromMatch = query.match(/FROM\s+`?(\w+)`?/i);
          if (!fromMatch) {
            throw new Error("Could not parse collection name from COUNT query");
          }

          const collection = fromMatch[1];
          const whereMatch = query.match(
            /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
          );

          let filter = null;
          if (whereMatch) {
            filter = this.convertWhereToFilter(whereMatch[1], parameters);
          }

          // Use PocketBase to get the count
          const result = await this.pb
            .collection(collection)
            .getList(1, 1, { filter: filter || undefined });
          const count = result.totalItems || 0;

          this.logger.debug(`COUNT query returned: ${count}`);

          if (callback) {
            callback(count);
            return undefined;
          }
          return count;
        }

        // For other queries, get single row and extract first value
        const row = await this.executeSingle(query, parameters, null);

        let result = null;
        if (row) {
          const keys = Object.keys(row);
          result = keys.length > 0 ? row[keys[0]] : null;
        }

        if (callback) {
          callback(result);
          return undefined;
        }
        return result;
      } catch (error) {
        this.logger.error(`OxMySQL SCALAR error: ${error.message}`);
        if (callback) {
          callback(null);
          return undefined;
        }
        throw error;
      }
    };

    return this.wrapAsync(handler)();
  }

  /**
   * Execute prepared statement
   */
  executePrepare(query, parameters, callback) {
    // Prepare is similar to query for our purposes
    return this.executeQuery(query, parameters, callback);
  }

  /**
   * Execute raw query (similar to prepare but with different return format)
   */
  executeRawExecute(query, parameters, callback) {
    // rawExecute is similar to query for our purposes
    return this.executeQuery(query, parameters, callback);
  }

  /**
   * Execute transaction (array of queries)
   */
  executeTransaction(queries, parameters, callback) {
    const handler = async () => {
      try {
        const results = [];

        // PocketBase doesn't have true transactions, so we execute sequentially
        // Note: This is not atomic - consider using PocketBase batch API if available
        for (let i = 0; i < queries.length; i++) {
          const queryDef = queries[i];
          let query, params;

          if (typeof queryDef === "string") {
            query = queryDef;
            params = [];
          } else if (Array.isArray(queryDef)) {
            query = queryDef[0];
            params = queryDef[1] || [];
          } else if (queryDef.query) {
            query = queryDef.query;
            params = queryDef.values || queryDef.parameters || [];
          } else {
            throw new Error("Invalid transaction query format");
          }

          // Execute query based on type
          const queryType = query.trim().toUpperCase();
          let result;

          if (
            queryType.startsWith("UPDATE") ||
            queryType.startsWith("DELETE")
          ) {
            result = await this.executeUpdate(query, params, null);
          } else if (queryType.startsWith("INSERT")) {
            result = await this.executeInsert(query, params, null);
          } else if (queryType.startsWith("SELECT")) {
            result = await this.executeQuery(query, params, null);
          } else {
            throw new Error(
              `Unsupported query type in transaction: ${queryType}`,
            );
          }

          results.push(result);
        }

        if (callback) {
          callback(results);
          return undefined;
        }
        return results;
      } catch (error) {
        this.logger.error(`OxMySQL TRANSACTION error: ${error.message}`);
        if (callback) {
          callback(null);
          return undefined;
        }
        throw error;
      }
    };

    return this.wrapAsync(handler)();
  }
}

module.exports = OxMySQLAdapter;
