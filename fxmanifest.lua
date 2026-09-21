fx_version 'cerulean'
game 'gta5'

name 'tDB'
description 'Database resource for FiveM: a drop-in oxmysql replacement backed by PocketBase, with realtime and collection APIs on top'
author 'Tommy Johnston'
author 'TIMMYG Studios'
version '1.0.0'

-- Runs PocketBase 0.40.4 by Gani Georgiev (MIT). See CREDITS.
--
-- The binary is no longer committed. `bun scripts/fetch-runtime.ts` downloads
-- it into .runtime/ and verifies it against the checksums PocketBase publishes
-- with the release. Before this, linux and windows had drifted onto different
-- builds (0.40.3 and 0.40.4) because each was updated by hand.

lua54 'yes'
node_version '22'

-- The HTTP router this resource depends on (see the `dependency` note below)
-- landed in tLib 0.6, so that is the real floor.
tlib_min_version '0.6'

tlib_modules { 'versioncheck' }

server_scripts {
    '@tLib/imports.lua',
    'config.lua',
    'server/utils/version.lua',
    'server/utils/config-loader.js',
    'server/utils/process-utils.js',
    'server/utils/server.js',
    'server/utils/client.js',
}

provide 'mysql-async'
provide 'ghmattimysql'
provide 'oxmysql'

-- tDB never opens a port of its own — PocketBase binds loopback, and tLib's
-- router is the only thing that can make the admin UI reachable. Required
-- rather than optional so the failure is "tLib is missing" at start, not an
-- admin UI that silently never appears.
dependency 'tLib'

-- Testing script
-- server_script 'tests.lua'
