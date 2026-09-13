const fs = require("fs");
const path = require("path");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const configLoader = require("./utils/config-loader.js");
const { spawnWithTimeout } = require("./utils/process-utils.js");
// Resolved from the resource root, not from this file — FiveM's Node runtime
// loads server_scripts with the resource directory as the base.
const pidGuard = require("./utils/pid-guard.js");
const settings = require("./utils/settings.js");
const tlibPublication = require("./utils/tlib-publication.js");

// ============================================================================
// Color Utilities
// ============================================================================
const colors = {
  red: (msg) => `^1${msg}^7`,
  green: (msg) => `^2${msg}^7`,
  yellow: (msg) => `^3${msg}^7`,
  cyan: (msg) => `^6${msg}^7`,
  magenta: (msg) => `^5${msg}^7`,
  white: (msg) => `^7${msg}`,
  gray: (msg) => `^8${msg}^7`,
};

// ============================================================================
// Logger
// ============================================================================
const logger = {
  info: (msg) => console.log(`^2[PocketBase]^7 ${msg}`),
  warn: (msg) => console.log(`^3[PocketBase]^7 ${msg}`),
  error: (msg) => console.log(`^1[PocketBase]^7 ${msg}`),
  debug: (msg) => console.log(`^5[PocketBase]^7 ${msg}`),
  raw: (msg) => console.log(msg),
};

// ============================================================================
// Startup Status Tracking
// ============================================================================
const startupStatus = {
  executablePath: "",
  superuserEmail: "",
  superuserPassword: "",
  bindAddress: "",
  publicUrl: "",
  /** Config.ExposeAdmin — whether a mount was WANTED. */
  exposeAdmin: false,
  /** Whether tLib actually accepted one. Distinct from exposeAdmin: wanting a
   *  mount and having one are different states, and conflating them is what
   *  made a failed registration print a loopback address under "Admin". */
  mounted: false,
  isRemoteMode: false,
  /** true / false / null, where null means "not checked". Three states, because
   *  an unchecked route and a broken one are different things and a very old
   *  tLib cannot tell us where its listener is. */
  healthCheckPassed: null,
  clientAuthenticated: null,
  hooksHealthy: null,
  errors: [],
  warnings: [],
};

// Where PocketBase itself is listening. Every internal check (hooks health,
// the client adapter) talks to this, and it stays correct whether or not the
// admin UI is reachable from outside.
let localUrl = "";
// What the operator is shown, and what PocketBase's own log lines are rewritten
// to. Starts as the loopback address and becomes the routed URL once tLib
// accepts the mount - and goes back if that mount is ever withdrawn.
let finalUrl = "";

// The credentials the local instance is actually provisioned with, kept so a
// repair can re-apply them, and a latch so repair runs at most once per start.
let activeSuperuser = null;
let superuserRepairAttempted = false;

// ============================================================================
// Configuration
// ============================================================================
const resourceName = GetCurrentResourceName();
const resourcePath = GetResourcePath(resourceName);

// Load configuration using shared loader
const config = configLoader.load(resourcePath);
logger.info("Configuration loaded");

// ============================================================================
// OS Detection
// ============================================================================
function getOS() {
  const platform = process.platform;
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  logger.error(`Unsupported operating system: ${platform}`);
  return null;
}

function getPocketBasePath() {
  const os = getOS();
  if (!os) return null;

  const binPath = path.join(resourcePath, "bin");
  const exeName = os === "windows" ? "pocketbase-win.exe" : "pocketbase-linux";
  const fullPath = path.join(binPath, exeName);

  if (!fs.existsSync(fullPath)) {
    logger.error(`PocketBase executable not found at: ${fullPath}`);
    return null;
  }

  // Make executable on Linux
  if (os === "linux") {
    try {
      fs.chmodSync(fullPath, "755");
    } catch (err) {
      logger.warn(`Could not set executable permissions: ${err.message}`);
    }
  }

  return fullPath;
}

// ============================================================================
// URL building
// ============================================================================
//
// There is deliberately no public-IP lookup here. tDB has no public address of
// its own to discover — the admin UI appears on tLib's router, at whatever
// address tLib reports. Asking an outside service (api.ipify.org) for our own
// IP at every startup was a network call made on behalf of a URL this resource
// no longer owns.
//
// This remains only for REMOTE mode, where the operator names a PocketBase
// instance on another machine and that host string has to be turned into a URL.
function buildSmartUrl(hostParam, port) {
  if (!hostParam || hostParam === "") {
    return null;
  }

  if (hostParam.startsWith("http://") || hostParam.startsWith("https://")) {
    const hostPart = hostParam.replace(/^https?:\/\//, "");
    if (hostPart.includes(":")) {
      return hostParam;
    }
    if (/^\d+\.\d+\.\d+\.\d+/.test(hostPart)) {
      return `${hostParam}:${port}`;
    }
    return hostParam;
  }

  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(hostParam)) {
    return `http://${hostParam}`;
  }

  const isDomain =
    /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(hostParam) &&
    !/^\d+\.\d+\.\d+\.\d+/.test(hostParam);

  if (isDomain) {
    return `https://${hostParam}`;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostParam)) {
    return `http://${hostParam}:${port}`;
  }

  return `http://${hostParam}:${port}`;
}

// ============================================================================
// Status Display
// ============================================================================
// Set once the box has printed. After that, anything that changes publication
// has to report itself in the log - the box is not reprinted.
let startupBoxPrinted = false;

function displayStartupStatus() {
  startupBoxPrinted = true;

  // Determine title based on errors
  let title;
  if (startupStatus.errors.length > 0) {
    title = `${colors.red("❌  PocketBase - Startup Failed")}`;
  } else if (startupStatus.warnings.length > 0) {
    title = `${colors.yellow("⚠️  PocketBase - Running with Warnings")}`;
  } else {
    title = `${colors.green("✅  PocketBase - System Ready")}`;
  }

  // Build status content
  let boxContent = [title, ""];

  // Mode. "Published" means a mount is live, not merely requested — see
  // startupStatus.mounted.
  let mode;
  if (startupStatus.isRemoteMode) {
    mode = colors.magenta("Remote");
  } else if (startupStatus.mounted) {
    mode = colors.cyan("Published via tLib");
  } else if (startupStatus.exposeAdmin && tlibTooOld) {
    // Distinct from pending: this one never resolves on its own, so calling it
    // "waiting" would leave the operator watching a console that will never
    // say anything more.
    mode = colors.yellow("Not published (tLib too old)");
  } else if (startupStatus.exposeAdmin && publisher.pending) {
    // Waiting on tLib's HTTP, not broken by it. The mount is claimed as soon
    // as tLib reports ready, so this line is a snapshot of a moment, not a
    // verdict — saying "failed" here sent people to debug a listener that was
    // simply half a second behind PocketBase.
    mode = colors.yellow("Waiting for tLib's HTTP listener");
  } else if (startupStatus.exposeAdmin) {
    mode = colors.yellow("Headless (mount failed)");
  } else {
    mode = colors.green("Headless");
  }
  boxContent.push(`${colors.white("Mode:    ")} ${mode}`);

  // Binding address or Remote URL
  if (startupStatus.isRemoteMode) {
    boxContent.push(
      `${colors.white("Remote:  ")} ${colors.magenta(startupStatus.publicUrl)}`,
    );
  } else {
    boxContent.push(
      `${colors.white("Binding: ")} ${colors.magenta(startupStatus.bindAddress)}`,
    );
  }

  // Combined Health & Authentication Status
  let healthStatus = "";
  let healthColor = colors.green;

  // Priority: Authentication issues first, then hooks health, then network health
  if (startupStatus.clientAuthenticated === false) {
    healthStatus = "✗ Authentication Failed";
    healthColor = colors.red;
    if (startupStatus.isRemoteMode) {
      startupStatus.errors.push(
        "Failed to authenticate with remote PocketBase - check superuser credentials",
      );
    } else {
      startupStatus.warnings.push(
        "Client failed to authenticate - check superuser credentials",
      );
    }
  } else if (
    startupStatus.isRemoteMode &&
    startupStatus.healthCheckPassed === false
  ) {
    healthStatus = "✗ Connection Failed";
    healthColor = colors.red;
    startupStatus.errors.push(
      "Could not connect to remote PocketBase instance",
    );
  } else if (startupStatus.hooksHealthy === false) {
    healthStatus = "✗ Hooks Failed to Load";
    healthColor = colors.red;
    startupStatus.warnings.push(
      "PocketBase hooks (pb_hooks) failed to initialize",
    );
  } else if (startupStatus.clientAuthenticated === true) {
    // Client is authenticated, now check network health
    if (startupStatus.isRemoteMode) {
      healthStatus = "✓ Connected";
      healthColor = colors.green;
    } else if (startupStatus.mounted) {
      if (startupStatus.healthCheckPassed === true) {
        healthStatus = "✓ Started";
        healthColor = colors.green;
      } else if (startupStatus.healthCheckPassed === false) {
        healthStatus = "✗ Not Reachable Through tLib";
        healthColor = colors.red;
        // This is a ROUTING failure, checked over loopback — the admin UI is
        // not reachable even from this machine. Port forwarding is a separate
        // question and is not what failed here, so do not send the operator to
        // their router config for it.
        startupStatus.warnings.push(
          "tLib accepted the mount but is not forwarding it — check tLib's log",
        );
      } else {
        // null: never dialled. Only happens on a tLib too old to report where
        // its listener is, which has already produced its own warning.
        healthStatus = "✓ Started (route not checked)";
        healthColor = colors.green;
      }
    } else {
      // Headless — whether by config or because the mount could not be made.
      // The database itself is fully working either way; registerWithTLib has
      // already said why if this was not the operator's choice.
      healthStatus = "✓ Started";
      healthColor = colors.green;
    }
  }

  // Only advertise an Admin URL that someone can actually open. When headless
  // there is no such URL — publicUrl is the loopback address, and printing it
  // here would read as "the admin UI is at 127.0.0.1:8090", which is true only
  // from a shell on the server and misleading everywhere else.
  if (startupStatus.isRemoteMode || startupStatus.mounted) {
    boxContent.push(
      `${colors.white("Admin:   ")} ${colors.cyan(startupStatus.publicUrl + "/_/")}`,
    );
  } else if (!startupStatus.exposeAdmin) {
    boxContent.push(
      `${colors.white("Admin:   ")} ${colors.gray("not published (ExposeAdmin = false)")}`,
    );
  } else if (tlibTooOld) {
    // ExposeAdmin is on and stays on — the operator asked for this and their
    // setting is not being rewritten. It just cannot be honoured yet.
    boxContent.push(
      `${colors.white("Admin:   ")} ${colors.yellow("unavailable until tLib is updated")}`,
    );
  }

  if (healthStatus) {
    boxContent.push(
      `${colors.white("Status:  ")} ${healthColor(healthStatus)}`,
    );
  }

  // Superuser credentials (only show if generated or first time)
  if (startupStatus.superuserEmail) {
    boxContent.push("");
    boxContent.push(
      `${colors.white("Email:   ")} ${colors.cyan(startupStatus.superuserEmail)}`,
    );
    boxContent.push(
      `${colors.white("Pass:    ")} ${colors.cyan(startupStatus.superuserPassword)}`,
    );
  }

  // Warnings
  if (startupStatus.warnings.length > 0) {
    boxContent.push("");
    boxContent.push(colors.yellow("⚠️  Warnings:"));
    startupStatus.warnings.forEach((warning) => {
      boxContent.push(`${colors.yellow("   • ")} ${warning}`);
    });
  }

  // Errors
  if (startupStatus.errors.length > 0) {
    boxContent.push("");
    boxContent.push(colors.red("❌  Errors:"));
    startupStatus.errors.forEach((error) => {
      boxContent.push(`${colors.red("   • ")} ${error}`);
    });
  }

  // Lua owns the shared tLib version/banner display. Keep database diagnostics
  // here, but do not draw a second resource-specific startup box.
  emit("tdb:startupStatus", boxContent.join("\n"));
}

// ============================================================================
// Health Check
// ============================================================================
/**
 * Verify that tLib's router actually forwards our mount to us.
 *
 * Deliberately NOT a request to the public URL. That URL's host is the
 * server's WAN address, which on most networks is unreachable from the machine
 * itself (NAT hairpinning is off by default), so probing it reports a failure
 * on a perfectly working setup. Whether the port is reachable from the
 * internet is a port-forwarding question that cannot be answered from in here
 * at all.
 *
 * What CAN be answered, and is the part likely to be misconfigured, is whether
 * the router is up and routing our prefix to our process. So the request goes
 * to tLib's own listener, carrying the same mount the public URL uses.
 *
 * The address comes from tLib's status snapshot (localUrl), never from the
 * public origin. Deriving it from the public URL is what this used to do, and
 * it was wrong in the ordinary case: behind a proxy the public origin is
 * https://host with no port, so the old code fell back to 443 and probed
 * 127.0.0.1:443 — reporting a broken admin route on a working setup.
 *
 * @param {string|null} url absolute health URL, from publisher.healthUrl()
 */
async function checkRouteHealth(url) {
  if (!url) return false;

  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  const transport = target.protocol === "https:" ? https : require("http");

  return new Promise((resolve) => {
    transport
      .get(url, { timeout: 5000 }, (resp) => resolve(resp.statusCode === 200))
      .on("error", () => resolve(false))
      .on("timeout", () => resolve(false));
  });
}

// ============================================================================
async function checkHooksHealth(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === "https:" ? https : require("http");

    const hooksHealthUrl = `${url}/api/extended/health`;

    protocol
      .get(hooksHealthUrl, { timeout: 5000 }, (resp) => {
        if (resp.statusCode === 200) {
          let data = "";
          resp.on("data", (chunk) => {
            data += chunk;
          });
          resp.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(json.status === "ok");
            } catch (e) {
              resolve(false);
            }
          });
        } else {
          resolve(false);
        }
      })
      .on("error", () => {
        resolve(false);
      })
      .on("timeout", () => {
        resolve(false);
      });
  });
}

// ============================================================================
// Superuser Management
// ============================================================================
function generateRandomPassword(length = 20) {
  return crypto.randomBytes(length).toString("base64").slice(0, length);
}

/**
 * Run `superuser upsert`, which creates the account or resets its password if
 * it already exists. Idempotent, so it doubles as the repair operation.
 */
async function upsertSuperuser(pbPath, email, password) {
  const result = await spawnWithTimeout(
    pbPath,
    ["superuser", "upsert", email, password, "--dir", config.Advanced.DataDir],
    { cwd: resourcePath },
    30000, // Increased timeout for first-time database initialization
  );

  // A zero exit code alone is not proof: trust it only when PocketBase also
  // says it saved the record, otherwise a silent failure leaves the instance
  // with no superuser and `serve` falls back to its interactive installer.
  const saved =
    result.code === 0 && /Successfully saved superuser/i.test(result.stdout);

  const detail =
    (result.stderr || "").trim() ||
    (result.stdout || "").trim() ||
    `exit code ${result.code}`;

  return { ok: saved, detail };
}

/** The loopback port PocketBase is given when nothing else on the machine wants
 *  it. Historically Config.Port's default, kept as the first choice so a local
 *  `curl 127.0.0.1:8090` still works the way every note about this ever written
 *  says it does. */
const PREFERRED_INTERNAL_PORT = 8090;

/**
 * Decide which loopback port to hand PocketBase.
 *
 * This replaced Config.Port as an operator setting. The port is internal:
 * PocketBase binds 127.0.0.1, tLib owns the server's one external port and
 * proxies the mount through to it, and the number is registered with tLib
 * programmatically — so nobody ever types it, forwards it, or dials it, and it
 * carries no operator intent worth asking for. Asking for it only created a way
 * to collide with something else on the machine.
 *
 * Tries PREFERRED_INTERNAL_PORT, then asks the OS for any free port. Both
 * branches prove availability by actually binding, then release — a small race
 * against something else grabbing the port in the gap, which is why a failure
 * to bind is reported by the caller rather than swallowed. `exclusive` keeps
 * the probe from succeeding on a port already bound by another process via
 * SO_REUSEADDR semantics, which would make the check meaningless.
 *
 * Returns null only if even an OS-chosen port could not be bound, which means
 * the machine has no loopback ports left.
 */
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(null));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const addr = srv.address();
      const bound = addr && typeof addr === "object" ? addr.port : null;
      srv.close(() => resolve(bound));
    });
  });
}

async function resolveInternalPort(skipPreferred = false) {
  if (!skipPreferred) {
    const preferred = await probePort(PREFERRED_INTERNAL_PORT);
    if (preferred) return preferred;
  }

  const fallback = await probePort(0);
  if (fallback) {
    if (!skipPreferred) {
      logger.info(
        `Port ${PREFERRED_INTERNAL_PORT} is in use on this machine — PocketBase will ` +
          `use loopback port ${fallback} instead. Nothing needs changing: this port is ` +
          "internal and tLib's router is told about it automatically.",
      );
    }
    return fallback;
  }
  return null;
}

/** Bind-failure signatures, across platforms and both PocketBase's own wording
 *  and Go's net package underneath it. Matched case-insensitively. */
const BIND_CONFLICT = [
  "address already in use",
  "only one usage of each socket address",
  "bind: permission denied",
  "cannot assign requested address",
];

/**
 * Wait until PocketBase has demonstrably bound its port, or died trying.
 *
 * Resolves as soon as the port accepts a TCP connection, so a healthy start
 * costs roughly one poll interval rather than a fixed delay. A bind failure is
 * detected by the process exiting — Go's listener fails immediately, so this is
 * fast and does not depend on log-line wording for the DECISION, only for
 * classifying the reason.
 *
 * A timeout resolves ok: the process is alive and not listening for some other
 * reason, which retrying on a different port cannot fix — the health checks
 * downstream are the right place to report that.
 */
function confirmBind(proc, port, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = "";
    const deadline = Date.now() + timeoutMs;

    const onStderr = (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    };
    proc.stderr.on("data", onStderr);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      proc.stderr.removeListener("data", onStderr);
      proc.removeListener("exit", onExit);
      proc.removeListener("error", onError);
      resolve(result);
    };

    // A spawn failure (missing binary, no execute bit) may emit 'error' without
    // a matching 'exit'. Without this the promise would hang until the timeout
    // and then wrongly report ok.
    function onError(err) {
      finish({ ok: false, bindConflict: false, detail: err.message });
    }
    proc.once("error", onError);

    function onExit(code) {
      const detail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" ").trim();
      const haystack = detail.toLowerCase();
      finish({
        ok: false,
        bindConflict: BIND_CONFLICT.some((sig) => haystack.includes(sig)),
        detail: detail || `exit code ${code}`,
      });
    }
    proc.once("exit", onExit);

    const poll = () => {
      if (settled) return;
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        finish({ ok: true });
      });
      sock.once("error", () => {
        sock.destroy();
        if (settled) return;
        if (Date.now() >= deadline) {
          finish({ ok: true });
          return;
        }
        setTimeout(poll, 100);
      });
    };
    poll();
  });
}

/**
 * The mount tDB asks tLib for. One constant: the registration and the health
 * probe have to agree on it, and they used to agree only because the probe
 * re-derived it by parsing the public URL's path.
 */
const TLIB_MOUNT = "/db";

/**
 * Read tLib's HTTP status snapshot.
 *
 * Feature-detected, because bumping tLib's required version is not this
 * change's to make.
 *
 * An older tLib cannot report readiness at all, and on that version the admin
 * UI is simply not published. That is deliberate, and it is the stricter of
 * the two options:
 *
 *   - GetHubUrl is not a readiness signal. It answered with a provisional
 *     localhost URL while autodetection was still running, and kept answering
 *     after a failed bind, so "non-empty" never meant "serving".
 *   - Registering anyway and advertising whatever URL comes back has the same
 *     problem one step later: nothing here can tell a real public URL from a
 *     provisional one, so the startup box would print a link that may well go
 *     nowhere. Printing a dead admin link is the class of bug this whole
 *     change exists to remove, and doing it in a fallback path is no better
 *     than doing it in the main one.
 *
 * The cost is real and bounded: on a mismatched tLib the admin UI is
 * unavailable until tLib is updated. tDB's actual job is unaffected - the
 * database, every oxmysql export and every script talking to it go over
 * loopback and never touch the router. And tLib is a hard dependency from the
 * same suite, so a tLib this old is a half-finished update, not a
 * configuration anyone is meant to run.
 *
 * Consistent with the rest of the suite: tRadio does the same.
 */
let tlibTooOld = false;

function readTLibHttpStatus() {
  try {
    if (GetResourceState("tLib") !== "started") return null;
    const api = globalThis.exports.tLib;

    if (typeof api.GetHttpStatus === "function") {
      tlibTooOld = false;
      return api.GetHttpStatus();
    }

    if (!tlibTooOld) {
      tlibTooOld = true;
      startupStatus.warnings.push(
        "tLib is too old to report HTTP readiness (no GetHttpStatus) - the admin " +
          "UI is not published. The database is unaffected. Update tLib.",
      );
    }
    // Not ready, and never will be on this version. No mount is attempted and
    // no URL is advertised.
    return {
      ready: false,
      listenerState: "unsupported",
      publicUrlState: "unsupported",
      publicUrl: null,
      localUrl: null,
      error: "tLib is too old to report HTTP readiness - update tLib",
    };
  } catch (err) {
    logger.debug(`Could not read tLib HTTP status: ${err.message}`);
    return null;
  }
}

/**
 * Ask tLib's router to expose this PocketBase instance on the server's one
 * external port.
 *
 * PocketBase binds loopback and is unreachable from outside on its own. tLib
 * owns the single public port and proxies `<mount>/...` here.
 *
 * Returns tLib's raw result so the publisher can tell a refusal from a
 * not-ready-yet; it no longer decides anything itself.
 *
 * Note on `exports`: these files are CommonJS modules, where `exports` is
 * module.exports and shadows FiveM's global export proxy. Reaching it through
 * globalThis is required, not stylistic.
 */
function registerWithTLib() {
  // tLib is a hard dependency, so this should not happen; if it does, the
  // database still works for every script on this server and only the admin
  // UI is missing. That is a warning, not a failed start.
  if (GetResourceState("tLib") !== "started") {
    return {
      ok: false,
      retryable: true,
      error: "tLib is not started",
    };
  }

  return globalThis.exports.tLib.RegisterWebApp({
    id: "db",
    mount: TLIB_MOUNT,
    port: config.Port,
    host: "127.0.0.1",
    // PocketBase serves its admin at /_/ and its API at /api/ with no base
    // path option, so it must see the unprefixed paths. That works because
    // its admin UI is subpath-relative: assets are emitted as ./assets/... and
    // its SDK client is constructed with a relative baseURL ("../"), which
    // resolves against window.location.pathname. Verified against 0.40.3.
    stripPrefix: true,
    // PocketBase realtime is SSE over plain HTTP, not WebSocket.
    websocket: false,
    title: "Database",
    icon: "database",
    description: "PocketBase collections, records and admin",
    accent: "#22c07a",
    // PocketBase serves nothing at its root — pb_public is empty — so the
    // bare mount would answer with its JSON "File not found", which reads
    // like the router is broken. The admin UI is at /_/.
    index: "/_/",
    // Listed on the hub. ExposeAdmin is already the decision about whether
    // this is public at all — once it is, the mount is reachable by anyone
    // who guesses "/db", so omitting it from the index would hide it from
    // the operator and nobody else. Set ExposeAdmin = false to stay headless.
    listed: true,
  });
}

/**
 * Owns whether the admin UI is currently published, and keeps the startup box
 * honest about it. See utils/tlib-publication.js for the state machine.
 */
const publisher = tlibPublication.createPublisher({
  mount: TLIB_MOUNT,
  register: registerWithTLib,
  logger,
  // Always a non-empty URL: the publisher refuses a mount it cannot advertise.
  onPublished: (url) => {
    startupStatus.mounted = true;
    finalUrl = url;
    startupStatus.publicUrl = url;
    // The startup box has already printed by the time a late or retried mount
    // lands, so it cannot carry this. Say it in the log instead, otherwise the
    // last thing the operator saw was "waiting for tLib" and nothing since.
    if (startupBoxPrinted) logger.info(`Admin UI is published at ${url}/_/`);
  },
  onUnpublished: () => {
    // Stop advertising an Admin URL for a route that no longer exists. The
    // database is unaffected - scripts never went through the router.
    startupStatus.mounted = false;
    startupStatus.healthCheckPassed = null;
    // Discard any probe still in flight against the mount just withdrawn.
    routeProbeGeneration++;
    if (localUrl) {
      finalUrl = localUrl;
      startupStatus.publicUrl = localUrl;
    }
  },
  onWarning: (message) => {
    startupStatus.warnings.push(message);
    logger.warn(message);
  },
});

/**
 * Subscribe first, then query — the contract's ordering. A status transition
 * landing between the two is then caught by the subscription instead of being
 * missed by a query that ran a moment too early.
 */
function watchTLibStatus() {
  on("tLib:http:status", (snapshot) => {
    const wasPublished = publisher.published;
    publisher.handleStatus(snapshot);
    if (publisher.published && !wasPublished) revalidateRoute();
  });

  // The reset belongs on STOP, not on start. tLib emits its status as it comes
  // up, and there is no ordering guarantee between that event and the
  // onResourceStart dispatched to us - so a start handler that resets
  // unconditionally can tear down a mount this same fresh tLib already granted
  // us a moment earlier, and then register a second time against the same
  // registry. Stop clears; start only asks where things stand.
  on("onResourceStop", (resource) => {
    if (resource !== "tLib") return;
    publisher.handleTLibRestart();
  });

  on("onResourceStart", (resource) => {
    if (resource !== "tLib") return;
    publisher.handleStatus(readTLibHttpStatus());
    if (publisher.published) revalidateRoute();
  });
}

// Bumped whenever the thing being probed changes. A probe waits up to 5s, and
// tLib can stop inside that window - so a result is only allowed to land if
// it still describes the mount we currently hold.
let routeProbeGeneration = 0;

/** Re-probe the mount after it is (re)published, and refresh the status box. */
async function revalidateRoute() {
  const generation = ++routeProbeGeneration;
  const url = publisher.healthUrl();

  // No listener address means the probe cannot run, which is not the same as
  // the probe failing. Reporting "not reachable" for something never dialled
  // would send the operator to debug a route that is probably fine.
  const result = url ? await checkRouteHealth(url) : null;

  // Superseded, or the mount went away while we were waiting on it. Writing
  // this answer now would describe a route that no longer exists.
  if (generation !== routeProbeGeneration || !publisher.published) return;

  startupStatus.healthCheckPassed = result;
}

async function createSuperuser(pbPath, publicIP) {
  let email = config.Superuser.Email;
  let password = config.Superuser.Password;
  let needsConfigUpdate = false;

  // Check if config has credentials
  const hasConfigCredentials =
    email && email !== "" && password && password !== "";

  // If config is empty, generate credentials
  if (!hasConfigCredentials) {
    const domain = publicIP || "localhost";
    email = `admin@${domain}.local`;
    password = generateRandomPassword();
    needsConfigUpdate = true;
  }

  // Remember the credentials the instance is actually provisioned with, so a
  // later repair can re-apply exactly these.
  activeSuperuser = { email, password };

  let attempt = await upsertSuperuser(pbPath, email, password);

  // One retry: on a cold start the first call can race the database file
  // being created.
  if (!attempt.ok) {
    logger.debug(`Superuser provisioning retrying (${attempt.detail})`);
    attempt = await upsertSuperuser(pbPath, email, password);
  }

  if (!attempt.ok) {
    startupStatus.errors.push(`Failed to configure superuser: ${attempt.detail}`);
    return false;
  }

  // Update config file with generated credentials (only if we generated them)
  if (needsConfigUpdate) {
    const updated = configLoader.updateSuperuserCredentials(email, password);
    if (!updated) {
      startupStatus.warnings.push("Failed to save credentials to config.lua");
    }
    // Store for display (only if newly generated)
    startupStatus.superuserEmail = email;
    startupStatus.superuserPassword = password;
  }

  return true;
}

/**
 * Re-provision the superuser against a running instance and ask the client to
 * authenticate again.
 *
 * PocketBase reads superusers from the database on each request, so this takes
 * effect without a restart. It exists so the resource can never strand a server
 * owner on the web installer: the resource has to work headless, with the admin
 * UI staying optional.
 */
async function repairSuperuser(pbPath, reason) {
  if (superuserRepairAttempted) return false;
  superuserRepairAttempted = true;

  if (!activeSuperuser) {
    startupStatus.warnings.push(
      "Superuser repair skipped - no credentials resolved",
    );
    return false;
  }

  logger.warn(`Repairing superuser account (${reason})`);

  const attempt = await upsertSuperuser(
    pbPath,
    activeSuperuser.email,
    activeSuperuser.password,
  );

  if (!attempt.ok) {
    startupStatus.errors.push(`Superuser repair failed: ${attempt.detail}`);
    return false;
  }

  logger.info("Superuser account repaired - re-authenticating");

  // Hand the credentials over explicitly rather than letting the client re-read
  // config.lua: its loader caches on first load, so it may still hold the
  // values from before provisioning rewrote them.
  emit("pocketbase:server:reauth", {
    email: activeSuperuser.email,
    password: activeSuperuser.password,
  });
  return true;
}

// ============================================================================
// Auto Update
// ============================================================================
async function checkAndUpdate(pbPath) {
  if (!config.AutoUpdate) {
    return true;
  }

  const result = await spawnWithTimeout(
    pbPath,
    ["update"],
    { cwd: resourcePath, stdio: "pipe" },
    30000,
  );

  if (result.code !== 0) {
    startupStatus.warnings.push("Update check failed, using current version");
  }
  return true;
}

// ============================================================================
// Migration Management
// ============================================================================
async function applyPendingMigrations(pbPath) {
  if (!config.Migrations.AutoApply) {
    return;
  }

  try {
    const result = await spawnWithTimeout(
      pbPath,
      [
        "migrate",
        "up",
        "--dir",
        config.Advanced.DataDir,
        "--migrationsDir",
        config.Migrations.Dir,
      ],
      { cwd: resourcePath },
      30000,
    );

    if (result.code === 0) {
      const output = result.stdout.trim();
      // Only log if migrations were actually applied
      if (
        output &&
        !output.includes("No migrations") &&
        output.includes("Applied")
      ) {
        const count = (output.match(/Applied/g) || []).length;
        logger.info(`Applied ${count} migration${count !== 1 ? "s" : ""}`);
      }
    } else if (
      result.stderr.includes("no migration") ||
      result.stdout.includes("No migrations")
    ) {
      // No migrations to apply, not an error - stay silent
      return;
    } else {
      startupStatus.warnings.push(
        "Failed to apply migrations - check pb_migrations directory",
      );
    }
  } catch (err) {
    startupStatus.warnings.push(`Migration error: ${err.message}`);
  }
}

// ============================================================================
// Config Validation
// ============================================================================
function validateConfig() {
  const errors = [];

  // Check if remote mode is configured
  const isRemote =
    config.Advanced.RemoteHost !== "" && config.Advanced.RemotePort !== "";

  // Validate remote mode configuration
  if (isRemote) {
    if (!config.Superuser.Email || !config.Superuser.Password) {
      errors.push(
        "Remote mode requires Superuser.Email and Superuser.Password to be configured",
      );
    }
    if (config.Superuser.Email && !config.Superuser.Email.includes("@")) {
      errors.push(`Invalid superuser email format: ${config.Superuser.Email}`);
    }
    // Remote mode doesn't need other validations (no local port, no SMTP/S3/Backup)
    if (errors.length > 0) {
      startupStatus.errors.push(...errors);
      return false;
    }
    return true;
  }

  // Local mode validations
  // No port validation. config.Port is not operator input any more — it is
  // resolved at startup by resolveInternalPort(), which can only produce a port
  // it has just successfully bound.

  // Validate superuser email format if provided
  if (config.Superuser.Email && !config.Superuser.Email.includes("@")) {
    errors.push(`Invalid superuser email format: ${config.Superuser.Email}`);
  }

  // Validate SMTP settings if enabled
  if (config.Advanced.SMTP.Enabled) {
    if (!config.Advanced.SMTP.Host) {
      errors.push("SMTP enabled but Host is empty");
    }
    if (!config.Advanced.SMTP.Port || config.Advanced.SMTP.Port < 1) {
      errors.push("SMTP enabled but Port is invalid");
    }
  }

  // Validate S3 settings if enabled
  if (config.Advanced.S3.Enabled) {
    if (!config.Advanced.S3.Bucket) {
      errors.push("S3 enabled but Bucket is empty");
    }
    if (!config.Advanced.S3.Region) {
      errors.push("S3 enabled but Region is empty");
    }
  }

  // Validate backup settings
  if (config.Backup.Enabled) {
    if (config.Backup.KeepLast < 0) {
      errors.push("Backup.KeepLast must be >= 0");
    }
    if (config.Backup.Schedule < 0) {
      errors.push("Backup.Schedule must be >= 0");
    }
  }

  if (errors.length > 0) {
    startupStatus.errors.push(...errors);
    return false;
  }

  return true;
}

// ============================================================================
// Backup Service
// ============================================================================
async function createBackup(basename) {
  try {
    const result = await global.pbInternalCreateBackup(basename);
    return result;
  } catch (err) {
    startupStatus.warnings.push(`Backup creation failed: ${err.message}`);
    return null;
  }
}

async function listBackups() {
  try {
    return await global.pbInternalListBackups();
  } catch (err) {
    return [];
  }
}

async function deleteBackup(key) {
  try {
    await global.pbInternalDeleteBackup(key);
    return true;
  } catch (err) {
    return false;
  }
}

async function manageBackupRotation() {
  if (!config.Backup.Enabled || config.Backup.KeepLast <= 0) {
    return;
  }

  const backups = await listBackups();
  if (backups.length <= config.Backup.KeepLast) {
    return;
  }

  // Filter only auto-created backups
  const autoBackups = backups
    .filter((b) => b.key.startsWith(config.Backup.BackupPrefix))
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  // Delete oldest backups beyond KeepLast
  const toDelete = autoBackups.slice(config.Backup.KeepLast);
  for (const backup of toDelete) {
    const deleted = await deleteBackup(backup.key);
    if (deleted) {
      logger.debug(`Deleted old backup: ${backup.key}`);
    }
  }
}

async function performStartupBackup() {
  if (!config.Backup.Enabled || !config.Backup.OnStartup) {
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const basename = `${config.Backup.BackupPrefix}startup_${timestamp}`;

  logger.debug("Creating startup backup...");
  const result = await createBackup(basename);

  if (result) {
    logger.debug(`Startup backup created: ${basename}`);
    await manageBackupRotation();
  }
}

async function scheduleBackups() {
  if (!config.Backup.Enabled || config.Backup.Schedule <= 0) {
    return;
  }

  const intervalMs = config.Backup.Schedule * 1000;

  setInterval(async () => {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    const basename = `${config.Backup.BackupPrefix}scheduled_${timestamp}`;

    logger.debug("Creating scheduled backup...");
    const result = await createBackup(basename);

    if (result) {
      logger.debug(`Scheduled backup created: ${basename}`);
      await manageBackupRotation();
    }
  }, intervalMs);

  logger.debug(
    `Scheduled backups enabled: every ${config.Backup.Schedule} seconds`,
  );
}

// ============================================================================
// Settings Management (SMTP/S3)
// ============================================================================
// The rules, and the measurement that forces them, are in utils/settings.js.
// The short version: settings only ever travel config.lua -> PocketBase,
// because PocketBase will not hand back the SMTP password or the S3 secret,
// so a sync in the other direction blanks them.
async function reconcileSettings() {
  // Somebody else's instance is not ours to reconfigure.
  if (startupStatus.isRemoteMode) return;

  const outcome = await settings.reconcile(
    {
      getSettings: () => global.pbInternalGetSettings(),
      updateSettings: (patch) => global.pbInternalUpdateSettings(patch),
    },
    config.Advanced,
    logger,
  );

  // Surfaced in the startup box, not just the log, so an overwrite is seen.
  for (const warning of outcome.warnings) startupStatus.warnings.push(warning);
}

// ============================================================================
// PocketBase Process Management
// ============================================================================
let pocketbaseProcess = null;

async function startPocketBase() {
  // Check if we're in remote mode
  const isRemote =
    config.Advanced.RemoteHost !== "" && config.Advanced.RemotePort !== "";

  startupStatus.isRemoteMode = isRemote;

  if (isRemote) {
    // Remote mode - connect to existing PocketBase instance
    await connectToRemotePocketBase();
    return;
  }

  // Local mode - start our own PocketBase instance
  // Validate configuration
  if (!validateConfig()) {
    displayStartupStatus();
    return;
  }

  // Get executable path
  const pbPath = getPocketBasePath();
  if (!pbPath) {
    startupStatus.errors.push("PocketBase executable not found");
    displayStartupStatus();
    return;
  }

  startupStatus.executablePath = pbPath;

  // Clear a PocketBase left over from an unclean shutdown before anything else
  // touches the data directory.
  //
  // This has to precede createSuperuser and applyPendingMigrations, not just the
  // `serve` spawn: those run the binary against the same SQLite directory, so an
  // orphan still holding it makes them fail first, and the resulting error
  // points at the database rather than at the real cause.
  if (!(await pidGuard.clearOrphan(resourcePath, pbPath, logger))) {
    startupStatus.errors.push(
      "A PocketBase process from a previous run is still running and could not be stopped",
    );
    displayStartupStatus();
    return;
  }

  // Check for updates
  await checkAndUpdate(pbPath);

  // PocketBase ALWAYS binds loopback now. It never opens a public port of its
  // own — external reachability is tLib's decision, not PocketBase's, and it
  // is granted by registering a mount on the tLib router (see registerWithTLib
  // below). Config.ExposeAdmin therefore no longer selects a bind address; it
  // selects whether we ask for that mount at all.
  //
  // The port is internal and no longer configured. It is resolved further down,
  // immediately before the spawn — NOT here. Everything between this point and
  // the spawn (superuser provisioning, migrations, a startup backup) can take
  // seconds, and a port proven free at the top of that window says nothing
  // about the bottom of it.
  //
  // Assigned once the port exists. `localUrl` and `finalUrl` are module-level
  // (see their declarations near startupStatus): the publication callbacks run
  // long after this function returns, when tLib's HTTP goes up or comes back,
  // and they need the loopback address to fall back to.
  let bindAddress = "";

  startupStatus.exposeAdmin = config.ExposeAdmin;

  // Create/update superuser before starting server
  // No public IP to pass any more: PocketBase is loopback-only. This only
  // affects the auto-generated superuser email on a first run with empty
  // credentials (admin@localhost.local instead of admin@<ip>.local), and those
  // credentials are written back to config.lua — so existing installs, which
  // already have credentials, are unaffected. Not deriving it from a public IP
  // is also the more stable choice on a host whose address changes.
  const superuserSuccess = await createSuperuser(pbPath, null);
  if (!superuserSuccess) {
    displayStartupStatus();
    return;
  }

  // Apply pending migrations before starting server
  await applyPendingMigrations(pbPath);

  // Perform startup backup before starting server
  await performStartupBackup();

  // Build arguments
  //
  // --migrationsDir is passed explicitly rather than left to default. Without
  // it PocketBase derives the directory from the data dir as
  // `<dataDir>/../pb_migrations`, which makes Config.Migrations.Dir a setting
  // that silently does nothing - and, for any instance whose data dir is not
  // under the resource, quietly shares a migrations directory with every other
  // instance next to it. PocketBase writes a migration file for every
  // collection change, so a shared directory means one instance's edits are
  // replayed into the next one that starts.
  const buildArgs = () => {
    const a = [
      "serve",
      `--http=${bindAddress}`,
      `--dir=${config.Advanced.DataDir}`,
      `--publicDir=${config.Advanced.PublicDir}`,
      `--migrationsDir=${config.Migrations.Dir}`,
    ];
    if (config.Advanced.Dev) a.push("--dev");
    if (!config.Advanced.AutoMigrate) a.push("--automigrate=false");
    return a;
  };

  // -- Resolve the port and bind, together, with retries --
  //
  // resolveInternalPort() proves a port free by binding it and letting go, so
  // between that release and PocketBase's own bind there is a window where
  // something else can take it. Small, but not theoretical: two FXServer
  // instances on one machine, each with tDB, starting together will both probe
  // 8090, both see it free, and both try to bind it. One loses.
  //
  // So the probe is a fast path, not a guarantee, and PocketBase's own bind is
  // the arbiter. A bind failure is fast and unambiguous (Go exits immediately
  // with "bind:" on stderr), so losing the race costs one retry on a different
  // port rather than a failed start the operator has no setting left to fix.
  const { spawn } = require("child_process");
  const MAX_BIND_ATTEMPTS = 3;
  let bound = false;

  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS && !bound; attempt++) {
    // After a lost race, stop asking for the preferred port -- something else
    // clearly wants it, and a second collision on the same number is likelier
    // than on an OS-chosen one.
    const resolvedPort = await resolveInternalPort(attempt > 1);
    if (!resolvedPort) {
      startupStatus.errors.push(
        "No free loopback port is available for PocketBase - this machine has exhausted its port range",
      );
      displayStartupStatus();
      return;
    }

    config.Port = resolvedPort;
    bindAddress = `127.0.0.1:${config.Port}`;
    localUrl = `http://127.0.0.1:${config.Port}`;
    finalUrl = localUrl;
    startupStatus.bindAddress = bindAddress;
    startupStatus.publicUrl = finalUrl;

    pocketbaseProcess = spawn(pbPath, buildArgs(), {
      cwd: resourcePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outcome = await confirmBind(pocketbaseProcess, config.Port);
    if (outcome.ok) {
      bound = true;
      break;
    }

    // Not a bind collision -- a real startup failure. Retrying on another port
    // would fail the same way three times and bury the actual reason.
    if (!outcome.bindConflict) {
      startupStatus.errors.push(
        `PocketBase exited during startup: ${outcome.detail || "no output"}`,
      );
      displayStartupStatus();
      return;
    }

    if (attempt === MAX_BIND_ATTEMPTS) {
      startupStatus.errors.push(
        `PocketBase could not bind a loopback port after ${MAX_BIND_ATTEMPTS} attempts: ${outcome.detail}`,
      );
      displayStartupStatus();
      return;
    }

    logger.warn(
      `Lost the race for loopback port ${config.Port} - retrying on another port ` +
        `(attempt ${attempt + 1}/${MAX_BIND_ATTEMPTS})`,
    );
  }

  // Recorded only once the bind is confirmed. Writing it per attempt would let
  // a losing attempt's exit handler clear the record belonging to the attempt
  // that actually won.
  if (pocketbaseProcess.pid) {
    pidGuard.write(resourcePath, pocketbaseProcess.pid, pbPath, logger);
  }

  pocketbaseProcess.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // PocketBase logs its own bind address, which is now always loopback and
      // therefore not a link anyone outside can use. Point it at the routed URL
      // instead. A no-op when there is no mount, since finalUrl is localUrl.
      line = line.replace(/http:\/\/(?:0\.0\.0\.0|127\.0\.0\.1):\d+/g, finalUrl);

      // Skip the default PocketBase startup messages - we'll show our own
      if (
        line.includes("Server started at") ||
        line.includes("REST API:") ||
        line.includes("Dashboard:") ||
        line.startsWith("├─") ||
        line.startsWith("└─")
      ) {
        continue;
      }

      // PocketBase only prints its installer banner when the instance has no
      // superuser at all. Since one is provisioned before `serve`, seeing this
      // means provisioning silently failed - so repair it rather than hiding
      // it. Suppressing the line (as this used to do) left the owner staring
      // at a setup page the resource is supposed to make unnecessary.
      if (
        line.includes("Launch the URL below") ||
        line.includes("create your first superuser account") ||
        line.includes("/_/#/pbinstall/")
      ) {
        if (!superuserRepairAttempted) {
          repairSuperuser(pbPath, "PocketBase reported no superuser exists");
        }
        continue;
      }

      logger.debug(line);
    }
  });

  pocketbaseProcess.stderr.on("data", (data) => {
    let output = data.toString().trim();
    if (output) {
      // Same rewrite as stdout — see above.
      output = output.replace(/http:\/\/(?:0\.0\.0\.0|127\.0\.0\.1):\d+/g, finalUrl);
      logger.warn(output);
    }
  });

  pocketbaseProcess.on("close", (code) => {
    // The process is gone, so the record now describes nothing. Removing it here
    // rather than only in stopPocketBase covers the case where PocketBase exits
    // on its own — otherwise the next start would probe a dead pid.
    pidGuard.clear(resourcePath);
    if (code !== 0 && code !== null) {
      logger.error(`PocketBase exited with code ${code}`);
    } else {
      logger.info("PocketBase stopped");
    }
  });

  pocketbaseProcess.on("error", (err) => {
    startupStatus.errors.push(`Failed to start PocketBase: ${err.message}`);
    displayStartupStatus();
  });

  // Give it a moment to start, then perform health check and display status
  setTimeout(async () => {
    if (pocketbaseProcess && !pocketbaseProcess.killed) {
      // PocketBase is listening — only now is a mount valid. Registering
      // earlier would advertise a route that 502s.
      //
      // Whether we want one at all is the operator's setting, untouched here.
      if (config.ExposeAdmin) {
        publisher.want(true);
        // Subscribe before querying. A transition landing between the two is
        // then caught by the subscription rather than lost, which is the
        // difference between "the admin UI came up a second late" and "the
        // admin UI never came up this boot".
        watchTLibStatus();
        publisher.handleStatus(readTLibHttpStatus());
      } else {
        logger.debug("ExposeAdmin is false — staying headless, no mount requested");
      }

      // Emit ready event for client.js to listen to immediately.
      // `url` stays the loopback address: this is what in-process consumers
      // (the oxmysql adapter, hooks) talk to, and it must not depend on the
      // router being up.
      emit("pocketbase:server:ready", {
        url: localUrl,
        port: config.Port,
        exposeAdmin: config.ExposeAdmin,
      });

      // Wait for client authentication status
      const clientReadyPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          startupStatus.clientAuthenticated = false;
          resolve();
        }, 3000);

        on("pocketbase:client:ready", (data) => {
          clearTimeout(timeout);
          startupStatus.clientAuthenticated = data.authenticated;
          resolve();
        });
      });

      await clientReadyPromise;

      // A local instance that refuses our own credentials has a missing or
      // mismatched superuser: re-provision it and give the client one more go,
      // so a broken pb_data never requires the web installer to recover.
      if (startupStatus.clientAuthenticated === false) {
        const repaired = await repairSuperuser(
          pbPath,
          "client could not authenticate against the local instance",
        );
        if (repaired) {
          startupStatus.clientAuthenticated = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 5000);
            on("pocketbase:client:ready", (data) => {
              clearTimeout(timeout);
              resolve(data.authenticated);
            });
          });
        }
      }

      // Hooks are an internal concern — always check them over loopback, which
      // works whether or not a mount exists.
      startupStatus.hooksHealthy = await checkHooksHealth(localUrl);

      // Only meaningful once the router actually accepted a mount. Headless is
      // not a degraded state and has nothing to probe, and neither is a mount
      // still pending on a tLib listener that has not finished coming up —
      // revalidateRoute() picks that up when it does.
      if (startupStatus.mounted) await revalidateRoute();

      // Before the banner, and awaited. It was a floating 2s setTimeout, which
      // meant a drift warning it raised landed after the status box had already
      // printed - and was dropped entirely if the resource stopped first.
      await reconcileSettings();

      // Display status after everything is ready
      displayStartupStatus();

      // Schedule periodic backups
      await scheduleBackups();
    }
  }, 1000);
}

async function connectToRemotePocketBase() {
  logger.info("Connecting to remote PocketBase instance...");

  // Build remote URL
  const remoteUrl = buildSmartUrl(
    config.Advanced.RemoteHost,
    config.Advanced.RemotePort,
  );

  if (!remoteUrl) {
    startupStatus.errors.push("Invalid remote host configuration");
    displayStartupStatus();
    return;
  }

  startupStatus.publicUrl = remoteUrl;
  startupStatus.bindAddress = "N/A (Remote)";

  // Check if remote instance is accessible
  startupStatus.healthCheckPassed = await checkPublicUrlHealth(remoteUrl);

  if (!startupStatus.healthCheckPassed) {
    startupStatus.clientAuthenticated = false;
    displayStartupStatus();
    return;
  }

  // Emit ready event for client.js to connect
  emit("pocketbase:server:ready", {
    url: remoteUrl,
    port: config.Advanced.RemotePort,
    exposeAdmin: true, // Remote is always "exposed"
    isRemote: true,
  });

  // Wait for client authentication status
  const clientReadyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      startupStatus.clientAuthenticated = false;
      resolve();
    }, 5000);

    on("pocketbase:client:ready", (data) => {
      clearTimeout(timeout);
      startupStatus.clientAuthenticated = data.authenticated;
      resolve();
    });
  });

  await clientReadyPromise;

  // Check if hooks are healthy
  startupStatus.hooksHealthy = await checkHooksHealth(remoteUrl);

  // Display connection status
  displayStartupStatus();
}

async function stopPocketBase() {
  if (startupStatus.isRemoteMode) {
    logger.info("Disconnecting from remote PocketBase...");
    return;
  }

  // Nothing is written back to config.lua here any more. Shutdown used to read
  // the instance's settings and rewrite config.lua from them, which blanked the
  // SMTP password and S3 secret (PocketBase never returns those) and replayed a
  // config.lua snapshot taken at boot over any edit made since. Settings now
  // travel one way, at startup - see reconcileSettings().

  if (pocketbaseProcess && !pocketbaseProcess.killed) {
    logger.info("Shutting down PocketBase...");
    pocketbaseProcess.kill("SIGTERM");

    // Force kill after 5 seconds if not stopped
    setTimeout(() => {
      if (pocketbaseProcess && !pocketbaseProcess.killed) {
        logger.warn("Force killing PocketBase process");
        pocketbaseProcess.kill("SIGKILL");
      }
    }, 5000);
  }
}

// ============================================================================
// Shutdown Handlers
// ============================================================================
process.on("SIGINT", () => {
  stopPocketBase().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  stopPocketBase().then(() => process.exit(0));
});
process.on("beforeExit", () => {
  stopPocketBase();
});

// ============================================================================
// Start
// ============================================================================
startPocketBase();
