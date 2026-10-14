// Routes each oxmysql/PocketBase export call to the first adapter that claims
// it. Split out of client.js so the pre-readiness behaviour can be tested
// without starting the resource: no FiveM globals here, everything injected.
module.exports = (function () {
  // Routes each export call to the first adapter that claims it, by priority.
  class ExportRouter {
    constructor(exportsFn, whenReady, logger, onFn) {
      this.adapters = [];
      this.exportNames = new Set();
      this.exportsFn = exportsFn;
      // FiveM's event registrar, injected for the same reason exportsFn is:
      // registerAliases has to be testable without the runtime.
      this.onFn = onFn;
      // resourceName -> Set of method names aliased under it.
      this.aliases = new Map();
      // Resolves when the adapters are in place. Injected so the router stays
      // testable without the readiness machinery.
      this.whenReady = whenReady || (() => Promise.resolve());
      this.logger = logger || console;
    }

    registerAdapter(adapter, priority = 100) {
      if (!adapter.canHandle || typeof adapter.canHandle !== "function") {
        throw new Error("Adapter must implement canHandle(exportName, args) method");
      }
      if (!adapter.handle || typeof adapter.handle !== "function") {
        throw new Error("Adapter must implement handle(exportName, args) method");
      }
      if (!adapter.name) {
        throw new Error("Adapter must have a name property");
      }

      this.adapters.push({ adapter, priority });
      this.adapters.sort((a, b) => a.priority - b.priority);

      this.logger.debug(`Registered adapter: ${adapter.name} (priority: ${priority})`);
    }

    registerExports(exportNames) {
      for (const exportName of exportNames) {
        this.createExport(exportName);
      }
    }

    createExport(exportName) {
      if (this.exportNames.has(exportName)) {
        this.logger.warn(`Export '${exportName}' already registered, skipping...`);
        return;
      }

      this.exportNames.add(exportName);
      this.exportsFn(exportName, this.entryPoint(exportName));
    }

    /**
     * The function an export name resolves to. One per name, shared by the
     * resource's own export and by every aliased name, so an alias cannot
     * drift from the real thing.
     */
    entryPoint(exportName) {
      const router = this;

      return function (...args) {
        // oxmysql has every export from its first frame; tDB's adapters only
        // exist once PocketBase is up. A script querying during its own
        // startup is normal and worked under oxmysql, so wait for readiness
        // rather than letting FiveM answer "no such export".
        if (!router.adapters.length) {
          return router.whenReady().then(() => router.dispatch(exportName, args));
        }
        return router.dispatch(exportName, args);
      };
    }

    /**
     * Publish exports under ANOTHER resource's name, which is what makes tDB a
     * drop-in rather than a port target.
     *
     * `provide 'oxmysql'` in the manifest does NOT do this. Measured on a live
     * server: `provide` makes `GetResourceState('oxmysql')` report `started` -
     * which is why dependency checks pass and why this looked fine - but
     * `exports.oxmysql:scalar(...)` still answers
     * "No such export scalar in resource oxmysql". So every unported resource,
     * which is to say the entire reason this layer exists, was failing.
     *
     * The mechanism is the one oxmysql itself uses for its own legacy names:
     * respond to `__cfx_export_<resource>_<method>` with the function. Also
     * measured on a live server, including the argument convention: the `:`
     * call form delivers `(query, parameters, cb)` with the self slot already
     * stripped, so an aliased function needs no shim - it is the same function
     * the resource's own export uses.
     */
    registerAliases(resourceName, methodNames) {
      if (typeof this.onFn !== "function") {
        this.logger.warn(
          `Cannot publish exports as '${resourceName}': no event registrar was provided`
        );
        return;
      }

      let known = this.aliases.get(resourceName);
      if (!known) {
        known = new Set();
        this.aliases.set(resourceName, known);
      }

      for (const method of methodNames) {
        if (known.has(method)) continue;
        known.add(method);

        const handler = this.entryPoint(method);
        // setCb is called every time a consumer resolves the export, so the
        // handler stays registered rather than answering once.
        this.onFn(`__cfx_export_${resourceName}_${method}`, (setCb) => setCb(handler));
      }

      this.logger.debug(`Published ${known.size} export(s) as '${resourceName}'`);
    }

    dispatch(exportName, args) {
      for (const { adapter } of this.adapters) {
        try {
          if (adapter.canHandle(exportName, args)) {
            const result = adapter.handle(exportName, args);

            // A callback-style call delivers its answer to the callback, and
            // oxmysql never reported errors through the return value, so Lua
            // callers drop it. Lua cannot attach a catch either, which leaves
            // a rejection nobody owns and V8 printing "Unhandled promise
            // rejection" on top of the error handleCallError already logged.
            if (
              typeof args[args.length - 1] === "function" &&
              result &&
              typeof result.catch === "function"
            ) {
              result.catch(() => {});
            }
            return result;
          }
        } catch (error) {
          this.logger.error(
            `Error in adapter '${adapter.name}' for export '${exportName}':`,
            error
          );
          throw error;
        }
      }
      // Name the argument, not just the export. "No adapter could handle
      // export 'scalar'" reads like a tDB wiring fault, when the real meaning
      // is almost always "this SQL construct is unsupported" - and working that
      // out from the old wording cost an outage.
      const first = args[0];
      const detail =
        typeof first === "string"
          ? `could not route this statement: ${first.slice(0, 160)}`
          : `could not route a call with a ${typeof first} first argument`;

      throw new Error(
        `tDB ${detail} (export '${exportName}'). If it is SQL, the construct may be ` +
          `unsupported; if it is a record call, check the collection name.`
      );
    }
  }

  return ExportRouter;
})();
