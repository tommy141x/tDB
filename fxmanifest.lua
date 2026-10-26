fx_version 'cerulean'
game 'gta5'

name 'tDB'
description 'Database resource for FiveM: a drop-in oxmysql replacement backed by PocketBase, with realtime and collection APIs on top'
author 'Tommy Johnston'
author 'TIMMYG Studios'
version '1.0.0'

-- Runs PocketBase 0.40.4 by Gani Georgiev (MIT). See CREDITS.
-- The binary is not committed: `bun scripts/fetch-runtime.ts` fetches it into
-- .runtime/ and checks it against the published checksums.

lua54 'yes'
node_version '22'

-- 1.0, not 0.6: server/utils/server.js calls tLib's `RegisterWebApp` export to
-- publish the admin UI, and that export landed with the HTTP router owning the
-- one external port — after 0.6, the only earlier release. A lower floor lets
-- the gate pass and then fails with "No such export", which is the cryptic error
-- this declaration exists to replace.
tlib_min_version '1.0'


-- ⚠️ Do not add config.lua or config.local.lua here. A server_script missing at
-- load time is fatal, so an operator who deleted one would stop the whole
-- resource — and nothing in tDB's Lua reads Config anyway. config-loader.js
-- parses both files directly and is their only reader.
server_scripts {
    '@tLib/imports.lua',
    'server/utils/version.lua',
    'server/utils/config-loader.js',
    'server/utils/process-utils.js',
    'server/utils/server.js',
    'server/utils/client.js',
}

provide 'mysql-async'
provide 'ghmattimysql'
provide 'oxmysql'

-- tDB opens no port of its own: PocketBase binds loopback and tLib's router is
-- what makes the admin UI reachable. Required, so a missing tLib fails at start.
dependency 'tLib'
