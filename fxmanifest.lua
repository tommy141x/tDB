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


-- config.lua is deliberately NOT listed here.
--
-- It is gitignored and created from config.example.lua on first start, so on a
-- fresh install it does not exist yet when FiveM builds this list - and a
-- server_script that is missing at load time stops the whole resource. Nothing
-- in tDB's Lua reads the Config table anyway; server/utils/config-loader.js
-- parses the file directly, and it is the only reader.
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
