-- tDB releases and PocketBase binary updates are separate things. This is tDB's
-- own repository, not PocketBase's -- the runtime is fetched by
-- scripts/fetch-runtime.ts and versioned independently of a tDB release.
local GITHUB_REPO = 'tommy141x/tDB'
local fetchRelease = tlib.versioncheck.github(GITHUB_REPO)
local cachedRelease, fetched = nil, false

-- One tLib info row per fact, which is the shape tLib's renderer expects.
--
-- The JS side used to hand over a single multi-line string and this passed it as
-- one `Database` value. tLib pads `key:` to a 10-column gutter and indents every
-- CONTINUATION line of a value by 12 spaces with no key -- so every fact after
-- the first rendered as a continuation of one value, which is why the box sat at
-- a different indent from tRadio's and wrapped mid-phrase. server.js now emits a
-- JSON array of { key, value, color }.
--
-- A plain string is still accepted: a decode failure here would otherwise cost
-- the whole startup box.
local function parseInfo(status)
    if type(status) ~= 'string' or status == '' then return {} end

    local ok, rows = pcall(json.decode, status)
    if not ok or type(rows) ~= 'table' or rows[1] == nil then
        return { { key = 'Database', value = status } }
    end

    local info = {}
    for _, entry in ipairs(rows) do
        if type(entry) == 'table' and entry.key and entry.value then
            info[#info + 1] = { key = entry.key, value = entry.value, color = entry.color }
        end
    end
    return info
end

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
        info = parseInfo(status),
    })
end)
