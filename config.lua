Config = {}

-- ============================================================================
-- ADMIN INTERFACE EXPOSURE
-- ============================================================================
-- Controls whether the PocketBase admin UI is publicly accessible
--
-- false (default - RECOMMENDED):
--   • PocketBase only accessible by this FiveM resource
--   • No public access to admin UI or API
--   • Binds to 127.0.0.1 (localhost only)
--   • Most secure option for production
--
-- true (only if you need external access):
--   • Admin UI accessible from external clients
--   • Binds to 0.0.0.0 (all network interfaces)
--   • Requires proper firewall configuration
--   • Public URL will be displayed on startup
-- ============================================================================
Config.ExposeAdmin = true

-- ============================================================================
-- PUBLIC URL (only used when ExposeAdmin = true)
-- ============================================================================
-- Leave empty ("") to auto-detect your server's public IP
-- Or specify your server's IP/domain manually
--
-- Examples:
--   "" - Auto-detect public IP
--   "192.168.1.100" - Use specific IP
--   "myserver.com" - Use domain name
-- ============================================================================
Config.Host = "localhost"

-- ============================================================================
-- PORT
-- ============================================================================
-- The port PocketBase will listen on
-- Default: 8090
-- ============================================================================
Config.Port = 8090

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
    Email = "",
    Password = "",
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
    --   • Config.Port, Migrations, Backup, SMTP, and S3 settings are ignored
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
