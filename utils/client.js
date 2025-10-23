/**
 * PocketBase FiveM Client
 */
(function () {
  const PocketBase = require("./bin/pocketbase.cjs.js");
  const configLoader = require("./utils/config-loader.js");
  const { retryWithBackoff } = require("./utils/process-utils.js");

  // Polyfill EventSource for Node.js environment
  if (typeof EventSource === "undefined") {
    const EventSourcePolyfill = require("./bin/eventsource.min.js");
    global.EventSource =
      EventSourcePolyfill.EventSourcePolyfill || EventSourcePolyfill;
  }

  // ============================================================================
  // Logger
  // ============================================================================
  const clientLogger = {
    info: (msg) => console.log(`^2[PocketBase Client]^7 ${msg}`),
    warn: (msg) => console.log(`^3[PocketBase Client]^7 ${msg}`),
    error: (msg) => console.log(`^1[PocketBase Client]^7 ${msg}`),
    debug: (msg) => console.log(`^5[PocketBase Client]^7 ${msg}`),
    silent: () => {}, // No-op for silent operations
  };

  // ============================================================================
  // Configuration
  // ============================================================================
  const resourceName = GetCurrentResourceName();
  const resourcePath = GetResourcePath(resourceName);

  // Load config using shared loader
  const config = configLoader.load(resourcePath);

  // Determine PocketBase URL - always connect to localhost since we're on same machine
  const pbUrl = `http://127.0.0.1:${config.Port}`;

  // ============================================================================
  // PocketBase Client Instance
  // ============================================================================
  const pb = new PocketBase(pbUrl);

  // Wait for PocketBase to be ready and authenticate
  let isReady = false;
  let isAuthenticated = false;
  const readyCallbacks = [];

  const notifyReady = () => {
    isReady = true;
    // Call all pending callbacks
    readyCallbacks.forEach((callback) => callback());
    readyCallbacks.length = 0;
  };

  const tryAuthenticate = async () => {
    if (!config.Superuser.Email || !config.Superuser.Password) {
      notifyReady();
      return;
    }

    try {
      await retryWithBackoff(
        async () => {
          await pb
            .collection("_superusers")
            .authWithPassword(
              config.Superuser.Email,
              config.Superuser.Password,
            );
        },
        10, // maxAttempts
        100, // baseDelay
        2000, // maxDelay
      );

      isAuthenticated = true;
      notifyReady();
    } catch (authErr) {
      clientLogger.error(`Authentication failed: ${authErr.message}`);
      notifyReady();
    }
  };

  // Event-driven startup: Listen for server ready event
  on("pocketbase:server:ready", async (data) => {
    await tryAuthenticate();

    // Emit client status back to server
    emit("pocketbase:client:ready", {
      authenticated: isAuthenticated,
    });
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Wraps async exports to handle errors properly
   */
  function wrapAsync(fn) {
    return async (...args) => {
      try {
        if (!isReady) {
          throw new Error(
            "PocketBase client not ready yet - wait for isReady() to return true",
          );
        }
        return await fn(...args);
      } catch (error) {
        // Don't log 404 errors - they're expected when checking if records exist
        if (error.status !== 404) {
          clientLogger.error(`${fn.name}: ${error.message}`);
        }
        throw error;
      }
    };
  }

  /**
   * Register a callback to be called when client is ready
   */
  function onReady(callback) {
    if (isReady) {
      callback();
    } else {
      readyCallbacks.push(callback);
    }
  }

  // ============================================================================
  // Internal Authentication (No exports - auto-authenticated as superuser)
  // ============================================================================
  // The client automatically authenticates as superuser on startup
  // Other resources should NOT attempt to re-authenticate

  // ============================================================================
  // Record CRUD Exports
  // ============================================================================

  /**
   * Get a list of records
   * @export
   */
  exports(
    "getList",
    wrapAsync(async (collection, page = 1, perPage = 30, options = {}) => {
      const result = await pb
        .collection(collection)
        .getList(page, perPage, options);
      return {
        page: result.page,
        perPage: result.perPage,
        totalItems: result.totalItems,
        totalPages: result.totalPages,
        items: result.items,
      };
    }),
  );

  /**
   * Get all records (paginated automatically)
   * @export
   */
  exports(
    "getFullList",
    wrapAsync(async (collection, options = {}) => {
      const items = await pb.collection(collection).getFullList(options);
      return items;
    }),
  );

  /**
   * Get a single record by ID
   * @export
   */
  exports(
    "getOne",
    wrapAsync(async (collection, id, options = {}) => {
      return await pb.collection(collection).getOne(id, options);
    }),
  );

  /**
   * Get first record matching filter
   * @export
   */
  exports(
    "getFirstListItem",
    wrapAsync(async (collection, filter, options = {}) => {
      return await pb.collection(collection).getFirstListItem(filter, options);
    }),
  );

  /**
   * Create a new record
   * @export
   */
  exports(
    "create",
    wrapAsync(async (collection, data, options = {}) => {
      return await pb.collection(collection).create(data, options);
    }),
  );

  /**
   * Update a record
   * @export
   */
  exports(
    "update",
    wrapAsync(async (collection, id, data, options = {}) => {
      return await pb.collection(collection).update(id, data, options);
    }),
  );

  /**
   * Delete a record
   * @export
   */
  exports(
    "delete",
    wrapAsync(async (collection, id, options = {}) => {
      return await pb.collection(collection).delete(id, options);
    }),
  );

  // ============================================================================
  // Realtime Subscriptions
  // ============================================================================

  const subscriptions = new Map();

  /**
   * Subscribe to realtime changes
   * @export
   */
  exports(
    "subscribe",
    wrapAsync(async (collection, topic, callbackRef) => {
      const callback = (data) => {
        // Emit to a FiveM event that the script can listen to
        emit(`pocketbase:${collection}:${topic}`, data);

        // Also call the callback if provided
        if (callbackRef && typeof callbackRef === "function") {
          callbackRef(data);
        }
      };

      const unsubscribe = await pb
        .collection(collection)
        .subscribe(topic, callback);

      const subKey = `${collection}:${topic}`;
      subscriptions.set(subKey, unsubscribe);

      return true;
    }),
  );

  /**
   * Unsubscribe from realtime changes
   * @export
   */
  exports(
    "unsubscribe",
    wrapAsync(async (collection, topic = null) => {
      if (topic) {
        const subKey = `${collection}:${topic}`;
        const unsubscribe = subscriptions.get(subKey);
        if (unsubscribe) {
          await unsubscribe();
          subscriptions.delete(subKey);
        }
      } else {
        await pb.collection(collection).unsubscribe();
        // Remove all subscriptions for this collection
        for (const [key, unsubscribe] of subscriptions.entries()) {
          if (key.startsWith(`${collection}:`)) {
            subscriptions.delete(key);
          }
        }
      }
      return true;
    }),
  );

  // ============================================================================
  // File Helpers
  // ============================================================================

  /**
   * Get URL for a file
   * @export
   */
  exports("getFileUrl", (record, filename, options = {}) => {
    return pb.files.getURL(record, filename, options);
  });

  /**
   * Get file token for protected files
   * @export
   */
  exports(
    "getFileToken",
    wrapAsync(async (options = {}) => {
      return await pb.files.getToken(options);
    }),
  );

  // ============================================================================
  // Filter Helper
  // ============================================================================

  /**
   * Build filter string with parameter substitution
   * @export
   */
  exports("filter", (rawFilter, params = {}) => {
    return pb.filter(rawFilter, params);
  });

  // ============================================================================
  // Collections Management
  // ============================================================================

  /**
   * Get all collections
   * @export
   */
  exports(
    "getCollections",
    wrapAsync(async (options = {}) => {
      return await pb.collections.getFullList(options);
    }),
  );

  /**
   * Get collection by ID or name
   * @export
   */
  exports(
    "getCollection",
    wrapAsync(async (idOrName, options = {}) => {
      return await pb.collections.getOne(idOrName, options);
    }),
  );

  /**
   * Create a new collection
   * @export
   */
  exports(
    "createCollection",
    wrapAsync(async (data, options = {}) => {
      return await pb.collections.create(data, options);
    }),
  );

  /**
   * Update a collection
   * @export
   */
  exports(
    "updateCollection",
    wrapAsync(async (idOrName, data, options = {}) => {
      return await pb.collections.update(idOrName, data, options);
    }),
  );

  /**
   * Delete a collection
   * @export
   */
  exports(
    "deleteCollection",
    wrapAsync(async (idOrName, options = {}) => {
      return await pb.collections.delete(idOrName, options);
    }),
  );

  // ============================================================================
  // Health Check
  // ============================================================================

  /**
   * Check PocketBase health
   * @export
   */
  exports(
    "healthCheck",
    wrapAsync(async () => {
      return await pb.health.check();
    }),
  );

  /**
   * Check if client is ready (connected AND authenticated)
   * @export
   */
  exports("isReady", () => {
    return isReady;
  });

  /**
   * Register callback to be called when client is ready
   * @export
   */
  exports("onReady", (callback) => {
    onReady(callback);
  });

  /**
   * Check if authenticated (may be ready but not authenticated)
   * @export
   */
  exports("isClientAuthenticated", () => {
    return isAuthenticated;
  });

  /**
   * Get PocketBase URL
   * @export
   */
  exports("getUrl", () => {
    return pbUrl;
  });

  // ============================================================================
  // Auth Collection Methods (for user authentication, NOT superuser)
  // ============================================================================

  /**
   * List available auth methods for a collection
   * @export
   */
  exports(
    "listAuthMethods",
    wrapAsync(async (collection, options = {}) => {
      return await pb.collection(collection).listAuthMethods(options);
    }),
  );

  /**
   * Authenticate with password (for user collections)
   * @export
   */
  const authCollectionWithPassword = wrapAsync(
    async (collection, usernameOrEmail, password, options = {}) => {
      const result = await pb
        .collection(collection)
        .authWithPassword(usernameOrEmail, password, options);
      return {
        token: result.token,
        record: result.record,
      };
    },
  );

  exports("authCollectionWithPassword", authCollectionWithPassword);
  exports("authWithPassword", authCollectionWithPassword); // Shorter alias

  /**
   * Authenticate with OTP
   * @export
   */
  exports(
    "authWithOTP",
    wrapAsync(async (collection, otpId, password, options = {}) => {
      const result = await pb
        .collection(collection)
        .authWithOTP(otpId, password, options);
      return {
        token: result.token,
        record: result.record,
      };
    }),
  );

  /**
   * Authenticate with OAuth2 code
   * @export
   */
  exports(
    "authWithOAuth2Code",
    wrapAsync(
      async (
        collection,
        provider,
        code,
        codeVerifier,
        redirectUrl,
        createData = {},
        options = {},
      ) => {
        const result = await pb
          .collection(collection)
          .authWithOAuth2Code(
            provider,
            code,
            codeVerifier,
            redirectUrl,
            createData,
            options,
          );
        return {
          token: result.token,
          record: result.record,
          meta: result.meta,
        };
      },
    ),
  );

  /**
   * Refresh auth token for a collection
   * @export
   */
  const authRefreshCollection = wrapAsync(async (collection, options = {}) => {
    const result = await pb.collection(collection).authRefresh(options);
    return {
      token: result.token,
      record: result.record,
    };
  });

  exports("authRefreshCollection", authRefreshCollection);
  exports("authRefresh", authRefreshCollection); // Shorter alias

  /**
   * Request OTP for a collection
   * @export
   */
  exports(
    "requestOTP",
    wrapAsync(async (collection, email, options = {}) => {
      return await pb.collection(collection).requestOTP(email, options);
    }),
  );

  /**
   * Request password reset
   * @export
   */
  exports(
    "requestPasswordReset",
    wrapAsync(async (collection, email, options = {}) => {
      return await pb
        .collection(collection)
        .requestPasswordReset(email, options);
    }),
  );

  /**
   * Confirm password reset
   * @export
   */
  exports(
    "confirmPasswordReset",
    wrapAsync(
      async (collection, token, password, passwordConfirm, options = {}) => {
        return await pb
          .collection(collection)
          .confirmPasswordReset(token, password, passwordConfirm, options);
      },
    ),
  );

  /**
   * Request verification email
   * @export
   */
  exports(
    "requestVerification",
    wrapAsync(async (collection, email, options = {}) => {
      return await pb
        .collection(collection)
        .requestVerification(email, options);
    }),
  );

  /**
   * Confirm email verification
   * @export
   */
  exports(
    "confirmVerification",
    wrapAsync(async (collection, token, options = {}) => {
      return await pb
        .collection(collection)
        .confirmVerification(token, options);
    }),
  );

  /**
   * Request email change
   * @export
   */
  exports(
    "requestEmailChange",
    wrapAsync(async (collection, newEmail, options = {}) => {
      return await pb
        .collection(collection)
        .requestEmailChange(newEmail, options);
    }),
  );

  /**
   * Confirm email change
   * @export
   */
  exports(
    "confirmEmailChange",
    wrapAsync(async (collection, token, password, options = {}) => {
      return await pb
        .collection(collection)
        .confirmEmailChange(token, password, options);
    }),
  );

  /**
   * List external auth providers for a record
   * @export
   */
  exports(
    "listExternalAuths",
    wrapAsync(async (collection, recordId, options = {}) => {
      return await pb
        .collection(collection)
        .listExternalAuths(recordId, options);
    }),
  );

  /**
   * Unlink external auth provider
   * @export
   */
  exports(
    "unlinkExternalAuth",
    wrapAsync(async (collection, recordId, provider, options = {}) => {
      return await pb
        .collection(collection)
        .unlinkExternalAuth(recordId, provider, options);
    }),
  );

  // ============================================================================
  // Batch Operations
  // ============================================================================

  /**
   * Create a new batch instance for bulk operations
   * Returns a table with _requests that can be passed to batch functions
   * @export
   */
  exports("batch", () => {
    return {
      _batchId: Math.random().toString(36).substr(2, 9),
      _requests: [],
    };
  });

  /**
   * Add create request to batch
   * @export
   */
  exports("batchCreate", (batchData, collection, data, options = {}) => {
    batchData._requests.push({ type: "create", collection, data, options });
    return batchData;
  });

  /**
   * Add update request to batch
   * @export
   */
  exports("batchUpdate", (batchData, collection, id, data, options = {}) => {
    batchData._requests.push({ type: "update", collection, id, data, options });
    return batchData;
  });

  /**
   * Add delete request to batch
   * @export
   */
  exports("batchDelete", (batchData, collection, id, options = {}) => {
    batchData._requests.push({ type: "delete", collection, id, options });
    return batchData;
  });

  /**
   * Add upsert request to batch
   * @export
   */
  exports("batchUpsert", (batchData, collection, data, options = {}) => {
    batchData._requests.push({ type: "upsert", collection, data, options });
    return batchData;
  });

  /**
   * Execute batch requests
   * @export
   */
  exports(
    "batchSend",
    wrapAsync(async (batchData) => {
      const batch = pb.createBatch();

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

      try {
        return await batch.send();
      } catch (error) {
        if (
          error.message &&
          error.message.includes("Batch requests are not allowed")
        ) {
          clientLogger.error(
            "Batch API is disabled. Enable it in PocketBase Admin > Settings > Batch API",
          );
        }
        throw error;
      }
    }),
  );

  // ============================================================================
  // Realtime Service (Custom Topics)
  // ============================================================================

  /**
   * Subscribe to a custom realtime topic
   * @export
   */
  exports(
    "subscribeToTopic",
    wrapAsync(async (topic, callbackRef) => {
      const callback = (data) => {
        // Emit to a FiveM event
        emit(`pocketbase:topic:${topic}`, data);

        // Also call the callback if provided
        if (callbackRef && typeof callbackRef === "function") {
          callbackRef(data);
        }
      };

      const unsubscribe = await pb.realtime.subscribe(topic, callback);

      const subKey = `topic:${topic}`;
      subscriptions.set(subKey, unsubscribe);

      return true;
    }),
  );

  /**
   * Unsubscribe from a custom topic
   * @export
   */
  exports(
    "unsubscribeFromTopic",
    wrapAsync(async (topic) => {
      const subKey = `topic:${topic}`;
      const unsubscribe = subscriptions.get(subKey);
      if (unsubscribe) {
        await unsubscribe();
        subscriptions.delete(subKey);
      } else {
        await pb.realtime.unsubscribe(topic);
      }
      return true;
    }),
  );

  /**
   * Unsubscribe from all topics with a prefix
   * @export
   */
  exports(
    "unsubscribeByPrefix",
    wrapAsync(async (topicPrefix) => {
      await pb.realtime.unsubscribeByPrefix(topicPrefix);

      // Clean up from our subscriptions map
      for (const [key] of subscriptions.entries()) {
        if (key.startsWith(`topic:${topicPrefix}`)) {
          subscriptions.delete(key);
        }
      }
      return true;
    }),
  );

  /**
   * Check if realtime connection is active
   * @export
   */
  exports("isRealtimeConnected", () => {
    return pb.realtime.isConnected;
  });

  // ============================================================================
  // Collection Advanced Operations
  // ============================================================================

  /**
   * Delete all records in a collection
   * @export
   */
  exports(
    "truncateCollection",
    wrapAsync(async (collectionIdOrName, options = {}) => {
      return await pb.collections.truncate(collectionIdOrName, options);
    }),
  );

  /**
   * Import collections
   * @export
   */
  exports(
    "importCollections",
    wrapAsync(async (collections, deleteMissing = false, options = {}) => {
      return await pb.collections.import(collections, deleteMissing, options);
    }),
  );

  /**
   * Get collection scaffolds (templates)
   * @export
   */
  exports(
    "getCollectionScaffolds",
    wrapAsync(async (options = {}) => {
      return await pb.collections.getScaffolds(options);
    }),
  );

  // ============================================================================
  // Migration Helpers
  // ============================================================================

  /**
   * Create a migration helper that can be used in pb_migrations/*.js files
   * This returns a helper object for creating collections programmatically
   * @export
   */
  exports("createMigrationHelper", () => {
    return {
      // Helper to create a basic collection structure
      createCollectionConfig: (name, type, fields, options = {}) => {
        return {
          name: name,
          type: type || "base",
          fields: fields,
          listRule: options.listRule,
          viewRule: options.viewRule,
          createRule: options.createRule,
          updateRule: options.updateRule,
          deleteRule: options.deleteRule,
          indexes: options.indexes || [],
        };
      },

      // Helper to create field definitions
      createField: (name, type, options = {}) => {
        return {
          name: name,
          type: type,
          required: options.required || false,
          max: options.max || 0,
          min: options.min,
          pattern: options.pattern,
          presentable: options.presentable,
          options: options.fieldOptions || {},
        };
      },
    };
  });

  // ============================================================================
  // Internal Admin API Methods (not exported, used by server.js)
  // ============================================================================

  /**
   * Internal: Get all settings
   */
  global.pbInternalGetSettings = wrapAsync(async () => {
    return await pb.settings.getAll();
  });

  /**
   * Internal: Update settings
   */
  global.pbInternalUpdateSettings = wrapAsync(async (settings) => {
    return await pb.settings.update(settings);
  });

  /**
   * Internal: List all backups
   */
  global.pbInternalListBackups = wrapAsync(async () => {
    return await pb.backups.getFullList();
  });

  /**
   * Internal: Create backup
   */
  global.pbInternalCreateBackup = wrapAsync(async (basename = "") => {
    return await pb.backups.create(basename);
  });

  /**
   * Internal: Delete backup
   */
  global.pbInternalDeleteBackup = wrapAsync(async (key) => {
    return await pb.backups.delete(key);
  });

  /**
   * Internal: Restore from backup
   */
  global.pbInternalRestoreBackup = wrapAsync(async (key) => {
    return await pb.backups.restore(key);
  });

  // ============================================================================
  // Cleanup
  // ============================================================================
  on("onResourceStop", (resource) => {
    if (resource === resourceName) {
      for (const [key, unsubscribe] of subscriptions.entries()) {
        try {
          unsubscribe();
        } catch (err) {
          // Silent cleanup
        }
      }
      subscriptions.clear();
    }
  });
})();
