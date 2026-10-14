// Regex-parses config.lua into a plain object. Singleton, cached after load().
//
// config.lua is NOT in git. It is the operator's copy, created on first run by
// copying config.example.lua (see ensureConfigFile), and it is the file the
// generated superuser password gets written into - which is exactly why it must
// never be tracked. config.example.lua is the committed template and carries no
// real values.
//
// buildDefaults() below is the single source of truth for every default. The
// example file documents those values and must agree with them;
// tests/dev/config-defaults.test.js parses the example through this loader and
// fails if the two ever drift apart.
module.exports = (function () {
  const fs = require("fs");
  const path = require("path");

  const CONFIG_FILE = "config.lua";
  const EXAMPLE_FILE = "config.example.lua";

  /**
   * THE defaults. Every one of these is what tDB does when the key is missing
   * from config.lua, and config.example.lua ships these same values.
   *
   * Returns a fresh object each call: the loader mutates what it is given, and
   * a shared literal would leak one load's parse into the next.
   */
  function buildDefaults() {
    return {
      // Publish the admin UI through tLib's router. True because that is the
      // resource's headline feature, it is what the docs have always promised,
      // and the panel is password-gated behind a generated random superuser
      // password. `false` keeps the database reachable only from the machine.
      ExposeAdmin: true,

      // Whether the mount appears in tLib's hub index. Not a security control -
      // an unlisted mount still answers.
      ShowInHub: true,

      // Print the `debug` log level. FALSE, matching tLib's own logger, whose
      // minimum level is INFO until a resource raises it. tDB's JS logger had
      // no level filter at all, so every debug line - the pid-file sweep, the
      // route probe, each backup, "Admin UI published at", which the banner's
      // Admin row already carries - printed on every boot of every install.
      Debug: false,

      // Preferred loopback port, not a setting. Overwritten at startup with
      // the port PocketBase actually got - see resolveInternalPort(). It is
      // deliberately absent from config.example.lua.
      Port: 8090,

      // Run `pocketbase update` on start. FALSE deliberately, against what the
      // docs said before: scripts/fetch-runtime.ts pins a version AND verifies
      // it against the published checksum, and `update` replaces that vetted
      // binary with an unverified newer one, under a live database, without
      // asking. Safe-by-default beats convenience here.
      AutoUpdate: false,

      Superuser: {
        Email: "",
        Password: "",
      },
      Migrations: {
        AutoApply: true,
        // Beside pb_data rather than at the resource root. PocketBase derives
        // `<dataDir>/../pb_migrations` when --migrationsDir is omitted, so this
        // is the path it would have picked anyway, and it keeps everything
        // PocketBase writes under the one gitignored .runtime/ tree.
        Dir: ".runtime/pb_migrations",
      },
      Sql: {
        Enabled: true,
        Dir: "sql",
        OnChanged: "warn",
      },
      Backup: {
        Enabled: false,
        OnStartup: true,
        // Renamed from `Schedule` - the unit belongs in the name.
        // The old key is still read, with a deprecation warning.
        ScheduleSeconds: 0,
        KeepLast: 7,
        BackupPrefix: "auto_",
      },
      Advanced: {
        RemoteHost: "",
        RemotePort: "",
        Dev: false,
        AutoMigrate: true,
        PublicDir: "pb_public",
        DataDir: ".runtime/pb_data",
        // THERE IS NO SMTP BLOCK, and there is not meant to be one. Mail
        // settings live in the PocketBase admin UI and nowhere else: tDB's
        // default was `Manage = false`, i.e. the admin UI owns them, so
        // config.lua held a second copy of eight fields that it then declined
        // to apply - including an SMTP password sitting in a file next to a
        // comment explaining it was being ignored.
        //
        // Manage false means tDB never touches S3 on the instance, so the
        // admin UI owns it. See reconcileSettings() in server.js.
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
  }

  // A Lua string literal, either quote style. The old parser accepted only
  // double quotes, so a perfectly legal `Dir = 'sql'` parsed as nothing and
  // silently fell back to the default.
  const LUA_STRING = /^(?:"([^"]*)"|'([^']*)')/;

  /**
   * Every name this loader will look for, by the block it lives in.
   *
   * This exists for the one failure `read()` cannot see. read() is handed a key
   * NAME and reports the value it found under it, so it covers "the value is
   * wrong" completely - but a MISSPELLED key is a name it is never handed. Its
   * regex simply does not match, it returns null, the default stands, and the
   * operator's setting does nothing at all with nothing said. That is the
   * config bug this whole file's header calls the most expensive kind, and it
   * was the only shape of it left uncovered here.
   *
   * Kept beside the read() calls in load() on purpose: the two lists have to
   * agree, and tests/dev/config-defaults.test.js parses config.example.lua
   * through this loader, so a name added to one and not the other shows up as
   * the example file warning about its own key.
   */
  const KNOWN_KEYS = {
    // `Config.<Name>` at the top level. The five table names are here because
    // they are assignments too - `Config.Backup = {` - and leaving them out
    // would report every block in the file as a stray key.
    root: [
      "ExposeAdmin",
      "ShowInHub",
      "Debug",
      "AutoUpdate",
      "Superuser",
      "Migrations",
      "Sql",
      "Backup",
      "Advanced",
    ],
    Superuser: ["Email", "Password"],
    Migrations: ["AutoApply", "Dir"],
    Sql: ["Enabled", "Dir", "OnChanged"],
    // Schedule is the retired name. It is read, with a deprecation warning of
    // its own further down, so it must not also be reported as unknown.
    Backup: [
      "Enabled",
      "OnStartup",
      "ScheduleSeconds",
      "Schedule",
      "KeepLast",
      "BackupPrefix",
    ],
    Advanced: [
      "RemoteHost",
      "RemotePort",
      "Dev",
      "AutoMigrate",
      "PublicDir",
      "DataDir",
      "S3",
    ],
    S3: [
      "Manage",
      "Enabled",
      "Bucket",
      "Region",
      "Endpoint",
      "AccessKey",
      "SecretKey",
      "ForcePathStyle",
    ],
  };

  /**
   * Keys that parse, are spelled correctly, and still do nothing. Reported in
   * their own words rather than as a typo, because "did you mean" advice on a
   * key the operator spelled perfectly is worse than silence.
   */
  const INERT_KEYS = {
    Port:
      "Config.Port is not a setting. The PocketBase port is loopback-internal " +
      "and is resolved at startup (preferred 8090, otherwise any free port), " +
      "so whatever is written here is overwritten before anything reads it. " +
      "Fix: delete the line. To reach a PocketBase you run yourself, use " +
      "Config.Advanced.RemoteHost and RemotePort instead.",
  };

  /**
   * Levenshtein distance, capped in effect by the caller's budget. Only used to
   * decide whether two key names are CLOSE.
   */
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    let cur = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  /**
   * The known name an unknown one was probably meant to be, or null.
   *
   * Case-insensitive, and the budget scales with length: `ExposeAdmn` and
   * `exposeadmin` are both near-misses worth naming, while a wrong suggestion
   * is worse than none - so it stays conservative and a long key gets no more
   * slack in proportion than a short one.
   */
  function suggest(unknown, known) {
    const budget = Math.max(2, Math.floor(unknown.length / 4));
    let best = null;
    let bestDistance = Infinity;
    for (const name of known) {
      const distance = editDistance(unknown.toLowerCase(), name.toLowerCase());
      if (distance <= budget && distance < bestDistance) {
        best = name;
        bestDistance = distance;
      }
    }
    return best;
  }

  class ConfigLoader {
    constructor() {
      this.config = null;
      this.configContent = "";
      this.configPath = "";
      // Collected during load() and drained by server.js into the startup box.
      // A parse problem the operator never sees is the same as no validation.
      this.warnings = [];
    }

    /**
     * Make sure config.lua exists, copying config.example.lua over it on a
     * first run. Never overwrites an existing file.
     *
     * @returns {{created: boolean, error: string|null}}
     */
    ensureConfigFile(resourcePath) {
      const target = path.join(resourcePath, CONFIG_FILE);
      const example = path.join(resourcePath, EXAMPLE_FILE);

      if (fs.existsSync(target)) return { created: false, error: null };

      if (!fs.existsSync(example)) {
        return {
          created: false,
          error:
            `Neither ${CONFIG_FILE} nor ${EXAMPLE_FILE} is present in the tDB ` +
            `resource folder. Re-download the release; ${EXAMPLE_FILE} ships with it.`,
        };
      }

      try {
        // copyFileSync with COPYFILE_EXCL so two resources racing to boot
        // cannot have one truncate the other's fresh copy.
        fs.copyFileSync(example, target, fs.constants.COPYFILE_EXCL);
        return { created: true, error: null };
      } catch (err) {
        if (err.code === "EEXIST") return { created: false, error: null };
        return {
          created: false,
          error: `Could not create ${CONFIG_FILE} from ${EXAMPLE_FILE}: ${err.message}`,
        };
      }
    }

    /**
     * Read one key out of a chunk of config.lua.
     *
     * `kind` is "bool", "number", "string", or an array of allowed strings
     * (an enum). `label` is what the operator is told the key is called, so it
     * reads as `Config.Backup.KeepLast` rather than `KeepLast`.
     *
     * Absent key -> null, and the default stands. Key PRESENT but unparseable
     * -> a warning naming file, key, expected and found, then null. Silently
     * ignoring it is the anti-pattern: the operator's setting
     * does nothing and nothing says so.
     */
    read(chunk, key, kind, label) {
      // Skip Lua-commented lines, and capture the whole right-hand side so the
      // warning can quote what was actually there.
      const line = chunk.match(
        new RegExp(`^(?!\\s*--).*?\\b${key}\\s*=\\s*(.*)$`, "m"),
      );
      if (!line) return null;

      const raw = line[1].replace(/\s*--.*$/, "").replace(/,\s*$/, "").trim();
      const name = label || key;

      if (kind === "bool") {
        if (raw === "true") return true;
        if (raw === "false") return false;
        return this.reject(name, "true or false (no quotes)", raw);
      }

      if (kind === "number") {
        const m = raw.match(/^-?\d+$/);
        if (m) return parseInt(raw, 10);
        return this.reject(name, "a whole number, unquoted", raw);
      }

      const str = raw.match(LUA_STRING);

      if (kind === "string") {
        if (str) return str[1] !== undefined ? str[1] : str[2];
        return this.reject(name, 'a quoted string, e.g. "value"', raw);
      }

      if (Array.isArray(kind)) {
        const value = str ? (str[1] !== undefined ? str[1] : str[2]) : null;
        if (value !== null && kind.includes(value)) return value;
        return this.reject(
          name,
          `one of ${kind.map((v) => `"${v}"`).join(", ")}`,
          raw,
        );
      }

      return null;
    }

    /** Record an unparseable key and leave the default in place. */
    reject(name, expected, found) {
      this.warnings.push(
        `${CONFIG_FILE}: ${name} could not be read. Expected ${expected}, ` +
          `found \`${found || "(nothing)"}\`. The built-in default is being used ` +
          `instead - fix the value and restart tDB.`,
      );
      return null;
    }

    /**
     * Report every assignment in `chunk` whose name this loader never looks
     * for. `prefix` is what the operator is told the block is called
     * ("Config.Backup"), `known` the names that belong in it.
     *
     * Lua-commented lines are skipped, so the example values carried in
     * comments - `-- Endpoint = "s3.example.com"` - are not reported as keys.
     *
     * `re` is how a key is spelled at this level: bare inside a table, and
     * `Config.<Name>` at the top of the file.
     */
    unknownKeys(chunk, prefix, known, re = /^\s*([A-Za-z_]\w*)\s*=/) {
      if (!chunk) return;

      const seen = new Set();
      for (const line of chunk.split("\n")) {
        if (/^\s*--/.test(line)) continue;
        const m = line.match(re);
        if (!m) continue;

        const key = m[1];
        if (known.includes(key) || seen.has(key)) continue;
        seen.add(key);

        const label = `${prefix}.${key}`;

        if (INERT_KEYS[key]) {
          this.warnings.push(`${CONFIG_FILE}: ${INERT_KEYS[key]}`);
          continue;
        }

        const guess = suggest(key, known);
        this.warnings.push(
          `${CONFIG_FILE}: ${label} is not a setting tDB reads, so it is doing ` +
            `nothing. ` +
            (guess
              ? `Fix: did you mean ${prefix}.${guess}?`
              : `Fix: check it against ${EXAMPLE_FILE}, or delete it.`),
        );
      }
    }

    /** Slice a flat `Config.<Name> = { ... }` table out of the file. */
    section(name) {
      const m = this.configContent.match(
        new RegExp(`Config\\.${name}\\s*=\\s*\\{([^}]+)\\}`, "s"),
      );
      return m ? m[1] : null;
    }

    /**
     * Slice a nested `<Name> = { ... }` sub-table (S3).
     *
     * Anchored to the start of a line so prose - `Backup and S3 are ignored`
     * in the Advanced header comment - cannot be mistaken for the table
     * itself.
     */
    subSection(name) {
      const m = this.configContent.match(
        new RegExp(`^[^\\S\\n]*${name}\\s*=\\s*\\{([^}]+)\\}`, "m"),
      );
      return m ? m[1] : null;
    }

    load(resourcePath) {
      if (this.config) {
        return this.config;
      }

      this.config = buildDefaults();
      this.warnings = [];

      this.configPath = path.join(resourcePath, CONFIG_FILE);

      const bootstrap = this.ensureConfigFile(resourcePath);
      if (bootstrap.error) {
        this.warnings.push(bootstrap.error);
      } else if (bootstrap.created) {
        console.log(
          `^2[Config Loader]^7 First run: created ${CONFIG_FILE} from ${EXAMPLE_FILE}. ` +
            `Edit ${CONFIG_FILE}, not ${EXAMPLE_FILE} - updates overwrite the example.`,
        );
      }

      try {
        if (!fs.existsSync(this.configPath)) {
          console.log(
            `^3[Config Loader]^7 ${CONFIG_FILE} not found, using defaults`,
          );
          return this.config;
        }

        this.configContent = fs.readFileSync(this.configPath, "utf8");

        const set = (target, prop, value) => {
          if (value !== null) target[prop] = value;
        };
        const whole = this.configContent;

        // ---- Parse top-level config ----
        set(
          this.config,
          "ExposeAdmin",
          this.read(whole, "Config\\.ExposeAdmin", "bool", "Config.ExposeAdmin"),
        );
        set(
          this.config,
          "ShowInHub",
          this.read(whole, "Config\\.ShowInHub", "bool", "Config.ShowInHub"),
        );
        set(this.config, "Debug", this.read(whole, "Config\\.Debug", "bool", "Config.Debug"));

        // Config.Port is deliberately NOT parsed. The port is
        // loopback-internal and startPocketBase() resolves it at runtime
        // (prefer 8090, else any free port). Honouring a stale Config.Port
        // would reintroduce the collision that resolution exists to avoid.

        set(
          this.config,
          "AutoUpdate",
          this.read(whole, "Config\\.AutoUpdate", "bool", "Config.AutoUpdate"),
        );

        // ---- Superuser ----
        // Scoped to its own table rather than matched across the whole file.
        // Advanced.S3 has a `SecretKey`, and a whole-file match for a password
        // would hand the admin login whichever one is written first.
        const superuser = this.section("Superuser");
        if (superuser) {
          set(
            this.config.Superuser,
            "Email",
            this.read(superuser, "Email", "string", "Config.Superuser.Email"),
          );
          set(
            this.config.Superuser,
            "Password",
            this.read(
              superuser,
              "Password",
              "string",
              "Config.Superuser.Password",
            ),
          );
        }

        // ---- Backup ----
        const backup = this.section("Backup");
        if (backup) {
          const b = this.config.Backup;
          set(b, "Enabled", this.read(backup, "Enabled", "bool", "Config.Backup.Enabled"));
          set(
            b,
            "OnStartup",
            this.read(backup, "OnStartup", "bool", "Config.Backup.OnStartup"),
          );

          // Renamed key. Read the new name first; fall back to the old one with
          // a deprecation warning rather than silently dropping the operator's
          // setting.
          const scheduleSeconds = this.read(
            backup,
            "ScheduleSeconds",
            "number",
            "Config.Backup.ScheduleSeconds",
          );
          if (scheduleSeconds !== null) {
            b.ScheduleSeconds = scheduleSeconds;
          } else if (/^(?!\s*--).*\bScheduleSeconds\s*=/m.test(backup) === false) {
            const legacy = this.read(
              backup,
              "Schedule",
              "number",
              "Config.Backup.Schedule",
            );
            if (legacy !== null) {
              b.ScheduleSeconds = legacy;
              this.warnings.push(
                `${CONFIG_FILE}: Config.Backup.Schedule is deprecated and will be ` +
                  `removed in tDB 2.0. It has been read as ` +
                  `Config.Backup.ScheduleSeconds = ${legacy}. Rename the key to ` +
                  `ScheduleSeconds to silence this.`,
              );
            }
          }

          set(b, "KeepLast", this.read(backup, "KeepLast", "number", "Config.Backup.KeepLast"));
          set(
            b,
            "BackupPrefix",
            this.read(backup, "BackupPrefix", "string", "Config.Backup.BackupPrefix"),
          );
        }

        // ---- Migrations ----
        const migrations = this.section("Migrations");
        if (migrations) {
          set(
            this.config.Migrations,
            "AutoApply",
            this.read(migrations, "AutoApply", "bool", "Config.Migrations.AutoApply"),
          );
          set(
            this.config.Migrations,
            "Dir",
            this.read(migrations, "Dir", "string", "Config.Migrations.Dir"),
          );
        }

        // ---- Sql ----
        const sql = this.section("Sql");
        if (sql) {
          set(this.config.Sql, "Enabled", this.read(sql, "Enabled", "bool", "Config.Sql.Enabled"));
          set(this.config.Sql, "Dir", this.read(sql, "Dir", "string", "Config.Sql.Dir"));
          set(
            this.config.Sql,
            "OnChanged",
            this.read(sql, "OnChanged", ["warn", "error", "apply"], "Config.Sql.OnChanged"),
          );
        }

        // ---- Advanced ----
        // The flat keys only. Slicing stops before the S3 sub-table so a flat
        // key here cannot pick up one of S3's.
        const advancedStart = whole.indexOf("Config.Advanced");
        let advanced = advancedStart === -1 ? "" : whole.slice(advancedStart);
        // Cut at the S3 sub-table's own LINE, not at the first mention of the
        // name: the Advanced header comment says "Migrations, Backup and S3
        // are ignored", and that sits above every flat key here.
        const s3At = advanced.search(/^[^\S\n]*S3\s*=\s*\{/m);
        if (s3At !== -1) advanced = advanced.slice(0, s3At);

        // An empty RemoteHost/RemotePort means "local", not "unset": both must
        // be non-empty for remote mode, so an empty string keeps the default.
        const remoteHost = this.read(
          advanced,
          "RemoteHost",
          "string",
          "Config.Advanced.RemoteHost",
        );
        if (remoteHost) this.config.Advanced.RemoteHost = remoteHost;

        const remotePort = this.read(
          advanced,
          "RemotePort",
          "string",
          "Config.Advanced.RemotePort",
        );
        if (remotePort) this.config.Advanced.RemotePort = remotePort;

        set(this.config.Advanced, "Dev", this.read(advanced, "Dev", "bool", "Config.Advanced.Dev"));
        set(
          this.config.Advanced,
          "AutoMigrate",
          this.read(advanced, "AutoMigrate", "bool", "Config.Advanced.AutoMigrate"),
        );
        set(
          this.config.Advanced,
          "PublicDir",
          this.read(advanced, "PublicDir", "string", "Config.Advanced.PublicDir"),
        );
        set(
          this.config.Advanced,
          "DataDir",
          this.read(advanced, "DataDir", "string", "Config.Advanced.DataDir"),
        );

        // ---- Advanced.S3 ----
        const s3 = this.subSection("S3");
        if (s3) {
          const t = this.config.Advanced.S3;
          const at = (k) => `Config.Advanced.S3.${k}`;
          set(t, "Manage", this.read(s3, "Manage", "bool", at("Manage")));
          set(t, "Enabled", this.read(s3, "Enabled", "bool", at("Enabled")));
          set(t, "Bucket", this.read(s3, "Bucket", "string", at("Bucket")));
          set(t, "Region", this.read(s3, "Region", "string", at("Region")));
          set(t, "Endpoint", this.read(s3, "Endpoint", "string", at("Endpoint")));
          set(t, "AccessKey", this.read(s3, "AccessKey", "string", at("AccessKey")));
          set(t, "SecretKey", this.read(s3, "SecretKey", "string", at("SecretKey")));
          set(
            t,
            "ForcePathStyle",
            this.read(s3, "ForcePathStyle", "bool", at("ForcePathStyle")),
          );
        }

        // ---- Keys tDB never looks for ----
        //
        // Last, so a typo is reported after the values that WERE read - the
        // operator reads the box top-down and a "did you mean" line above the
        // settings it applies reads as though nothing was applied.
        //
        // One known blind spot, stated rather than papered over: the Advanced
        // slice stops at the S3 sub-table, so a stray key written BELOW it is
        // not seen. Extending the slice past a nested table with a regex is how
        // this parser starts matching braces it cannot count, and the shipped
        // file has nothing there.
        this.unknownKeys(whole, "Config", KNOWN_KEYS.root, /^\s*Config\.([A-Za-z_]\w*)\s*=/);
        this.unknownKeys(superuser, "Config.Superuser", KNOWN_KEYS.Superuser);
        this.unknownKeys(backup, "Config.Backup", KNOWN_KEYS.Backup);
        this.unknownKeys(migrations, "Config.Migrations", KNOWN_KEYS.Migrations);
        this.unknownKeys(sql, "Config.Sql", KNOWN_KEYS.Sql);
        this.unknownKeys(advanced, "Config.Advanced", KNOWN_KEYS.Advanced);
        this.unknownKeys(s3, "Config.Advanced.S3", KNOWN_KEYS.S3);

        return this.config;
      } catch (err) {
        console.log(
          `^1[Config Loader]^7 Failed to load config: ${err.message}`,
        );
        return this.config;
      }
    }

    updateSuperuserCredentials(email, password) {
      try {
        if (!this.configPath || !fs.existsSync(this.configPath)) {
          console.log(
            "^1[Config Loader]^7 Cannot update config - config file not loaded",
          );
          return false;
        }

        // Re-read rather than editing the copy taken at load(): this runs long
        // after startup on the superuser repair path, and writing the boot
        // snapshot back would revert anything edited by hand since.
        const original = fs.readFileSync(this.configPath, "utf8");

        // Scoped to the Config.Superuser table. A whole-file replace rewrites
        // the FIRST `Password = "..."`, which is the superuser's only by luck
        // of ordering.
        const block = original.match(/(Config\.Superuser\s*=\s*\{)([^}]*)(\})/s);
        if (!block) {
          console.log(
            "^1[Config Loader]^7 Cannot update config - no Config.Superuser block in config.lua",
          );
          return false;
        }

        const patched = block[2]
          .replace(/(Email\s*=\s*)(?:"[^"]*"|'[^']*')/, `$1"${email}"`)
          .replace(/(Password\s*=\s*)(?:"[^"]*"|'[^']*')/, `$1"${password}"`);

        const updatedContent =
          original.slice(0, block.index) +
          block[1] +
          patched +
          block[3] +
          original.slice(block.index + block[0].length);

        fs.writeFileSync(this.configPath, updatedContent, "utf8");

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

    get() {
      return this.config;
    }

    /** Warnings collected by the last load(), for the startup box. */
    getWarnings() {
      return this.warnings;
    }
  }

  const instance = new ConfigLoader();
  // Exposed for tests/dev/config-defaults.test.js, which needs a fresh loader
  // and the untouched default tree to compare config.example.lua against.
  instance.ConfigLoader = ConfigLoader;
  instance.buildDefaults = buildDefaults;
  instance.CONFIG_FILE = CONFIG_FILE;
  instance.EXAMPLE_FILE = EXAMPLE_FILE;
  return instance;
})();
