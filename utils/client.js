/**
 * PocketBase FiveM Client
 */
(function () {
  const PocketBase = require("./bin/pocketbase.cjs.js");
  const configLoader = require("./utils/config-loader.js");
  const { retryWithBackoff } = require("./utils/process-utils.js");
  const PocketBaseAdapter = require("./adapters/pocketbase.js");
  const OxMySQLAdapter = require("./adapters/oxmysql.js");

  // ============================================================================
  // Export Router - Routes export calls to appropriate adapters
  // ============================================================================

  class ExportRouter {
    constructor(exportsFn) {
      this.adapters = [];
      this.exportNames = new Set();
      this.exportsFn = exportsFn;
    }

    registerAdapter(adapter, priority = 100) {
      if (!adapter.canHandle || typeof adapter.canHandle !== "function") {
        throw new Error(
          "Adapter must implement canHandle(exportName, args) method",
        );
      }
      if (!adapter.handle || typeof adapter.handle !== "function") {
        throw new Error(
          "Adapter must implement handle(exportName, args) method",
        );
      }
      if (!adapter.name) {
        throw new Error("Adapter must have a name property");
      }

      this.adapters.push({ adapter, priority });
      this.adapters.sort((a, b) => a.priority - b.priority);

      clientLogger.info(
        `Registered adapter: ${adapter.name} (priority: ${priority})`,
      );
    }

    registerExports(exportNames) {
      for (const exportName of exportNames) {
        this.createExport(exportName);
      }
    }

    createExport(exportName) {
      if (this.exportNames.has(exportName)) {
        clientLogger.warn(
          `Export '${exportName}' already registered, skipping...`,
        );
        return;
      }

      this.exportNames.add(exportName);
      const router = this;

      this.exportsFn(exportName, function (...args) {
        for (const { adapter } of router.adapters) {
          try {
            if (adapter.canHandle(exportName, args)) {
              return adapter.handle(exportName, args);
            }
          } catch (error) {
            clientLogger.error(
              `Error in adapter '${adapter.name}' for export '${exportName}':`,
              error,
            );
            throw error;
          }
        }
        throw new Error(
          `No adapter could handle export '${exportName}' with arguments: ${JSON.stringify(args.slice(0, 2))}...`,
        );
      });
    }
  }

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

  // Determine PocketBase URL - will be set based on server mode (local or remote)
  let pbUrl = null;
  let pb = null;

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

  /**
   * Wraps async exports to handle errors properly
   */
  function wrapAsync(fn) {
    return async (...args) => {
      try {
        if (!isReady || !pb) {
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
  // State Exports - Available Immediately
  // ============================================================================

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
    // Initialize PocketBase client with the correct URL (local or remote)
    if (data.isRemote) {
      // Remote mode - connect to remote URL
      pbUrl = data.url;
      clientLogger.debug(`Connecting to remote PocketBase at ${pbUrl}`);
    } else {
      // Local mode - connect to localhost
      pbUrl = `http://127.0.0.1:${config.Port}`;
    }

    // Create PocketBase instance with the determined URL
    pb = new PocketBase(pbUrl);

    // Initialize export router with the exports function
    const router = new ExportRouter(exports);

    // Register adapters after PocketBase is initialized
    const pbAdapter = new PocketBaseAdapter(pb, wrapAsync, clientLogger);
    const oxmysqlAdapter = new OxMySQLAdapter(pb, wrapAsync, clientLogger);

    // Register adapters with priority (lower = higher priority)
    // PocketBase has priority 10 (checked first)
    // OxMySQL has priority 20 (checked second, fallback)
    router.registerAdapter(pbAdapter, 10);
    router.registerAdapter(oxmysqlAdapter, 20);

    // Automatically register all exports from adapters (excluding state exports)
    const allExportNames = new Set();
    const stateExports = [
      "isReady",
      "onReady",
      "isClientAuthenticated",
      "getUrl",
    ];

    pbAdapter.supportedExports.forEach((name) => {
      if (!stateExports.includes(name)) {
        allExportNames.add(name);
      }
    });
    oxmysqlAdapter.supportedExports.forEach((name) => allExportNames.add(name));

    // Register all collected exports
    router.registerExports(Array.from(allExportNames));

    await tryAuthenticate();

    // Emit client status back to server
    emit("pocketbase:client:ready", {
      authenticated: isAuthenticated,
    });
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
  // Note: Subscriptions are automatically cleaned up when the WebSocket connection
  // closes on resource stop. No explicit cleanup needed.
})();
