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
        Host: "",
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
          SMTP: {
            Enabled: false,
            Host: "",
            Port: 587,
            Username: "",
            Password: "",
            LocalName: "",
            TLS: true,
          },
          S3: {
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

          const host = simpleMatch(/Config\.Host\s*=\s*"([^"]*)"/);
          if (host) this.config.Host = host;

          const port = simpleMatch(/Config\.Port\s*=\s*(\d+)/);
          if (port) this.config.Port = parseInt(port);

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
        if (!this.configContent) {
          console.log(
            "^1[Config Loader]^7 Cannot update config - config file not loaded",
          );
          return false;
        }

        let updatedContent = this.configContent;
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

    /**
     * Update advanced settings (SMTP/S3) in config file
     * @param {object} updates - Object with SMTP and/or S3 updates
     * @returns {boolean} Success status
     */
    updateAdvancedSettings(updates) {
      try {
        if (!this.configContent) {
          console.log(
            "^1[Config Loader]^7 Cannot update config - config file not loaded",
          );
          return false;
        }

        let updatedContent = this.configContent;

        // Update SMTP settings
        if (updates.SMTP) {
          const smtpSection = updatedContent.match(/SMTP\s*=\s*\{([^}]+)\}/s);
          if (smtpSection) {
            let newSMTP = smtpSection[1];

            if (updates.SMTP.Host !== undefined) {
              newSMTP = newSMTP.replace(
                /Host\s*=\s*"[^"]*"/,
                `Host = "${updates.SMTP.Host}"`,
              );
            }
            if (updates.SMTP.Port !== undefined) {
              newSMTP = newSMTP.replace(
                /Port\s*=\s*\d+/,
                `Port = ${updates.SMTP.Port}`,
              );
            }
            if (updates.SMTP.Username !== undefined) {
              newSMTP = newSMTP.replace(
                /Username\s*=\s*"[^"]*"/,
                `Username = "${updates.SMTP.Username}"`,
              );
            }
            if (updates.SMTP.Password !== undefined) {
              newSMTP = newSMTP.replace(
                /Password\s*=\s*"[^"]*"/,
                `Password = "${updates.SMTP.Password}"`,
              );
            }
            if (updates.SMTP.LocalName !== undefined) {
              newSMTP = newSMTP.replace(
                /LocalName\s*=\s*"[^"]*"/,
                `LocalName = "${updates.SMTP.LocalName}"`,
              );
            }
            if (updates.SMTP.TLS !== undefined) {
              newSMTP = newSMTP.replace(
                /TLS\s*=\s*(true|false)/,
                `TLS = ${updates.SMTP.TLS}`,
              );
            }

            updatedContent = updatedContent.replace(
              /SMTP\s*=\s*\{[^}]+\}/s,
              `SMTP = {${newSMTP}}`,
            );
          }
        }

        // Update S3 settings
        if (updates.S3) {
          const s3Section = updatedContent.match(/S3\s*=\s*\{([^}]+)\}/s);
          if (s3Section) {
            let newS3 = s3Section[1];

            if (updates.S3.Bucket !== undefined) {
              newS3 = newS3.replace(
                /Bucket\s*=\s*"[^"]*"/,
                `Bucket = "${updates.S3.Bucket}"`,
              );
            }
            if (updates.S3.Region !== undefined) {
              newS3 = newS3.replace(
                /Region\s*=\s*"[^"]*"/,
                `Region = "${updates.S3.Region}"`,
              );
            }
            if (updates.S3.Endpoint !== undefined) {
              newS3 = newS3.replace(
                /Endpoint\s*=\s*"[^"]*"/,
                `Endpoint = "${updates.S3.Endpoint}"`,
              );
            }
            if (updates.S3.AccessKey !== undefined) {
              newS3 = newS3.replace(
                /AccessKey\s*=\s*"[^"]*"/,
                `AccessKey = "${updates.S3.AccessKey}"`,
              );
            }
            if (updates.S3.SecretKey !== undefined) {
              newS3 = newS3.replace(
                /SecretKey\s*=\s*"[^"]*"/,
                `SecretKey = "${updates.S3.SecretKey}"`,
              );
            }
            if (updates.S3.ForcePathStyle !== undefined) {
              newS3 = newS3.replace(
                /ForcePathStyle\s*=\s*(true|false)/,
                `ForcePathStyle = ${updates.S3.ForcePathStyle}`,
              );
            }

            updatedContent = updatedContent.replace(
              /S3\s*=\s*\{[^}]+\}/s,
              `S3 = {${newS3}}`,
            );
          }
        }

        fs.writeFileSync(this.configPath, updatedContent, "utf8");

        // Update cached config and content
        this.configContent = updatedContent;
        if (updates.SMTP) {
          Object.assign(this.config.Advanced.SMTP, updates.SMTP);
        }
        if (updates.S3) {
          Object.assign(this.config.Advanced.S3, updates.S3);
        }

        return true;
      } catch (err) {
        console.log(
          `^1[Config Loader]^7 Failed to update advanced settings: ${err.message}`,
        );
        return false;
      }
    }
  }

  // Return singleton instance
  return new ConfigLoader();
})();
