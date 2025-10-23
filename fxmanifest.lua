fx_version 'cerulean'
game 'gta5'

name 'PocketBase'
description 'Open Source realtime backend in 1 file'
author 'Tommy Johnston, Gani Georgiev'
version 'v0.30.4'

lua54 'yes'
node_version '22'

server_scripts {
    'config.lua',
    'utils/config-loader.js',
    'utils/process-utils.js',
    'utils/server.js',
    'utils/client.js'
}

-- Testing script
--server_script 'tests.lua'
