fx_version 'cerulean'
game 'gta5'

name 'tDB'
description 'Database resource for FiveM: a drop-in oxmysql replacement backed by PocketBase, with realtime and collection APIs on top'
author 'Tommy Johnston'
version '1.0.0'

-- Bundles PocketBase 0.40.3 by Gani Georgiev (MIT). See bin/ and CREDITS.

lua54 'yes'
node_version '22'

server_scripts {
    'config.lua',
    'utils/config-loader.js',
    'utils/process-utils.js',
    'utils/server.js',
    'utils/client.js',
}

provide 'mysql-async'
provide 'ghmattimysql'
provide 'oxmysql'

-- Optional. PocketBase binds loopback only; tLib's router is what makes the
-- admin UI reachable from outside (Config.ExposeAdmin + Config.MountPath).
-- tDB runs fine without it — it is simply not externally reachable.
dependency '/optional:tLib'

-- Testing script
-- server_script 'tests.lua'
