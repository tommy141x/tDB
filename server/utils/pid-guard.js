// Clearing a leftover PocketBase before starting a new one.
//
// PocketBase is tLib's child now, not tDB's: tLib brokers the spawn and reaps
// everything it started for tDB on tDB's `onResourceStop`, and everything it
// started at all when tLib itself stops. That covers every case where a handler
// gets to run - a resource restart, a resource stop, a tLib restart.
//
// This guard covers the case where nothing runs at all: `kill -9` on FXServer, a
// txAdmin hard restart, a power loss. The survivor keeps the HTTP port and the
// SQLite data dir, so the next start fails as a port bind error or a locked
// database during migrations. Hence this runs before createSuperuser touches the
// data dir.
//
// PIDs are recycled, so "the recorded PID is alive" proves nothing. The
// governing rule is unchanged and is the reason this file is not ten lines: an
// identity we cannot establish counts as not ours, which risks leaving a real
// orphan but never risks killing a stranger. A surviving orphan announces itself
// as a bind failure naming a pid an operator can end by hand; a wrongly killed
// stranger announces nothing, and on a game server the stranger is somebody's
// database.
//
// What changed is how identity is established. This used to resolve the live
// pid's executable and compare it against the binary we launched - /proc on
// Linux, and a PowerShell command run through a tLib probe on Windows. That is
// gone:
//
//   - The probe no longer exists on tLib's side, so the Windows branch could not
//     work at all.
//   - Linux containers are a first-class target here, not a port. A minimal
//     container ships no PowerShell, no wmic and no tasklist, and a branch only
//     the Windows dev box ever executes is the branch that rots. Assume nothing
//     is installed that the resource did not ship.
//   - It was one question with two implementations, and the two disagreed about
//     what they could even answer: /proc returns EACCES for another user's
//     process, which already read as "cannot confirm".
//
// The replacement asks three things, all answerable in-process from node's os,
// net and process.kill on both platforms:
//
//   1. A boot identity written into the record at spawn - the machine's
//      approximate boot instant, quantised to ten seconds so clock jitter and
//      os.uptime()'s one-second resolution do not look like a reboot. A record
//      from a previous boot cannot describe a live process of ours, so it is
//      deleted and nothing is signalled. That removes the dominant recycling
//      case outright.
//   2. Liveness, via kill(pid, 0). EPERM still means alive and owned by another
//      user, which is to say not ours to kill.
//   3. Whether the recorded port is actually held, via a TCP connect to
//      loopback. Holding the port is the entire harm an orphan does, so if
//      nothing is listening there is no conflict to resolve. This is strictly
//      safer than the old behaviour, which killed a path-matching process
//      whether or not anything was actually wrong.
//
// Be clear about what this does not cover, because it is not strictly stronger
// than the exe-path check it replaces. Within a SINGLE boot, if PocketBase
// exited, the OS handed its pid to an unrelated process, AND the recorded port
// is now held by something else, this kills that unrelated process. The path
// check did close that window. It is much narrower than the cross-boot case this
// removes - it needs two independent coincidences inside one uptime - but it is
// not zero.
//
// Deliberately not shared with tAI's process-supervisor.ts: a cross-resource
// require would make tDB fail to start when tAI is absent.

module.exports = (function () {
  const fs = require("fs");
  const net = require("net");
  const os = require("os");
  const path = require("path");

  const POLL_MS = 100;

  // Long enough for a loopback accept, short enough not to stall a start.
  const PORT_PROBE_TIMEOUT_MS = 500;

  // Ten-second buckets. os.uptime() has one-second resolution and the wall clock
  // can be stepped by NTP, so the derived boot instant wanders by a second or
  // two between reads on the same boot.
  const BOOT_ID_QUANTUM_MS = 10000;

  // `.runtime/`, not `pb_data/`. The data dir is configurable and defaults to
  // `.runtime/pb_data`, so a hardcoded `pb_data` at the resource root pointed at
  // a directory that does not exist -- every write failed with ENOENT and the
  // orphan-cleanup record was never kept. `.runtime/` is the one gitignored tree
  // everything PocketBase-related already lives under.
  function pidFilePath(resourcePath) {
    return path.join(resourcePath, ".runtime", "tdb-pocketbase.pid");
  }

  // A fresh clone has no .runtime/ until PocketBase first runs, and the pid is
  // written before that is guaranteed.
  function ensurePidDir(resourcePath) {
    const dir = path.dirname(pidFilePath(resourcePath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // kill(pid, 0) sends no signal, it only tests reachability. EPERM means the
  // process exists but belongs to another user: alive, and not ours to kill.
  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  }

  function bootIdentity() {
    return Math.round((Date.now() - os.uptime() * 1000) / BOOT_ID_QUANTUM_MS);
  }

  // One bucket of tolerance, not equality. Quantising only helps if a true value
  // sitting near a bucket boundary may fall either side of it; with === a
  // two-second wander across a boundary would read as a reboot and silently
  // switch orphan cleanup off for good. The cost is a 20s window, and no reboot
  // completes in twenty seconds. A 0 on either side is the absent field of a
  // record written before this existed, and never matches.
  function sameBoot(a, b) {
    if (!a || !b) return false;
    return Math.abs(a - b) <= 1;
  }

  // Compares two paths for "same file". Both sides are now ours - one written
  // into the record at spawn, one handed in by this start - so the only
  // differences left are separator style and, on Windows, case. Nothing the OS
  // reported is ever fed to this any more.
  function samePath(a, b) {
    if (!a || !b) return false;
    const normalise = (v) => {
      const slashes = v.replace(/\\/g, "/").replace(/\/+/g, "/");
      return process.platform === "win32" ? slashes.toLowerCase() : slashes;
    };
    return normalise(a) === normalise(b);
  }

  // Is anything accepting connections on this loopback port?
  //
  // A plain TCP connect: nothing written, nothing read. The question is whether
  // the port is held, not what is behind it, because holding the port is the
  // whole harm.
  //
  // Every failure mode - refused, timed out, address unusable - resolves false,
  // and false means "no proof of a conflict, so do not kill". A timeout in
  // particular must not read as held: on loopback a connect either completes or
  // is refused immediately, so a timeout means the probe is wrong rather than
  // the port being busy. Never rejects; a diagnostic must not take startup down.
  function isPortHeld(port) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (held) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(held);
      };
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
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
        // Already gone between check and signal, which is the goal.
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

  function discard(file) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      // A record left behind is survivable: it is re-evaluated next start and
      // will reach the same conclusion.
    }
  }

  // pbPath is the absolute path of the binary about to be launched. It is still
  // a parameter, and still compared - but against the path stored in the record,
  // never against anything the OS reports. That comparison stops a resource
  // copied to a new location from reaching back and killing whatever now holds
  // the pid its old copy wrote down.
  //
  // Returns false only when an orphan was found and survived.
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

    if (!record.bootId) {
      // A record from before boot identities were written. It may name a live
      // PocketBase of ours or a pid from three reboots ago, and there is no way
      // to tell, so it authorises nothing. Exactly one start pays this: the
      // write below replaces the file. Kept rather than deleted, because it is
      // still the only pointer to a pid an operator might have to end by hand.
      logger.warn(
        `pid ${record.pid} comes from a pid file written before boot identities were ` +
          "recorded, so it cannot be confirmed as ours and will not be killed. If " +
          "PocketBase fails to bind its port, end that process manually.",
      );
      return true;
    }
    if (!sameBoot(record.bootId, bootIdentity())) {
      // The machine rebooted. Nothing we launched survived it, so whatever holds
      // that pid now is a stranger by construction - no probe needed.
      logger.debug(`Discarding a PocketBase pid file from before the last reboot (pid ${record.pid})`);
      discard(file);
      return true;
    }
    if (!samePath(record.binaryPath || pbPath, pbPath)) {
      logger.debug(
        `The pid file records ${record.binaryPath}, but this start launches ${pbPath}; ` +
          `leaving pid ${record.pid} alone`,
      );
      return true;
    }
    if (!isAlive(record.pid)) {
      logger.debug(`Stale PocketBase pid file (pid ${record.pid} not running)`);
      discard(file);
      return true;
    }

    const port = Number.isInteger(record.port) && record.port > 0 ? record.port : 0;
    if (!port) {
      logger.warn(
        `pid ${record.pid} is alive but the pid file records no port, so there is nothing ` +
          "to prove it is ours and it will not be killed. If PocketBase fails to bind its " +
          "port, end that process manually.",
      );
      return true;
    }
    if (!(await isPortHeld(port))) {
      // Alive and from this boot, but holding nothing - so either it is not our
      // PocketBase or ours is doing no harm. The old check would have killed
      // here on a path match alone.
      logger.debug(
        `pid ${record.pid} is alive but nothing is listening on port ${port}; leaving it alone`,
      );
      discard(file);
      return true;
    }

    logger.warn(
      `Found a leftover PocketBase from a previous run (pid ${record.pid} still holding ` +
        `port ${port}), terminating it`,
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

  // `port` must be the port PocketBase actually bound, not one probed earlier:
  // resolveInternalPort() releases what it proves free, so the caller retries on
  // a different port after a lost race. Recording the loser would leave the next
  // start probing a port nothing of ours ever held, which reads as "no conflict"
  // and quietly disables the cleanup.
  function write(resourcePath, pid, pbPath, port, logger) {
    try {
      ensurePidDir(resourcePath);
      fs.writeFileSync(
        pidFilePath(resourcePath),
        `${JSON.stringify(
          {
            pid,
            binaryPath: pbPath,
            startedAtMs: Date.now(),
            port,
            bootId: bootIdentity(),
          },
          null,
          2,
        )}\n`,
      );
    } catch (err) {
      // Losing the record only costs orphan cleanup on the next unclean restart.
      logger.warn(`Could not write the PocketBase pid file: ${err.message}`);
    }
  }

  function clear(resourcePath) {
    discard(pidFilePath(resourcePath));
  }

  return { clearOrphan, write, clear };
})();
