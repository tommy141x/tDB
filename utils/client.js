/**
 * PocketBase FiveM Client
 */
(function () {
  const fs = require("fs");
  const path = require("path");
  const PocketBase = require("./bin/pocketbase.cjs.js");
  const configLoader = require("./utils/config-loader.js");
  const {
    AuthManager,
    isAuthError,
    ensureSuperuserTokenDuration,
  } = require("./utils/auth-manager.js");
  const PocketBaseAdapter = require("./adapters/pocketbase.js");
  const OxMySQLAdapter = require("./adapters/oxmysql.js");
  const httpTransport = require("./utils/http-transport.js");
  const sqlImport = require("./utils/sql-import.js");

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
  // Log Throttling
  // ============================================================================
  // A script polling on a timer turns one persistent fault into hundreds of
  // identical console lines per minute, which buries whatever else the server
  // is trying to tell you. Identical messages collapse into a periodic line
  // carrying the suppressed count instead.
  const LOG_THROTTLE_WINDOW_MS = 60 * 1000;
  const throttleState = new Map();

  function logThrottled(level, key, message) {
    const now = Date.now();
    const entry = throttleState.get(key);

    if (!entry || now - entry.lastLoggedAt >= LOG_THROTTLE_WINDOW_MS) {
      const suppressed = entry ? entry.suppressed : 0;
      throttleState.set(key, { lastLoggedAt: now, suppressed: 0 });

      clientLogger[level](
        suppressed > 0
          ? `${message} ^8(repeated ${suppressed} more time${suppressed === 1 ? "" : "s"} in the last minute)^7`
          : message,
      );
      return;
    }

    entry.suppressed++;
  }

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

  // Whether we are talking to somebody else's instance. Gates the settings we
  // are only entitled to change on an instance this resource starts itself.
  let isRemoteMode = false;

  // Owns the superuser token lifecycle once the server reports ready.
  let authManager = null;

  // Kept at module scope so the SQL importer can reach the translation and
  // batch paths before the exports are open for business.
  let oxmysqlAdapter = null;

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
   * Wraps async exports so that every call gets consistent readiness checks,
   * transparent recovery from an expired superuser session, and non-spammy
   * error reporting.
   *
   * @param {function} fn The operation to run.
   * @param {string} [label] Name used in error messages. Most callers pass an
   *   anonymous arrow, whose `fn.name` is "" - that is why the original error
   *   lines read as "[PocketBase Client] : <message>" with nothing before the
   *   colon.
   */
  function wrapAsync(fn, label) {
    const name = label || fn.name || "request";

    return async (...args) => {
      if (!isReady || !pb) {
        throw new Error(
          "PocketBase client not ready yet - wait for isReady() to return true",
        );
      }

      try {
        return await fn(...args);
      } catch (error) {
        // A 401/403 here usually means the superuser token expired rather
        // than that the caller did anything wrong. Re-authenticate once and
        // replay the call; only a second failure is a real error.
        if (isAuthError(error) && authManager) {
          const recovered = await authManager.ensureAuthenticated(true);

          if (recovered) {
            try {
              return await fn(...args);
            } catch (retryError) {
              return handleCallError(retryError, name);
            }
          }
        }

        return handleCallError(error, name);
      }
    };
  }

  /**
   * Log an export failure once per throttle window, then rethrow it so the
   * caller still sees the failure.
   */
  function handleCallError(error, name) {
    // 404 is a normal answer to "does this record exist?", not a fault.
    if (error.status !== 404) {
      logThrottled(
        "error",
        `${name}:${error.status || 0}:${error.message}`,
        `${name}: ${error.message}`,
      );
    }
    throw error;
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
    // Report the live session state, not just the outcome of the initial
    // login - the token is refreshed on a timer and can lapse and recover.
    return authManager ? authManager.isAuthenticated : isAuthenticated;
  });

  /**
   * Get PocketBase URL
   * @export
   */
  exports("getUrl", () => {
    return pbUrl;
  });

  /**
   * Wait for connection to be ready (OxMySQL compatibility)
   * Returns a promise that resolves when the client is ready
   * @export
   */
  exports("awaitConnection", () => {
    return new Promise((resolve) => {
      if (isReady) {
        resolve(true);
      } else {
        onReady(() => resolve(true));
      }
    });
  });

  /**
   * Authenticate and hand the session to the AuthManager, which keeps the
   * token refreshed for as long as the resource runs.
   */
  const tryAuthenticate = async (credentials) => {
    authManager = new AuthManager(
      pb,
      credentials || config.Superuser,
      clientLogger,
    );

    isAuthenticated = await authManager.start();

    if (isAuthenticated) await applyManagedTokenLifetime();

    // Before readiness, deliberately. Anything waiting on awaitConnection -
    // which is every well-behaved consumer - then finds the schema already
    // there, and a script that ships a .sql file never races its own tables.
    if (isAuthenticated) await runSqlImports();

    notifyReady();
  };

  // Imports run once per resource start. A re-auth rebuilds the session, not
  // the database.
  let sqlImportsDone = false;

  const runSqlImports = async () => {
    if (sqlImportsDone || !config.Sql.Enabled || !oxmysqlAdapter) return;
    sqlImportsDone = true;

    const dir = path.isAbsolute(config.Sql.Dir)
      ? config.Sql.Dir
      : path.join(resourcePath, config.Sql.Dir);

    try {
      const summary = await sqlImport.run(oxmysqlAdapter, dir, clientLogger, {
        onChanged: config.Sql.OnChanged,
      });

      if (summary.applied.length) {
        clientLogger.info(
          `SQL import: applied ${summary.applied.length} file(s) - ${summary.applied.join(", ")}`,
        );
      }
      if (summary.failed.length) {
        clientLogger.error(
          `SQL import: ${summary.failed.length} file(s) FAILED and were rolled back - ` +
            `${summary.failed.join(", ")}. Fix them and restart; see 'tdb sql status'.`,
        );
      }
    } catch (error) {
      // Never take the resource down over an import. A dump that cannot be
      // read is something to go and fix, with the server still up.
      clientLogger.error(`SQL import could not run: ${error.message}`);
    }
  };

  /**
   * On a local instance, make sure the superuser token lifetime has not been
   * left at some very short value before settling into the refresh loop.
   * Normally a no-op - PocketBase's default already clears the floor. A remote
   * instance is left exactly as its owner configured it.
   */
  const applyManagedTokenLifetime = async () => {
    if (isRemoteMode) return;

    const changed = await ensureSuperuserTokenDuration(pb, clientLogger, () =>
      authManager.ensureAuthenticated(true),
    );

    // The token already in hand was minted under the old duration, so trade
    // it in - otherwise the refresh timer is scheduled against the short one.
    if (changed) await authManager.ensureAuthenticated(true);
  };

  // Event-driven startup: Listen for server ready event
  on("pocketbase:server:ready", async (data) => {
    // Initialize PocketBase client with the correct URL (local or remote)
    isRemoteMode = Boolean(data.isRemote);

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

    // The SDK defaults to auto-cancellation: it keys each request by method
    // and path, and a second request with the same key ABORTS the first. That
    // is a browser feature - a search box superseding its own in-flight
    // request - and it is actively wrong here. On a game server, two players
    // hitting one code path in the same tick is the normal case, and the
    // loser gets "The request was autocancelled" instead of their data.
    // Measured before this line existed: 5 of 6 concurrent identical calls
    // were cancelled (.dev/autocancel.test.js).
    //
    // Only one of the adapters' ~31 SDK call sites passed requestKey: null,
    // so this is set once on the client rather than trusting every site to
    // remember.
    pb.autoCancellation(false);

    // Send over node:http instead of the global fetch. In FiveM's Node
    // (v26.3.0) every fetch carrying a request body leaks an unhandled
    // "Invalid state: Reader released" rejection - and every query this
    // resource serves is a POST with a body. See utils/http-transport.js for
    // the measurements.
    httpTransport.install(pb);

    // Initialize export router with the exports function
    const router = new ExportRouter(exports);

    // Register adapters after PocketBase is initialized
    const pbAdapter = new PocketBaseAdapter(pb, wrapAsync, clientLogger);
    oxmysqlAdapter = new OxMySQLAdapter(pb, wrapAsync, clientLogger);

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
      "awaitConnection",
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

  /**
   * Re-authenticate after the server side repairs the superuser account.
   *
   * Only the session is rebuilt - the client, adapters and exports stay as they
   * are, and the previous manager is stopped so its refresh timer is not leaked.
   */
  on("pocketbase:server:reauth", async (data) => {
    if (!pb) return;

    if (authManager) {
      authManager.stop();
      authManager = null;
    }

    // Prefer the credentials the server just provisioned; the local config
    // cache can predate that rewrite.
    const credentials =
      data && data.email && data.password
        ? { Email: data.email, Password: data.password }
        : config.Superuser;

    await tryAuthenticate(credentials);

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
  // Console commands
  // ============================================================================

  /**
   * `tdb sql status`            what has been imported, and what is pending
   * `tdb sql import <file>`     apply one file now
   * `tdb sql import <file> --force`  apply it again even if it already ran
   *
   * Server console only - these read and write the database.
   */
  RegisterCommand(
    "tdb",
    async (source, args) => {
      const say = (line) => console.log(`^2[tDB]^7 ${line}`);

      if (source !== 0) return; // console only, never a player

      if (args[0] !== "sql" || !args[1]) {
        say("usage: tdb sql status | tdb sql import <file> [--force]");
        return;
      }

      if (!isReady || !oxmysqlAdapter) {
        say("not ready yet - wait for the startup banner");
        return;
      }

      const dir = path.isAbsolute(config.Sql.Dir)
        ? config.Sql.Dir
        : path.join(resourcePath, config.Sql.Dir);

      try {
        if (args[1] === "status") {
          await sqlImport.ensureLedger(oxmysqlAdapter);
          const ledger = await sqlImport.readLedger(oxmysqlAdapter);
          const onDisk = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".sql")).sort()
            : [];

          say(`sql folder: ${dir}`);
          if (!onDisk.length && !ledger.size) {
            say("nothing imported, and no .sql files waiting");
            return;
          }

          for (const filename of onDisk) {
            const row = ledger.get(filename);
            if (!row) {
              say(`  PENDING   ${filename}`);
              continue;
            }
            const current = sqlImport.checksum(
              fs.readFileSync(path.join(dir, filename), "utf8"),
            );
            const drift = current === row.checksum ? "" : "  ^3(file changed since)^7";
            const detail =
              row.status === "applied"
                ? `${row.statements} statement(s), ${row.duration_ms}ms`
                : row.error;
            say(`  ${row.status.toUpperCase().padEnd(9)} ${filename}  ${detail}${drift}`);
          }

          // Rows whose file is gone still matter - that is the history.
          for (const [filename, row] of ledger) {
            if (onDisk.includes(filename)) continue;
            say(`  ${row.status.toUpperCase().padEnd(9)} ${filename}  ^8(file no longer present)^7`);
          }
          return;
        }

        if (args[1] === "import") {
          const filename = args[2];
          if (!filename) {
            say("usage: tdb sql import <file> [--force]");
            return;
          }
          const force = args.includes("--force");

          if (!fs.existsSync(path.join(dir, filename))) {
            say(`no such file: ${path.join(dir, filename)}`);
            return;
          }

          const summary = await sqlImport.run(oxmysqlAdapter, dir, clientLogger, {
            onChanged: force ? "apply" : config.Sql.OnChanged,
            only: [filename],
            force,
          });

          if (summary.applied.length) say(`applied ${filename}`);
          else if (summary.failed.length) say(`FAILED ${filename} - rolled back, nothing applied`);
          else if (summary.changed.length) say(`${filename} changed since it ran; use --force to re-apply`);
          else say(`${filename} was already applied; use --force to re-apply`);
          return;
        }

        say("usage: tdb sql status | tdb sql import <file> [--force]");
      } catch (error) {
        say(`^1command failed: ${error.message}^7`);
      }
    },
    // Restricted, so it is gated on the `command.tdb` ACE. The live server
    // console holds every ACE and runs it fine. Another resource calling
    // ExecuteCommand does not, and FiveM denies it silently - no output, no
    // "access denied" line, the handler simply never runs. If you want to
    // drive this from a script or an admin tool, grant it:
    //   add_ace resource.<that_resource> command.tdb allow
    true,
  );

  // ============================================================================
  // Cleanup
  // ============================================================================
  // Note: Subscriptions are automatically cleaned up when the WebSocket connection
  // closes on resource stop. The auth refresh timer is ours though, and has to
  // be cancelled explicitly or it will keep firing against a dead client.
  on("onResourceStop", (stoppedResource) => {
    if (stoppedResource !== resourceName) return;

    if (authManager) {
      authManager.stop();
    }
  });
})();
