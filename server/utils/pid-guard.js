// Clearing a leftover PocketBase before starting a new one.
//
// The hazard this closes: tDB spawns PocketBase attached, which handles a clean
// FXServer shutdown, but nothing handles an unclean one. txAdmin restarts and
// `kill -9` never give the resource a chance to run its shutdown handlers, and
// on Windows a child does not die with its parent at all. The previous
// PocketBase therefore survives, still holding the HTTP port and the SQLite data
// directory, and the next start fails in a way that looks like a config problem:
// the port bind fails, or superuser provisioning and migrations fail on a locked
// database before `serve` is even reached.
//
// So this runs first, before createSuperuser touches the data dir.
//
// The safety rule is the important part. PIDs are recycled, so "the recorded PID
// is alive" proves nothing — on a game server the process now holding that PID
// could be anything. A kill is only authorised when the OS confirms the live
// PID's executable is the PocketBase binary we launched. An identity we cannot
// establish counts as "not ours", which risks leaving a real orphan but never
// risks killing a stranger.
//
// Kept self-contained rather than shared with tAI's equivalent
// (shared/engine/process-supervisor.ts): these are separate resources and a
// cross-resource require would make tDB fail to start when tAI is absent.

module.exports = (function () {
  const fs = require("fs");
  const path = require("path");
  const { execFile } = require("child_process");

  const POLL_MS = 100;

  function pidFilePath(resourcePath) {
    return path.join(resourcePath, "pb_data", "tdb-pocketbase.pid");
  }

  // kill(pid, 0) sends no signal and only tests reachability. EPERM means the
  // process exists but belongs to another user — alive, and not ours to kill.
  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  }

  function samePath(a, b) {
    if (!a || !b) return false;
    const normalise = (v) => {
      const slashes = v.replace(/\\/g, "/").replace(/\/+/g, "/");
      return process.platform === "win32" ? slashes.toLowerCase() : slashes;
    };
    return normalise(a) === normalise(b);
  }

  // Resolves a live PID's executable, or "" when the OS will not say.
  function executablePathOf(pid) {
    if (process.platform !== "win32") {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/exe`);
        // A binary replaced while running reports this suffix; the path before
        // it is still the one that was launched.
        return target.endsWith(" (deleted)")
          ? target.slice(0, -" (deleted)".length)
          : target;
      } catch (err) {
        return "";
      }
    }
    return new Promise((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`,
        ],
        { timeout: 10000, windowsHide: true },
        (err, stdout) => resolve(err ? "" : String(stdout).trim()),
      );
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function killAndWait(pid, graceMs) {
    const send = (signal) => {
      try {
        process.kill(pid, signal);
      } catch (err) {
        // Already gone between check and signal — the goal, not an error.
      }
    };
    send("SIGTERM");
    for (let waited = 0; waited < graceMs; waited += POLL_MS) {
      if (!isAlive(pid)) return true;
      await sleep(POLL_MS);
    }
    send("SIGKILL");
    for (let waited = 0; waited < graceMs; waited += POLL_MS) {
      if (!isAlive(pid)) return true;
      await sleep(POLL_MS);
    }
    return !isAlive(pid);
  }

  /**
   * Terminates a leftover PocketBase from a previous run, if there is one.
   *
   * @param {string} resourcePath
   * @param {string} pbPath absolute path of the binary about to be launched
   * @param {object} logger
   * @param {number} graceMs
   * @returns {Promise<boolean>} false only when an orphan was found and survived
   */
  async function clearOrphan(resourcePath, pbPath, logger, graceMs = 5000) {
    const file = pidFilePath(resourcePath);
    let record = null;
    try {
      if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      // A truncated file is the normal result of losing power mid-write, which
      // is precisely the case this guard exists for. Read it as "no record".
      record = null;
    }
    if (!record || typeof record.pid !== "number" || !Number.isInteger(record.pid)) return true;
    if (record.pid <= 0) return true;
    if (!isAlive(record.pid)) {
      logger.debug(`Stale PocketBase pid file (pid ${record.pid} not running)`);
      return true;
    }

    const actual = await executablePathOf(record.pid);
    if (!actual) {
      logger.warn(
        `pid ${record.pid} is alive but its executable could not be read, so it ` +
          "will not be killed. If PocketBase fails to bind its port, end that process manually.",
      );
      return true;
    }
    if (!samePath(actual, pbPath) || !samePath(actual, record.binaryPath || pbPath)) {
      logger.debug(`pid ${record.pid} now runs ${actual}, not ours — leaving it alone`);
      return true;
    }

    logger.warn(
      `Found a leftover PocketBase from a previous run (pid ${record.pid}) — terminating it`,
    );
    const gone = await killAndWait(record.pid, graceMs);
    if (!gone) {
      logger.error(
        `Could not terminate the previous PocketBase (pid ${record.pid}). ` +
          "Not starting a second instance against the same data directory.",
      );
      return false;
    }
    return true;
  }

  function write(resourcePath, pid, pbPath, logger) {
    try {
      fs.writeFileSync(
        pidFilePath(resourcePath),
        `${JSON.stringify({ pid, binaryPath: pbPath, startedAtMs: Date.now() }, null, 2)}\n`,
      );
    } catch (err) {
      // Losing the record costs orphan cleanup on the next unclean restart, not
      // this start — so it is a warning, never fatal.
      logger.warn(`Could not write the PocketBase pid file: ${err.message}`);
    }
  }

  function clear(resourcePath) {
    try {
      const file = pidFilePath(resourcePath);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      // A stale file is survivable: the next start re-probes the pid anyway.
    }
  }

  return { clearOrphan, write, clear, pidFilePath };
})();
