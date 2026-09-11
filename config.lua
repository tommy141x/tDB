Config = {}

-- ============================================================================
-- ADMIN INTERFACE EXPOSURE
-- ============================================================================
-- Whether to publish the PocketBase admin UI through tLib's router.
--
-- tDB NEVER opens a port of its own. PocketBase always binds 127.0.0.1, so by
-- itself it is headless: usable by this server's resources and unreachable
-- from anywhere else. The only way in from outside is tLib, which owns the
-- server's single external port and proxies Config.MountPath through to it.
--
-- true (default): register the mount on startup. The admin UI is then at
--                 <tLib hub URL><MountPath>/_/ — on tLib's port. PocketBase's
--                 own loopback port stays internal and must not be forwarded.
-- false:          stay headless. Nothing is registered and nothing outside
--                 this machine can reach the database at all.
--
-- Turning this off does not affect any script using tDB — those talk to it
-- over loopback either way.
-- ============================================================================
Config.ExposeAdmin = true

-- ============================================================================
-- MOUNT PATH (only used when ExposeAdmin = true)
-- ============================================================================
-- Path prefix the tLib router serves PocketBase under.
-- Change it only if it collides with another resource's mount - tLib refuses
-- overlapping mounts rather than silently shadowing one, and logs which
-- resource already owns the path.
-- ============================================================================
Config.MountPath = "/db"

-- ============================================================================
-- PUBLIC URL
-- ============================================================================
-- DEPRECATED and ignored. tDB has no public address of its own - the one the
-- admin UI appears on is tLib's. Override it with 'tlib_http_public_url' in
-- server.cfg. Kept only so existing configs keep loading.
-- ============================================================================
Config.Host = "localhost"

-- ============================================================================
-- PORT - there isn't one
-- ============================================================================
-- There is deliberately no port setting here. PocketBase binds 127.0.0.1 on
-- port 8090, and if something on this machine already holds 8090 it silently
-- takes a free port instead - nothing outside this machine addresses it, so
-- the number is never typed, forwarded, or dialled.
--
-- The one port that IS a decision belongs to tLib, which owns the server's
-- single external port and proxies Config.MountPath through to PocketBase.
-- To change it, put this in server.cfg:
--
--     setr tlib_http_port 7777
--
-- (A 'Config.Port' left over from an older tDB is simply ignored.)
-- ============================================================================

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
Config.AutoUpdate = false

-- ============================================================================
-- MIGRATION CONFIGURATION
-- ============================================================================
Config.Migrations = {
    -- Auto-apply pending migrations on startup
    -- When enabled, any new migration files will be automatically applied
    AutoApply = true,

    -- Directory where migration files are stored
    -- Default: "pb_migrations"
    Dir = "pb_migrations",
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
    DataDir = "pb_data",

    -- SMTP Email Configuration (optional)
    -- Configure email sending for password resets, verifications, etc.
    SMTP = {
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
    -- Configure S3-compatible storage for file uploads
    S3 = {
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
