const fs = require("fs");
const path = require("path");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const configLoader = require("./server/utils/config-loader.js");
const { spawnBroker, spawnWithTimeout } = require("./server/utils/process-utils.js");
// Paths resolve from the resource root, not from this file: FiveM's Node runtime
// loads server_scripts with the resource directory as the base.
const pidGuard = require("./server/utils/pid-guard.js");
const settings = require("./server/utils/settings.js");
const tlibPublication = require("./server/utils/tlib-publication.js");

// The route probe. Three dials 500ms apart bound the boot-time race between a
// mount being registered and the first request through it succeeding, without
// making a genuinely broken route take long to report: a refused connection
// answers instantly, so the whole sequence costs ~1s in that case.
const ROUTE_PROBE_ATTEMPTS = 3;
const ROUTE_PROBE_BACKOFF_MS = 500;
const ROUTE_PROBE_TIMEOUT_MS = 5000;

// Bare FiveM colour codes, for the startup rows. tLib's renderer prefixes the
// row's colour to each line it emits, so a row's value must NOT carry its own
// codes - an embedded `^7` resets the colour mid-row.
//
// ⚠️ Only problem states carry a colour; no colour renders white, which is
// what tRadio's whole box does. Note `^6` is PURPLE in FiveM's palette and
// `^5` is cyan - constants here were once named the other way round, which is
// how two decorative rows ended up purple.
const RED = "^1";
const YELLOW = "^3";
const GREY = "^8";

// `debug` is filtered, the other levels are not, matching tLib's own logger.
// It used to print unconditionally, which made it a second INFO channel in a
// different colour: the pid-file sweep, every route probe and each backup, on
// every boot.
//
// applyLogLevel() sets the flag once the config is parsed, which is after this
// module loads, so anything logged before then stays filtered.
let debugEnabled = false;

function applyLogLevel(config) {
  debugEnabled = config?.Debug === true;
}

// One tag for the whole resource. This half used to print `[PocketBase]`, which
// named the embedded project rather than tDB: a fault in tDB's own supervisor
// code reported under someone else's name, and a relayed line from the real
// PocketBase process was indistinguishable from a tDB line about it. Where that
// distinction matters the subsystem goes inside the message instead - see the
// `pocketbase:` prefix on the two stdout/stderr relays.
//
// INFO carries no colour. Only problem states are coloured; see the banner
// note above.
const logger = {
  info: (msg) => console.log(`[tDB] ${msg}`),
  warn: (msg) => console.log(`^3[tDB]^7 ${msg}`),
  error: (msg) => console.log(`^1[tDB]^7 ${msg}`),
  debug: (msg) => {
    if (debugEnabled) console.log(`^5[tDB]^7 ${msg}`);
  },
  raw: (msg) => console.log(msg),
};

const startupStatus = {
  executablePath: "",
  superuserEmail: "",
  /** Only ever set on the run that generated it. Redacted in the banner
   *  otherwise - see displayStartupStatus(). */
  superuserPassword: "",
  /** True only on the boot that created the credentials, which is the one boot
   *  the password is printed on. */
  superuserGenerated: false,
  publicUrl: "",
  /** Config.ExposeAdmin: whether a mount was wanted. */
  exposeAdmin: false,
  /** Whether tLib actually accepted one. Conflating this with exposeAdmin is
   *  what made a failed registration print a loopback address under "Admin". */
  mounted: false,
  isRemoteMode: false,
  /** true / false / null, where null means "not checked" - an unchecked route and
   *  a broken one are different, and a tLib that has not answered GetHttpStatus
   *  cannot tell us where its listener is. */
  healthCheckPassed: null,
  /** What the last route probe actually saw ("HTTP 404", "ECONNREFUSED", ...)
   *  and which URL it dialled. A verdict the operator cannot act on is the
   *  thing this pair exists to stop: "check tLib's log" is not a diagnosis. */
  routeProbeDetail: null,
  routeProbeUrl: null,
  clientAuthenticated: null,
  hooksHealthy: null,
  errors: [],
  warnings: [],
  // Files a server owner declared and tDB could not apply. Separate from
  // `errors` because these outlive startup: the database is up and healthy, the
  // schema is simply not what the operator asked for.
  sqlFailures: [],
};

// Where PocketBase itself is listening. Every internal check talks to this, and
// it stays correct whether or not the admin UI is reachable from outside.
let localUrl = "";
// What the operator is shown, and what PocketBase's own log lines are rewritten
// to. Loopback until tLib accepts the mount, and back again if it is withdrawn.
let finalUrl = "";

// Credentials the local instance is actually provisioned with, kept so a repair
// can re-apply them. The latch keeps repair to once per start.
let activeSuperuser = null;
let superuserRepairAttempted = false;

const resourceName = GetCurrentResourceName();
const resourcePath = GetResourcePath(resourceName);

const config = configLoader.load(resourcePath);
applyLogLevel(config);
logger.debug("Configuration loaded");

// A key the parser could not read, or a deprecated one it read anyway. These go
// in the startup box as well as the log: a setting that quietly did nothing is
// the single most expensive config bug to support.
for (const warning of configLoader.getWarnings()) {
  logger.warn(warning);
  startupStatus.warnings.push(warning);
}

// ── How PocketBase gets run ──────────────────────────────────────────────────
//
// Not a path. tLib's spawn catalog knows where tDB's PocketBase binary lives
// (`.runtime/pocketbase-win.exe` / `-linux`) and resolves it itself; naming a
// path here would be refused, and that refusal is the point of the design.
const POCKETBASE_PROGRAM = "pocketbase";

// The resource root, expressed the way tLib's catalog declares it. It is not a
// default: omitting cwd puts PocketBase in the binary's own directory, which is
// `.runtime/`, and every directory argument below (--dir `.runtime/pb_data`,
// --publicDir `pb_public`, --hooksDir `pb_hooks`) is relative to the resource
// root. Running from `.runtime/` resolves all three one level too deep.
const POCKETBASE_CWD = "";

// The name the long-lived `serve` process is filed under inside tLib. tLib keys
// its process table by (resource, key), so this is what SpawnUnserve addresses
// and what tLib reaps on tDB's onResourceStop. One process, one key.
const POCKETBASE_KEY = "pocketbase";

/** How often tLib's output ring is drained for the serving process. tLib keeps
 *  200 lines per process; PocketBase does not write anywhere near that in a
 *  quarter second, so nothing is discarded before it is read. */
const OUTPUT_POLL_MS = 250;

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

  const binPath = path.join(resourcePath, ".runtime");
  const exeName = os === "windows" ? "pocketbase-win.exe" : "pocketbase-linux";
  const fullPath = path.join(binPath, exeName);

  if (!fs.existsSync(fullPath)) {
    logger.error(`PocketBase executable not found at: ${fullPath}`);
    return null;
  }

  if (os === "linux") {
    try {
      fs.chmodSync(fullPath, "755");
    } catch (err) {
      logger.warn(`Could not set executable permissions: ${err.message}`);
    }
  }

  return fullPath;
}

// REMOTE mode only. tDB has no public address of its own; the admin UI appears
// wherever tLib's router reports.
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
    /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(hostParam) && !/^\d+\.\d+\.\d+\.\d+/.test(hostParam);

  // A bare domain is assumed to be fronted by TLS on 443, so RemotePort is
  // deliberately not appended. A bare IP or hostname keeps the port.
  if (isDomain) {
    return `https://${hostParam}`;
  }

  return `http://${hostParam}:${port}`;
}

// Reported by the client half once the SQL importer has run. Kept as state
// rather than logged and forgotten: a console line at boot is read hours after
// the symptom reaches a player, which is the failure mode this exists to stop.
global.tdbReportSqlFailures = (failures) => {
  startupStatus.sqlFailures = Array.isArray(failures) ? failures : [];

  if (!startupStatus.sqlFailures.length) {
    if (sqlFailureReminder) {
      clearInterval(sqlFailureReminder);
      sqlFailureReminder = null;
    }
    return;
  }

  // Repeats, because whoever reads the log is rarely the person who saw the
  // boot. Cleared as soon as a later import succeeds.
  if (!sqlFailureReminder) {
    sqlFailureReminder = setInterval(
      () => {
        for (const failure of startupStatus.sqlFailures) {
          logger.error(
            `SQL import still unresolved: ${failure.file} did not apply, so its tables ` +
              `do not exist. Fix the file and restart, or run 'tdb sql status'.`
          );
        }
      },
      5 * 60 * 1000
    );
  }
};

let sqlFailureReminder = null;

// The box is printed once. After that, anything that changes publication has to
// report itself in the log.
let startupBoxPrinted = false;

function displayStartupStatus() {
  startupBoxPrinted = true;

  // One row per fact. Three constraints from tLib's renderer, each of which
  // this got wrong once:
  //
  //   - a value's own newlines render as CONTINUATION lines, indented 12
  //     spaces with no key, so a multi-fact value sits at a different indent
  //     from every other box and wraps mid-phrase
  //   - values are PLAIN TEXT; tLib prefixes the row colour to each line, so
  //     an embedded `^7` resets it part-way through
  //   - keys stay within 8 characters or they overrun the 10-column gutter
  const rows = [];
  const row = (key, value, color) => {
    if (value === undefined || value === null || value === "") return;
    rows.push(color ? { key, value, color } : { key, value });
  };

  // ⚠️ MUST stay above the Status row. This is the only thing that discovers
  // an auth, hooks or routing failure, and it reports by pushing into
  // `errors`/`warnings`. Decided after Status, a server whose client never
  // authenticated still printed `System ready`.
  let healthStatus = "";
  let healthFailed = false;

  // Auth issues first, then hooks health, then network health.
  if (startupStatus.clientAuthenticated === false) {
    healthStatus = "Authentication failed";
    healthFailed = true;
    if (startupStatus.isRemoteMode) {
      startupStatus.errors.push(
        "Failed to authenticate with remote PocketBase - check superuser credentials"
      );
    } else {
      startupStatus.warnings.push("Client failed to authenticate - check superuser credentials");
    }
  } else if (startupStatus.isRemoteMode && startupStatus.healthCheckPassed === false) {
    healthStatus = "Connection failed";
    healthFailed = true;
    startupStatus.errors.push(
      `Could not connect to remote PocketBase instance at ` +
        `${startupStatus.routeProbeUrl} (${startupStatus.routeProbeDetail})`
    );
  } else if (startupStatus.hooksHealthy === false) {
    healthStatus = "Hooks failed to load";
    healthFailed = true;
    startupStatus.warnings.push("PocketBase hooks (pb_hooks) failed to initialize");
  } else if (startupStatus.clientAuthenticated === true) {
    if (startupStatus.isRemoteMode) {
      healthStatus = "Connected";
    } else if (startupStatus.mounted) {
      if (startupStatus.healthCheckPassed === true) {
        healthStatus = "Started";
      } else if (startupStatus.healthCheckPassed === false) {
        healthStatus = "Not reachable through tLib";
        healthFailed = true;
        // A ROUTING failure, checked over loopback, so port forwarding is not
        // what failed here - don't send the operator to their router config.
        // The URL and what came back are both named: without them the only
        // actionable half of this warning was "check tLib's log", and the
        // operator's next move is to open that exact URL themselves.
        startupStatus.warnings.push(
          `tLib accepted the mount but ${startupStatus.routeProbeUrl} did not ` +
            `answer 200 after ${ROUTE_PROBE_ATTEMPTS} attempts ` +
            `(${startupStatus.routeProbeDetail}); check tLib's log`
        );
      } else {
        // null: never dialled, because readTLibHttpStatus() returned null -- tLib
        // not started yet, or its router failed and warned for itself.
        healthStatus = "Started (route not checked)";
      }
    } else {
      // Headless, by config or because the mount failed. Either way the
      // database itself works; registerWithTLib has already said why.
      healthStatus = "Started";
    }
  }

  // One verdict, not two. `Health: Started` under `Status: System ready` said
  // the same thing on every healthy boot, so the failure branches carry the
  // health text instead - "Authentication failed" IS the status.
  if (startupStatus.sqlFailures.length > 0) {
    // Ahead of everything else: a missing table is not a degraded feature,
    // it is a resource that fails at its first query, which surfaces hours
    // later as a player-facing fault with nothing pointing back here.
    row("Status", "SQL import FAILED", RED);
  } else if (healthFailed) {
    row("Status", healthStatus, RED);
  } else if (startupStatus.errors.length > 0) {
    row("Status", "Startup failed", RED);
  } else if (startupStatus.warnings.length > 0) {
    row("Status", `Running with warnings`, YELLOW);
  } else {
    // The healthy health texts ("Started", "Connected") add nothing to "ready";
    // the one that does is the un-dialled route, so it alone is carried over.
    row(
      "Status",
      healthStatus === "Started (route not checked)"
        ? "System ready (route not checked)"
        : "System ready"
    );
  }

  // "Published" means a mount is live, not merely requested.
  if (startupStatus.isRemoteMode) {
    row("Mode", "Remote");
  } else if (startupStatus.mounted) {
    row("Mode", "Published via tLib");
  } else if (startupStatus.exposeAdmin && publisher.pending) {
    // A snapshot, not a verdict - the mount is claimed as soon as tLib reports
    // ready. Saying "failed" here sent people to debug a listener that was half
    // a second behind PocketBase.
    row("Mode", "Waiting for tLib's HTTP listener", YELLOW);
  } else if (startupStatus.exposeAdmin) {
    row("Mode", "Headless (mount failed)", YELLOW);
  } else {
    row("Mode", "Headless");
  }

  // Remote's URL is the one address the banner cannot otherwise imply.
  if (startupStatus.isRemoteMode) {
    row("Remote", startupStatus.publicUrl);
  }

  // Only advertise an Admin URL someone can actually open. Headless, publicUrl
  // is the loopback address, true only from a shell on the server.
  if (startupStatus.isRemoteMode || startupStatus.mounted) {
    row("Admin", `${startupStatus.publicUrl}/_/`);
  } else if (!startupStatus.exposeAdmin) {
    row("Admin", "not published (ExposeAdmin = false)", GREY);
  }

  if (startupStatus.sqlFailures.length > 0) {
    // One row rather than a block, because tLib wraps a long value on word
    // boundaries under its own key. The files are named first: that is the only
    // part an operator cannot reconstruct from the advice.
    const named = startupStatus.sqlFailures.map((f) => f.file).join(", ");
    row(
      "SQL",
      `${startupStatus.sqlFailures.length} file(s) did NOT apply: ${named}. ` +
        `Each rolled back, so NONE of its tables exist and any resource ` +
        `expecting them will fail. Run: tdb sql status`,
      RED
    );
  }

  // Credentials appear on EXACTLY ONE BOOT: the run that generated them, which
  // is the operator's only chance to read a generated password. Every later run
  // prints neither - not even a `Pass: hidden` placeholder, which named a file
  // the operator already has while a banner goes into log files, screenshots
  // and pasted support threads.
  if (startupStatus.superuserEmail && startupStatus.superuserGenerated) {
    row("Email", startupStatus.superuserEmail);
    row("Pass", startupStatus.superuserPassword);
    row(
      "Save it",
      "This is the only time these are shown. They are stored in " +
        "config.local.lua, which is gitignored and never packaged.",
      YELLOW
    );
  }

  // Joined into one row each, the way tRadio's Warnings row does it: tLib
  // renders a value's own newlines as unkeyed continuation lines, so a list
  // passed as one multi-line value is exactly the shape this change removes.
  if (startupStatus.warnings.length > 0) {
    row("Warnings", startupStatus.warnings.join("  -  "), YELLOW);
  }

  if (startupStatus.errors.length > 0) {
    row("Errors", startupStatus.errors.join("  -  "), RED);
  }

  // Lua owns the shared tLib version/banner display, so don't draw a second
  // resource-specific startup box here. JSON because a FiveM event argument
  // crossing into Lua as a table is fine, but the rows are built here and
  // consumed in one place, and a string keeps the contract obvious.
  emit("tdb:startupStatus", JSON.stringify(rows));
}

/**
 * Verify that tLib's router actually forwards our mount to us.
 *
 * Deliberately not a request to the public URL: that host is the server's WAN
 * address, unreachable from the machine itself on most networks (no NAT
 * hairpinning), so probing it reports failure on a working setup. The address
 * comes from tLib's status snapshot, never from the public origin - behind a
 * proxy that origin is https://host with no port, and the old code fell back to
 * probing 127.0.0.1:443.
 *
 * A mount is live in tLib's registry the instant RegisterWebApp returns, but
 * the first request through it can still lose a race that has nothing to do
 * with routing - the upstream is mid-bootstrap, or the listener's event loop is
 * still buried under resource start-up. One dial turned that into a permanent
 * "not reachable" on a route the operator could open in a browser a second
 * later, so this retries before it accuses anyone.
 *
 * @param {string|null} url absolute health URL, from publisher.healthUrl()
 * @returns {Promise<{ok: boolean, detail: string}>} detail names what was seen
 */
async function checkRouteHealth(url) {
  if (!url) return { ok: false, detail: "no listener address to dial" };

  let outcome = { ok: false, detail: "not dialled" };

  for (let attempt = 1; attempt <= ROUTE_PROBE_ATTEMPTS; attempt++) {
    outcome = await dialHealth(url);
    if (outcome.ok) {
      if (attempt > 1) {
        logger.debug(`Route probe succeeded on attempt ${attempt} (${url})`);
      }
      return outcome;
    }
    if (attempt < ROUTE_PROBE_ATTEMPTS) {
      logger.debug(
        `Route probe attempt ${attempt}/${ROUTE_PROBE_ATTEMPTS} on ${url}: ${outcome.detail}`
      );
      await sleep(ROUTE_PROBE_BACKOFF_MS);
    }
  }

  return outcome;
}

/** One dial. Never rejects: a probe failing is a result, not an exception. */
function dialHealth(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, detail: `malformed health URL ${url}` });
  }

  const transport = target.protocol === "https:" ? https : require("http");

  return new Promise((resolve) => {
    const req = transport.get(url, { timeout: ROUTE_PROBE_TIMEOUT_MS }, (resp) => {
      // The body is never read. Draining it frees the socket instead of
      // leaving the response paused until the agent times out.
      resp.resume();
      resolve(
        resp.statusCode === 200
          ? { ok: true, detail: "HTTP 200" }
          : { ok: false, detail: `HTTP ${resp.statusCode}` }
      );
    });
    req.on("error", (err) => resolve({ ok: false, detail: err.code || err.message }));
    // The timeout option only fires the event; the request has to be torn down
    // here or the socket outlives the verdict.
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        detail: `no response within ${ROUTE_PROBE_TIMEOUT_MS}ms`,
      });
    });
  });
}

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

function generateRandomPassword(length = 20) {
  return crypto.randomBytes(length).toString("base64").slice(0, length);
}

// `superuser upsert` creates the account or resets its password, so it doubles
// as the repair operation.
async function upsertSuperuser(email, password) {
  const result = await spawnWithTimeout(
    POCKETBASE_PROGRAM,
    ["superuser", "upsert", email, password, "--dir", config.Advanced.DataDir],
    { cwd: POCKETBASE_CWD },
    30000 // first-time database initialization is slow
  );

  // Exit code 0 alone is not proof: without "Successfully saved superuser" a
  // silent failure leaves no superuser and `serve` falls back to its
  // interactive installer.
  const saved = result.code === 0 && /Successfully saved superuser/i.test(result.stdout);

  let detail =
    (result.stderr || "").trim() || (result.stdout || "").trim() || `exit code ${result.code}`;

  // The password went in as a CLI argument, so PocketBase echoing its own usage
  // line on a rejected argument would put it straight into the startup box and
  // the server log. Scrub it out of whatever comes back rather than trusting
  // that it never does.
  if (password) detail = detail.split(password).join("[redacted]");

  return { ok: saved, detail };
}

/** Historically Config.Port's default, kept as first choice so a local
 *  `curl 127.0.0.1:8090` still works as every note about this says it does. */
const PREFERRED_INTERNAL_PORT = 8090;

/**
 * Prove a loopback port free by binding it, then release.
 *
 * `exclusive` stops the probe succeeding on a port already bound by another
 * process via SO_REUSEADDR semantics, which would make the check meaningless.
 * There is still a race in the gap before PocketBase binds, so a failure to
 * bind is reported by the caller rather than swallowed.
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

// Replaced Config.Port as an operator setting: the port is internal, registered
// with tLib programmatically, so nobody types, forwards or dials it. Returns
// null only if even an OS-chosen port could not be bound.
async function resolveInternalPort(skipPreferred = false) {
  if (!skipPreferred) {
    const preferred = await probePort(PREFERRED_INTERNAL_PORT);
    if (preferred) return preferred;
  }

  const fallback = await probePort(0);
  if (fallback) {
    if (!skipPreferred) {
      logger.info(
        `Port ${PREFERRED_INTERNAL_PORT} is in use on this machine, PocketBase will ` +
          `use loopback port ${fallback} instead. Nothing needs changing: this port is ` +
          "internal and tLib's router is told about it automatically."
      );
    }
    return fallback;
  }
  return null;
}

/** Bind-failure signatures across platforms, covering both PocketBase's wording
 *  and Go's net package underneath it. Matched case-insensitively. */
const BIND_CONFLICT = [
  "address already in use",
  "only one usage of each socket address",
  "bind: permission denied",
  "cannot assign requested address",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One TCP probe of the loopback port. Resolves true only on a completed
 *  connect - a refusal is the normal answer while PocketBase is still coming
 *  up, not an error worth reporting. */
function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * One drain of tLib's output ring for the serving process.
 *
 * Returns null - not an empty snapshot - when the broker could not be read, so
 * a caller can tell "nothing was said" from "the answer is unavailable". Reading
 * a missing key as "not alive" would end the pump on a transient hiccup and
 * silence PocketBase's log for the rest of the session.
 */
function drainOutput(api) {
  let snapshot;
  try {
    snapshot = JSON.parse(api.SpawnOutput(POCKETBASE_KEY, outputCursor));
  } catch (err) {
    logger.debug(`Could not read PocketBase output from tLib: ${err.message}`);
    return null;
  }
  if (!snapshot || !Array.isArray(snapshot.lines)) return null;
  outputCursor = typeof snapshot.next === "number" ? snapshot.next : outputCursor;
  return snapshot;
}

/**
 * Wait until PocketBase has demonstrably bound its port, or died trying.
 *
 * Resolves as soon as the port accepts a TCP connection. A bind failure is
 * detected by the process exiting (Go's listener fails immediately), so log
 * wording only classifies the reason, it does not drive the decision. A timeout
 * resolves ok: alive-but-not-listening is not fixable by another port, and the
 * downstream health checks report it.
 *
 * The exit covers a launch failure too - a missing binary or a refused argument
 * reaches tLib's ring as a stderr line and flips `alive` - so there is no
 * separate error case here the way there was with a ChildProcess's 'error'.
 *
 * stdout lines that arrive during this window are pushed onto `held` rather than
 * handled: the installer-banner branch calls repairSuperuser, and that must not
 * run on behalf of an attempt that is about to be thrown away for a port
 * collision. startOutputPump replays them once the bind is confirmed.
 */
async function confirmBind(api, port, held, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let stderrTail = "";

  for (;;) {
    const snapshot = drainOutput(api);
    if (snapshot) {
      for (const line of snapshot.lines) {
        if (line.stream === "stderr") {
          stderrTail = `${stderrTail + line.text}\n`.slice(-2000);
        } else {
          held.push(line.text);
        }
      }

      if (!snapshot.alive) {
        const detail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" ").trim();
        const haystack = detail.toLowerCase();
        return {
          ok: false,
          bindConflict: BIND_CONFLICT.some((sig) => haystack.includes(sig)),
          detail: detail || `exit code ${snapshot.code}`,
        };
      }
    }

    if (await canConnect(port)) return { ok: true };
    if (Date.now() >= deadline) return { ok: true };
    await sleep(100);
  }
}

/** One constant because the registration and the health probe have to agree on
 *  the mount; they used to agree only by re-parsing the public URL's path. */
const TLIB_MOUNT = "/db";

/**
 * Read tLib's HTTP status snapshot.
 *
 * GetHttpStatus is a hard dependency, gated by `tlib_min_version '1.0'` in
 * fxmanifest.lua.
 *
 * ⚠️ Don't reach for GetHubUrl as a readiness signal: it answers with a
 * provisional localhost URL while autodetection runs and keeps answering after
 * a failed bind, so registering on it advertises a URL indistinguishable from a
 * dead one. Returning null leaves the admin UI unpublished and the database
 * unaffected, since every export goes over loopback.
 */
function readTLibHttpStatus() {
  try {
    if (GetResourceState("tLib") !== "started") return null;
    return globalThis.exports.tLib.GetHttpStatus();
  } catch (err) {
    logger.debug(`Could not read tLib HTTP status: ${err.message}`);
    return null;
  }
}

/**
 * Ask tLib's router to expose this PocketBase instance. PocketBase binds
 * loopback and is unreachable from outside on its own; tLib owns the single
 * public port and proxies `<mount>/...` here. Returns tLib's raw result so the
 * publisher can tell a refusal from a not-ready-yet.
 *
 * `globalThis.exports` is required, not stylistic: in CommonJS `exports` is
 * module.exports and shadows FiveM's global export proxy.
 */
function registerWithTLib() {
  // tLib is a hard dependency so this should not happen; if it does, only the
  // admin UI is missing. A warning, not a failed start.
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
    // PocketBase has no base-path option, so it must see unprefixed paths. Its
    // admin UI is subpath-relative (assets as ./assets/..., SDK baseURL "../"),
    // so stripping works. Verified against 0.40.3.
    stripPrefix: true,
    // PocketBase realtime is SSE over plain HTTP, not WebSocket.
    websocket: false,
    title: "Database",
    icon: "database",
    description: "PocketBase collections, records and admin",
    accent: "#22c07a",
    // pb_public is empty, so the bare mount answers with PocketBase's JSON
    // "File not found", which reads like a broken router. Admin is at /_/.
    index: "/_/",
    // Whether the mount gets an entry in tLib's hub index.
    //
    // NOT a security control, and the docs say so in those words: the mount
    // answers to anyone requesting "/db" whether listed or not. ExposeAdmin =
    // false is the way to actually not serve it. This is for a server that
    // wants the hub to show player-facing apps only.
    //
    // `!== false` so an old config.lua without the key stays listed.
    listed: config.ShowInHub !== false,
  });
}

/**
 * Owns whether the admin UI is currently published, and keeps the startup box
 * honest about it. State machine is in utils/tlib-publication.js.
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
    // A late or retried mount lands after the box has printed, so say it in the
    // log - otherwise the last thing the operator saw was "waiting for tLib".
    if (startupBoxPrinted) logger.info(`Admin UI is published at ${url}/_/`);
  },
  onUnpublished: () => {
    // Stop advertising a route that no longer exists. The database is
    // unaffected - scripts never went through the router.
    startupStatus.mounted = false;
    startupStatus.healthCheckPassed = null;
    startupStatus.routeProbeDetail = null;
    startupStatus.routeProbeUrl = null;
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

// Subscribe first, then query - the contract's ordering. A transition landing
// between the two is caught by the subscription instead of missed by the query.
function watchTLibStatus() {
  on("tLib:http:status", (snapshot) => {
    const wasPublished = publisher.published;
    publisher.handleStatus(snapshot);
    if (publisher.published && !wasPublished) revalidateRoute();
  });

  // The reset belongs on STOP, not start. tLib emits its status as it comes up
  // with no ordering guarantee against the onResourceStart dispatched to us, so
  // a start handler that resets unconditionally can tear down a mount this same
  // fresh tLib already granted, then register twice against the same registry.
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

// Bumped whenever the thing being probed changes. A probe waits up to 5s and
// tLib can stop inside that window, so a result may only land if it still
// describes the mount we currently hold.
let routeProbeGeneration = 0;

/** Re-probe the mount after it is (re)published, and refresh the status box. */
async function revalidateRoute() {
  const generation = ++routeProbeGeneration;
  const url = publisher.healthUrl();

  // No listener address means the probe cannot run, which is not the probe
  // failing. null keeps those apart.
  const probe = url ? await checkRouteHealth(url) : null;

  // Superseded, or the mount went away while we waited.
  if (generation !== routeProbeGeneration || !publisher.published) return;

  startupStatus.healthCheckPassed = probe ? probe.ok : null;
  startupStatus.routeProbeDetail = probe ? probe.detail : null;
  startupStatus.routeProbeUrl = url;
}

async function createSuperuser(publicIP) {
  let email = config.Superuser.Email;
  let password = config.Superuser.Password;
  let needsConfigUpdate = false;

  const hasConfigCredentials = email && email !== "" && password && password !== "";

  if (!hasConfigCredentials) {
    const domain = publicIP || "localhost";
    email = `admin@${domain}.local`;
    password = generateRandomPassword();
    needsConfigUpdate = true;
  }

  // Remember what the instance is actually provisioned with so a later repair
  // can re-apply exactly these.
  activeSuperuser = { email, password };

  let attempt = await upsertSuperuser(email, password);

  // One retry: on a cold start the first call can race the database file being
  // created.
  if (!attempt.ok) {
    logger.debug(`Superuser provisioning retrying (${attempt.detail})`);
    attempt = await upsertSuperuser(email, password);
  }

  if (!attempt.ok) {
    startupStatus.errors.push(`Failed to configure superuser: ${attempt.detail}`);
    return false;
  }

  // The email is not a secret and is useful on every boot; the password is.
  startupStatus.superuserEmail = email;

  if (needsConfigUpdate) {
    const updated = configLoader.updateSuperuserCredentials(email, password);
    if (!updated) {
      // The only copy of a freshly generated password is the one about to be
      // printed, so say that rather than "failed to save".
      startupStatus.warnings.push(
        "Could not write the generated credentials to config.local.lua. Copy the " +
          "password below into `set tdb_superuser_password` now - it cannot be " +
          "recovered later."
      );
    }
    // Printed once, here, and redacted on every boot after this one.
    startupStatus.superuserPassword = password;
    startupStatus.superuserGenerated = true;
  }

  return true;
}

/**
 * Re-provision the superuser against a running instance and re-authenticate.
 *
 * PocketBase reads superusers from the database per request, so this takes
 * effect without a restart. It exists so a broken pb_data can never strand a
 * server owner on the web installer.
 */
async function repairSuperuser(reason) {
  if (superuserRepairAttempted) return false;
  superuserRepairAttempted = true;

  if (!activeSuperuser) {
    startupStatus.warnings.push("Superuser repair skipped - no credentials resolved");
    return false;
  }

  logger.warn(`Repairing superuser account (${reason})`);

  const attempt = await upsertSuperuser(activeSuperuser.email, activeSuperuser.password);

  if (!attempt.ok) {
    startupStatus.errors.push(`Superuser repair failed: ${attempt.detail}`);
    return false;
  }

  logger.info("Superuser account repaired - re-authenticating");

  // Hand the credentials over rather than letting the client re-read config.lua:
  // its loader caches on first load, so it may still hold pre-provisioning
  // values.
  emit("pocketbase:server:reauth", {
    email: activeSuperuser.email,
    password: activeSuperuser.password,
  });
  return true;
}

async function checkAndUpdate() {
  if (!config.AutoUpdate) {
    return true;
  }

  const result = await spawnWithTimeout(
    POCKETBASE_PROGRAM,
    ["update"],
    { cwd: POCKETBASE_CWD },
    30000
  );

  if (result.code !== 0) {
    startupStatus.warnings.push("Update check failed, using current version");
  }
  return true;
}

async function applyPendingMigrations() {
  if (!config.Migrations.AutoApply) {
    return;
  }

  try {
    const result = await spawnWithTimeout(
      POCKETBASE_PROGRAM,
      ["migrate", "up", "--dir", config.Advanced.DataDir, "--migrationsDir", config.Migrations.Dir],
      { cwd: POCKETBASE_CWD },
      30000
    );

    if (result.code === 0) {
      const output = result.stdout.trim();
      if (output && !output.includes("No migrations") && output.includes("Applied")) {
        const count = (output.match(/Applied/g) || []).length;
        logger.info(`Applied ${count} migration${count !== 1 ? "s" : ""}`);
      }
    } else if (result.stderr.includes("no migration") || result.stdout.includes("No migrations")) {
      // Nothing to apply, not an error.
      return;
    } else {
      startupStatus.warnings.push("Failed to apply migrations - check pb_migrations directory");
    }
  } catch (err) {
    startupStatus.warnings.push(`Migration error: ${err.message}`);
  }
}

/**
 * Validate config.lua once, at startup, before anything else runs.
 *
 * Every message names the file, the key, what was expected,
 * what was found, and how to fix it. All problems are collected, not just the
 * first - an operator who fixes one and restarts to find another is being made
 * to bisect their own config file.
 *
 * Called for BOTH local and remote startup. It used to sit behind the remote
 * early-return in startPocketBase(), which meant a remote deployment - the one
 * shape where a missing superuser password is fatal rather than recoverable -
 * was never validated at all.
 */
function validateConfig() {
  const errors = [];
  const where = "config.lua";

  const isRemote = config.Advanced.RemoteHost !== "" && config.Advanced.RemotePort !== "";

  const emailLooksValid = (value) => /^[^@\s]+@[^@\s]+$/.test(value);

  if (config.Superuser.Email && !emailLooksValid(config.Superuser.Email)) {
    errors.push(
      `${where}: Config.Superuser.Email must be an email address ` +
        `(found "${config.Superuser.Email}"). Fix: use something like ` +
        `"admin@example.com", or leave it empty to have tDB generate one.`
    );
  }

  if (isRemote) {
    // Remote is somebody else's instance: tDB cannot provision a superuser on
    // it, so empty credentials are fatal rather than a generate-on-first-run.
    if (!config.Superuser.Email || !config.Superuser.Password) {
      const missing = [
        !config.Superuser.Email && "Email",
        !config.Superuser.Password && "Password",
      ].filter(Boolean);
      errors.push(
        `${where}: Config.Superuser.${missing.join(" and Config.Superuser.")} ` +
          `${missing.length > 1 ? "are" : "is"} empty, but ` +
          `Config.Advanced.RemoteHost is set to "${config.Advanced.RemoteHost}". ` +
          `tDB cannot create a superuser on an instance it does not run. ` +
          `Fix: fill in the login you already use for that PocketBase, or clear ` +
          `RemoteHost and RemotePort to let tDB run its own.`
      );
    }

    if (!/^\d+$/.test(String(config.Advanced.RemotePort))) {
      errors.push(
        `${where}: Config.Advanced.RemotePort must be a port number in quotes ` +
          `(found "${config.Advanced.RemotePort}"). Fix: use RemotePort = "8090".`
      );
    }

    // Remote needs no local S3/Backup checks: tDB ignores those blocks
    // entirely against an instance it does not own.
    if (errors.length > 0) {
      startupStatus.errors.push(...errors);
      return false;
    }
    return true;
  }

  // Exactly one of RemoteHost/RemotePort set is almost always a half-finished
  // edit, and silently running local is how that goes unnoticed for weeks.
  if (config.Advanced.RemoteHost !== "" || config.Advanced.RemotePort !== "") {
    const set = config.Advanced.RemoteHost !== "" ? "RemoteHost" : "RemotePort";
    const unset = config.Advanced.RemoteHost !== "" ? "RemotePort" : "RemoteHost";
    errors.push(
      `${where}: Config.Advanced.${set} is set but Config.Advanced.${unset} is ` +
        `empty. Remote mode needs both, so tDB would silently start its own ` +
        `local database instead. Fix: set ${unset} too, or clear ${set}.`
    );
  }

  if (config.Advanced.S3.Enabled) {
    if (!config.Advanced.S3.Bucket) {
      errors.push(
        `${where}: Config.Advanced.S3.Bucket is empty while S3.Enabled = true. ` +
          `Expected the bucket name. Fix: set Bucket = "my-bucket", or set ` +
          `S3.Enabled = false.`
      );
    }
    if (!config.Advanced.S3.Region) {
      errors.push(
        `${where}: Config.Advanced.S3.Region is empty while S3.Enabled = true. ` +
          `Expected a region. Fix: set Region = "us-east-1", or set ` +
          `S3.Enabled = false.`
      );
    }
  }

  if (config.Backup.Enabled) {
    if (!Number.isInteger(config.Backup.KeepLast) || config.Backup.KeepLast < 0) {
      errors.push(
        `${where}: Config.Backup.KeepLast must be a whole number >= 0 ` +
          `(found ${JSON.stringify(config.Backup.KeepLast)}). ` +
          `Fix: use KeepLast = 7, or 0 to keep every backup.`
      );
    }
    if (!Number.isInteger(config.Backup.ScheduleSeconds) || config.Backup.ScheduleSeconds < 0) {
      errors.push(
        `${where}: Config.Backup.ScheduleSeconds must be a whole number of ` +
          `seconds >= 0 (found ${JSON.stringify(config.Backup.ScheduleSeconds)}). ` +
          `Fix: use ScheduleSeconds = 3600 for hourly, or 0 to disable the timer.`
      );
    }
  }

  const onChanged = ["warn", "error", "apply"];
  if (!onChanged.includes(config.Sql.OnChanged)) {
    errors.push(
      `${where}: Config.Sql.OnChanged must be one of ` +
        `${onChanged.map((v) => `"${v}"`).join(", ")} ` +
        `(found ${JSON.stringify(config.Sql.OnChanged)}). ` +
        `Fix: use OnChanged = "warn" unless your .sql files are pure DDL.`
    );
  }

  if (errors.length > 0) {
    startupStatus.errors.push(...errors);
    return false;
  }

  return true;
}

/**
 * Refuse to come up on invalid config.
 *
 * Returning without stopping left tDB "running" with no exports registered, so
 * every consumer failed later with `no such export`, pointing at the wrong
 * resource. Stopping means the console names tDB once, at the top, with the
 * config errors right above it: fail fast.
 */
function abortStartup() {
  displayStartupStatus();

  logger.error(
    "Startup aborted - tDB is stopping. Fix the configuration errors above " +
      "in config.lua and restart the resource."
  );

  // Guarded: the test harnesses load this file outside FiveM, where the native
  // does not exist. Losing the stop there is fine - the errors still print.
  if (typeof StopResource === "function") {
    StopResource(resourceName);
  }
}

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

  // Rotate only backups this resource created.
  const autoBackups = backups
    .filter((b) => b.key.startsWith(config.Backup.BackupPrefix))
    .sort((a, b) => new Date(b.created) - new Date(a.created));

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
  if (!config.Backup.Enabled || config.Backup.ScheduleSeconds <= 0) {
    return;
  }

  const intervalMs = config.Backup.ScheduleSeconds * 1000;

  setInterval(async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const basename = `${config.Backup.BackupPrefix}scheduled_${timestamp}`;

    logger.debug("Creating scheduled backup...");
    const result = await createBackup(basename);

    if (result) {
      logger.debug(`Scheduled backup created: ${basename}`);
      await manageBackupRotation();
    }
  }, intervalMs);

  logger.debug(`Scheduled backups enabled: every ${config.Backup.ScheduleSeconds} seconds`);
}

// Settings only ever travel config.lua -> PocketBase: PocketBase will not hand
// back the S3 secret, so a sync the other way blanks it.
// Rules and the measurement behind them are in utils/settings.js.
async function reconcileSettings() {
  // Somebody else's instance is not ours to reconfigure.
  if (startupStatus.isRemoteMode) return;

  const outcome = await settings.reconcile(
    {
      getSettings: () => global.pbInternalGetSettings(),
      updateSettings: (patch) => global.pbInternalUpdateSettings(patch),
    },
    config.Advanced,
    logger
  );

  // Surfaced in the startup box, not just the log, so an overwrite is seen.
  for (const warning of outcome.warnings) startupStatus.warnings.push(warning);
}

// ── The serving process, as seen from outside tLib ───────────────────────────
//
// tLib owns the process, so tDB holds only the pid tLib reported (for the pid
// file, which is the unclean-shutdown guard's only evidence), a cursor into
// tLib's line ring, and whether the process has been seen to exit. Everything
// else is asked for by key.
let pocketbasePid = 0;
let outputCursor = 0;
let outputTimer = null;
let pocketbaseExited = false;

/**
 * One line of PocketBase's stdout.
 *
 * tLib splits the pipe into lines and drops blank ones, so there is no
 * splitting to do here.
 */
function handlePocketBaseStdout(raw) {
  let line = raw.trim();
  if (!line) return;

  // PocketBase logs its own bind address, always loopback now, so point it
  // at the routed URL. A no-op with no mount, since finalUrl is localUrl.
  line = line.replace(/http:\/\/(?:0\.0\.0\.0|127\.0\.0\.1):\d+/g, finalUrl);

  // We print our own startup summary instead.
  if (
    line.includes("Server started at") ||
    line.includes("REST API:") ||
    line.includes("Dashboard:") ||
    line.startsWith("├─") ||
    line.startsWith("└─")
  ) {
    return;
  }

  // PocketBase only prints its installer banner when the instance has no
  // superuser at all. One is provisioned before `serve`, so seeing this
  // means provisioning silently failed: repair rather than hide it.
  if (
    line.includes("Launch the URL below") ||
    line.includes("create your first superuser account") ||
    line.includes("/_/#/pbinstall/")
  ) {
    if (!superuserRepairAttempted) {
      repairSuperuser("PocketBase reported no superuser exists");
    }
    return;
  }

  // Prefixed because this is the PocketBase process talking, not tDB. Under a
  // single `[tDB]` tag the two are otherwise the same line.
  logger.debug(`pocketbase: ${line}`);
}

function handlePocketBaseStderr(raw) {
  const output = raw.trim();
  if (!output) return;
  // Same rewrite as stdout, and the same relay prefix.
  logger.warn(
    `pocketbase: ${output.replace(/http:\/\/(?:0\.0\.0\.0|127\.0\.0\.1):\d+/g, finalUrl)}`
  );
}

/**
 * What the ChildProcess 'close' handler used to do.
 *
 * Reached from the pump rather than from an event, because tLib owns the
 * process and reports its exit as a flag on the next read.
 */
function handlePocketBaseExit(code) {
  // Cleared here as well as in stopPocketBase, for the case where PocketBase
  // exits on its own - otherwise the next start probes a dead pid.
  pidGuard.clear(resourcePath);
  if (code !== 0 && code !== null) {
    logger.error(`PocketBase exited with code ${code}`);
  } else {
    logger.info("PocketBase stopped");
  }
}

/**
 * Drain tLib's ring into the line handlers, forever, and notice the exit.
 *
 * The exit needs two passes, not one: tLib sets its exit flag from the child's
 * 'exit' event, which can be delivered before the last chunk of stdout has been
 * split into lines. Stopping on the first `alive: false` would drop exactly the
 * lines that say why it died.
 */
// tDB's own stop, not tLib's.
//
// The pump reaches across a resource boundary on a timer, and a timer that
// survives its own resource's teardown is a call into a runtime that no longer
// exists. That is not a JavaScript error you can catch - it faults the host - so
// the timer has to be cancelled by the stop itself rather than left to whichever
// of the two runtimes is torn down first. tLib reaps the process either way; this
// only stops tDB talking to it.
on("onResourceStop", (stopped) => {
  if (stopped !== resourceName) return;
  if (outputTimer) {
    clearTimeout(outputTimer);
    outputTimer = null;
  }
  pocketbaseExited = true;
});

function startOutputPump(api, held) {
  for (const line of held) handlePocketBaseStdout(line);
  held.length = 0;

  const tick = () => {
    outputTimer = null;
    const snapshot = drainOutput(api);

    if (snapshot) {
      for (const line of snapshot.lines) {
        if (line.stream === "stderr") handlePocketBaseStderr(line.text);
        else handlePocketBaseStdout(line.text);
      }

      if (!snapshot.alive) {
        if (pocketbaseExited) {
          handlePocketBaseExit(snapshot.code);
          return;
        }
        pocketbaseExited = true;
      }
    }

    outputTimer = setTimeout(tick, OUTPUT_POLL_MS);
  };

  tick();
}

async function startPocketBase() {
  const isRemote = config.Advanced.RemoteHost !== "" && config.Advanced.RemotePort !== "";

  startupStatus.isRemoteMode = isRemote;

  // Before the remote branch, not after it. This call used to sit below the
  // `if (isRemote) return`, so remote deployments were never validated.
  if (!validateConfig()) {
    abortStartup();
    return;
  }

  if (isRemote) {
    await connectToRemotePocketBase();
    return;
  }

  const pbPath = getPocketBasePath();
  if (!pbPath) {
    startupStatus.errors.push(
      "PocketBase executable not found in .runtime/. Fix: re-download the tDB " +
        "release (it ships the binary), or run `bun run runtime` in the " +
        "resource folder if you installed from git."
    );
    abortStartup();
    return;
  }

  startupStatus.executablePath = pbPath;

  // Clear an orphan from an unclean shutdown before anything else touches the
  // data directory. This has to precede createSuperuser and
  // applyPendingMigrations, not just the `serve` spawn: those run the binary
  // against the same SQLite directory, so an orphan makes them fail first and
  // the error then points at the database rather than the real cause.
  if (!(await pidGuard.clearOrphan(resourcePath, pbPath, logger))) {
    startupStatus.errors.push(
      "A PocketBase process from a previous run is still running and could not be stopped"
    );
    displayStartupStatus();
    return;
  }

  // Proven before anything is asked of it, so a tLib whose spawn broker is not
  // answering fails here with an instruction rather than four lines later with
  // "No such export". tLib is a hard `dependency` pinned at 1.0, so there is
  // nothing to fall back to and nothing that should try.
  let spawner;
  try {
    spawner = spawnBroker("SpawnServe");
  } catch (err) {
    startupStatus.errors.push(err.message);
    abortStartup();
    return;
  }

  await checkAndUpdate();

  // PocketBase always binds loopback. External reachability is tLib's decision,
  // granted by registering a mount on its router, so Config.ExposeAdmin selects
  // whether we ask for that mount, not a bind address.
  //
  // The port is resolved immediately before the spawn, not here: superuser
  // provisioning, migrations and a startup backup can take seconds, and a port
  // proven free at the top of that window says nothing about the bottom of it.
  //
  // localUrl/finalUrl are module-level because the publication callbacks run
  // long after this function returns and need the loopback fallback.
  let bindAddress = "";

  startupStatus.exposeAdmin = config.ExposeAdmin;

  // No public IP to pass: PocketBase is loopback-only. This only affects the
  // auto-generated superuser email on a first run with empty credentials
  // (admin@localhost.local), which is then written to config.lua, so existing
  // installs are unaffected.
  const superuserSuccess = await createSuperuser(null);
  if (!superuserSuccess) {
    displayStartupStatus();
    return;
  }

  await applyPendingMigrations();

  await performStartupBackup();

  // --migrationsDir is passed explicitly: without it PocketBase derives
  // `<dataDir>/../pb_migrations`, which makes Config.Migrations.Dir do nothing
  // and, for a data dir outside the resource, shares a migrations directory
  // with every neighbouring instance. PocketBase writes a migration file per
  // collection change, so one instance's edits replay into the next to start.
  const buildArgs = () => {
    const a = [
      "serve",
      `--http=${bindAddress}`,
      `--dir=${config.Advanced.DataDir}`,
      `--publicDir=${config.Advanced.PublicDir}`,
      `--migrationsDir=${config.Migrations.Dir}`,
      // Explicit for the SAME reason Migrations.Dir is: PocketBase derives
      // `<dataDir>/../pb_hooks` when this is omitted, and dataDir is
      // `.runtime/pb_data`, so it looked in `.runtime/pb_hooks` -- which does
      // not exist. The hooks are at the resource root.
      //
      // The failure is quiet and total: PocketBase starts, /api/health answers
      // 200, and every route pb_hooks registers is simply absent. The startup
      // box reported "Hooks Failed to Load" from a 404 on
      // /api/extended/health without being able to say why.
      "--hooksDir=pb_hooks",
    ];
    if (config.Advanced.Dev) a.push("--dev");
    if (!config.Advanced.AutoMigrate) a.push("--automigrate=false");
    return a;
  };

  // Resolve the port and bind together, with retries. resolveInternalPort()
  // releases the port it proved free, so something else can take it before
  // PocketBase binds - two FXServer instances with tDB starting together both
  // probe 8090 and one loses. The probe is a fast path; PocketBase's own bind
  // is the arbiter, and a bind failure is fast and unambiguous.
  const MAX_BIND_ATTEMPTS = 3;
  let bound = false;

  // stdout produced while a bind is still unproven. See confirmBind.
  const heldStdout = [];

  for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS && !bound; attempt++) {
    // After a lost race, stop asking for the preferred port - something else
    // clearly wants it.
    const resolvedPort = await resolveInternalPort(attempt > 1);
    if (!resolvedPort) {
      startupStatus.errors.push(
        "No free loopback port is available for PocketBase - this machine has exhausted its port range"
      );
      displayStartupStatus();
      return;
    }

    config.Port = resolvedPort;
    bindAddress = `127.0.0.1:${config.Port}`;
    localUrl = `http://127.0.0.1:${config.Port}`;
    finalUrl = localUrl;
    startupStatus.publicUrl = finalUrl;

    let served;
    try {
      served = JSON.parse(
        spawner.SpawnServe(
          JSON.stringify({
            key: POCKETBASE_KEY,
            program: POCKETBASE_PROGRAM,
            args: buildArgs(),
            cwd: POCKETBASE_CWD,
          })
        )
      );
    } catch (err) {
      served = { error: err.message };
    }

    // A refusal here is not a port problem and retrying cannot fix it: tLib
    // either would not run this program, would not accept these arguments, or
    // could not find the binary. All three name themselves in the message.
    if (!served?.pid) {
      startupStatus.errors.push(
        `tLib would not start PocketBase: ${served?.error || "no pid was returned"}`
      );
      displayStartupStatus();
      return;
    }
    pocketbasePid = served.pid;

    const outcome = await confirmBind(spawner, config.Port, heldStdout);
    if (outcome.ok) {
      bound = true;
      break;
    }

    // This attempt is over, whatever happens next. SpawnServe is idempotent per
    // key: leaving the entry in place would make the next attempt hand back
    // THIS attempt's pid instead of starting anything, and the loop would then
    // "succeed" against a dead process. Unserve drops the entry and its line
    // ring together, which is why the cursor and the held lines reset with it.
    try {
      spawner.SpawnUnserve(POCKETBASE_KEY);
    } catch (err) {
      logger.debug(`Could not release the failed attempt: ${err.message}`);
    }
    pocketbasePid = 0;
    outputCursor = 0;
    heldStdout.length = 0;

    // Not a collision, so a real startup failure. Retrying would fail the same
    // way three times and bury the actual reason.
    if (!outcome.bindConflict) {
      startupStatus.errors.push(
        `PocketBase exited during startup: ${outcome.detail || "no output"}`
      );
      displayStartupStatus();
      return;
    }

    if (attempt === MAX_BIND_ATTEMPTS) {
      startupStatus.errors.push(
        `PocketBase could not bind a loopback port after ${MAX_BIND_ATTEMPTS} attempts: ${outcome.detail}`
      );
      displayStartupStatus();
      return;
    }

    logger.warn(
      `Lost the race for loopback port ${config.Port} - retrying on another port ` +
        `(attempt ${attempt + 1}/${MAX_BIND_ATTEMPTS})`
    );
  }

  // Only once the bind is confirmed: writing it per attempt would let a losing
  // attempt's record overwrite the winning attempt's. pbPath, not tLib's
  // resolved binary, because this is the same string the guard will compare
  // against on the next start. config.Port is read here rather than earlier for
  // the same reason the write is: the loop reassigns it per attempt, so only
  // after `bound` is it the port PocketBase is actually holding - and that port
  // is now what proves a leftover pid is really ours.
  if (pocketbasePid) {
    pidGuard.write(resourcePath, pocketbasePid, pbPath, config.Port, logger);
  }

  startOutputPump(spawner, heldStdout);

  setTimeout(async () => {
    if (pocketbasePid && !pocketbaseExited) {
      // Only now is a mount valid - registering earlier advertises a route that
      // 502s. Whether we want one is the operator's setting, untouched here.
      if (config.ExposeAdmin) {
        publisher.want(true);
        // Subscribe before querying, so a transition landing between the two is
        // caught rather than lost.
        watchTLibStatus();
        publisher.handleStatus(readTLibHttpStatus());
      } else {
        logger.debug("ExposeAdmin is false, staying headless");
      }

      // `url` stays loopback: this is what in-process consumers (the oxmysql
      // adapter, hooks) talk to, and it must not depend on the router.
      emit("pocketbase:server:ready", {
        url: localUrl,
        port: config.Port,
        exposeAdmin: config.ExposeAdmin,
      });

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

      // A local instance refusing our own credentials has a missing or
      // mismatched superuser: re-provision and give the client one more go, so
      // a broken pb_data never requires the web installer to recover.
      if (startupStatus.clientAuthenticated === false) {
        const repaired = await repairSuperuser(
          "client could not authenticate against the local instance"
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

      // Hooks are internal, so always check over loopback.
      startupStatus.hooksHealthy = await checkHooksHealth(localUrl);

      // Only meaningful once the router accepted a mount. A still-pending mount
      // is picked up by revalidateRoute() when tLib finishes coming up.
      if (startupStatus.mounted) await revalidateRoute();

      // Before the banner, and awaited. As a floating 2s setTimeout its drift
      // warnings landed after the box had printed, or were dropped entirely if
      // the resource stopped first.
      await reconcileSettings();

      displayStartupStatus();

      await scheduleBackups();
    }
  }, 1000);
}

async function connectToRemotePocketBase() {
  logger.debug("Connecting to remote PocketBase instance...");

  const remoteUrl = buildSmartUrl(config.Advanced.RemoteHost, config.Advanced.RemotePort);

  if (!remoteUrl) {
    startupStatus.errors.push("Invalid remote host configuration");
    displayStartupStatus();
    return;
  }

  startupStatus.publicUrl = remoteUrl;

  const remoteHealthUrl = `${remoteUrl.replace(/\/+$/, "")}${tlibPublication.HEALTH_PATH}`;
  const remoteProbe = await checkRouteHealth(remoteHealthUrl);
  startupStatus.healthCheckPassed = remoteProbe.ok;
  startupStatus.routeProbeDetail = remoteProbe.detail;
  startupStatus.routeProbeUrl = remoteHealthUrl;

  if (!startupStatus.healthCheckPassed) {
    startupStatus.clientAuthenticated = false;
    displayStartupStatus();
    return;
  }

  emit("pocketbase:server:ready", {
    url: remoteUrl,
    port: config.Advanced.RemotePort,
    exposeAdmin: true, // Remote is always "exposed"
    isRemote: true,
  });

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

  startupStatus.hooksHealthy = await checkHooksHealth(remoteUrl);

  displayStartupStatus();
}

async function stopPocketBase() {
  if (startupStatus.isRemoteMode) {
    logger.debug("Disconnecting from remote PocketBase...");
    return;
  }

  // Nothing is written back to config.lua here. Shutdown used to rewrite it
  // from the instance's settings, which blanked the S3 secret
  // (PocketBase never returns those) and replayed a boot-time snapshot over any
  // edit since. Settings travel one way now - see reconcileSettings().

  if (!pocketbasePid || pocketbaseExited) return;

  logger.debug("Shutting down PocketBase...");

  // The pump is stopped first: with the process going away there is nothing
  // left to read, and these paths (SIGINT/SIGTERM on FXServer, beforeExit) are
  // exactly the ones where a pending timer may never fire again.
  if (outputTimer) {
    clearTimeout(outputTimer);
    outputTimer = null;
  }

  // tLib owns the process, so the escalation is tLib's: SIGTERM, then SIGKILL
  // after its own grace period. Asking is not redundant with tLib's reaping on
  // tDB's onResourceStop - no resource event fires when FXServer itself is
  // signalled, which is what these three handlers are for.
  try {
    spawnBroker("SpawnUnserve").SpawnUnserve(POCKETBASE_KEY);
  } catch (err) {
    logger.warn(`Could not ask tLib to stop PocketBase: ${err.message}`);
  }

  pocketbaseExited = true;
  // The exit handler that would normally do this is on the pump, which has just
  // been stopped.
  pidGuard.clear(resourcePath);
}

// ⛔ THESE HANDLERS MUST ALWAYS LET THE HOST DIE. They used to be
//
//     process.on("SIGTERM", () => { stopPocketBase().then(() => process.exit(0)); });
//
// and that made FXServer unkillable, which took txAdmin's restart with it.
//
// In Node, registering a listener for SIGTERM REPLACES the default disposition
// for the whole process -- and this runs inside FXServer's runtime, so the
// process in question is the game server, not tDB. Once the listener existed,
// a SIGTERM no longer terminated anything; it just called this function. If
// `stopPocketBase()` did not settle -- or if `process.exit` does not reach the
// host from a resource sandbox -- nothing else ever ended the process.
//
// Measured on the test server 2026-10-19: SIGTERM to the game server, then
// five minutes with the process still alive, still answering players.json, and
// not one line logged. txAdmin stops a server with SIGTERM, so its restart
// spawned a replacement that could not bind 30120, read the bind failure as
// "server process close detected", and respawned forever at a growing backoff.
// A container restart always worked, because that ends in SIGKILL.
//
// The shape below is the standard one: do the cleanup, then REMOVE the listener
// and re-raise the same signal so the default disposition applies and the host
// dies exactly as it would have if tDB had never been loaded. Cleanup is
// best-effort and must never be able to hold the process open -- a shutdown
// that leaks one PocketBase is recoverable, a server that cannot be restarted
// is not.
let hostSignalHandled = false;

function onHostSignal(signal) {
  // A second SIGTERM arrives if an operator or supervisor gets impatient. Only
  // the first does cleanup; the rest fall straight through to the default.
  if (hostSignalHandled) return;
  hostSignalHandled = true;

  try {
    // Deliberately NOT awaited. The part that matters -- asking tLib to unserve
    // PocketBase -- is a synchronous export call inside stopPocketBase, so it
    // has already been issued by the time this returns. Awaiting a promise here
    // is what the old code did, and it is the thing that hung.
    stopPocketBase();
  } catch (err) {
    logger.warn(`PocketBase shutdown on ${signal} failed: ${err.message}`);
  }

  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

process.on("SIGINT", () => onHostSignal("SIGINT"));
process.on("SIGTERM", () => onHostSignal("SIGTERM"));
// `beforeExit` is a different case and stays as it was: it fires on a normal
// drain, not on a signal, and nothing is waiting on the process to die.
process.on("beforeExit", () => {
  stopPocketBase();
});

startPocketBase();
