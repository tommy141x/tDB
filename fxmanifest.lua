fx_version 'cerulean'
game 'gta5'

name 'tDB'
description 'Database resource for FiveM: a drop-in oxmysql replacement backed by PocketBase, with realtime and collection APIs on top'
author 'Tommy Johnston'
author 'TIMMYG Studios'
version '1.0.0'

-- Bundles PocketBase 0.40.4 (MIT, Gani Georgiev). See THIRD-PARTY-NOTICES.md.

lua54 'yes'
node_version '22'

-- Below 1.0 tLib has no `RegisterWebApp` export, so the admin UI dies with
-- "No such export" instead of a version message.
tlib_min_version '1.0'

-- config.lua and config.local.lua are parsed by config-loader.js, not listed
-- here: a server_script pointing at a file an operator deleted is fatal.
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

dependency 'tLib'
