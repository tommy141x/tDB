--[[----------------------------------------------------------------------
    TIMMYG Studios — tDB 1.0.0
    config.lua — the file you edit. It is the only one.

    HOW TO EDIT: change values to the RIGHT of the = sign only. Keep the
    commas — a trailing comma on the last entry is legal Lua. Do not remove
    the quotes around text.

    NOTHING HERE IS REQUIRED. tDB runs correctly with this file unedited —
    the superuser login is generated on first start.

    CREDENTIALS DO NOT GO IN THIS FILE. Every credential-shaped key here
    ships blank and stays blank, so this file is safe to commit and safe to
    paste. A real value comes from one of two places instead, and the first
    one that is set wins:

        1. a server convar, e.g. `set tdb_superuser_password "…"`
        2. `config.local.lua` beside this file — same grammar, only the keys
           you are overriding. tDB writes the generated superuser password
           there, and it is gitignored.

    APPLYING CHANGES: restart the resource. `ensure tDB` in the server
    console, or txAdmin > Resources > tDB > Restart. Nothing here is read
    again while the server runs.

    IF IT WON'T START: Lua reports the line BELOW the real mistake, so look
    one line up from whatever the console names. Fix the FIRST error only,
    then restart — the rest is usually fallout from that one.

    Docs: https://timmygstudios.com/docs/tDB/configuration
------------------------------------------------------------------------]]

Config = {}

-- 1. COMMON SETTINGS

-- Publish the PocketBase admin panel at /db/_/ on tLib's public URL and port.
-- Set false to keep tDB private; server resources can still use it internally
-- and the database itself is unaffected. Default: true
Config.ExposeAdmin = true

-- List the admin panel in tLib's hub index. Cosmetic ONLY: the mount still
-- answers to anyone who requests it while ExposeAdmin is true. For genuine
-- unreachability use ExposeAdmin = false. Default: true
Config.ShowInHub = true

-- Print tDB's debug lines: the pid-file sweep, route probes, each backup, the
-- settings asserted from this file. Off, a normal boot prints the startup box
-- and nothing else. Turn it on to see a start-up problem step by step.
-- Default: false
Config.Debug = false

-- Run `pocketbase update` on every start.
--
-- tDB ships a specific PocketBase build, fetched against a published checksum.
-- Turning this on replaces that verified binary with an unverified newer one,
-- under a live database, without asking. Left off, PocketBase updates arrive
-- with tDB updates. Default: false
Config.AutoUpdate = false

-- The PocketBase admin login. Blank here, always.
--
-- To pin a login you already have, set it in server.cfg:
--
--     set tdb_superuser_email "admin@example.com"
--     set tdb_superuser_password "…"
--
-- With neither convar set, tDB generates both on first start and writes them
-- into config.local.lua. The generated password is printed in the server
-- console ONCE, on the run that creates it, and never again.
--
-- To rotate: delete the pair from config.local.lua, unset the convars, restart.
Config.Superuser = {
    Email = "",
    Password = "",
}

-- 2. SQL IMPORTS
--
-- Scripts normally ship a .sql file you load into MySQL by hand. Drop it in
-- Dir instead and it is applied on startup, before any other resource can
-- query. A file runs once, ever, and lands whole or not at all; what has run
-- is recorded in tdb_sql_imports. See `tdb sql status`.

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

-- 3. BACKUPS
--
-- Backups land inside the PocketBase data directory, under `backups`. That is
-- the same disk as the database: it protects against a bad migration, not
-- against losing the machine.

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

-- 4. MIGRATIONS
--
-- PocketBase's own collection migrations, not the .sql drop folder above.
-- PocketBase writes a migration file whenever you change a collection in the
-- admin UI, so schema changes travel with the resource. Collection edits made
-- in the UI are never reverted.

Config.Migrations = {
    -- Apply pending migrations on start. Default: true
    AutoApply = true,

    -- Relative to the resource folder. `.runtime/` is gitignored, so moving
    -- this out of it puts PocketBase's generated migration files into your
    -- version control. Default: ".runtime/pb_migrations"
    Dir = ".runtime/pb_migrations",
}

-- 5. ADVANCED — most servers change nothing here

Config.Advanced = {
    -- Use a PocketBase instance you already run instead of starting one. BOTH
    -- must be set, or tDB stays local. No local process is started, and
    -- Migrations, Backup and S3 above are ignored — configure those on the
    -- instance itself. Remote mode DOES require Superuser.Email and
    -- Superuser.Password above: tDB cannot generate a login on a database it
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

    -- S3 storage for PocketBase's files and backups.
    --
    -- Manage decides who owns this block:
    --
    --   false  tDB never touches the setting. Set it in the admin UI and it
    --          stays. Everything else in the block is ignored.
    --   true   config.lua wins. Every field is applied on every start, and an
    --          admin-UI edit is reported and then overwritten. Enabled = false
    --          genuinely turns the feature off.
    --
    -- Settings only travel config.lua -> PocketBase, never back: PocketBase
    -- will not hand out the S3 secret once set, so syncing the other way would
    -- overwrite a real credential with an empty one.
    --
    -- AccessKey and SecretKey are credentials, so they stay blank here. Set
    -- `tdb_advanced_s3_accesskey` / `tdb_advanced_s3_secretkey` in server.cfg,
    -- or put them in config.local.lua.
    --
    -- Mail is not here. Set it in the PocketBase admin UI, under Settings >
    -- Mail.
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
