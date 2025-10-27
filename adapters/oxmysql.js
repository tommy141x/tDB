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

    // Query caching
    this.queryCache = new Map();
    this.cacheConfig = {
      enabled: false,
      ttl: 60000, // 60 seconds default
      maxSize: 100,
    };

    // Transaction locks
    this.transactionLocks = new Map();

    // Performance monitoring
    this.slowQueryThreshold = 100; // ms

    // Define which exports this adapter supports
    this.supportedExports = [
      "update",
      "update_async",
      "updateSync",
      "insert",
      "insert_async",
      "insertSync",
      "query",
      "query_async",
      "querySync",
      "execute",
      "execute_async",
      "executeSync",
      "single",
      "single_async",
      "singleSync",
      "scalar",
      "scalar_async",
      "scalarSync",
      "prepare",
      "prepare_async",
      "prepareSync",
      "rawExecute",
      "rawExecute_async",
      "rawExecuteSync",
      "transaction",
      "transaction_async",
      "transactionSync",
      "fetch",
      "fetch_async",
      "fetchSync",
      "store",
      "enableCache",
      "disableCache",
      "invalidateCache",
      "setSlowQueryThreshold",
    ];

    // SQL query parser patterns
    this.sqlPatterns = {
      update: /^\s*UPDATE\s+`?(\w+)`?\s+SET\s+(.+?)\s+WHERE\s+(.+)/i,
      insert: /^\s*INSERT\s+INTO\s+`?(\w+)`?\s*\((.+?)\)\s*VALUES\s*\((.+?)\)/i,
      select:
        /^\s*SELECT\s+(.+?)\s+FROM\s+`?(\w+)`?(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(.+?))?$/i,
      delete: /^\s*DELETE\s+FROM\s+`?(\w+)`?(?:\s+WHERE\s+(.+))?/i,
    };
  }

  /**
   * Enable query result caching
   */
  enableCache(ttl = 60000, maxSize = 100) {
    this.cacheConfig = { enabled: true, ttl, maxSize };
    this.logger.debug(`Query cache enabled: TTL=${ttl}ms, MaxSize=${maxSize}`);
    return true;
  }

  /**
   * Disable query result caching
   */
  disableCache() {
    this.cacheConfig.enabled = false;
    this.queryCache.clear();
    this.logger.debug(`Query cache disabled`);
    return true;
  }

  /**
   * Invalidate cache entries matching pattern
   */
  invalidateCache(pattern) {
    if (pattern) {
      let count = 0;
      for (const [key] of this.queryCache.entries()) {
        if (key.includes(pattern)) {
          this.queryCache.delete(key);
          count++;
        }
      }
      if (count > 0) {
        this.logger.debug(
          `Invalidated ${count} cache entries matching "${pattern}"`,
        );
      }
    } else {
      const size = this.queryCache.size;
      this.queryCache.clear();
      if (size > 0) {
        this.logger.debug(`Cleared all ${size} cache entries`);
      }
    }
    return true;
  }

  /**
   * Set slow query warning threshold
   */
  setSlowQueryThreshold(ms) {
    this.slowQueryThreshold = ms;
    this.logger.debug(`Slow query threshold set to ${ms}ms`);
    return true;
  }

  /**
   * Get cache key for query
   */
  getCacheKey(query, parameters) {
    return `${query}:${JSON.stringify(parameters)}`;
  }

  /**
   * Get cached result if available
   */
  getCachedResult(query, parameters) {
    if (!this.cacheConfig.enabled) return null;

    const cacheKey = this.getCacheKey(query, parameters);
    const cached = this.queryCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheConfig.ttl) {
      this.logger.debug(`Cache HIT: ${cacheKey.substring(0, 100)}...`);
      return cached.data;
    }

    if (cached) {
      // Expired entry
      this.queryCache.delete(cacheKey);
    }

    return null;
  }

  /**
   * Store result in cache
   */
  setCachedResult(query, parameters, data) {
    if (!this.cacheConfig.enabled) return;

    const cacheKey = this.getCacheKey(query, parameters);
    this.queryCache.set(cacheKey, {
      data: data,
      timestamp: Date.now(),
    });

    // Cleanup old cache entries if over limit
    if (this.queryCache.size > this.cacheConfig.maxSize) {
      const firstKey = this.queryCache.keys().next().value;
      this.queryCache.delete(firstKey);
      this.logger.debug(`Cache full, evicted oldest entry`);
    }
  }

  /**
   * Acquire transaction lock
   */
  async acquireLock(resourceKey, timeout = 5000) {
    const startTime = Date.now();

    while (this.transactionLocks.has(resourceKey)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(
          `Lock timeout: Could not acquire lock for ${resourceKey}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.transactionLocks.set(resourceKey, Date.now());
  }

  /**
   * Release transaction lock
   */
  releaseLock(resourceKey) {
    this.transactionLocks.delete(resourceKey);
  }

  /**
   * Detect if this adapter should handle the call
   * OxMySQL signatures:
   * - update(query: string, parameters: array|object, callback?: function)
   * - insert(query: string, parameters: array|object, callback?: function)
   * - query(query: string, parameters: array|object, callback?: function)
   */
  canHandle(exportName, args) {
    // Remove _async and Sync suffixes for checking
    const baseName = exportName.replace(/_async$/, "").replace(/Sync$/, "");

    if (!this.supportedExports.includes(exportName)) {
      return false;
    }

    // Special case: store takes a query and callback
    if (baseName === "store") {
      return typeof args[0] === "string" && typeof args[1] === "function";
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
    const baseName = exportName.replace(/_async$/, "").replace(/Sync$/, "");
    const isAsync =
      exportName.endsWith("_async") || exportName.endsWith("Sync");

    // Handle special utility exports
    if (baseName === "store") {
      // store(query, callback) - just returns the query as-is for compatibility
      const [query, callback] = args;
      if (callback) {
        callback(query);
        return undefined;
      }
      return query;
    }

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
      case "fetch": // fetch is an alias for query
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

    // Try DELETE
    let match = this.sqlPatterns.delete.exec(query);
    if (match) {
      return {
        type: "delete",
        collection: match[1],
        whereClause: match[2] || null,
        parameters,
      };
    }

    // Try UPDATE
    match = this.sqlPatterns.update.exec(query);
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
      throw new Error("Could not parse collection name from query");
    }

    const collection = fromMatch[1];
    const whereMatch = query.match(
      /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
    );
    const orderMatch = query.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|$)/i);

    // Parse LIMIT with optional OFFSET
    const limitMatch = query.match(/LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i);
    let limit = null;
    let offset = null;
    let page = null;

    if (limitMatch) {
      limit = parseInt(limitMatch[1]);
      offset = limitMatch[2] ? parseInt(limitMatch[2]) : 0;
      // Calculate page number for PocketBase (1-based)
      // PocketBase pages are 1-based, so page 1 = records 1-N, page 2 = records N+1-2N, etc.
      // With OFFSET, we need to calculate which page contains the offset record
      // Example: LIMIT 5 OFFSET 2 means skip 2, take 5 (records 3-7)
      // That's starting at record 3, which needs special handling
      // We need to use page=1 but we can't skip records with PocketBase pagination alone
      // So we'll fetch from the calculated page and handle offset in post-processing
      page = Math.floor(offset / limit) + 1;
    }

    // Check for DISTINCT
    const distinctMatch = query.match(/SELECT\s+DISTINCT\s+(.+?)\s+FROM/i);
    const columnsMatch = distinctMatch || query.match(/SELECT\s+(.+?)\s+FROM/i);
    const isDistinct = !!distinctMatch;

    return {
      type: "select",
      columns: columnsMatch ? columnsMatch[1] : "*",
      collection: collection,
      whereClause: whereMatch ? whereMatch[1] : null,
      orderBy: orderMatch ? orderMatch[1] : null,
      limit: limit,
      offset: offset,
      page: page,
      distinct: isDistinct,
      parameters,
    };
  }

  /**
   * Replace ? and @name placeholders with actual values
   * Supports both positional (?) and named (@name) parameters
   */
  replacePlaceholders(text, parameters) {
    if (!text) {
      return text;
    }

    if (!parameters || (Array.isArray(parameters) && parameters.length === 0)) {
      return text;
    }

    let result = text;

    // Handle named parameters first (if parameters is an object)
    if (!Array.isArray(parameters) && typeof parameters === "object") {
      // Replace @name placeholders with values
      result = result.replace(/@(\w+)/g, (match, paramName) => {
        if (!(paramName in parameters)) {
          throw new Error(
            `Named parameter @${paramName} not found in parameters`,
          );
        }
        const value = parameters[paramName];
        return this.formatValue(value);
      });
    } else {
      // Handle positional parameters (?)
      let paramIndex = 0;
      const params = Array.isArray(parameters)
        ? parameters
        : Object.values(parameters);

      result = result.replace(/\?/g, () => {
        if (paramIndex >= params.length) {
          throw new Error("Not enough parameters for placeholders");
        }
        const value = params[paramIndex++];
        return this.formatValue(value);
      });
    }

    return result;
  }

  /**
   * Format a value for PocketBase filter syntax
   */
  formatValue(value) {
    if (typeof value === "string") {
      return `"${value}"`;
    } else if (value === null) {
      return "null";
    } else if (typeof value === "boolean") {
      return value ? "true" : "false";
    } else {
      return String(value);
    }
  }

  /**
   * Convert SQL WHERE clause to PocketBase filter
   */
  convertWhereToFilter(whereClause, parameters) {
    if (!whereClause) {
      return "";
    }

    // Strip GROUP BY clause if present (it should not be in the filter)
    let cleanedWhereClause = whereClause;
    const groupByMatch = whereClause.match(/^(.+?)\s+GROUP\s+BY\s+.+$/i);
    if (groupByMatch) {
      cleanedWhereClause = groupByMatch[1];
    }

    // Replace ? and @name with actual values FIRST
    let filter = this.replacePlaceholders(cleanedWhereClause, parameters);

    // Remove backticks
    filter = filter.replace(/`/g, "");

    // Convert SQL operators to PocketBase filter syntax
    // First handle complex operators that need special processing

    // Handle IN operator: column IN (val1, val2, val3) -> (column = val1 || column = val2 || column = val3)
    filter = filter.replace(
      /(\w+)\s+IN\s*\(([^)]+)\)/gi,
      (match, column, values) => {
        const valueList = values.split(",").map((v) => v.trim());
        return (
          "(" + valueList.map((v) => `${column} = ${v}`).join(" || ") + ")"
        );
      },
    );

    // Handle BETWEEN operator: column BETWEEN val1 AND val2 -> column >= val1 && column <= val2
    filter = filter.replace(
      /(\w+)\s+BETWEEN\s+(.+?)\s+AND\s+(.+?)(?:\s+(?:AND|OR|&&|\|\|)|$)/gi,
      (match, column, val1, val2) => {
        return `${column} >= ${val1.trim()} && ${column} <= ${val2.trim()}`;
      },
    );

    // Handle IS NULL and IS NOT NULL
    filter = filter
      .replace(/(\w+)\s+IS\s+NOT\s+NULL/gi, "$1 != null")
      .replace(/(\w+)\s+IS\s+NULL/gi, "$1 = null");

    // Use placeholders to protect multi-char operators from being split
    filter = filter
      .replace(/\s*>=\s*/g, "___GTE___")
      .replace(/\s*<=\s*/g, "___LTE___")
      .replace(/\s*!=\s*/g, "___NEQ___")
      .replace(/\s*<>\s*/g, "___NEQ___")
      .replace(/\s*>\s*/g, "___GT___")
      .replace(/\s*<\s*/g, "___LT___")
      .replace(/\s*=\s*/g, "___EQ___")
      .replace(/\bAND\b/gi, "___AND___")
      .replace(/\bOR\b/gi, "___OR___")
      .replace(/\bLIKE\s+"([^"]+)"/gi, (match, pattern) => {
        const cleanPattern = pattern.replace(/%/g, "");
        return `___LIKE___ "${cleanPattern}"`;
      })
      // Now replace placeholders with proper operators
      .replace(/___GTE___/g, " >= ")
      .replace(/___LTE___/g, " <= ")
      .replace(/___NEQ___/g, " != ")
      .replace(/___GT___/g, " > ")
      .replace(/___LT___/g, " < ")
      .replace(/___EQ___/g, " = ")
      .replace(/___AND___/g, " && ")
      .replace(/___OR___/g, " || ")
      .replace(/___LIKE___/g, "~")
      .replace(/\s+/g, " ");

    const finalFilter = filter.trim();

    // Debug log
    this.logger.debug(`WHERE clause: ${cleanedWhereClause}`);
    this.logger.debug(`Parameters: ${JSON.stringify(parameters)}`);
    this.logger.debug(`Converted filter: ${finalFilter}`);

    return finalFilter;
  }

  /**
   * Execute DELETE query
   * Returns: number of affected rows (for compatibility with oxmysql)
   */
  executeDelete(query, parameters, callback) {
    const handler = async () => {
      try {
        const parsed = this.parseQuery(query, parameters);

        if (parsed.type !== "delete") {
          throw new Error("Expected DELETE query");
        }

        // Invalidate cache for this collection
        this.invalidateCache(parsed.collection);

        // Invalidate cache for this collection
        this.invalidateCache(parsed.collection);

        // Convert WHERE clause to filter
        const filter = this.convertWhereToFilter(
          parsed.whereClause,
          parsed.parameters,
        );

        // Get records matching filter
        const records = await this.pb
          .collection(parsed.collection)
          .getFullList({
            filter: filter || undefined,
          });

        // Delete each record
        let affectedRows = 0;
        for (const record of records) {
          await this.pb.collection(parsed.collection).delete(record.id);
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
        this.logger.error(`OxMySQL DELETE error: ${error.message}`);
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
   * Execute UPDATE query
   * Returns: number of affected rows (for compatibility with oxmysql)
   */
  executeUpdate(query, parameters, callback) {
    const handler = async () => {
      try {
        const parsed = this.parseQuery(query, parameters);

        if (parsed.type === "delete") {
          // Redirect DELETE queries to executeDelete
          return await this.executeDelete(query, parameters, null);
        }

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
        if (error.data) {
          this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
        }
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
        // Detect bulk insert pattern: INSERT INTO table (cols) VALUES (?,?),(?,?)
        const bulkMatch = query.match(
          /INSERT\s+INTO\s+`?(\w+)`?\s*\((.+?)\)\s*VALUES\s*(.+)/i,
        );

        if (bulkMatch && bulkMatch[3].includes("),(")) {
          return await this.executeBatchInsert(query, parameters, callback);
        }

        const parsed = this.parseQuery(query, parameters);

        if (parsed.type !== "insert") {
          throw new Error("Expected INSERT query");
        }

        // Invalidate cache for this collection
        this.invalidateCache(parsed.collection);

        // Build data object from columns and parameters
        const data = {};
        const params = Array.isArray(parameters)
          ? parameters
          : Object.values(parameters);

        if (params.length > 0) {
          // Use parameters
          for (let i = 0; i < parsed.columns.length; i++) {
            if (i < params.length) {
              data[parsed.columns[i]] = params[i];
            }
          }
        } else {
          // Parse literal values from VALUES clause
          const valuesStr = parsed.values;
          // Match quoted strings and numbers
          const valueMatches = valuesStr.match(
            /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?|true|false|null)/gi,
          );

          if (valueMatches) {
            for (
              let i = 0;
              i < parsed.columns.length && i < valueMatches.length;
              i++
            ) {
              let value = valueMatches[i];
              // Remove quotes from strings
              if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
              ) {
                value = value.slice(1, -1);
              } else if (value === "true") {
                value = true;
              } else if (value === "false") {
                value = false;
              } else if (value === "null") {
                value = null;
              } else if (!isNaN(value)) {
                value = Number(value);
              }
              data[parsed.columns[i]] = value;
            }
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
        if (error.data) {
          this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
        }
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
   * Execute batch insert
   */
  async executeBatchInsert(query, parameters, callback) {
    try {
      const bulkMatch = query.match(
        /INSERT\s+INTO\s+`?(\w+)`?\s*\((.+?)\)\s*VALUES\s*(.+)/i,
      );

      const collection = bulkMatch[1];
      const columns = bulkMatch[2]
        .split(",")
        .map((c) => c.trim().replace(/`/g, ""));
      const valuesStr = bulkMatch[3];

      // Parse multiple value sets: (?,?),(?,?),(?,?)
      const valueSets = [];
      let paramIndex = 0;
      const valueGroups = valuesStr.match(/\([^)]+\)/g);

      if (!valueGroups) {
        throw new Error("Could not parse bulk insert values");
      }

      for (const group of valueGroups) {
        const placeholderCount = (group.match(/\?/g) || []).length;
        const values = parameters.slice(
          paramIndex,
          paramIndex + placeholderCount,
        );
        paramIndex += placeholderCount;

        const record = {};
        columns.forEach((col, idx) => {
          record[col] = values[idx];
        });

        valueSets.push(record);
      }

      this.logger.debug(
        `Batch inserting ${valueSets.length} records into ${collection}`,
      );

      // Batch insert with parallel execution
      const batchSize = 50; // Process in batches
      const results = [];

      for (let i = 0; i < valueSets.length; i += batchSize) {
        const batch = valueSets.slice(i, i + batchSize);

        const batchResults = await Promise.all(
          batch.map((record) => this.pb.collection(collection).create(record)),
        );

        results.push(...batchResults);
      }

      // Invalidate cache
      this.invalidateCache(collection);

      const lastId = results[results.length - 1]?.id;

      if (callback) {
        callback(lastId);
        return undefined;
      }
      return lastId;
    } catch (error) {
      this.logger.error(`Batch insert error: ${error.message}`);
      if (callback) {
        callback(null);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Execute SELECT query
   * Handles all SELECT operations including aggregations, GROUP BY, etc.
   */
  executeQuery(query, parameters, callback) {
    const handler = async () => {
      const startTime = Date.now();

      try {
        // Check cache for non-mutating queries
        if (this.cacheConfig.enabled && !query.match(/INSERT|UPDATE|DELETE/i)) {
          const cached = this.getCachedResult(query, parameters);
          if (cached !== null) {
            if (callback) {
              callback(cached);
              return undefined;
            }
            return cached;
          }
        }

        // Check if query contains subqueries and execute them first
        if (this.hasSubqueries(query)) {
          query = await this.executeSubqueries(query, parameters);
          // Re-parse after subquery substitution
          parameters = []; // Parameters already substituted
        }

        const parsed = this.parseQuery(query, parameters);

        if (parsed.type !== "select") {
          throw new Error("Expected SELECT query");
        }

        // Check if query contains aggregation functions
        const hasAggregation = /\b(SUM|AVG|MIN|MAX|COUNT)\s*\(/i.test(
          parsed.columns,
        );
        const aggregationMatch = parsed.columns.match(
          /\b(SUM|AVG|MIN|MAX|COUNT)\s*\(\s*([^)]+)\s*\)(?:\s+AS\s+(\w+))?/gi,
        );

        // Check if query contains GROUP BY
        const hasGroupBy = /\bGROUP\s+BY\b/i.test(query);

        // Check if query contains string, date, math functions, or CASE WHEN
        const hasStringFunctions =
          /\b(UPPER|LOWER|CONCAT|TRIM|LENGTH|SUBSTRING|SUBSTR|LTRIM|RTRIM|REPLACE|LEFT|RIGHT|LPAD|RPAD|CHAR_LENGTH)\s*\(/i.test(
            parsed.columns,
          );
        const hasDateFunctions =
          /\b(NOW|CURDATE|CURTIME|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|DATE|DATE_ADD|DATE_SUB|DATEDIFF|TIMESTAMPDIFF|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|DAYOFMONTH)\s*\(|NOW\(\)|CURDATE\(\)|CURTIME\(\)/i.test(
            parsed.columns,
          );
        const hasMathFunctions =
          /\b(ABS|CEIL|CEILING|FLOOR|ROUND|SQRT|POW|POWER|SIGN)\s*\(/i.test(
            parsed.columns,
          );
        const hasCaseWhen = /\bCASE\s+WHEN\b/i.test(parsed.columns);

        // If we have GROUP BY with aggregations, handle it specially
        if (hasGroupBy && hasAggregation) {
          return await this.executeGroupByQuery(
            parsed,
            aggregationMatch,
            query,
            callback,
          );
        }

        // If we have aggregations other than COUNT, we need to fetch all data and calculate
        if (
          hasAggregation &&
          aggregationMatch &&
          /\b(SUM|AVG|MIN|MAX)\s*\(/i.test(parsed.columns)
        ) {
          return await this.executeAggregationQuery(
            parsed,
            aggregationMatch,
            callback,
          );
        }

        // If we have string/date/math functions or CASE WHEN, process client-side
        if (
          hasStringFunctions ||
          hasDateFunctions ||
          hasMathFunctions ||
          hasCaseWhen
        ) {
          return await this.executeQueryWithStringFunctions(parsed, callback);
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
          // Handle multiple columns in ORDER BY
          const orderParts = parsed.orderBy.split(",").map((part) => {
            const trimmed = part.trim().replace(/`/g, "");
            // Check if DESC is specified
            if (trimmed.toUpperCase().includes(" DESC")) {
              const colName = trimmed.replace(/\s+DESC/i, "").trim();
              return `-${colName}`;
            } else {
              const colName = trimmed.replace(/\s+ASC/i, "").trim();
              return `+${colName}`;
            }
          });
          options.sort = orderParts.join(",");
        }

        this.logger.debug(`Query options: ${JSON.stringify(options)}`);

        // Get records
        let records;
        if (parsed.limit) {
          // Handle OFFSET by fetching enough records and slicing
          if (parsed.offset && parsed.offset > 0) {
            // Calculate how many records we need to fetch
            // We need offset + limit records total
            const totalNeeded = parsed.offset + parsed.limit;

            // Fetch all needed records
            records = await this.pb
              .collection(parsed.collection)
              .getList(1, totalNeeded, options);
            records = records.items || [];

            // Skip the offset records
            records = records.slice(parsed.offset);
          } else {
            // No offset, just use simple pagination
            const page = parsed.page || 1;
            const perPage = parsed.limit;

            records = await this.pb
              .collection(parsed.collection)
              .getList(page, perPage, options);
            records = records.items || [];
          }
        } else {
          records = await this.pb
            .collection(parsed.collection)
            .getFullList(options);
        }

        this.logger.debug(`Query returned ${records.length} records`);

        // Performance warnings
        const duration = Date.now() - startTime;
        if (duration > this.slowQueryThreshold) {
          this.logger.warn(
            `[SLOW QUERY] ${duration}ms: ${query.substring(0, 100)}${query.length > 100 ? "..." : ""}`,
          );
        }

        if (records.length > 1000 && !parsed.limit) {
          this.logger.warn(
            `[LARGE RESULT] ${records.length} records without LIMIT. Consider adding pagination.`,
          );
        }

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

        // Handle DISTINCT - deduplicate results
        if (parsed.distinct) {
          const seen = new Set();
          records = records.filter((record) => {
            // Create a key from all column values
            const key = JSON.stringify(record);
            if (seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          });
          this.logger.debug(
            `DISTINCT reduced to ${records.length} unique records`,
          );
        }

        // Cache the result
        if (this.cacheConfig.enabled && !query.match(/INSERT|UPDATE|DELETE/i)) {
          this.setCachedResult(query, parameters, records);
        }

        if (callback) {
          callback(records);
          return undefined;
        }
        return records;
      } catch (error) {
        this.logger.error(`OxMySQL QUERY error: ${error.message}`);
        if (error.data) {
          this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
        }
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
   * Execute aggregation query (SUM, AVG, MIN, MAX)
   * Fetches all matching records and calculates aggregations client-side
   */
  async executeAggregationQuery(parsed, aggregationMatch, callback) {
    try {
      // Convert WHERE clause to filter
      const filter = this.convertWhereToFilter(
        parsed.whereClause,
        parsed.parameters,
      );

      // Build options (no sort or limit for aggregations)
      const options = {};
      if (filter) {
        options.filter = filter;
      }

      this.logger.debug(
        `Aggregation query options: ${JSON.stringify(options)}`,
      );

      // Fetch all matching records
      const records = await this.pb
        .collection(parsed.collection)
        .getFullList(options);

      this.logger.debug(`Fetched ${records.length} records for aggregation`);

      // Parse each aggregation function
      const result = {};
      for (const aggMatch of aggregationMatch) {
        const aggParts = aggMatch.match(
          /\b(SUM|AVG|MIN|MAX|COUNT)\s*\(\s*([^)]+)\s*\)(?:\s+AS\s+(\w+))?/i,
        );
        if (!aggParts) continue;

        const funcName = aggParts[1].toUpperCase();
        const column = aggParts[2].trim().replace(/`/g, "");
        const alias = aggParts[3] || `${funcName}(${column})`;

        let value = null;

        if (funcName === "COUNT") {
          if (column === "*") {
            value = records.length;
          } else {
            value = records.filter((r) => r[column] != null).length;
          }
        } else if (funcName === "SUM") {
          value = records.reduce((sum, r) => {
            const val = parseFloat(r[column]);
            return sum + (isNaN(val) ? 0 : val);
          }, 0);
        } else if (funcName === "AVG") {
          const validRecords = records.filter((r) => r[column] != null);
          if (validRecords.length === 0) {
            value = null;
          } else {
            const sum = validRecords.reduce((sum, r) => {
              const val = parseFloat(r[column]);
              return sum + (isNaN(val) ? 0 : val);
            }, 0);
            value = sum / validRecords.length;
          }
        } else if (funcName === "MIN") {
          const validValues = records
            .map((r) => r[column])
            .filter((v) => v != null)
            .map((v) => (typeof v === "number" ? v : parseFloat(v)))
            .filter((v) => !isNaN(v));
          value = validValues.length > 0 ? Math.min(...validValues) : null;
        } else if (funcName === "MAX") {
          const validValues = records
            .map((r) => r[column])
            .filter((v) => v != null)
            .map((v) => (typeof v === "number" ? v : parseFloat(v)))
            .filter((v) => !isNaN(v));
          value = validValues.length > 0 ? Math.max(...validValues) : null;
        }

        result[alias] = value;
      }

      // Return as single row object
      const resultRow = [result];

      if (callback) {
        callback(resultRow);
        return undefined;
      }
      return resultRow;
    } catch (error) {
      this.logger.error(`OxMySQL AGGREGATION error: ${error.message}`);
      if (error.data) {
        this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
      }
      if (callback) {
        callback([]);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Execute query with string functions (UPPER, LOWER, CONCAT, TRIM, LENGTH)
   * Fetches records and applies string functions client-side
   */
  async executeQueryWithStringFunctions(parsed, callback) {
    try {
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
        const orderParts = parsed.orderBy.split(",").map((part) => {
          const trimmed = part.trim().replace(/`/g, "");
          if (trimmed.toUpperCase().includes(" DESC")) {
            const colName = trimmed.replace(/\s+DESC/i, "").trim();
            return `-${colName}`;
          } else {
            const colName = trimmed.replace(/\s+ASC/i, "").trim();
            return `+${colName}`;
          }
        });
        options.sort = orderParts.join(",");
      }

      this.logger.debug(
        `String function query options: ${JSON.stringify(options)}`,
      );

      // Fetch records
      let records;
      if (parsed.limit) {
        if (parsed.offset && parsed.offset > 0) {
          const totalNeeded = parsed.offset + parsed.limit;
          records = await this.pb
            .collection(parsed.collection)
            .getList(1, totalNeeded, options);
          records = records.items || [];
          records = records.slice(parsed.offset);
        } else {
          const page = parsed.page || 1;
          const perPage = parsed.limit;
          records = await this.pb
            .collection(parsed.collection)
            .getList(page, perPage, options);
          records = records.items || [];
        }
      } else {
        records = await this.pb
          .collection(parsed.collection)
          .getFullList(options);
      }

      this.logger.debug(
        `Fetched ${records.length} records for string function processing`,
      );

      // Parse and apply string functions
      const columnDefs = this.parseColumnDefinitions(parsed.columns);

      // Process each record
      records = records.map((record) => {
        const processedRecord = {};

        for (const colDef of columnDefs) {
          if (colDef.isFunction) {
            processedRecord[colDef.alias] = this.applyStringFunction(
              colDef,
              record,
            );
          } else {
            // Regular column
            const colName = colDef.column.replace(/`/g, "");
            processedRecord[colDef.alias] = record[colName];
          }
        }

        return processedRecord;
      });

      if (callback) {
        callback(records);
        return undefined;
      }
      return records;
    } catch (error) {
      this.logger.error(`OxMySQL String Function error: ${error.message}`);
      if (error.data) {
        this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
      }
      if (callback) {
        callback([]);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Parse column definitions to identify functions and aliases
   */
  parseColumnDefinitions(columnsStr) {
    const columns = [];

    // Match CASE WHEN statements (with multiline support)
    const casePattern = /CASE\s+WHEN\s+.+?\s+END(?:\s+AS\s+(\w+))?/gis;
    let remaining = columnsStr;
    let match;

    while ((match = casePattern.exec(columnsStr)) !== null) {
      const alias = match[1] || "case_result";
      columns.push({
        isFunction: true,
        function: "CASE",
        caseExpression: match[0],
        alias: alias,
        fullMatch: match[0],
      });
      remaining = remaining.replace(match[0], "");
    }

    // Match function calls: UPPER(col), CONCAT(col1, col2), NOW(), etc.
    const funcPattern =
      /\b(UPPER|LOWER|CONCAT|TRIM|LENGTH|SUBSTRING|SUBSTR|LTRIM|RTRIM|REPLACE|LEFT|RIGHT|LPAD|RPAD|CHAR_LENGTH|NOW|CURDATE|CURTIME|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|DATE|DATE_ADD|DATE_SUB|DATEDIFF|TIMESTAMPDIFF|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|DAYOFMONTH|ABS|CEIL|CEILING|FLOOR|ROUND|SQRT|POW|POWER|SIGN)\s*\(([^)]*)\)(?:\s+AS\s+(\w+))?/gi;

    while ((match = funcPattern.exec(remaining)) !== null) {
      const funcName = match[1].toUpperCase();
      const args = match[2] || "";
      const alias = match[3] || `${funcName}(${args})`;

      columns.push({
        isFunction: true,
        function: funcName,
        args: args
          ? args.split(",").map((a) => a.trim().replace(/`/g, ""))
          : [],
        alias: alias,
        fullMatch: match[0],
      });

      remaining = remaining.replace(match[0], "");
    }

    // Handle remaining regular columns
    const regularCols = remaining
      .split(",")
      .filter((c) => c.trim() && c.trim() !== "*");
    for (const col of regularCols) {
      const parts = col.trim().split(/\s+AS\s+/i);
      const colName = parts[0].trim().replace(/`/g, "");
      const alias = parts[1] ? parts[1].trim() : colName;

      if (colName && colName !== "") {
        columns.push({
          isFunction: false,
          column: colName,
          alias: alias,
        });
      }
    }

    // If we have *, include all fields
    if (columnsStr.includes("*") && columns.length === 0) {
      columns.push({
        isFunction: false,
        column: "*",
        alias: "*",
      });
    }

    return columns;
  }

  /**
   * Apply a string, date, math function or CASE WHEN to a record
   */
  applyStringFunction(colDef, record) {
    const { function: funcName, args, caseExpression } = colDef;

    // Handle CASE WHEN
    if (funcName === "CASE") {
      return this.parseCaseWhen(caseExpression, record);
    }

    // String functions
    switch (funcName) {
      case "UPPER": {
        const value = String(record[args[0]] || "");
        return value.toUpperCase();
      }

      case "LOWER": {
        const value = String(record[args[0]] || "");
        return value.toLowerCase();
      }

      case "CONCAT": {
        const parts = args.map((arg) => {
          if (
            (arg.startsWith('"') && arg.endsWith('"')) ||
            (arg.startsWith("'") && arg.endsWith("'"))
          ) {
            return arg.slice(1, -1);
          }
          return String(record[arg] || "");
        });
        return parts.join("");
      }

      case "TRIM": {
        const value = String(record[args[0]] || "");
        return value.trim();
      }

      case "LTRIM": {
        const value = String(record[args[0]] || "");
        return value.trimStart();
      }

      case "RTRIM": {
        const value = String(record[args[0]] || "");
        return value.trimEnd();
      }

      case "LENGTH":
      case "CHAR_LENGTH": {
        const value = String(record[args[0]] || "");
        return value.length;
      }

      case "SUBSTRING":
      case "SUBSTR": {
        const value = String(record[args[0]] || "");
        const start = parseInt(args[1]) - 1; // SQL is 1-indexed
        const length = args[2] ? parseInt(args[2]) : undefined;
        return value.substring(start, length ? start + length : undefined);
      }

      case "REPLACE": {
        const value = String(record[args[0]] || "");
        const search = args[1].replace(/['"]/g, "");
        const replace = args[2].replace(/['"]/g, "");
        return value.replace(new RegExp(search, "g"), replace);
      }

      case "LEFT": {
        const value = String(record[args[0]] || "");
        return value.substring(0, parseInt(args[1]));
      }

      case "RIGHT": {
        const value = String(record[args[0]] || "");
        return value.substring(value.length - parseInt(args[1]));
      }

      case "LPAD": {
        const value = String(record[args[0]] || "");
        const length = parseInt(args[1]);
        const pad = args[2] ? args[2].replace(/['"]/g, "") : " ";
        return value.padStart(length, pad);
      }

      case "RPAD": {
        const value = String(record[args[0]] || "");
        const length = parseInt(args[1]);
        const pad = args[2] ? args[2].replace(/['"]/g, "") : " ";
        return value.padEnd(length, pad);
      }

      // Date functions
      case "NOW":
      case "CURRENT_TIMESTAMP":
        return new Date().toISOString();

      case "CURDATE":
      case "CURRENT_DATE":
        return new Date().toISOString().split("T")[0];

      case "CURTIME":
      case "CURRENT_TIME":
        return new Date().toTimeString().split(" ")[0];

      case "YEAR": {
        const date = new Date(record[args[0]]);
        return date.getFullYear();
      }

      case "MONTH": {
        const date = new Date(record[args[0]]);
        return date.getMonth() + 1;
      }

      case "DAY":
      case "DAYOFMONTH": {
        const date = new Date(record[args[0]]);
        return date.getDate();
      }

      case "HOUR": {
        const date = new Date(record[args[0]]);
        return date.getHours();
      }

      case "MINUTE": {
        const date = new Date(record[args[0]]);
        return date.getMinutes();
      }

      case "SECOND": {
        const date = new Date(record[args[0]]);
        return date.getSeconds();
      }

      case "DATE": {
        const date = new Date(record[args[0]]);
        return date.toISOString().split("T")[0];
      }

      case "DATEDIFF": {
        const date1 = new Date(record[args[0]] || args[0].replace(/['"]/g, ""));
        const date2 = new Date(record[args[1]] || args[1].replace(/['"]/g, ""));
        return Math.floor((date1 - date2) / (1000 * 60 * 60 * 24));
      }

      // Math functions
      case "ABS": {
        const value = parseFloat(record[args[0]]);
        return Math.abs(value);
      }

      case "CEIL":
      case "CEILING": {
        const value = parseFloat(record[args[0]]);
        return Math.ceil(value);
      }

      case "FLOOR": {
        const value = parseFloat(record[args[0]]);
        return Math.floor(value);
      }

      case "ROUND": {
        const value = parseFloat(record[args[0]]);
        const decimals = args[1] ? parseInt(args[1]) : 0;
        return Number(value.toFixed(decimals));
      }

      case "SQRT": {
        const value = parseFloat(record[args[0]]);
        return Math.sqrt(value);
      }

      case "POW":
      case "POWER": {
        const value = parseFloat(record[args[0]]);
        const power = parseFloat(args[1]);
        return Math.pow(value, power);
      }

      case "SIGN": {
        const value = parseFloat(record[args[0]]);
        return Math.sign(value);
      }

      default:
        return null;
    }
  }

  /**
   * Parse and evaluate CASE WHEN expression
   */
  parseCaseWhen(caseExpr, record) {
    const whenMatches = caseExpr.matchAll(
      /WHEN\s+(.+?)\s+THEN\s+(.+?)(?=\s+WHEN|\s+ELSE|\s+END)/gi,
    );
    const elseMatch = caseExpr.match(/ELSE\s+(.+?)\s+END/i);

    for (const match of whenMatches) {
      const condition = match[1];
      const result = match[2].replace(/['"]/g, "");

      if (this.evaluateCondition(condition, record)) {
        return result;
      }
    }

    return elseMatch ? elseMatch[1].replace(/['"]/g, "") : null;
  }

  /**
   * Evaluate a condition for CASE WHEN
   */
  evaluateCondition(condition, record) {
    const match = condition.match(/(\w+)\s*(=|!=|<>|<|>|<=|>=)\s*(.+)/);
    if (!match) return false;

    const [, field, operator, valueStr] = match;
    const fieldValue = record[field];
    const compareValue = valueStr.replace(/['"]/g, "");
    const numValue = parseFloat(compareValue);

    switch (operator) {
      case "=":
        return fieldValue == (isNaN(numValue) ? compareValue : numValue);
      case "!=":
      case "<>":
        return fieldValue != (isNaN(numValue) ? compareValue : numValue);
      case "<":
        return fieldValue < numValue;
      case ">":
        return fieldValue > numValue;
      case "<=":
        return fieldValue <= numValue;
      case ">=":
        return fieldValue >= numValue;
      default:
        return false;
    }
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
   * Supports multiple parameter sets: prepare(query, [[params1], [params2], ...])
   */
  executePrepare(query, parameters, callback) {
    // Check if parameters is an array of arrays (multiple parameter sets)
    if (
      Array.isArray(parameters) &&
      parameters.length > 0 &&
      Array.isArray(parameters[0])
    ) {
      // Multiple parameter sets - execute query for each set
      const handler = async () => {
        try {
          const results = [];
          for (const paramSet of parameters) {
            const result = await this.executeQuery(query, paramSet, null);
            // For multiple sets, always return the result (even single rows)
            results.push(result);
          }

          if (callback) {
            callback(results);
            return undefined;
          }
          return results;
        } catch (error) {
          this.logger.error(`OxMySQL PREPARE error: ${error.message}`);
          if (error.data) {
            this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
          }
          if (callback) {
            callback(null);
            return undefined;
          }
          throw error;
        }
      };
      return this.wrapAsync(handler)();
    }

    // Single parameter set - use normal query
    return this.executeQuery(query, parameters, callback);
  }

  /**
   * Execute GROUP BY query with aggregations
   * Fetches all matching records and groups/aggregates client-side
   */
  async executeGroupByQuery(parsed, aggregationMatch, fullQuery, callback) {
    try {
      // Extract GROUP BY columns
      const groupByMatch = fullQuery.match(
        /GROUP\s+BY\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
      );
      if (!groupByMatch) {
        throw new Error("Could not parse GROUP BY clause");
      }

      const groupByColumns = groupByMatch[1]
        .split(",")
        .map((col) => col.trim().replace(/`/g, ""));

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

      this.logger.debug(`GROUP BY query options: ${JSON.stringify(options)}`);

      // Fetch all matching records
      const records = await this.pb
        .collection(parsed.collection)
        .getFullList(options);

      this.logger.debug(
        `Fetched ${records.length} records for GROUP BY processing`,
      );

      // Performance warning for large GROUP BY
      if (records.length > 500) {
        this.logger.warn(
          `[GROUP BY] Processing ${records.length} records client-side. ` +
            `Consider pre-aggregating data or using smaller date ranges for better performance.`,
        );
      }

      // Group records by the GROUP BY columns
      const groups = {};
      for (const record of records) {
        // Create a key from the group by columns
        const groupKey = groupByColumns.map((col) => record[col]).join("|~|");

        if (!groups[groupKey]) {
          groups[groupKey] = {
            key: groupKey,
            columns: {},
            records: [],
          };
          // Store the group by column values
          for (const col of groupByColumns) {
            groups[groupKey].columns[col] = record[col];
          }
        }

        groups[groupKey].records.push(record);
      }

      this.logger.debug(`Grouped into ${Object.keys(groups).length} groups`);

      // Calculate aggregations for each group
      const results = [];
      for (const groupKey in groups) {
        const group = groups[groupKey];
        const resultRow = { ...group.columns };

        // Parse and calculate each aggregation
        for (const aggMatch of aggregationMatch) {
          const aggParts = aggMatch.match(
            /\b(SUM|AVG|MIN|MAX|COUNT)\s*\(\s*([^)]+)\s*\)(?:\s+AS\s+(\w+))?/i,
          );
          if (!aggParts) continue;

          const funcName = aggParts[1].toUpperCase();
          const column = aggParts[2].trim().replace(/`/g, "");
          const alias = aggParts[3] || `${funcName}(${column})`;

          let value = null;

          if (funcName === "COUNT") {
            if (column === "*") {
              value = group.records.length;
            } else {
              value = group.records.filter((r) => r[column] != null).length;
            }
          } else if (funcName === "SUM") {
            value = group.records.reduce((sum, r) => {
              const val = parseFloat(r[column]);
              return sum + (isNaN(val) ? 0 : val);
            }, 0);
          } else if (funcName === "AVG") {
            const validRecords = group.records.filter((r) => r[column] != null);
            if (validRecords.length === 0) {
              value = null;
            } else {
              const sum = validRecords.reduce((sum, r) => {
                const val = parseFloat(r[column]);
                return sum + (isNaN(val) ? 0 : val);
              }, 0);
              value = sum / validRecords.length;
            }
          } else if (funcName === "MIN") {
            const validValues = group.records
              .map((r) => r[column])
              .filter((v) => v != null)
              .map((v) => (typeof v === "number" ? v : parseFloat(v)))
              .filter((v) => !isNaN(v));
            value = validValues.length > 0 ? Math.min(...validValues) : null;
          } else if (funcName === "MAX") {
            const validValues = group.records
              .map((r) => r[column])
              .filter((v) => v != null)
              .map((v) => (typeof v === "number" ? v : parseFloat(v)))
              .filter((v) => !isNaN(v));
            value = validValues.length > 0 ? Math.max(...validValues) : null;
          }

          resultRow[alias] = value;
        }

        results.push(resultRow);
      }

      // Apply ORDER BY if specified
      if (parsed.orderBy) {
        const orderParts = parsed.orderBy.split(",").map((part) => {
          const trimmed = part.trim().replace(/`/g, "");
          const isDesc = trimmed.toUpperCase().includes(" DESC");
          const colName = trimmed.replace(/\s+(DESC|ASC)/i, "").trim();
          return { column: colName, desc: isDesc };
        });

        results.sort((a, b) => {
          for (const { column, desc } of orderParts) {
            const aVal = a[column];
            const bVal = b[column];
            if (aVal < bVal) return desc ? 1 : -1;
            if (aVal > bVal) return desc ? -1 : 1;
          }
          return 0;
        });
      }

      // Apply LIMIT if specified
      let finalResults = results;
      if (parsed.limit) {
        const start = parsed.offset || 0;
        const end = start + parsed.limit;
        finalResults = results.slice(start, end);
      }

      if (callback) {
        callback(finalResults);
        return undefined;
      }
      return finalResults;
    } catch (error) {
      this.logger.error(`OxMySQL GROUP BY error: ${error.message}`);
      if (error.data) {
        this.logger.error(`Error details: ${JSON.stringify(error.data)}`);
      }
      if (callback) {
        callback([]);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Check if query contains subqueries
   */
  hasSubqueries(query) {
    // Check for subqueries in IN clauses or as scalar values
    return (
      /\bIN\s*\(\s*SELECT\b/i.test(query) ||
      /\(\s*SELECT\b.*?\)\s*(?:AS|FROM|,|\))/i.test(query)
    );
  }

  /**
   * Execute subqueries and substitute results into main query
   */
  async executeSubqueries(query, parameters) {
    let processedQuery = query;
    let iteration = 0;
    const maxIterations = 5; // Prevent infinite loops

    // Process subqueries iteratively (inner to outer)
    while (this.hasSubqueries(processedQuery) && iteration < maxIterations) {
      iteration++;

      // Find and execute IN subqueries: WHERE col IN (SELECT ...)
      const inSubqueryPattern = /\bIN\s*\(\s*(SELECT\s+[^)]+)\)/gi;
      let match;
      const inMatches = [];

      while ((match = inSubqueryPattern.exec(processedQuery)) !== null) {
        inMatches.push({
          fullMatch: match[0],
          subquery: match[1],
          index: match.index,
        });
      }

      // Execute IN subqueries
      for (const inMatch of inMatches) {
        try {
          const subResults = await this.executeQuery(
            inMatch.subquery,
            parameters,
            null,
          );

          // Extract values from first column of results
          const values = subResults.map((row) => {
            const firstCol = Object.keys(row)[0];
            const val = row[firstCol];
            // Format value based on type
            if (typeof val === "string") {
              return `"${val}"`;
            } else if (val === null) {
              return "null";
            } else {
              return String(val);
            }
          });

          // Replace subquery with values
          const replacement =
            values.length > 0 ? `IN (${values.join(", ")})` : "IN (NULL)";
          processedQuery = processedQuery.replace(
            inMatch.fullMatch,
            replacement,
          );
        } catch (error) {
          this.logger.error(`Subquery execution error: ${error.message}`);
          throw new Error(`Failed to execute subquery: ${error.message}`);
        }
      }

      // Find and execute scalar subqueries: (SELECT col FROM table LIMIT 1)
      const scalarSubqueryPattern =
        /\(\s*(SELECT\s+.+?)\s*\)(?=\s*(?:AS|,|FROM|\s|$))/gi;
      const scalarMatches = [];

      while ((match = scalarSubqueryPattern.exec(processedQuery)) !== null) {
        // Skip if this is an IN subquery (already processed)
        const precedingText = processedQuery.substring(
          Math.max(0, match.index - 10),
          match.index,
        );
        if (!/\bIN\s*$/i.test(precedingText)) {
          scalarMatches.push({
            fullMatch: match[0],
            subquery: match[1],
            index: match.index,
          });
        }
      }

      // Execute scalar subqueries
      for (const scalarMatch of scalarMatches) {
        try {
          const subResults = await this.executeQuery(
            scalarMatch.subquery,
            parameters,
            null,
          );

          // Get scalar value (first column of first row)
          let scalarValue = "NULL";
          if (subResults && subResults.length > 0) {
            const firstCol = Object.keys(subResults[0])[0];
            const val = subResults[0][firstCol];
            if (typeof val === "string") {
              scalarValue = `"${val}"`;
            } else if (val === null) {
              scalarValue = "NULL";
            } else {
              scalarValue = String(val);
            }
          }

          // Replace subquery with scalar value
          processedQuery = processedQuery.replace(
            scalarMatch.fullMatch,
            scalarValue,
          );
        } catch (error) {
          this.logger.error(
            `Scalar subquery execution error: ${error.message}`,
          );
          throw new Error(
            `Failed to execute scalar subquery: ${error.message}`,
          );
        }
      }
    }

    if (iteration >= maxIterations) {
      this.logger.warn("Max subquery iterations reached");
    }

    return processedQuery;
  }

  /**
   * Execute raw query (similar to prepare but with different return format)
   */
  executeRawExecute(query, parameters, callback) {
    // rawExecute is similar to query for our purposes
    return this.executeQuery(query, parameters, callback);
  }

  /**
   * Execute transaction (array of queries) with rollback support
   * Note: This is a best-effort transaction simulation. PocketBase doesn't support true ACID transactions.
   */
  executeTransaction(queries, parameters, callback) {
    const handler = async () => {
      const executedOperations = [];
      const lockKey = `transaction_${Date.now()}_${Math.random()}`;

      try {
        // Acquire lock to prevent concurrent transaction conflicts
        await this.acquireLock(lockKey, 10000);

        this.logger.debug(
          `Starting transaction with ${queries.length} queries`,
        );

        // PHASE 1: Parse and validate all queries
        const parsedQueries = [];
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
            throw new Error(`Invalid transaction query format at index ${i}`);
          }

          parsedQueries.push({ query, params, index: i });
        }

        // PHASE 2: Execute queries with rollback tracking
        for (const { query, params, index } of parsedQueries) {
          const queryType = query.trim().toUpperCase();
          let result;
          let rollbackData = null;

          try {
            // For UPDATE: Store old values for potential rollback
            if (queryType.startsWith("UPDATE")) {
              const parsed = this.parseQuery(query, params);
              const filter = this.convertWhereToFilter(
                parsed.whereClause,
                parsed.parameters,
              );
              const oldRecords = await this.pb
                .collection(parsed.collection)
                .getFullList({ filter });

              rollbackData = {
                type: "update",
                collection: parsed.collection,
                records: oldRecords,
              };

              result = await this.executeUpdate(query, params, null);
            }
            // For INSERT: Track IDs for deletion on rollback
            else if (queryType.startsWith("INSERT")) {
              const parsed = this.parseQuery(query, params);
              rollbackData = {
                type: "insert",
                collection: parsed.collection,
                ids: [],
              };

              result = await this.executeInsert(query, params, null);

              if (result) {
                rollbackData.ids.push(result);
              }
            }
            // For DELETE: Store deleted records for restoration
            else if (queryType.startsWith("DELETE")) {
              const parsed = this.parseQuery(query, params);
              const filter = this.convertWhereToFilter(
                parsed.whereClause,
                parsed.parameters,
              );
              const toDelete = await this.pb
                .collection(parsed.collection)
                .getFullList({ filter });

              rollbackData = {
                type: "delete",
                collection: parsed.collection,
                records: toDelete,
              };

              result = await this.executeDelete(query, params, null);
            }
            // For SELECT: Just execute
            else if (queryType.startsWith("SELECT")) {
              result = await this.executeQuery(query, params, null);
            } else {
              throw new Error(
                `Unsupported query type in transaction: ${queryType}`,
              );
            }

            executedOperations.push({ rollbackData, result, index });
          } catch (error) {
            throw new Error(
              `Transaction failed at query ${index}: ${error.message}`,
            );
          }
        }

        this.logger.debug(`Transaction completed successfully`);
        this.releaseLock(lockKey);

        const results = executedOperations.map((op) => op.result);

        if (callback) {
          callback(results);
          return undefined;
        }
        return results;
      } catch (error) {
        this.logger.error(`Transaction failed: ${error.message}`);
        this.logger.warn(
          `Attempting to rollback ${executedOperations.length} operations...`,
        );

        // PHASE 3: Rollback (best effort)
        let rollbackSuccess = 0;
        let rollbackFailed = 0;

        for (let i = executedOperations.length - 1; i >= 0; i--) {
          const { rollbackData } = executedOperations[i];
          if (!rollbackData) continue;

          try {
            switch (rollbackData.type) {
              case "insert":
                // Delete inserted records
                for (const id of rollbackData.ids) {
                  try {
                    await this.pb
                      .collection(rollbackData.collection)
                      .delete(id);
                  } catch (err) {
                    // Record might not exist, continue
                  }
                }
                rollbackSuccess++;
                break;

              case "update":
                // Restore old values
                for (const record of rollbackData.records) {
                  try {
                    const {
                      id,
                      created,
                      updated,
                      collectionId,
                      collectionName,
                      ...data
                    } = record;
                    await this.pb
                      .collection(rollbackData.collection)
                      .update(id, data);
                  } catch (err) {
                    // Record might not exist, continue
                  }
                }
                rollbackSuccess++;
                break;

              case "delete":
                // Re-create deleted records
                for (const record of rollbackData.records) {
                  try {
                    const {
                      id,
                      created,
                      updated,
                      collectionId,
                      collectionName,
                      ...data
                    } = record;
                    await this.pb.collection(rollbackData.collection).create({
                      ...data,
                      id: id, // Try to preserve original ID
                    });
                  } catch (err) {
                    // ID might conflict, try without ID
                    try {
                      await this.pb
                        .collection(rollbackData.collection)
                        .create(data);
                    } catch (err2) {
                      // Give up on this record
                    }
                  }
                }
                rollbackSuccess++;
                break;
            }
          } catch (rollbackError) {
            this.logger.error(
              `Rollback failed for operation ${i}: ${rollbackError.message}`,
            );
            rollbackFailed++;
          }
        }

        if (rollbackFailed > 0) {
          this.logger.error(
            `⚠️ CRITICAL: Transaction rollback incomplete! ` +
              `${rollbackSuccess} operations rolled back, ${rollbackFailed} failed. ` +
              `Database may be in inconsistent state!`,
          );
        } else if (rollbackSuccess > 0) {
          this.logger.warn(
            `Transaction rolled back successfully (${rollbackSuccess} operations reversed)`,
          );
        }

        this.releaseLock(lockKey);

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
