const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const configLoader = require("./utils/config-loader.js");
const { spawnWithTimeout } = require("./utils/process-utils.js");

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
        healthStatus = "✗ Public URL Not Accessible";
        healthColor = colors.red;
        startupStatus.warnings.push("Check firewall/port forwarding settings");
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
async function checkPublicUrlHealth(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === "https:" ? https : require("http");

    const healthUrl = `${url}/api/health`;

    protocol
      .get(healthUrl, { timeout: 5000 }, (resp) => {
        if (resp.statusCode === 200) {
          resolve(true);
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

  // Always upsert the superuser (create if not exists, update if exists)
  const result = await spawnWithTimeout(
    pbPath,
    ["superuser", "upsert", email, password, "--dir", config.Advanced.DataDir],
    { cwd: resourcePath },
    30000, // Increased timeout for first-time database initialization
  );

  if (
    result.code === 0 ||
    result.stdout.includes("Successfully saved superuser")
  ) {
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
  } else {
    startupStatus.errors.push(
      `Failed to configure superuser (code ${result.code})`,
    );
    return false;
  }
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
      ["migrate", "up", "--dir", config.Advanced.DataDir],
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

  // Check for updates
  await checkAndUpdate(pbPath);

  // Determine binding address and URL based on ExposeAdmin setting
  let bindAddress;
  let finalUrl;
  let publicIP = null;

  startupStatus.exposeAdmin = config.ExposeAdmin;

  if (config.ExposeAdmin) {
    // Admin exposed: bind to 0.0.0.0 and generate public URL
    bindAddress = `0.0.0.0:${config.Port}`;

    if (!config.Host || config.Host === "") {
      publicIP = await getPublicIP();
      if (!publicIP) {
        startupStatus.warnings.push(
          "Could not detect public IP - configure Config.Host manually",
        );
        finalUrl = `http://0.0.0.0:${config.Port}`;
      } else {
        finalUrl = `http://${publicIP}:${config.Port}`;
      }
    } else {
      finalUrl = buildSmartUrl(config.Host, config.Port);
    }
  } else {
    // Admin not exposed: bind to localhost only
    bindAddress = `127.0.0.1:${config.Port}`;
    finalUrl = `http://localhost:${config.Port}`;
  }

  startupStatus.bindAddress = bindAddress;
  startupStatus.publicUrl = finalUrl;

  // Create/update superuser before starting server
  const superuserSuccess = await createSuperuser(pbPath, publicIP);
  if (!superuserSuccess) {
    displayStartupStatus();
    return;
  }

  // Apply pending migrations before starting server
  await applyPendingMigrations(pbPath);

  // Perform startup backup before starting server
  await performStartupBackup();

  // Build arguments
  const args = [
    "serve",
    `--http=${bindAddress}`,
    `--dir=${config.Advanced.DataDir}`,
    `--publicDir=${config.Advanced.PublicDir}`,
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

  pocketbaseProcess.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Replace 0.0.0.0 URLs with the actual public URL
      line = line.replace(/http:\/\/0\.0\.0\.0:\d+/g, finalUrl);

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

      // Suppress first time setup messages - we handle superuser creation via CLI
      if (
        line.includes("Launch the URL below") ||
        line.includes("create your first superuser account") ||
        line.includes("/_/#/pbinstal/")
      ) {
        continue;
      }

      logger.debug(line);
    }
  });

  pocketbaseProcess.stderr.on("data", (data) => {
    let output = data.toString().trim();
    if (output) {
      // Replace 0.0.0.0 URLs with the actual public URL in error messages too
      output = output.replace(/http:\/\/0\.0\.0\.0:\d+/g, finalUrl);
      logger.warn(output);
    }
  });

  pocketbaseProcess.on("close", (code) => {
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
      // Emit ready event for client.js to listen to immediately
      emit("pocketbase:server:ready", {
        url: finalUrl,
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

      // Check if hooks are healthy
      startupStatus.hooksHealthy = await checkHooksHealth(finalUrl);

      // Perform health check if admin is exposed
      if (config.ExposeAdmin) {
        startupStatus.healthCheckPassed = await checkPublicUrlHealth(finalUrl);
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
