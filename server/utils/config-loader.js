// Wrap in module.exports function to avoid global scope pollution
module.exports = (function () {
  const fs = require("fs");
  const path = require("path");

  /**
   * Shared configuration loader for PocketBase
   * Prevents duplication of config parsing logic between server.js and client.js
   */

  class ConfigLoader {
    constructor() {
      this.config = null;
      this.configContent = "";
      this.configPath = "";
    }

    /**
     * Load configuration from config.lua
     * @param {string} resourcePath - Path to the resource
     * @returns {object} Parsed configuration
     */
    load(resourcePath) {
      if (this.config) {
        return this.config; // Return cached config
      }

      this.config = {
        ExposeAdmin: false,
        // Whether the mount appears in tLib's hub index. Defaults to TRUE,
        // unlike ExposeAdmin beside it, and deliberately: this key is newer
        // than the resource, so an install whose config.lua predates it must
        // keep behaving exactly as it does today. Defaulting to false would
        // silently drop every existing server out of the hub on update.
        //
        // Not a security control. See the note on `listed` in server.js:
        // an unlisted mount is still registered and still answers.
        ShowInHub: true,
        // Preferred loopback port, not a setting — see the note in the parser
        // below and resolveInternalPort() in server/utils/server.js. Overwritten at
        // startup with the port PocketBase was actually given.
        Port: 8090,
        AutoUpdate: false,
        Superuser: {
          Email: "",
          Password: "",
        },
        Migrations: {
          AutoApply: true,
          Dir: "pb_migrations",
        },
        Sql: {
          Enabled: true,
          Dir: "sql",
          OnChanged: "warn",
        },
        Backup: {
          Enabled: false,
          OnStartup: true,
          Schedule: 0,
          KeepLast: 7,
          BackupPrefix: "auto_",
        },
        Advanced: {
          RemoteHost: "",
          RemotePort: "",
          Dev: false,
          AutoMigrate: true,
          PublicDir: "pb_public",
          DataDir: "pb_data",
          // Manage defaults to false: unless asked, tDB does not touch these
          // settings on the instance at all, so the admin UI owns them and
          // nothing can drift. See reconcileSettings() in server/utils/server.js.
          SMTP: {
            Manage: false,
            Enabled: false,
            Host: "",
            Port: 587,
            Username: "",
            Password: "",
            LocalName: "",
            TLS: true,
          },
          S3: {
            Manage: false,
            Enabled: false,
            Bucket: "",
            Region: "",
            Endpoint: "",
            AccessKey: "",
            SecretKey: "",
            ForcePathStyle: false,
          },
        },
      };

      this.configPath = path.join(resourcePath, "config.lua");

      try {
        if (fs.existsSync(this.configPath)) {
          this.configContent = fs.readFileSync(this.configPath, "utf8");

          // Simple regex patterns for top-level config
          const simpleMatch = (pattern) => {
            const match = this.configContent.match(pattern);
            return match ? match[1] : null;
          };

          // Parse top-level config
          const exposeAdmin = simpleMatch(
            /Config\.ExposeAdmin\s*=\s*(true|false)/,
          );
          if (exposeAdmin) this.config.ExposeAdmin = exposeAdmin === "true";

          // Absent from config.lua leaves the default (true) in place, which
          // is what keeps an install that predates this key listed.
          const showInHub = simpleMatch(/Config\.ShowInHub\s*=\s*(true|false)/);
          if (showInHub) this.config.ShowInHub = showInHub === "true";

          // Config.Port is deliberately NOT parsed. It is no longer an
          // operator setting: PocketBase's port is loopback-internal, so
          // startPocketBase() resolves it at runtime (preferring 8090, falling
          // back to any free port) and writes it onto this.config.Port. A
          // Config.Port left in an older config.lua is ignored rather than
          // honoured, because honouring it could reintroduce the collision the
          // runtime resolution exists to avoid.

          const autoUpdate = simpleMatch(
            /Config\.AutoUpdate\s*=\s*(true|false)/,
          );
          if (autoUpdate) this.config.AutoUpdate = autoUpdate === "true";

          // Parse Superuser config
          const email = simpleMatch(/Email\s*=\s*"([^"]*)"/);
          if (email) this.config.Superuser.Email = email;

          const password = simpleMatch(/Password\s*=\s*"([^"]*)"/);
          if (password) this.config.Superuser.Password = password;

          // Parse Backup config - extract the entire Backup table
          const backupSection = this.configContent.match(
            /Config\.Backup\s*=\s*\{([^}]+)\}/s,
          );
          if (backupSection) {
            const backupContent = backupSection[1];
            const backupEnabled = backupContent.match(
              /Enabled\s*=\s*(true|false)/,
            );
            if (backupEnabled)
              this.config.Backup.Enabled = backupEnabled[1] === "true";

            const onStartup = backupContent.match(
              /OnStartup\s*=\s*(true|false)/,
            );
            if (onStartup)
              this.config.Backup.OnStartup = onStartup[1] === "true";

            const schedule = backupContent.match(/Schedule\s*=\s*(\d+)/);
            if (schedule) this.config.Backup.Schedule = parseInt(schedule[1]);

            const keepLast = backupContent.match(/KeepLast\s*=\s*(\d+)/);
            if (keepLast) this.config.Backup.KeepLast = parseInt(keepLast[1]);

            const prefix = backupContent.match(/BackupPrefix\s*=\s*"([^"]*)"/);
            if (prefix) this.config.Backup.BackupPrefix = prefix[1];
          }

          // Parse Migrations config
          const migrationsSection = this.configContent.match(
            /Config\.Migrations\s*=\s*\{([^}]+)\}/s,
          );
          if (migrationsSection) {
            const migrationsContent = migrationsSection[1];
            const autoApply = migrationsContent.match(
              /AutoApply\s*=\s*(true|false)/,
            );
            if (autoApply)
              this.config.Migrations.AutoApply = autoApply[1] === "true";

            const dir = migrationsContent.match(/Dir\s*=\s*"([^"]*)"/);
            if (dir) this.config.Migrations.Dir = dir[1];
          }

          // Parse Sql import config
          const sqlSection = this.configContent.match(
            /Config\.Sql\s*=\s*\{([^}]+)\}/s,
          );
          if (sqlSection) {
            const sqlContent = sqlSection[1];

            const enabled = sqlContent.match(/Enabled\s*=\s*(true|false)/);
            if (enabled) this.config.Sql.Enabled = enabled[1] === "true";

            const sqlDir = sqlContent.match(/Dir\s*=\s*"([^"]*)"/);
            if (sqlDir) this.config.Sql.Dir = sqlDir[1];

            const onChanged = sqlContent.match(
              /OnChanged\s*=\s*"(warn|error|apply)"/,
            );
            if (onChanged) this.config.Sql.OnChanged = onChanged[1];
          }

          // Parse Advanced config
          // Match only non-commented lines (not starting with --)
          // Use negative lookbehind to ensure line doesn't start with --
          const remoteHostMatch = this.configContent.match(
            /^(?!\s*--).*RemoteHost\s*=\s*"([^"]*)"/m,
          );
          const remoteHost = remoteHostMatch ? remoteHostMatch[1] : null;
          if (remoteHost !== null && remoteHost !== "")
            this.config.Advanced.RemoteHost = remoteHost;

          const remotePortMatch = this.configContent.match(
            /^(?!\s*--).*RemotePort\s*=\s*"([^"]*)"/m,
          );
          const remotePort = remotePortMatch ? remotePortMatch[1] : null;
          if (remotePort !== null && remotePort !== "")
            this.config.Advanced.RemotePort = remotePort;

          const dev = simpleMatch(/Dev\s*=\s*(true|false)/);
          if (dev) this.config.Advanced.Dev = dev === "true";

          const autoMigrate = simpleMatch(/AutoMigrate\s*=\s*(true|false)/);
          if (autoMigrate)
            this.config.Advanced.AutoMigrate = autoMigrate === "true";

          // Parse SMTP config - extract SMTP table
          const smtpSection = this.configContent.match(
            /SMTP\s*=\s*\{([^}]+)\}/s,
          );
          if (smtpSection) {
            const smtpContent = smtpSection[1];
            const manage = smtpContent.match(/Manage\s*=\s*(true|false)/);
            if (manage) this.config.Advanced.SMTP.Manage = manage[1] === "true";

            const enabled = smtpContent.match(/Enabled\s*=\s*(true|false)/);
            if (enabled)
              this.config.Advanced.SMTP.Enabled = enabled[1] === "true";

            const smtpHost = smtpContent.match(/Host\s*=\s*"([^"]*)"/);
            if (smtpHost) this.config.Advanced.SMTP.Host = smtpHost[1];

            const smtpPort = smtpContent.match(/Port\s*=\s*(\d+)/);
            if (smtpPort)
              this.config.Advanced.SMTP.Port = parseInt(smtpPort[1]);

            const username = smtpContent.match(/Username\s*=\s*"([^"]*)"/);
            if (username) this.config.Advanced.SMTP.Username = username[1];

            const smtpPassword = smtpContent.match(/Password\s*=\s*"([^"]*)"/);
            if (smtpPassword)
              this.config.Advanced.SMTP.Password = smtpPassword[1];

            const localName = smtpContent.match(/LocalName\s*=\s*"([^"]*)"/);
            if (localName) this.config.Advanced.SMTP.LocalName = localName[1];

            const tls = smtpContent.match(/TLS\s*=\s*(true|false)/);
            if (tls) this.config.Advanced.SMTP.TLS = tls[1] === "true";
          }

          // Parse S3 config - extract S3 table
          const s3Section = this.configContent.match(/S3\s*=\s*\{([^}]+)\}/s);
          if (s3Section) {
            const s3Content = s3Section[1];
            const manage = s3Content.match(/Manage\s*=\s*(true|false)/);
            if (manage) this.config.Advanced.S3.Manage = manage[1] === "true";

            const enabled = s3Content.match(/Enabled\s*=\s*(true|false)/);
            if (enabled)
              this.config.Advanced.S3.Enabled = enabled[1] === "true";

            const bucket = s3Content.match(/Bucket\s*=\s*"([^"]*)"/);
            if (bucket) this.config.Advanced.S3.Bucket = bucket[1];

            const region = s3Content.match(/Region\s*=\s*"([^"]*)"/);
            if (region) this.config.Advanced.S3.Region = region[1];

            const endpoint = s3Content.match(/Endpoint\s*=\s*"([^"]*)"/);
            if (endpoint) this.config.Advanced.S3.Endpoint = endpoint[1];

            const accessKey = s3Content.match(/AccessKey\s*=\s*"([^"]*)"/);
            if (accessKey) this.config.Advanced.S3.AccessKey = accessKey[1];

            const secretKey = s3Content.match(/SecretKey\s*=\s*"([^"]*)"/);
            if (secretKey) this.config.Advanced.S3.SecretKey = secretKey[1];

            const forcePathStyle = s3Content.match(
              /ForcePathStyle\s*=\s*(true|false)/,
            );
            if (forcePathStyle)
              this.config.Advanced.S3.ForcePathStyle =
                forcePathStyle[1] === "true";
          }

          return this.config;
        } else {
          console.log(
            "^3[Config Loader]^7 config.lua not found, using defaults",
          );
          return this.config;
        }
      } catch (err) {
        console.log(
          `^1[Config Loader]^7 Failed to load config: ${err.message}`,
        );
        return this.config;
      }
    }

    /**
     * Update config file with new superuser credentials
     * @param {string} email - New email
     * @param {string} password - New password
     * @returns {boolean} Success status
     */
    updateSuperuserCredentials(email, password) {
      try {
        if (!this.configPath || !fs.existsSync(this.configPath)) {
          console.log(
            "^1[Config Loader]^7 Cannot update config - config file not loaded",
          );
          return false;
        }

        // Re-read rather than editing the copy taken at load(). This can run
        // long after startup (the superuser repair path), and writing the boot
        // snapshot back would silently revert anything edited by hand since.
        let updatedContent = fs.readFileSync(this.configPath, "utf8");
        updatedContent = updatedContent.replace(
          /(Email\s*=\s*)"([^"]*)"/,
          `$1"${email}"`,
        );
        updatedContent = updatedContent.replace(
          /(Password\s*=\s*)"([^"]*)"/,
          `$1"${password}"`,
        );

        fs.writeFileSync(this.configPath, updatedContent, "utf8");

        // Update cached config
        this.config.Superuser.Email = email;
        this.config.Superuser.Password = password;
        this.configContent = updatedContent;

        return true;
      } catch (err) {
        console.log(
          `^1[Config Loader]^7 Failed to update config file: ${err.message}`,
        );
        return false;
      }
    }

    /**
     * Get the loaded config (cached)
     * @returns {object} Configuration object
     */
    get() {
      return this.config;
    }
  }

  // Return singleton instance
  return new ConfigLoader();
})();
