/**
 * PocketBase Native Adapter - Modular Export System
 *
 * Each export is defined as a self-contained object with:
 * - name: export name
 * - canHandle: detection function to determine if this export should handle the call
 * - handle: the actual implementation
 */

class PocketBaseAdapter {
  constructor(pb, wrapAsync, logger) {
    this.name = "PocketBase";
    this.pb = pb;
    this.wrapAsync = wrapAsync;
    this.logger = logger || console;

    // Define all exports as self-contained modules
    this.exports = this.defineExports();

    // Build list of supported export names for quick lookup
    this.supportedExports = this.exports.map((exp) => exp.name);
  }

  /**
   * Define all exports with their detection and handling logic together
   */
  defineExports() {
    return [
      // ========================================================================
      // CRUD Operations
      // ========================================================================
      {
        name: "create",
        canHandle: (args) => {
          // create(collection, data, options?)
          return (
            typeof args[0] === "string" &&
            !this.isSQLQuery(args[0]) &&
            typeof args[1] === "object" &&
            !Array.isArray(args[1])
          );
        },
        handle: (args) => {
          const [collection, data, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collection(collection).create(data, options);
          })();
        },
      },

      {
        name: "update",
        canHandle: (args) => {
          // update(collection, id, data, options?)
          return (
            typeof args[0] === "string" &&
            !this.isSQLQuery(args[0]) &&
            typeof args[1] === "string" &&
            (typeof args[2] === "object" || args[2] === undefined)
          );
        },
        handle: (args) => {
          const [collection, id, data, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .update(id, data, options);
          })();
        },
      },

      {
        name: "delete",
        canHandle: (args) => {
          // delete(collection, id, options?)
          return (
            typeof args[0] === "string" &&
            !this.isSQLQuery(args[0]) &&
            (typeof args[1] === "string" || typeof args[1] === "undefined")
          );
        },
        handle: (args) => {
          const [collection, id, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collection(collection).delete(id, options);
          })();
        },
      },

      {
        name: "getOne",
        canHandle: (args) => {
          // getOne(collection, id, options?)
          return (
            typeof args[0] === "string" &&
            !this.isSQLQuery(args[0]) &&
            typeof args[1] === "string"
          );
        },
        handle: (args) => {
          const [collection, id, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collection(collection).getOne(id, options);
          })();
        },
      },

      {
        name: "getList",
        canHandle: (args) => {
          // getList(collection, page, perPage, options?)
          return (
            typeof args[0] === "string" &&
            !this.isSQLQuery(args[0]) &&
            typeof args[1] === "number" &&
            typeof args[2] === "number"
          );
        },
        handle: (args) => {
          const [collection, page = 1, perPage = 30, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .getList(page, perPage, options);
          })();
        },
      },

      {
        name: "getFullList",
        canHandle: (args) => {
          // getFullList(collection, options?)
          return typeof args[0] === "string" && !this.isSQLQuery(args[0]);
        },
        handle: (args) => {
          const [collection, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collection(collection).getFullList(options);
          })();
        },
      },

      {
        name: "getFirstListItem",
        canHandle: (args) => {
          // getFirstListItem(collection, filter, options?)
          return (
            typeof args[0] === "string" &&
            !this.isSQLQuery(args[0]) &&
            typeof args[1] === "string"
          );
        },
        handle: (args) => {
          const [collection, filter, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .getFirstListItem(filter, options);
          })();
        },
      },

      // ========================================================================
      // Realtime Subscriptions
      // ========================================================================
      {
        name: "subscribe",
        canHandle: (args) => {
          // subscribe(collection, topic, callback?)
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, topic, callbackRef] = args;
          return this.wrapAsync(async () => {
            const callback = (data) => {
              emit(`pocketbase:${collection}:${topic}`, data);
              if (callbackRef && typeof callbackRef === "function") {
                callbackRef(data);
              }
            };
            await this.pb.collection(collection).subscribe(topic, callback);
            return true;
          })();
        },
      },

      {
        name: "unsubscribe",
        canHandle: (args) => {
          // unsubscribe(collection, topic?)
          return typeof args[0] === "string" && !this.isSQLQuery(args[0]);
        },
        handle: (args) => {
          const [collection, topic = null] = args;
          return this.wrapAsync(async () => {
            if (topic) {
              await this.pb.collection(collection).unsubscribe(topic);
            } else {
              await this.pb.collection(collection).unsubscribe();
            }
            return true;
          })();
        },
      },

      {
        name: "subscribeToTopic",
        canHandle: (args) => {
          // subscribeToTopic(topic, callback?)
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [topic, callbackRef] = args;
          return this.wrapAsync(async () => {
            const callback = (data) => {
              emit(`pocketbase:topic:${topic}`, data);
              if (callbackRef && typeof callbackRef === "function") {
                callbackRef(data);
              }
            };
            await this.pb.realtime.subscribe(topic, callback);
            return true;
          })();
        },
      },

      {
        name: "unsubscribeFromTopic",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [topic] = args;
          return this.wrapAsync(async () => {
            await this.pb.realtime.unsubscribe(topic);
            return true;
          })();
        },
      },

      {
        name: "unsubscribeByPrefix",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [topicPrefix] = args;
          return this.wrapAsync(async () => {
            await this.pb.realtime.unsubscribeByPrefix(topicPrefix);
            return true;
          })();
        },
      },

      {
        name: "isRealtimeConnected",
        canHandle: () => true,
        handle: () => {
          return this.pb.realtime.isConnected;
        },
      },

      // ========================================================================
      // File Operations
      // ========================================================================
      {
        name: "getFileUrl",
        canHandle: (args) => {
          // getFileUrl(record, filename, options?)
          return typeof args[0] === "object" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [record, filename, options = {}] = args;
          return this.pb.files.getURL(record, filename, options);
        },
      },

      {
        name: "getFileToken",
        canHandle: () => true,
        handle: (args) => {
          const [options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.files.getToken(options);
          })();
        },
      },

      // ========================================================================
      // Filter Helper
      // ========================================================================
      {
        name: "filter",
        canHandle: (args) => {
          // filter(rawFilter, params?)
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [rawFilter, params = {}] = args;
          return this.pb.filter(rawFilter, params);
        },
      },

      // ========================================================================
      // Collection Management
      // ========================================================================
      {
        name: "getCollections",
        canHandle: () => true,
        handle: (args) => {
          const [options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.getFullList(options);
          })();
        },
      },

      {
        name: "getCollection",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [idOrName, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.getOne(idOrName, options);
          })();
        },
      },

      {
        name: "createCollection",
        canHandle: (args) => {
          return typeof args[0] === "object";
        },
        handle: (args) => {
          const [data, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.create(data, options);
          })();
        },
      },

      {
        name: "updateCollection",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "object";
        },
        handle: (args) => {
          const [idOrName, data, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.update(idOrName, data, options);
          })();
        },
      },

      {
        name: "deleteCollection",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [idOrName, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.delete(idOrName, options);
          })();
        },
      },

      {
        name: "truncateCollection",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [collectionIdOrName, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.truncate(
              collectionIdOrName,
              options,
            );
          })();
        },
      },

      {
        name: "importCollections",
        canHandle: (args) => {
          // Accept both array and JSON string
          return Array.isArray(args[0]) || typeof args[0] === "string";
        },
        handle: (args) => {
          let [collections, deleteMissing = false, options = {}] = args;

          // If collections is a JSON string, parse it
          if (typeof collections === "string") {
            try {
              collections = JSON.parse(collections);
            } catch (e) {
              throw new Error("Invalid JSON string for collections");
            }
          }

          return this.wrapAsync(async () => {
            return await this.pb.collections.import(
              collections,
              deleteMissing,
              options,
            );
          })();
        },
      },

      {
        name: "getCollectionScaffolds",
        canHandle: () => true,
        handle: (args) => {
          const [options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb.collections.getScaffolds(options);
          })();
        },
      },

      // ========================================================================
      // Health and Status
      // ========================================================================
      {
        name: "healthCheck",
        canHandle: () => true,
        handle: () => {
          return this.wrapAsync(async () => {
            return await this.pb.health.check();
          })();
        },
      },

      // ========================================================================
      // Auth Methods
      // ========================================================================
      {
        name: "listAuthMethods",
        canHandle: (args) => {
          return typeof args[0] === "string" && !this.isSQLQuery(args[0]);
        },
        handle: (args) => {
          const [collection, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .listAuthMethods(options);
          })();
        },
      },

      {
        name: "authCollectionWithPassword",
        canHandle: (args) => {
          return (
            typeof args[0] === "string" &&
            typeof args[1] === "string" &&
            typeof args[2] === "string"
          );
        },
        handle: (args) => {
          const [collection, usernameOrEmail, password, options = {}] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb
              .collection(collection)
              .authWithPassword(usernameOrEmail, password, options);
            return { token: result.token, record: result.record };
          })();
        },
      },

      {
        name: "authWithPassword",
        canHandle: (args) => {
          return (
            typeof args[0] === "string" &&
            typeof args[1] === "string" &&
            typeof args[2] === "string"
          );
        },
        handle: (args) => {
          // Alias for authCollectionWithPassword
          const exp = this.exports.find(
            (e) => e.name === "authCollectionWithPassword",
          );
          return exp.handle(args);
        },
      },

      {
        name: "authWithOTP",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, otpId, password, options = {}] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb
              .collection(collection)
              .authWithOTP(otpId, password, options);
            return { token: result.token, record: result.record };
          })();
        },
      },

      {
        name: "authWithOAuth2Code",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [
            collection,
            provider,
            code,
            codeVerifier,
            redirectURL,
            createData = {},
            options = {},
          ] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb
              .collection(collection)
              .authWithOAuth2Code(
                provider,
                code,
                codeVerifier,
                redirectURL,
                createData,
                options,
              );
            return { token: result.token, record: result.record };
          })();
        },
      },

      {
        name: "authRefreshCollection",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [collection, options = {}] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb
              .collection(collection)
              .authRefresh(options);
            return { token: result.token, record: result.record };
          })();
        },
      },

      {
        name: "authRefresh",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          // Alias for authRefreshCollection
          const exp = this.exports.find(
            (e) => e.name === "authRefreshCollection",
          );
          return exp.handle(args);
        },
      },

      {
        name: "requestOTP",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, email, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .requestOTP(email, options);
          })();
        },
      },

      {
        name: "requestPasswordReset",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, email, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .requestPasswordReset(email, options);
          })();
        },
      },

      {
        name: "confirmPasswordReset",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, token, password, passwordConfirm, options = {}] =
            args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .confirmPasswordReset(token, password, passwordConfirm, options);
          })();
        },
      },

      {
        name: "requestVerification",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, email, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .requestVerification(email, options);
          })();
        },
      },

      {
        name: "confirmVerification",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, token, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .confirmVerification(token, options);
          })();
        },
      },

      {
        name: "requestEmailChange",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, newEmail, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .requestEmailChange(newEmail, options);
          })();
        },
      },

      {
        name: "confirmEmailChange",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, token, password, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .confirmEmailChange(token, password, options);
          })();
        },
      },

      {
        name: "listExternalAuths",
        canHandle: (args) => {
          return typeof args[0] === "string" && typeof args[1] === "string";
        },
        handle: (args) => {
          const [collection, recordId, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .listExternalAuths(recordId, options);
          })();
        },
      },

      {
        name: "unlinkExternalAuth",
        canHandle: (args) => {
          return (
            typeof args[0] === "string" &&
            typeof args[1] === "string" &&
            typeof args[2] === "string"
          );
        },
        handle: (args) => {
          const [collection, recordId, provider, options = {}] = args;
          return this.wrapAsync(async () => {
            return await this.pb
              .collection(collection)
              .unlinkExternalAuth(recordId, provider, options);
          })();
        },
      },

      // ========================================================================
      // Batch Operations
      // ========================================================================
      {
        name: "batch",
        canHandle: () => true,
        handle: () => {
          return {
            _batchId: Math.random().toString(36).substr(2, 9),
            _requests: [],
          };
        },
      },

      {
        name: "batchCreate",
        canHandle: (args) => {
          return typeof args[0] === "object" && args[0]._requests !== undefined;
        },
        handle: (args) => {
          const [batchData, collection, data, options = {}] = args;
          batchData._requests.push({
            type: "create",
            collection,
            data,
            options,
          });
          return batchData;
        },
      },

      {
        name: "batchUpdate",
        canHandle: (args) => {
          return typeof args[0] === "object" && args[0]._requests !== undefined;
        },
        handle: (args) => {
          const [batchData, collection, id, data, options = {}] = args;
          batchData._requests.push({
            type: "update",
            collection,
            id,
            data,
            options,
          });
          return batchData;
        },
      },

      {
        name: "batchDelete",
        canHandle: (args) => {
          return typeof args[0] === "object" && args[0]._requests !== undefined;
        },
        handle: (args) => {
          const [batchData, collection, id, options = {}] = args;
          batchData._requests.push({ type: "delete", collection, id, options });
          return batchData;
        },
      },

      {
        name: "batchUpsert",
        canHandle: (args) => {
          return typeof args[0] === "object" && args[0]._requests !== undefined;
        },
        handle: (args) => {
          const [batchData, collection, data, options = {}] = args;
          batchData._requests.push({
            type: "upsert",
            collection,
            data,
            options,
          });
          return batchData;
        },
      },

      {
        name: "batchSend",
        canHandle: (args) => {
          return typeof args[0] === "object" && args[0]._requests !== undefined;
        },
        handle: (args) => {
          const [batchData] = args;
          return this.wrapAsync(async () => {
            const batch = this.pb.createBatch();
            for (const req of batchData._requests) {
              if (req.type === "create") {
                batch.collection(req.collection).create(req.data, req.options);
              } else if (req.type === "update") {
                batch
                  .collection(req.collection)
                  .update(req.id, req.data, req.options);
              } else if (req.type === "delete") {
                batch.collection(req.collection).delete(req.id, req.options);
              } else if (req.type === "upsert") {
                batch.collection(req.collection).upsert(req.data, req.options);
              }
            }
            return await batch.send();
          })();
        },
      },

      // ========================================================================
      // SQL Operations (PocketBase native SQL API)
      // ========================================================================
      {
        name: "sqlQuery",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [sql, params = {}, columns = null] = args;
          return this.wrapAsync(async () => {
            let finalColumns = columns;
            if (!finalColumns) {
              const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
              if (selectMatch) {
                const colStr = selectMatch[1].trim();
                if (colStr !== "*") {
                  finalColumns = {};
                  const cols = colStr.split(",").map((c) =>
                    c
                      .trim()
                      .split(/\s+as\s+/i)
                      .pop()
                      .trim(),
                  );
                  cols.forEach((col) => {
                    const cleanCol = col.includes(".")
                      ? col.split(".").pop()
                      : col;
                    finalColumns[cleanCol] = "";
                  });
                }
              }
            }
            if (!finalColumns) {
              finalColumns = { id: "", name: "", value: "" };
            }
            const result = await this.pb.send("/api/sql/query", {
              method: "POST",
              body: { sql, params, columns: finalColumns },
            });
            if (!result.success) {
              throw new Error(result.error || "SQL query failed");
            }
            return result.data;
          })();
        },
      },

      {
        name: "sqlScalar",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [sql, params = {}, columnName = "value"] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/sql/scalar", {
              method: "POST",
              body: { sql, params, columnName },
            });
            if (!result.success) {
              throw new Error(result.error || "SQL scalar failed");
            }
            return result.data;
          })();
        },
      },

      {
        name: "sqlSingle",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [sql, params = {}, columns = null] = args;
          return this.wrapAsync(async () => {
            let finalColumns = columns;
            if (!finalColumns) {
              const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
              if (selectMatch) {
                const colStr = selectMatch[1].trim();
                if (colStr !== "*") {
                  finalColumns = {};
                  const cols = colStr.split(",").map((c) =>
                    c
                      .trim()
                      .split(/\s+as\s+/i)
                      .pop()
                      .trim(),
                  );
                  cols.forEach((col) => {
                    const cleanCol = col.includes(".")
                      ? col.split(".").pop()
                      : col;
                    finalColumns[cleanCol] = "";
                  });
                }
              }
            }
            if (!finalColumns) {
              finalColumns = { id: "", name: "", value: "" };
            }
            const result = await this.pb.send("/api/sql/single", {
              method: "POST",
              body: { sql, params, columns: finalColumns },
            });
            if (!result.success) {
              throw new Error(result.error || "SQL single failed");
            }
            return result.data;
          })();
        },
      },

      {
        name: "sqlExecute",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [sql, params = {}] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/sql/execute", {
              method: "POST",
              body: { sql, params },
            });
            if (!result.success) {
              throw new Error(result.error || "SQL execute failed");
            }
            return result.insertId;
          })();
        },
      },

      {
        name: "sqlTransaction",
        canHandle: (args) => {
          return Array.isArray(args[0]);
        },
        handle: (args) => {
          const [queries] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/sql/transaction", {
              method: "POST",
              body: { queries },
            });
            if (!result.success) {
              throw new Error(result.error || "SQL transaction failed");
            }
            return result.success;
          })();
        },
      },

      // ========================================================================
      // Helper Utilities
      // ========================================================================
      {
        name: "findRecordsByIds",
        canHandle: (args) => {
          return typeof args[0] === "string" && Array.isArray(args[1]);
        },
        handle: (args) => {
          const [collection, ids] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/records/findByIds", {
              method: "POST",
              body: { collection, ids },
            });
            if (!result.success) {
              throw new Error(result.error || "Find by IDs failed");
            }
            return result.data;
          })();
        },
      },

      {
        name: "countRecords",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [collection, filter = null, params = {}] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/records/count", {
              method: "POST",
              body: { collection, filter, params },
            });
            if (!result.success) {
              throw new Error(result.error || "Count failed");
            }
            return result.count;
          })();
        },
      },

      {
        name: "runTransaction",
        canHandle: (args) => {
          return Array.isArray(args[0]);
        },
        handle: (args) => {
          const [operations] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/transactions/run", {
              method: "POST",
              body: { operations },
            });
            if (!result.success) {
              throw new Error(result.error || "Transaction failed");
            }
            return result.results;
          })();
        },
      },

      {
        name: "createMigrationHelper",
        canHandle: () => true,
        handle: () => {
          return {
            createCollection: (name, schema) => {
              const exp = this.exports.find(
                (e) => e.name === "createCollection",
              );
              return exp.handle([{ name, schema }]);
            },
            updateCollection: (idOrName, changes) => {
              const exp = this.exports.find(
                (e) => e.name === "updateCollection",
              );
              return exp.handle([idOrName, changes]);
            },
            deleteCollection: (idOrName) => {
              const exp = this.exports.find(
                (e) => e.name === "deleteCollection",
              );
              return exp.handle([idOrName]);
            },
          };
        },
      },

      // ========================================================================
      // Realtime Messaging
      // ========================================================================
      {
        name: "sendRealtimeMessage",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [topic, data] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/realtime/send", {
              method: "POST",
              body: { topic, data },
            });
            if (!result.success) {
              throw new Error(result.error || "Send realtime message failed");
            }
            return result.sentCount;
          })();
        },
      },

      {
        name: "getRealtimeClients",
        canHandle: () => true,
        handle: () => {
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/realtime/clients", {
              method: "GET",
            });
            if (!result.success) {
              throw new Error(result.error || "Get realtime clients failed");
            }
            return result.clients;
          })();
        },
      },

      // ========================================================================
      // Email
      // ========================================================================
      {
        name: "sendEmail",
        canHandle: (args) => {
          return typeof args[0] === "string";
        },
        handle: (args) => {
          const [to, subject, html, text = ""] = args;
          return this.wrapAsync(async () => {
            const result = await this.pb.send("/api/email/send", {
              method: "POST",
              body: { to, subject, html, text },
            });
            if (!result.success) {
              throw new Error(result.error || "Send email failed");
            }
            return true;
          })();
        },
      },
    ];
  }

  /**
   * Check if a string looks like a SQL query
   */
  isSQLQuery(str) {
    if (typeof str !== "string") return false;
    const upper = str.trim().toUpperCase();
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
    return sqlKeywords.some((keyword) => upper.startsWith(keyword));
  }

  /**
   * Check if this adapter can handle the export call
   */
  canHandle(exportName, args) {
    const exportDef = this.exports.find((exp) => exp.name === exportName);
    if (!exportDef) return false;

    try {
      return exportDef.canHandle(args);
    } catch (error) {
      this.logger.error(`Error in canHandle for ${exportName}:`, error);
      return false;
    }
  }

  /**
   * Handle the export call
   */
  handle(exportName, args) {
    const exportDef = this.exports.find((exp) => exp.name === exportName);
    if (!exportDef) {
      throw new Error(
        `PocketBase adapter does not support export: ${exportName}`,
      );
    }

    try {
      return exportDef.handle(args);
    } catch (error) {
      this.logger.error(`Error in handle for ${exportName}:`, error);
      throw error;
    }
  }
}

module.exports = PocketBaseAdapter;
