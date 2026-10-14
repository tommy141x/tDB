// The client half: owns the PocketBase SDK instance, the adapters behind the
// exports, and the superuser session.
(function () {
  const fs = require("fs");
  const path = require("path");
  const PocketBase = require("./server/vendor/pocketbase.cjs.js");
  const configLoader = require("./server/utils/config-loader.js");
  const {
    AuthManager,
    isAuthError,
    ensureSuperuserTokenDuration,
  } = require("./server/utils/auth-manager.js");
  const PocketBaseAdapter = require("./server/adapters/pocketbase.js");
  const OxMySQLAdapter = require("./server/adapters/oxmysql.js");
  const httpTransport = require("./server/utils/http-transport.js");
  const sqlImport = require("./server/utils/sql-import.js");
  const pbAdopt = require("./server/utils/pb-adopt.js");
  const { describeRouteError } = require("./server/utils/route-error.js");

  const ExportRouter = require("./server/utils/export-router.js");

  // The SDK's realtime subscriptions need it and Node does not have one.
  if (typeof EventSource === "undefined") {
    const EventSourcePolyfill = require("./server/vendor/eventsource.min.js");
    global.EventSource = EventSourcePolyfill.EventSourcePolyfill || EventSourcePolyfill;
  }

  // `debug` is filtered, the other levels are not - same contract and same
  // `Config.Debug` as the `[PocketBase]` logger in server.js. Assigned below
  // where the config is read, so anything logged before then stays filtered.
  let debugEnabled = false;

  const clientLogger = {
    info: (msg) => console.log(`^2[PocketBase Client]^7 ${msg}`),
    warn: (msg) => console.log(`^3[PocketBase Client]^7 ${msg}`),
    error: (msg) => console.log(`^1[PocketBase Client]^7 ${msg}`),
    debug: (msg) => {
      if (debugEnabled) console.log(`^5[PocketBase Client]^7 ${msg}`);
    },
    silent: () => {},
  };

  // A script polling on a timer turns one persistent fault into hundreds of
  // identical console lines a minute. Collapse repeats into one periodic line
  // carrying the suppressed count.
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
          : message
      );
      return;
    }

    entry.suppressed++;
  }

  const resourceName = GetCurrentResourceName();
  const resourcePath = GetResourcePath(resourceName);

  const config = configLoader.load(resourcePath);
  debugEnabled = config.Debug === true;

  // Set once the server announces its mode (local or remote).
  let pbUrl = null;
  let pb = null;

  // Somebody else's instance, so we are not entitled to change its settings.
  let isRemoteMode = false;

  let authManager = null;

  // Module scope so the SQL importer can reach the translation and batch paths
  // before the exports are open for business.
  let oxmysqlAdapter = null;

  let isReady = false;
  let isAuthenticated = false;
  const readyCallbacks = [];

  const notifyReady = () => {
    isReady = true;
    readyCallbacks.forEach((callback) => {
      callback();
    });
    readyCallbacks.length = 0;
  };

  // Readiness check, one transparent retry after a session expiry, throttled
  // error reporting. `label` matters because most callers pass an anonymous
  // arrow, whose `fn.name` is "", leaving errors with nothing before the colon.
  function wrapAsync(fn, label) {
    const name = label || fn.name || "request";

    return async (...args) => {
      if (!isReady || !pb) {
        throw new Error("PocketBase client not ready yet - wait for isReady() to return true");
      }

      try {
        return await fn(...args);
      } catch (error) {
        // A 401/403 usually means the superuser token expired, not that the
        // caller erred. Re-auth once and replay; only a second failure is real.
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

  // Logs once per throttle window, then rethrows so the caller still sees it.
  function handleCallError(error, name) {
    // 404 is a normal answer to "does this record exist?", not a fault.
    if (error.status !== 404) {
      logThrottled(
        "error",
        `${name}:${error.status || 0}:${error.message}`,
        `${name}: ${error.message}`
      );
    }
    throw error;
  }

  function onReady(callback) {
    if (isReady) {
      callback();
    } else {
      readyCallbacks.push(callback);
    }
  }

  // State exports, available before the adapters are wired up.

  exports("isReady", () => {
    return isReady;
  });

  exports("onReady", (callback) => {
    onReady(callback);
  });

  exports("isClientAuthenticated", () => {
    // Live session state, not the outcome of the initial login: the token is
    // refreshed on a timer and can lapse and recover.
    return authManager ? authManager.isAuthenticated : isAuthenticated;
  });

  exports("getUrl", () => {
    return pbUrl;
  });

  // oxmysql compatibility.
  const awaitConnection = () =>
    new Promise((resolve) => {
      if (isReady) {
        resolve(true);
      } else {
        onReady(() => resolve(true));
      }
    });

  exports("awaitConnection", awaitConnection);

  // oxmysql registers every method three times (`x`, `x_async`, `xSync`), and
  // that loop covers isReady and awaitConnection too. Scripts do call the
  // suffixed forms, so the plain name alone is not the whole contract.
  exports("awaitConnection_async", awaitConnection);
  exports("awaitConnectionSync", awaitConnection);
  exports("isReady_async", async () => isReady);
  exports("isReadySync", async () => isReady);

  // A dedicated connection held open across a caller-supplied callback, with
  // BEGIN/COMMIT around it. tDB reaches PocketBase over stateless HTTP and
  // PocketBase's own runInTransaction is scoped to one request, so there is
  // nothing to hold. Refused by name rather than left to read as a typo.
  const startTransactionUnsupported = () => {
    throw new Error(
      "tDB does not support startTransaction: it needs a connection held " +
        "across your callback, and tDB talks to PocketBase over stateless " +
        "HTTP. Use transaction(queries) or exports.tDB:runTransaction(ops), " +
        "which are atomic but need the statements up front."
    );
  };

  exports("startTransaction", startTransactionUnsupported);
  exports("startTransaction_async", startTransactionUnsupported);
  exports("startTransactionSync", startTransactionUnsupported);

  // Every data export is registered now, before PocketBase is up, because that
  // is when oxmysql has them and when ported scripts call them. A call landing
  // before the adapters exist waits on awaitConnection instead of failing.
  // Only the names are needed here, so neither adapter list touches a client.
  const router = new ExportRouter(exports, awaitConnection, clientLogger, on);

  const STATE_EXPORTS = new Set([
    "isReady",
    "onReady",
    "awaitConnection",
    "isClientAuthenticated",
    "getUrl",
  ]);

  const dataExportNames = new Set([
    ...OxMySQLAdapter.buildExportList(),
    ...PocketBaseAdapter.exportNames(),
  ]);

  for (const name of STATE_EXPORTS) dataExportNames.delete(name);

  router.registerExports(Array.from(dataExportNames));

  // And again under the names of the resources tDB replaces. `provide` in the
  // manifest does NOT alias exports - measured on a live server, where
  // `GetResourceState('oxmysql')` reported `started` while
  // `exports.oxmysql:scalar(...)` answered "No such export". Without this,
  // every script that was never ported to tDB fails, which is every script
  // this compatibility layer exists for.
  const aliased = OxMySQLAdapter.aliasedResources();
  for (const [resourceName, methods] of Object.entries(aliased)) {
    router.registerAliases(
      resourceName,
      methods.filter((name) => !STATE_EXPORTS.has(name))
    );
  }

  // Hands the session to AuthManager, which keeps the token refreshed for as
  // long as the resource runs.
  const tryAuthenticate = async (credentials) => {
    authManager = new AuthManager(pb, credentials || config.Superuser, clientLogger);

    isAuthenticated = await authManager.start();

    if (isAuthenticated) await applyManagedTokenLifetime();

    // Before readiness, deliberately: anything waiting on awaitConnection then
    // finds the schema already there and never races its own tables.
    if (isAuthenticated) await runSqlImports();

    notifyReady();

    // After readiness on purpose. A new view costs ~38ms, so a first run over a
    // freshly imported dump would otherwise delay every resource waiting on the
    // database. Idempotent, so later boots are a no-op.
    if (isAuthenticated) adoptTables();
  };

  // The ledger holds the statement that stopped each file, which is the one
  // thing that makes a failure actionable, so it travels with the filename.
  const reportSqlFailures = async (failedFiles) => {
    if (typeof global.tdbReportSqlFailures !== "function") return;

    const failures = [];
    try {
      const ledger = await sqlImport.readLedger(oxmysqlAdapter);
      for (const file of failedFiles || []) {
        const row = ledger.get(file);
        failures.push({ file, error: row ? row.error : null });
      }
    } catch (_) {
      // Without the ledger the filename alone is still worth surfacing.
      for (const file of failedFiles || []) failures.push({ file, error: null });
    }

    global.tdbReportSqlFailures(failures);
  };

  // Once per resource start. A re-auth rebuilds the session, not the database.
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
          `SQL import: applied ${summary.applied.length} file(s) - ${summary.applied.join(", ")}`
        );
      }
      if (summary.partial.length) {
        clientLogger.warn(
          `SQL import: ${summary.partial.length} file(s) applied with trigger(s) skipped - ` +
            `${summary.partial.join(", ")}. See 'tdb sql status'.`
        );
      }
      if (summary.failed.length) {
        clientLogger.error(
          `SQL import: ${summary.failed.length} file(s) FAILED and were rolled back - ` +
            `${summary.failed.join(", ")}. Fix them and restart; see 'tdb sql status'.`
        );
      }

      // Hand the outcome to the startup box, so a failure is a state the
      // operator cannot miss rather than one console line at boot. Reported
      // even when empty, which clears a previous failure after a fix.
      await reportSqlFailures(summary.failed);
    } catch (error) {
      // Never take the resource down over an import; an unreadable dump is
      // something to go and fix with the server still up.
      clientLogger.error(`SQL import could not run: ${error.message}`);
    }
  };

  const adoptDeps = () => ({
    query: (sql, params) => oxmysqlAdapter.handle("query", [sql, params || []]),
    exec: (sql, params) => oxmysqlAdapter.handle("update", [sql, params || []]),
    // No MySQL translation: used to put back triggers read out of sqlite_master,
    // which are already SQLite and would not survive being parsed as MySQL.
    rawExec: (sql) =>
      pb.send("/api/tdb/execute", {
        method: "POST",
        body: { sql, params: {} },
        requestKey: null,
      }),
    collections: {
      getFullList: () => pb.collections.getFullList({ requestKey: null }),
      getOne: (name) => pb.collections.getOne(name, { requestKey: null }),
      create: (data) => pb.collections.create(data),
      update: (id, data) => pb.collections.update(id, data),
      delete: (id) => pb.collections.delete(id),
    },
    logger: clientLogger,
  });

  // Hands raw tables to PocketBase so they appear as editable collections.
  //
  // This rewrites tables, so it takes a PocketBase backup first -- once, before
  // the first table is touched, not per table. Idempotent afterwards: a table
  // PocketBase already owns is not planned again, so a steady-state boot does
  // nothing. Failure never propagates; the database is usable either way.
  const adoptTables = async (announce) => {
    try {
      const planned = await pbAdopt.plan(adoptDeps());

      if (!planned.length) {
        if (announce) announce("every table is already a collection");
        return { adopted: [], failed: [], triggers: 0, unsupported: [] };
      }

      // Lowercase, and `.zip`. PocketBase validates the backup name against a
      // lowercase pattern, so an ISO timestamp's `T` and `Z` were rejected with
      // `name: Must be in a valid format` - which refused adoption on every
      // boot while reporting only PocketBase's generic validation message.
      // Measured: the same name lowercased is accepted, and the extension is
      // required.
      const backupName = `pre-adopt-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .toLowerCase()}.zip`;

      // Settled with .then(ok, err) rather than try/catch around an await: that
      // owns the rejection in the turn it is created, so FiveM cannot also
      // report it as unhandled and print the stack twice alongside the handled
      // log line.
      const backup = await pb.backups.create(backupName).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error })
      );

      if (!backup.ok) {
        // Without a backup this is not worth doing automatically. The field
        // detail matters: PocketBase's own message names nothing.
        clientLogger.error(
          `Refusing to adopt tables: the pre-adoption backup failed - ` +
            `${describeRouteError(backup.error)}`
        );
        return null;
      }

      clientLogger.info(
        `Backed up to ${backupName} before adopting ${planned.length} table(s); ` +
          `restore from Admin -> Backups if needed`
      );

      const summary = await pbAdopt.adopt(adoptDeps(), planned);

      clientLogger.info(`Admin UI collections: ${pbAdopt.describe(summary)}`);
      for (const failure of summary.failed) {
        clientLogger.warn(`Adoption: ${failure}`);
      }
      for (const note of summary.unsupported) {
        clientLogger.warn(`Adoption could not reproduce: ${note}`);
      }
      return summary;
    } catch (error) {
      clientLogger.warn(`Could not hand tables to PocketBase: ${error.message}`);
      return null;
    }
  };

  // Raise a very short superuser token lifetime to a sane floor before settling
  // into the refresh loop. A no-op on a stock instance, and never applied to a
  // remote one, which its owner configured.
  const applyManagedTokenLifetime = async () => {
    if (isRemoteMode) return;

    const changed = await ensureSuperuserTokenDuration(pb, clientLogger, () =>
      authManager.ensureAuthenticated(true)
    );

    // The token in hand was minted under the old duration, so trade it in, or
    // the refresh timer is scheduled against the short one.
    if (changed) await authManager.ensureAuthenticated(true);
  };

  on("pocketbase:server:ready", async (data) => {
    isRemoteMode = Boolean(data.isRemote);

    if (data.isRemote) {
      pbUrl = data.url;
      clientLogger.debug(`Connecting to remote PocketBase at ${pbUrl}`);
    } else {
      pbUrl = `http://127.0.0.1:${config.Port}`;
    }

    pb = new PocketBase(pbUrl);

    // The SDK keys each request by method and path and ABORTS the earlier one
    // on a collision. That is a browser affordance and it is wrong here: two
    // players hitting one code path in a tick is normal, and the loser gets
    // "The request was autocancelled" instead of their data. Measured at 5 of 6
    // concurrent identical calls cancelled (.dev/autocancel.test.js). Set on the
    // client because only one of the ~31 adapter call sites passed
    // requestKey: null.
    pb.autoCancellation(false);

    // node:http instead of the global fetch; see utils/http-transport.js.
    httpTransport.install(pb);

    const pbAdapter = new PocketBaseAdapter(pb, wrapAsync, clientLogger);
    oxmysqlAdapter = new OxMySQLAdapter(pb, wrapAsync, clientLogger);

    // Lower number wins, so PocketBase is tried first and oxmysql is the
    // fallback. The export names were registered at resource start; calls that
    // arrived before now are parked on whenReady() and dispatch from here.
    router.registerAdapter(pbAdapter, 10);
    router.registerAdapter(oxmysqlAdapter, 20);

    await tryAuthenticate();

    emit("pocketbase:client:ready", {
      authenticated: isAuthenticated,
    });
  });

  // Re-auth after the server repairs the superuser account. Only the session is
  // rebuilt; the old manager is stopped so its refresh timer is not leaked.
  on("pocketbase:server:reauth", async (data) => {
    if (!pb) return;

    if (authManager) {
      authManager.stop();
      authManager = null;
    }

    // The local config cache can predate the rewrite the server just made.
    const credentials =
      data && data.email && data.password
        ? { Email: data.email, Password: data.password }
        : config.Superuser;

    await tryAuthenticate(credentials);

    emit("pocketbase:client:ready", {
      authenticated: isAuthenticated,
    });
  });

  // Admin API for server.js. Globals rather than exports: the server half runs
  // in the same resource and must not go through the export router.
  global.pbInternalGetSettings = wrapAsync(async () => {
    return await pb.settings.getAll();
  });

  global.pbInternalUpdateSettings = wrapAsync(async (settings) => {
    return await pb.settings.update(settings);
  });

  global.pbInternalListBackups = wrapAsync(async () => {
    return await pb.backups.getFullList();
  });

  global.pbInternalCreateBackup = wrapAsync(async (basename = "") => {
    return await pb.backups.create(basename);
  });

  global.pbInternalDeleteBackup = wrapAsync(async (key) => {
    return await pb.backups.delete(key);
  });

  global.pbInternalRestoreBackup = wrapAsync(async (key) => {
    return await pb.backups.restore(key);
  });

  // tdb sql status             what has been imported, and what is pending
  // tdb sql import <file>      apply one file now
  // tdb sql import <file> --force   apply it again even if it already ran
  RegisterCommand(
    "tdb",
    async (source, args) => {
      const say = (line) => console.log(`^2[tDB]^7 ${line}`);
      const USAGE =
        "usage: tdb sql status | import <file> [--force] | tables [match] | " +
        "query <sql> | plan | adopt";

      if (source !== 0) return; // console only, never a player

      if (args[0] !== "sql" || !args[1]) {
        say(USAGE);
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
            ? fs
                .readdirSync(dir)
                .filter((f) => f.toLowerCase().endsWith(".sql"))
                .sort()
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
            const current = sqlImport.checksum(fs.readFileSync(path.join(dir, filename), "utf8"));
            const drift = current === row.checksum ? "" : "  ^3(file changed since)^7";
            const detail =
              row.status === "applied"
                ? `${row.statements} statement(s), ${row.duration_ms}ms`
                : row.status === "partial"
                  ? `${row.statements} statement(s), ${row.duration_ms}ms - ${row.error}`
                  : row.error;
            say(`  ${row.status.toUpperCase().padEnd(9)} ${filename}  ${detail}${drift}`);
          }

          // Rows whose file is gone are still history worth showing.
          for (const [filename, row] of ledger) {
            if (onDisk.includes(filename)) continue;
            say(
              `  ${row.status.toUpperCase().padEnd(9)} ${filename}  ^8(file no longer present)^7`
            );
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

          // A fix applied by hand has to clear the startup box's failure state,
          // or it keeps reporting a problem the operator has already solved.
          const stillFailing = await sqlImport.readLedger(oxmysqlAdapter);
          const unresolved = [];
          for (const [name, row] of stillFailing) {
            if (row.status === "failed") unresolved.push(name);
          }
          await reportSqlFailures(unresolved);

          // New tables need handing over, or the operator imports a dump and
          // still sees nothing in the admin UI.
          await adoptTables();

          if (summary.applied.length) say(`applied ${filename}`);
          else if (summary.partial.length)
            say(`applied ${filename} with trigger(s) skipped - see 'tdb sql status'`);
          else if (summary.failed.length) say(`FAILED ${filename} - rolled back, nothing applied`);
          else if (summary.changed.length)
            say(`${filename} changed since it ran; use --force to re-apply`);
          else say(`${filename} was already applied; use --force to re-apply`);
          return;
        }

        // An imported dump lands as raw SQLite tables, which the Collections
        // screen cannot show: it lists _collections, and a raw table is not one.
        // `adopt` hands them over; `tables` and `query` read them either way.
        if (args[1] === "adopt") {
          const summary = await adoptTables(say);
          if (!summary) {
            say("adoption did not run; see the message above");
            return;
          }
          say(`admin UI collections: ${pbAdopt.describe(summary)}`);
          for (const name of summary.adopted) say(`  adopted  ${name}`);
          for (const note of summary.unsupported) say(`  ^3note     ${note}^7`);
          for (const failure of summary.failed) say(`  ^1failed   ${failure}^7`);
          return;
        }

        if (args[1] === "plan") {
          const planned = await pbAdopt.plan(adoptDeps());
          if (!planned.length) {
            say("every table is already a collection");
            return;
          }
          say(`${planned.length} table(s) would be adopted:`);
          for (const entry of planned) {
            say(
              `  ${entry.table.padEnd(38)} id:${entry.idStrategy.padEnd(8)} ` +
                `${entry.columns.length} column(s), ${entry.foreignKeys.length} foreign key(s)`
            );
          }
          return;
        }

        if (args[1] === "tables") {
          const like = args[2];
          const rows = await oxmysqlAdapter.handle("query", [
            like
              ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name LIKE ? ORDER BY name"
              : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
            like ? [`%${like}%`] : [],
          ]);

          if (!rows.length) {
            say(like ? `no tables matching '${like}'` : "no tables yet");
            return;
          }

          say(`${rows.length} table(s)${like ? ` matching '${like}'` : ""}:`);
          for (const row of rows) {
            const n = await oxmysqlAdapter.handle("scalar", [`SELECT COUNT(*) FROM "${row.name}"`]);
            say(`  ${String(row.name).padEnd(40)} ${n} row(s)`);
          }
          return;
        }

        if (args[1] === "query") {
          // Everything after the subcommand, so quoting is the operator's
          // business rather than something we have to second-guess.
          const sql = args.slice(2).join(" ").trim();

          if (!sql) {
            say(
              "usage: tdb sql query <sql>   e.g. tdb sql query SELECT * FROM phone_phones LIMIT 5"
            );
            return;
          }

          const rows = await oxmysqlAdapter.handle("query", [sql]);

          if (!Array.isArray(rows)) {
            say(`ok: ${JSON.stringify(rows)}`);
            return;
          }
          if (!rows.length) {
            say("0 rows");
            return;
          }

          const columns = Object.keys(rows[0]);
          say(columns.join(" | "));

          const MAX_ROWS = 50;
          for (const row of rows.slice(0, MAX_ROWS)) {
            say(columns.map((c) => (row[c] === null ? "NULL" : String(row[c]))).join(" | "));
          }
          if (rows.length > MAX_ROWS) {
            say(`... ${rows.length - MAX_ROWS} more row(s); add a LIMIT`);
          }
          return;
        }

        say(USAGE);
      } catch (error) {
        say(`^1command failed: ${error.message}^7`);
      }
    },
    // Restricted, so it is gated on the `command.tdb` ACE. The server console
    // holds every ACE; another resource calling ExecuteCommand does not, and
    // FiveM denies it silently - no output, the handler just never runs. To
    // drive it from a script: add_ace resource.<name> command.tdb allow
    true
  );

  // Subscriptions die with the WebSocket, but the auth refresh timer is ours and
  // keeps firing against a dead client unless cancelled.
  on("onResourceStop", (stoppedResource) => {
    if (stoppedResource !== resourceName) return;

    if (authManager) {
      authManager.stop();
    }
  });
})();
