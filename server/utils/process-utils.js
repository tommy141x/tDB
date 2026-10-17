// Shared process helpers, and tDB's one door to a child process.
//
// tDB does not spawn anything itself any more. FXServer attributes
// `add_unsafe_child_process_permission` to the resource whose runtime made the
// call, so every t* resource that shipped a local engine needed its own grant;
// tLib now holds the single grant for the family and brokers the spawn behind a
// catalog that names the program and the shape of its arguments. tDB's side of
// that deal is: name "pocketbase", never a path, and pass arguments that match
// one of the declared invocations.
//
// There is deliberately no local fallback. tLib is a hard `dependency` in
// fxmanifest.lua, so a missing export is an installation fault to report at the
// operator, not a case to route around by spawning here.
module.exports = (function () {
  /** How often a one-shot's result is asked for. Short because every caller is
   *  awaiting it inside startup, and the poll is a cheap in-process export
   *  call, not IPC. */
  const JOB_POLL_MS = 50;

  /**
   * tLib's export table, with the one export this caller needs proven present.
   *
   * `globalThis.exports`, not `exports`: tDB's server code is CommonJS, where
   * the bare `exports` identifier is module.exports and shadows FiveM's global
   * export proxy. Same reason server.js's registerWithTLib() spells it out.
   *
   * Throws rather than returning null so no caller can accidentally continue
   * with a half-working broker; the message is the operator's instruction.
   */
  function spawnBroker(requiredExport) {
    const api = globalThis.exports?.tLib;
    if (typeof api?.[requiredExport] !== "function") {
      throw new Error(
        `tLib's spawn broker is unavailable (no ${requiredExport} export). tDB runs ` +
          "PocketBase through tLib and has no spawn path of its own. Fix: `ensure tLib` " +
          "before tDB in server.cfg, and update tLib to a build that ships the spawn broker.",
      );
    }
    return api;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function failure(message) {
    return { code: -1, stdout: "", stderr: message };
  }

  /**
   * Poll a one-shot to completion. Never rejects.
   *
   * Polling rather than an event because the result crosses a resource
   * boundary: an event registered after it fired is a hang, and a hang during
   * startup provisioning is the worst failure shape available here.
   *
   * Reading a finished job also forgets it on tLib's side, so this reads once
   * and keeps what it got.
   */
  async function awaitJob(api, id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      let result;
      try {
        result = JSON.parse(api.SpawnJob(id));
      } catch (err) {
        return failure(`Could not read job ${id} from tLib: ${err.message}`);
      }

      if (result.state === "exited") {
        // tLib reports a launch failure as `error` with no exit code - the same
        // fact the local spawn used to deliver on its 'error' event, and the
        // same -1 the contract promises for it.
        if (result.error) {
          return { code: -1, stdout: result.stdout || "", stderr: result.error };
        }
        return {
          code: result.code,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      }

      if (result.state !== "running") {
        // "unknown": the job was never created, or was already read once.
        // Neither is recoverable and neither is an exit code.
        return failure(`tLib has no record of job ${id}`);
      }

      if (Date.now() >= deadline) {
        // Cancel kills the child; tLib keeps the job record until it reaps
        // tDB's, which is fine - nothing here will ask for it again.
        try {
          api.SpawnCancel(id);
        } catch {
          // The job finished between the poll and the cancel, which is the
          // outcome the cancel was asking for.
        }
        return failure(`Timed out after ${timeoutMs}ms`);
      }

      await sleep(JOB_POLL_MS);
    }
  }

  /**
   * Run a catalogued program to completion. Never rejects: a refusal or a
   * launch failure comes back as code -1 with the reason on stderr.
   *
   * `program` is a NAME from tLib's catalog, not a path - tLib resolves the
   * binary inside tDB's own directory and refuses anything that resolves out of
   * it. `options.cwd` is resource-relative and must be one tLib declares.
   */
  async function spawnWithTimeout(program, args, options = {}, timeoutMs = 5000) {
    let api;
    try {
      api = spawnBroker("SpawnRun");
    } catch (err) {
      return failure(err.message);
    }

    const request = { program, args };
    if (options.cwd !== undefined) request.cwd = options.cwd;
    if (typeof options.stdin === "string") request.stdin = options.stdin;

    let started;
    try {
      started = JSON.parse(api.SpawnRun(JSON.stringify(request)));
    } catch (err) {
      return failure(`tLib could not start ${program}: ${err.message}`);
    }

    if (!started?.job) {
      return failure(started?.error || `tLib returned no job id for ${program}`);
    }

    return awaitJob(api, started.job, timeoutMs);
  }

  // Exponential backoff, capped. Rethrows the last error once attempts run out.
  async function retryWithBackoff(
    fn,
    maxAttempts = 10,
    baseDelay = 100,
    maxDelay = 2000,
  ) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts) {
          await sleep(Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay));
        }
      }
    }

    throw lastError;
  }

  return {
    spawnBroker,
    spawnWithTimeout,
    retryWithBackoff,
  };
})();
