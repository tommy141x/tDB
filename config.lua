Config = {}

-- Publish the PocketBase admin panel at /db/_/ on tLib's public URL and port.
-- Disable to keep tDB private; server resources can still use it internally.
Config.ExposeAdmin = true

-- ============================================================================
-- SUPERUSER CREDENTIALS
-- ============================================================================
-- Admin account credentials for PocketBase
-- Auto-generated on first startup if left empty
--
-- SECURITY WARNING: Credentials are stored in plain text
-- Make sure this file has proper permissions!
-- ============================================================================
Config.Superuser = {
    -- Leave empty for auto-generation on first startup
    Email = "admin@localhost.local",
    Password = "K5FpzGrGb+N2Xrue1Q5D",
}

-- ============================================================================
-- AUTO UPDATE
-- ============================================================================
-- Automatically update PocketBase binary on resource start
-- false (recommended): Manual updates for stability
-- true: Automatic updates to latest version
-- ============================================================================
Config.AutoUpdate = true

-- ============================================================================
-- MIGRATION CONFIGURATION
-- ============================================================================
Config.Migrations = {
    -- Auto-apply pending migrations on startup
    -- When enabled, any new migration files will be automatically applied
    AutoApply = true,

    -- Directory where migration files are stored
    -- Default: "pb_migrations"
    Dir = ".runtime/pb_migrations",
}

-- ============================================================================
-- SQL FILE IMPORT
-- ============================================================================
-- Scripts normally ship a .sql file you are expected to load into MySQL by
-- hand. Drop it in tDB's sql/ folder instead and it is applied on startup,
-- before any other resource can query.
--
-- A file runs once, ever, and lands whole or not at all. What has run is
-- recorded in the tdb_sql_imports table - see `tdb sql status`.
-- ============================================================================
Config.Sql = {
    -- Import .sql files on startup
    Enabled = true,

    -- Folder to take them from, relative to this resource
    Dir = "sql",

    -- What to do with a file that changed after it was already applied.
    -- Re-running a dump replays every INSERT in it, so this is not automatic.
    --   "warn"  (recommended): report it and move on
    --   "error": report it loudly; still does not re-run it
    --   "apply": re-run the whole file
    OnChanged = "warn",
}

-- ============================================================================
-- BACKUP CONFIGURATION
-- ============================================================================
Config.Backup = {
    -- Enable automatic backup system
    Enabled = false,

    -- Create backup on resource startup (recommended)
    OnStartup = true,

    -- Auto-backup interval in seconds (0 = disabled)
    -- Example: 86400 = every 24 hours
    Schedule = 0,

    -- Number of backups to keep (older ones are auto-deleted)
    -- Set to 0 to keep all backups
    KeepLast = 7,

    -- Prefix for auto-created backup filenames
    BackupPrefix = "auto_",
}

-- ============================================================================
-- ADVANCED OPTIONS (rarely need to change these)
-- ============================================================================
Config.Advanced = {
    -- ========================================================================
    -- REMOTE POCKETBASE MODE
    -- ========================================================================
    -- Connect to an existing remote PocketBase instance instead of starting
    -- a local one. Both RemoteHost and RemotePort must be filled to enable.
    --
    -- When enabled:
    --   • No local PocketBase process will be started
    --   • Connects to remote instance using Config.Superuser credentials
    --   • Migrations, Backup, SMTP, and S3 settings are ignored
    --   • Perfect for connecting multiple FiveM servers to one PocketBase
    --
    -- Examples:
    --   RemoteHost = "192.168.1.100"
    --   RemotePort = "8090"
    --
    --   RemoteHost = "pocketbase.myserver.com"
    --   RemotePort = "443"
    -- ========================================================================
    RemoteHost = "",
    RemotePort = "",

    -- Enable development mode (more verbose logging)
    Dev = false,

    -- Enable automatic database migrations
    AutoMigrate = true,

    -- Directory for public files (web interface)
    PublicDir = "pb_public",

    -- Directory for database and internal data
    DataDir = ".runtime/pb_data",

    -- ========================================================================
    -- SMTP AND S3
    -- ========================================================================
    -- Both blocks work the same way, and `Manage` is the important switch.
    --
    --   Manage = false (default)
    --       tDB never touches this setting on the PocketBase instance. Set it
    --       in the admin UI and it stays exactly as you left it. Everything
    --       below is then ignored - tDB says so on startup if you filled it in.
    --
    --   Manage = true
    --       config.lua is the truth. Every field below is applied on every
    --       start, so the instance always matches this file. An edit made in
    --       the admin UI is reported and then overwritten.
    --       Enabled = false here genuinely turns the feature off.
    --
    -- Settings only ever travel config.lua -> PocketBase, never back. They
    -- cannot travel back: PocketBase does not hand out the SMTP password or
    -- the S3 secret once set, so reading its settings and writing them here
    -- would replace your real credentials with empty strings.
    -- ========================================================================

    -- SMTP Email Configuration (optional)
    -- Email sending for password resets, verifications, etc.
    SMTP = {
        Manage = false,
        Enabled = false,
        Host = "smtp.gmail.com",
        Port = 587,
        Username = "",
        Password = "",
        -- LocalName is optional (defaults to "localhost")
        LocalName = "",
        -- Use TLS encryption
        TLS = true,
    },

    -- S3 Storage Configuration (optional)
    -- S3-compatible storage for file uploads
    S3 = {
        Manage = false,
        Enabled = false,
        Bucket = "",
        Region = "",
        Endpoint = "",
        AccessKey = "",
        SecretKey = "",
        -- Force path style (for MinIO and some S3-compatible services)
        ForcePathStyle = false,
    },
}

return Config
