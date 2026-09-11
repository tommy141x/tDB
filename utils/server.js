const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const configLoader = require("./utils/config-loader.js");
const { spawnWithTimeout } = require("./utils/process-utils.js");
// Resolved from the resource root, not from this file — FiveM's Node runtime
// loads server_scripts with the resource directory as the base.
const pidGuard = require("./utils/pid-guard.js");

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
  exposeAdmin: false,
  isRemoteMode: false,
  healthCheckPassed: false,
  clientAuthenticated: null,
  hooksHealthy: null,
  errors: [],
  warnings: [],
};

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
// IP Detection
// ============================================================================
function getPublicIP() {
  return new Promise((resolve) => {
    https
      .get("https://api.ipify.org", (resp) => {
        let data = "";

        resp.on("data", (chunk) => {
          data += chunk;
        });

        resp.on("end", () => {
          resolve(data.trim());
        });
      })
      .on("error", (err) => {
        logger.debug(`Failed to get public IP: ${err.message}`);
        resolve(null);
      });
  });
}

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
function displayStartupStatus() {
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

  // Mode
  let mode;
  if (startupStatus.isRemoteMode) {
    mode = colors.magenta("Remote");
  } else if (startupStatus.exposeAdmin) {
    mode = colors.cyan("Public");
  } else {
    mode = colors.green("Internal");
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
    } else if (startupStatus.exposeAdmin) {
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
          "tLib's router did not forward the mount — check that tLib started",
        );
      }
    } else {
      // Not exposed, just show started
      healthStatus = "✓ Started";
      healthColor = colors.green;
    }
  }

  // Public URL (only if exposed and not remote)
  if (startupStatus.exposeAdmin && !startupStatus.isRemoteMode) {
    boxContent.push(
      `${colors.white("Admin:   ")} ${colors.cyan(startupStatus.publicUrl + "/_/")}`,
    );
  } else if (startupStatus.isRemoteMode) {
    boxContent.push(
      `${colors.white("Admin:   ")} ${colors.cyan(startupStatus.publicUrl + "/_/")}`,
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

  // Draw box
  const maxLength = Math.max(
    ...boxContent.map((line) => line.replace(/\^\d/g, "").length),
  );
  const border = "═".repeat(maxLength + 4);

  logger.raw("");
  logger.raw(`╔${border}╗`);
  boxContent.forEach((line) => {
    const stripped = line.replace(/\^\d/g, "");
    const padding = " ".repeat(maxLength - stripped.length);
    logger.raw(`║  ${line}${padding}  ║`);
  });
  logger.raw(`╚${border}╝`);
  logger.raw("");
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
 * to the router over loopback, carrying the same mount the public URL uses.
 */
async function checkRouteHealth(publicUrl) {
  const routerPort = getRouterPort();
  if (routerPort === null) return false;

  let mount;
  try {
    // The mount is the public URL's path — the router's own base contributes
    // none, so whatever path survives is exactly what it matches on.
    mount = new URL(publicUrl).pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    require("http")
      .get(
        `http://127.0.0.1:${routerPort}${mount}/api/health`,
        { timeout: 5000 },
        (resp) => resolve(resp.statusCode === 200),
      )
      .on("error", () => resolve(false))
      .on("timeout", () => resolve(false));
  });
}

/** The port tLib's router is bound to, or null if it cannot be determined. */
function getRouterPort() {
  try {
    if (GetResourceState("tLib") !== "started") return null;
    const base = globalThis.exports.tLib.GetHubUrl();
    if (typeof base !== "string" || !base) return null;
    const u = new URL(base);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
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

/**
 * Ask tLib's router to expose this PocketBase instance on the server's one
 * external port.
 *
 * PocketBase binds loopback and is unreachable from outside on its own. tLib
 * owns the single public port and proxies `<mount>/...` here.
 *
 * Returns the routed public URL, or null if no mount was made (tLib absent,
 * admin not exposed, remote mode, or the router refused).
 *
 * Note on `exports`: these files are CommonJS modules, where `exports` is
 * module.exports and shadows FiveM's global export proxy. Reaching it through
 * globalThis is required, not stylistic.
 */
function registerWithTLib() {
  // Remote mode: PocketBase is somewhere else entirely and already has its own
  // URL. tLib only exposes services on this machine — proxying to an
  // operator-supplied remote host is exactly the SSRF shape its loopback-only
  // rule exists to prevent. So: no mount.
  const adv = config.Advanced || {};
  if (adv.RemoteHost && adv.RemotePort) return null;

  if (!config.ExposeAdmin) return null;

  try {
    if (GetResourceState("tLib") !== "started") {
      startupStatus.warnings.push(
        "tLib is not started - the admin UI will not be reachable from outside",
      );
      return null;
    }

    const result = globalThis.exports.tLib.RegisterWebApp({
      id: "db",
      mount: config.MountPath || "/db",
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
      // PocketBase serves nothing at its root — pb_public is empty — so the
      // bare mount would answer with its JSON "File not found", which reads
      // like the router is broken. The admin UI is at /_/.
      index: "/_/",
      // Routable but absent from the public hub index: an anonymous listing
      // advertising "PocketBase admin here" is a map for an attacker.
      listed: false,
    });

    if (!result || result.ok !== true) {
      startupStatus.warnings.push(
        `tLib refused the /db mount: ${(result && result.error) || "unknown error"}`,
      );
      return null;
    }

    return result.url;
  } catch (err) {
    startupStatus.warnings.push(`Could not register with tLib: ${err.message}`);
    return null;
  }
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
  // Validate port
  if (config.Port < 1 || config.Port > 65535) {
    errors.push(`Invalid port: ${config.Port} (must be 1-65535)`);
  }

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
async function configureSettings() {
  if (!config.Advanced.SMTP.Enabled && !config.Advanced.S3.Enabled) {
    return;
  }

  try {
    const settings = await global.pbInternalGetSettings();
    let needsUpdate = false;
    const updates = {};

    // Configure SMTP
    if (config.Advanced.SMTP.Enabled) {
      if (
        settings.smtp?.host !== config.Advanced.SMTP.Host ||
        settings.smtp?.port !== config.Advanced.SMTP.Port ||
        settings.smtp?.username !== config.Advanced.SMTP.Username ||
        settings.smtp?.password !== config.Advanced.SMTP.Password
      ) {
        updates.smtp = {
          enabled: true,
          host: config.Advanced.SMTP.Host,
          port: config.Advanced.SMTP.Port,
          username: config.Advanced.SMTP.Username,
          password: config.Advanced.SMTP.Password,
          authMethod: "PLAIN",
          tls: config.Advanced.SMTP.TLS,
          localName: config.Advanced.SMTP.LocalName || "localhost",
        };
        needsUpdate = true;
      }
    }

    // Configure S3
    if (config.Advanced.S3.Enabled) {
      if (
        settings.s3?.bucket !== config.Advanced.S3.Bucket ||
        settings.s3?.region !== config.Advanced.S3.Region ||
        settings.s3?.endpoint !== config.Advanced.S3.Endpoint
      ) {
        updates.s3 = {
          enabled: true,
          bucket: config.Advanced.S3.Bucket,
          region: config.Advanced.S3.Region,
          endpoint: config.Advanced.S3.Endpoint,
          accessKey: config.Advanced.S3.AccessKey,
          secret: config.Advanced.S3.SecretKey,
          forcePathStyle: config.Advanced.S3.ForcePathStyle,
        };
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await global.pbInternalUpdateSettings(updates);
      logger.debug("PocketBase settings updated from config");
    }
  } catch (err) {
    startupStatus.warnings.push(`Failed to configure settings: ${err.message}`);
  }
}

async function syncSettingsToConfig() {
  if (!config.Advanced.SMTP.Enabled && !config.Advanced.S3.Enabled) {
    return;
  }

  try {
    const settings = await global.pbInternalGetSettings();
    let needsUpdate = false;
    const updates = {};

    // Check SMTP changes
    if (config.Advanced.SMTP.Enabled && settings.smtp) {
      if (
        settings.smtp.host !== config.Advanced.SMTP.Host ||
        settings.smtp.port !== config.Advanced.SMTP.Port ||
        settings.smtp.username !== config.Advanced.SMTP.Username ||
        settings.smtp.password !== config.Advanced.SMTP.Password
      ) {
        updates.SMTP = {
          Host: settings.smtp.host || "",
          Port: settings.smtp.port || 587,
          Username: settings.smtp.username || "",
          Password: settings.smtp.password || "",
          LocalName: settings.smtp.localName || "",
          TLS: settings.smtp.tls !== false,
        };
        needsUpdate = true;
      }
    }

    // Check S3 changes
    if (config.Advanced.S3.Enabled && settings.s3) {
      if (
        settings.s3.bucket !== config.Advanced.S3.Bucket ||
        settings.s3.region !== config.Advanced.S3.Region ||
        settings.s3.endpoint !== config.Advanced.S3.Endpoint ||
        settings.s3.accessKey !== config.Advanced.S3.AccessKey ||
        settings.s3.secret !== config.Advanced.S3.SecretKey
      ) {
        updates.S3 = {
          Bucket: settings.s3.bucket || "",
          Region: settings.s3.region || "",
          Endpoint: settings.s3.endpoint || "",
          AccessKey: settings.s3.accessKey || "",
          SecretKey: settings.s3.secret || "",
          ForcePathStyle: settings.s3.forcePathStyle === true,
        };
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await configLoader.updateAdvancedSettings(updates);
      logger.info("Config.lua updated with latest PocketBase settings");
    }
  } catch (err) {
    logger.warn(`Failed to sync settings to config: ${err.message}`);
  }
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
  // Config.Port is now an internal port. It does not need to be open in the
  // firewall, and it should not be.
  const bindAddress = `127.0.0.1:${config.Port}`;

  // Every internal check (hooks health, the client adapter) talks to this.
  // It stays correct whether or not the admin UI is reachable from outside.
  const localUrl = `http://127.0.0.1:${config.Port}`;

  // Provisional. Replaced with the real routed URL once tLib accepts the mount.
  let finalUrl = localUrl;

  startupStatus.exposeAdmin = config.ExposeAdmin;
  startupStatus.bindAddress = bindAddress;
  startupStatus.publicUrl = finalUrl;

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
  const args = [
    "serve",
    `--http=${bindAddress}`,
    `--dir=${config.Advanced.DataDir}`,
    `--publicDir=${config.Advanced.PublicDir}`,
    `--migrationsDir=${config.Migrations.Dir}`,
  ];

  if (config.Advanced.Dev) {
    args.push("--dev");
  }

  if (!config.Advanced.AutoMigrate) {
    args.push("--automigrate=false");
  }

  // Start PocketBase
  const { spawn } = require("child_process");
  pocketbaseProcess = spawn(pbPath, args, {
    cwd: resourcePath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Recorded immediately, so a hard kill of FXServer one millisecond from now
  // still leaves the next start able to find this process.
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
      const routed = registerWithTLib();
      if (routed) {
        finalUrl = routed;
        startupStatus.publicUrl = routed;
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

      // Only meaningful once the router actually accepted a mount; finalUrl
      // still equals localUrl when it did not, and checking that would report
      // a healthy "public" URL that is not public at all.
      if (config.ExposeAdmin && finalUrl !== localUrl) {
        startupStatus.healthCheckPassed = await checkRouteHealth(finalUrl);
      }

      // Display status after everything is ready
      displayStartupStatus();

      // Configure SMTP/S3 settings after startup
      setTimeout(async () => {
        await configureSettings();
      }, 2000);

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
  // Don't try to sync settings or stop process in remote mode
  if (startupStatus.isRemoteMode) {
    logger.info("Disconnecting from remote PocketBase...");
    return;
  }

  // Sync settings to config before stopping
  try {
    await syncSettingsToConfig();
  } catch (err) {
    logger.warn(`Failed to sync settings on shutdown: ${err.message}`);
  }

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
