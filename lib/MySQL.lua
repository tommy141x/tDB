---@diagnostic disable: duplicate-set-field
-- The MySQL.* API, for scripts that load oxmysql's library file rather than
-- calling its exports. In the consuming fxmanifest, replace
--     server_script '@oxmysql/lib/MySQL.lua'
-- with
--     server_script '@tDB/lib/MySQL.lua'
-- Scripts calling exports.oxmysql:query(...) need no change either, but NOT
-- because of `provide 'oxmysql'`. Measured on a live server: `provide` makes
-- GetResourceState('oxmysql') report `started`, which is what satisfies a
-- dependency check, and it does NOT route exports -- exports.oxmysql:scalar()
-- answered "No such export scalar in resource oxmysql". What routes them is
-- ExportRouter.registerAliases, which answers `__cfx_export_oxmysql_<method>`
-- the way oxmysql itself publishes its mysql-async and ghmattimysql names.
--
-- This path is frozen. It mirrors oxmysql's own lib/MySQL.lua so that swapping
-- one word in a manifest is the entire migration, which is why it sits outside
-- the client/server/shared layout the rest of tDB follows. Same for pb_hooks/
-- (PocketBase's --hooksDir) and sql/ (where users drop .sql files).

-- The resource that ships this file. Not discoverable at runtime:
-- GetCurrentResourceName() returns whichever resource *loaded* it. Renaming the
-- folder means changing this and the @tDB/ prefix above together.
local resourceName = 'tDB'

-- tDB registers its query exports only once PocketBase is up, a few seconds
-- after the resource starts. oxmysql has them from its first frame, so a ported
-- script queries straight away and would get "No such export query_async"
-- instead of its rows. The readiness exports do exist from the start, so wait on
-- those. A no-op once the database is up, which is every call but the first few.
local function waitForDatabase()
    if not exports[resourceName]:isReady() then
        exports[resourceName]:awaitConnection()
    end
end

-- oxmysql's MySQL.Sync.store returns an integer index into a local table, and
-- its safeArgs turns a numeric first argument back into the stored string. The
-- export named `store` is a different thing that hands back the query itself.
local queryStore = {}

local function addStore(query, cb)
    assert(type(query) == 'string', 'The SQL Query must be a string')

    local n = #queryStore + 1
    queryStore[n] = query

    return cb and cb(n) or n
end

local function resolveQuery(query)
    if type(query) ~= 'number' then return query end

    local stored = queryStore[query]
    assert(stored, 'First argument received invalid query store reference')
    return stored
end

-- The callback forms can be reached from outside a coroutine, where
-- awaitConnection has nothing to yield to, so defer those to a thread rather
-- than blocking the caller. Called while ready, it runs inline as before.
local function whenReady(fn)
    if exports[resourceName]:isReady() then
        return fn()
    end

    CreateThread(function()
        waitForDatabase()
        fn()
    end)
end

---@class MySQL
MySQL = {}

-- Tables, not functions: each must be callable and also carry .await.
MySQL.update = {}
MySQL.insert = {}
MySQL.query = {}
MySQL.single = {}
MySQL.scalar = {}
MySQL.prepare = {}
MySQL.transaction = {}
MySQL.execute = {}
MySQL.fetch = {}
MySQL.rawExecute = {}
MySQL.Sync = {}
MySQL.Async = {}

---@param query string SQL query
---@param parameters? table|array Query parameters
---@return number affectedRows Number of rows affected
MySQL.update.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:update_async(resolveQuery(query), parameters or {})
end

MySQL.Sync.execute = MySQL.update.await

---@param query string SQL INSERT query
---@param parameters? table|array Query parameters
---@return string|number insertId The ID of the inserted record
MySQL.insert.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:insert_async(resolveQuery(query), parameters or {})
end

MySQL.Sync.insert = MySQL.insert.await

---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@return table[] rows Array of result rows
MySQL.query.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:query_async(resolveQuery(query), parameters or {})
end

MySQL.Sync.fetchAll = MySQL.query.await

---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@return table|nil row Single result row or nil
MySQL.single.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:single_async(resolveQuery(query), parameters or {})
end

MySQL.Sync.fetchSingle = MySQL.single.await

---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@return any value Single scalar value
MySQL.scalar.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:scalar_async(resolveQuery(query), parameters or {})
end

MySQL.Sync.fetchScalar = MySQL.scalar.await

---@param query string SQL query
---@param parameters? table|array Query parameters
---@return any result Query result
MySQL.prepare.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:prepare_async(resolveQuery(query), parameters or {})
end

---@param queries table[] Array of queries {query, parameters} or {query = "", values = {}}
---@return table[] results Array of results from each query
-- `parameters` is forwarded, as oxmysql's own `.await` does for every method
-- including transaction. Dropping it was silent: oxmysql applies a shared
-- parameter table to every bare-string query in the list, so
--     MySQL.transaction.await({ 'DELETE FROM a WHERE id = ?' }, { 7 })
-- deleted row 7 under oxmysql and ran with an unbound placeholder under tDB,
-- then reported the transaction as successful.
MySQL.transaction.await = function(queries, parameters)
    waitForDatabase()
    return exports[resourceName]:transaction_async(resolveQuery(queries), parameters)
end

MySQL.Sync.transaction = MySQL.transaction.await

---Alias of MySQL.query: returns rows, NOT an affected-row count. The
---mysql-async names MySQL.Sync/Async.execute do mean "update". oxmysql's
---inconsistency, preserved here.
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return table[] rows
MySQL.execute.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:execute_async(resolveQuery(query), parameters or {})
end

---Alias of MySQL.query.
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return table[] rows
MySQL.fetch.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:fetch_async(resolveQuery(query), parameters or {})
end

---Run a statement without the result unpacking prepare applies
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return any result
MySQL.rawExecute.await = function(query, parameters)
    waitForDatabase()
    return exports[resourceName]:rawExecute_async(resolveQuery(query), parameters or {})
end

---Returns affected rows.
---@param query string SQL query
---@param parameters? table|array Query parameters
---@param callback? function Callback function(affectedRows)
setmetatable(MySQL.update, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:update(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:update(resolveQuery(query), parameters or {})
        end
    end
})

MySQL.Async.execute = MySQL.update

---@param query string SQL INSERT query
---@param parameters? table|array Query parameters
---@param callback? function Callback function(insertId)
setmetatable(MySQL.insert, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:insert(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:insert(resolveQuery(query), parameters or {})
        end
    end
})

MySQL.Async.insert = MySQL.insert

---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@param callback? function Callback function(rows)
setmetatable(MySQL.query, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:query(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:query(resolveQuery(query), parameters or {})
        end
    end
})

MySQL.Async.fetchAll = MySQL.query

---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@param callback? function Callback function(row)
setmetatable(MySQL.single, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:single(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:single(resolveQuery(query), parameters or {})
        end
    end
})

MySQL.Async.fetchSingle = MySQL.single

---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@param callback? function Callback function(value)
setmetatable(MySQL.scalar, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:scalar(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:scalar(resolveQuery(query), parameters or {})
        end
    end
})

MySQL.Async.fetchScalar = MySQL.scalar

---@param query string SQL query
---@param parameters? table|array Query parameters
---@param callback? function Callback function(result)
setmetatable(MySQL.prepare, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:prepare(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:prepare(resolveQuery(query), parameters or {})
        end
    end
})

---@param queries table[] Array of queries
---@param parameters? table Shared parameters, applied to every bare-string query
---@param callback? function Callback function(results)
--
-- Three slots, matching oxmysql's uniform `function(self, query, parameters, cb)`
-- metamethod. With only two, `MySQL.transaction(queries, { 7 }, cb)` bound the
-- parameter table to `callback`: it is truthy, so the call took the
-- fire-and-forget branch and the real callback was NEVER invoked. A caller
-- awaiting it waited forever, with nothing logged anywhere.
--
-- `parameters` may still be the callback, because oxmysql's own setCallback
-- accepts a function in either slot.
setmetatable(MySQL.transaction, {
    __call = function(_, queries, parameters, callback)
        if type(parameters) == 'function' or (type(parameters) == 'table' and parameters.__cfx_functionReference) then
            callback = parameters
            parameters = nil
        end

        if callback then
            whenReady(function()
                exports[resourceName]:transaction(resolveQuery(queries), parameters, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:transaction(resolveQuery(queries), parameters)
        end
    end
})

MySQL.Async.transaction = MySQL.transaction

---Alias of MySQL.query, with callback
setmetatable(MySQL.execute, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:execute(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:execute(resolveQuery(query), parameters or {})
        end
    end
})

---Alias of MySQL.query, with callback
setmetatable(MySQL.fetch, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:fetch(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:fetch(resolveQuery(query), parameters or {})
        end
    end
})

---Run a statement without prepare's result unpacking, with callback
setmetatable(MySQL.rawExecute, {
    __call = function(_, query, parameters, callback)
        if type(parameters) == 'function' then
            callback = parameters
            parameters = {}
        end

        if callback then
            whenReady(function()
                exports[resourceName]:rawExecute(resolveQuery(query), parameters or {}, callback)
            end)
        else
            waitForDatabase()
            return exports[resourceName]:rawExecute(resolveQuery(query), parameters or {})
        end
    end
})

-- A table with .await and __call, not a function. oxmysql's is
-- `setmetatable({ await = onReady }, { __call = ... })`, so callers write both
-- MySQL.ready(cb) and MySQL.ready.await(). A plain function breaks the second
-- form, and lb-phone's database checker uses it.
local function onReady(callback)
    waitForDatabase()
    return callback and callback() or true
end

MySQL.ready = setmetatable({ await = onReady }, {
    __call = function(_, callback)
        Citizen.CreateThreadNow(function() onReady(callback) end)
    end,
})

---@return boolean ready True if ready
function MySQL.isReady()
    return exports[resourceName]:isReady()
end

---@return boolean connected True when connected
MySQL.awaitConnection = function()
    return exports[resourceName]:awaitConnection()
end

---oxmysql compatibility: returns the query as-is.
---@param query string SQL query
---@param callback function Callback function(query)
function MySQL.store(query, callback)
    return exports[resourceName]:store(query, callback)
end

---Scoped transaction. tDB cannot provide this; see the export's error.
MySQL.startTransaction = function(callback)
    return exports[resourceName]:startTransaction(callback)
end

-- ghmattimysql's execute/executeSync are MySQL.Async.execute / MySQL.Sync.execute.

-- oxmysql's alias table covers prepare in both namespaces, and both carry
-- `store`, which is addStore rather than the export of the same name.
MySQL.Sync.prepare = MySQL.prepare.await
MySQL.Async.prepare = MySQL.prepare
MySQL.Sync.store = addStore
MySQL.Async.store = addStore

-- Last, so it cannot shadow anything defined above. oxmysql forwards any
-- unknown MySQL.<name> straight to the export of that name, which is what keeps
-- a script using a method this file never enumerated from dying on a nil call.
setmetatable(MySQL, {
    __index = function(_, index)
        return function(...)
            waitForDatabase()
            return exports[resourceName][index](nil, ...)
        end
    end,
})
