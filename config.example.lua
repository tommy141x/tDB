--[[----------------------------------------------------------------------
    TIMMYG Studios — tDB 1.0.0
    config.example.lua — the committed template. Never edited in place.

    HOW IT IS USED: tDB copies this file to `config.lua` the first time it
    starts, if `config.lua` is not already there. Edit `config.lua`. This
    file is overwritten by updates; `config.lua` is yours and is kept out of
    git, because tDB writes the generated superuser password into it.

    HOW TO EDIT: change values to the RIGHT of the = sign only. Keep the
    commas — a trailing comma on the last entry is legal Lua and is there on
    purpose. Do not remove the quotes around text.

    APPLYING CHANGES: restart the resource. `ensure tDB` in the server
    console, or txAdmin > Resources > tDB > Restart. Nothing here is read
    again while the server runs.

    IF IT WON'T START: Lua reports the line BELOW the real mistake, so look
    one line up from whatever the console names. Fix the FIRST error only,
    then restart — everything after it is usually just fallout from that one.

    NEVER paste your real config.lua in a public support channel: it holds
    the superuser password in plain text. `tdb status` prints a redacted
    version that is safe to share.

    Docs: https://docs.timmygstudios.com/docs/tDB/configuration
------------------------------------------------------------------------]]

Config = {}

-- ==========================================================================
--  1. REQUIRED — nothing. tDB runs correctly with this file unedited.
--     The superuser login is generated on first start and written into
--     config.lua for you. Everything below is optional.
-- ==========================================================================

-- ==========================================================================
--  2. COMMON SETTINGS
-- ==========================================================================

-- Publish the PocketBase admin panel at /db/_/ on tLib's public URL and port.
-- Set false to keep tDB private; server resources can still use it internally
-- and the database itself is unaffected. Default: true
Config.ExposeAdmin = true

-- List the admin panel in tLib's hub index. Cosmetic ONLY: the mount still
-- answers to anyone who requests it while ExposeAdmin is true. For genuine
-- unreachability use ExposeAdmin = false. Default: true
Config.ShowInHub = true

-- Run `pocketbase update` on every start.
--
-- FALSE on purpose. tDB ships a specific PocketBase build, fetched against a
-- published checksum. Turning this on replaces that verified binary with an
-- unverified newer one, under a live database, without asking. Leave it off
-- and take PocketBase updates with tDB updates. Default: false
Config.AutoUpdate = false

-- The PocketBase admin login.
--
-- Leave both empty and tDB generates them on first start and writes them back
-- into config.lua — that write is why config.lua must stay out of version
-- control. The generated password is printed in the server console ONCE, on
-- the run that creates it, and never again.
--
-- Fill them in yourself to pin a known login. To rotate: blank both, restart.
Config.Superuser = {
    Email = "",
    Password = "",
}

-- ==========================================================================
--  3. SQL IMPORTS
--
--  Scripts normally ship a .sql file you load into MySQL by hand. Drop it in
--  Dir instead and it is applied on startup, before any other resource can
--  query. A file runs once, ever, and lands whole or not at all; what has run
--  is recorded in tdb_sql_imports. See `tdb sql status`.
-- ==========================================================================

Config.Sql = {
    -- Default: true
    Enabled = true,

    -- Relative to the resource folder, or an absolute path. Default: "sql"
    Dir = "sql",

    -- What to do about a file that changed after it was applied. Re-running a
    -- dump replays every INSERT in it, so only "apply" re-runs.
    --   "warn"   report it and move on
    --   "error"  report it loudly, still does not re-run
    --   "apply"  re-run the whole file — suits pure DDL dumps only
    -- Default: "warn"
    OnChanged = "warn",
}

-- ==========================================================================
--  4. BACKUPS
--
--  Backups land inside the PocketBase data directory, under `backups`.
--  That is the same disk as the database: it protects against a bad
--  migration, not against losing the machine.
-- ==========================================================================

Config.Backup = {
    -- Master switch. Nothing below happens while this is false.
    -- Default: false
    Enabled = false,

    -- Back up once, before each start. Default: true
    OnStartup = true,

    -- Seconds between scheduled backups. 0 disables the timer.
    -- 3600 = hourly, 86400 = daily. Default: 0
    ScheduleSeconds = 0,

    -- How many of tDB's OWN backups to keep; the oldest are deleted past this.
    -- 0 keeps all of them. Backups you took by hand are never pruned.
    -- Default: 7
    KeepLast = 7,

    -- How tDB recognises its own backups, so manual ones survive rotation.
    -- Default: "auto_"
    BackupPrefix = "auto_",
}

-- ==========================================================================
--  5. MIGRATIONS
--
--  PocketBase's own collection migrations, not the .sql drop folder above.
--  PocketBase writes a migration file whenever you change a collection in the
--  admin UI, so schema changes travel with the resource. Collection edits made
--  in the UI are never reverted.
-- ==========================================================================

Config.Migrations = {
    -- Apply pending migrations on start. Default: true
    AutoApply = true,

    -- Relative to the resource folder. Sits beside pb_data on purpose: it is
    -- the path PocketBase derives anyway, and it keeps everything PocketBase
    -- writes under one gitignored tree. Default: ".runtime/pb_migrations"
    Dir = ".runtime/pb_migrations",
}

-- ==========================================================================
--  6. ADVANCED — most servers change nothing here
-- ==========================================================================

Config.Advanced = {
    -- Use a PocketBase instance you already run instead of starting one. BOTH
    -- must be set, or tDB stays local. No local process is started, and
    -- Migrations, Backup, SMTP and S3 are ignored: the instance is somebody
    -- else's to configure. Remote mode DOES require Superuser.Email and
    -- Superuser.Password above — tDB cannot generate a login on a database it
    -- does not own.
    -- Example: RemoteHost = "db.example.com", RemotePort = "8090"
    RemoteHost = "",
    RemotePort = "",

    -- Run PocketBase with verbose logging. Noisy. Default: false
    Dev = false,

    -- Let PocketBase write a migration file when a collection changes in the
    -- admin UI. Default: true
    AutoMigrate = true,

    -- Directory served as static files, relative to the resource folder.
    -- Default: "pb_public"
    PublicDir = "pb_public",

    -- Where the database and its backups live, relative to the resource
    -- folder. Changing this points PocketBase at a NEW, EMPTY directory — it
    -- does not move your data. Stop the server, move the folder yourself, then
    -- change this. Default: ".runtime/pb_data"
    DataDir = ".runtime/pb_data",

    -- ----------------------------------------------------------------------
    --  Manage decides who owns the two blocks below.
    --
    --    false  tDB never touches the setting. Set it in the admin UI and it
    --           stays. Everything else in the block is ignored, and tDB says
    --           so on startup if you filled it in.
    --    true   config.lua wins. Every field is applied on every start, and an
    --           admin-UI edit is reported and then overwritten. Enabled =
    --           false genuinely turns the feature off.
    --
    --  Settings only travel config.lua -> PocketBase, never back: PocketBase
    --  will not hand out the SMTP password or the S3 secret once set, so
    --  syncing the other way would overwrite real credentials with empty ones.
    --
    --  These are credentials. They live in config.lua, which is gitignored and
    --  server-side only — never in a shared_script.
    -- ----------------------------------------------------------------------

    SMTP = {
        Manage = false,
        Enabled = false,

        -- Mail server hostname. NO default on purpose: a prefilled host would
        -- mean flipping Enabled = true silently aimed your mail somewhere you
        -- never chose. Example: Host = "smtp.gmail.com"
        Host = "",

        -- 587 for STARTTLS, 465 for implicit TLS, 25 unencrypted.
        -- Default: 587
        Port = 587,

        Username = "",
        Password = "",

        -- HELO/EHLO name. Empty lets PocketBase pick. Default: ""
        LocalName = "",

        -- Default: true
        TLS = true,
    },

    S3 = {
        Manage = false,
        Enabled = false,
        Bucket = "",
        Region = "",

        -- Example: Endpoint = "https://s3.us-east-1.amazonaws.com"
        Endpoint = "",

        AccessKey = "",
        SecretKey = "",

        -- For MinIO and some S3-compatible services. Default: false
        ForcePathStyle = false,
    },
}

return Config
