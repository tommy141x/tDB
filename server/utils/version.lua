-- tDB releases and PocketBase binary updates are separate things. Set this to
-- the real owner/repository once tDB is published; never query an invented repo.
local GITHUB_REPO = nil
local fetchRelease = tlib.versioncheck.github(GITHUB_REPO)
local cachedRelease, fetched = nil, false

AddEventHandler('tdb:startupStatus', function(status)
    tlib.versioncheck({
        name = 'tDB',
        current = GetResourceMetadata(GetCurrentResourceName(), 'version', 0),
        author = 'TIMMYG Studios',
        fetch = function(cb)
            if fetched then return cb(cachedRelease) end
            fetchRelease(function(release)
                cachedRelease, fetched = release, true
                cb(release)
            end)
        end,
        info = { { key = 'Database', value = status } },
    })
end)
