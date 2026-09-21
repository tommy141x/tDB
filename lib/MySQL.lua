---@diagnostic disable: duplicate-set-field
-- MySQL.lua - the MySQL.* API, for scripts that load oxmysql's library file
-- rather than calling its exports.
--
-- Usage: replace
--     server_script '@oxmysql/lib/MySQL.lua'
-- with
--     server_script '@tDB/lib/MySQL.lua'
-- in the consuming resource's fxmanifest.
--
-- Scripts that call exports.oxmysql:query(...) need no change at all - tDB
-- declares `provide 'oxmysql'`, which routes that export name here.
--
-- THIS PATH IS FROZEN. lib/MySQL.lua mirrors oxmysql's own lib/MySQL.lua
-- character for character so that swapping one word in a manifest is the
-- entire migration. It is a compatibility contract with an external ecosystem,
-- not this repo's folder convention, so it deliberately sits outside the
-- client/server/shared layout the rest of tDB follows. Moving it under
-- server/ would cost tDB the drop-in property it leads with. Same reasoning
-- applies to pb_hooks/ (PocketBase's --hooksDir) and sql/ (the documented
-- folder users drop .sql files into).

-- The resource this file lives in. It cannot be discovered at runtime:
-- GetCurrentResourceName() returns the resource that *loaded* the file, not
-- the one that ships it. Renaming the folder means changing this and the
-- @tDB/ prefix above together.
local resourceName = 'tDB'

---@class MySQL
MySQL = {}

-- Initialize tables for methods that need both callable and .await properties
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

-- ============================================================================
-- Promise-based API (.await syntax)
-- ============================================================================

---Execute a query and return affected rows
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return number affectedRows Number of rows affected
MySQL.update.await = function(query, parameters)
    return exports[resourceName]:update_async(query, parameters or {})
end

MySQL.Sync.execute = MySQL.update.await

---Execute an insert query and return the insert ID
---@param query string SQL INSERT query
---@param parameters? table|array Query parameters
---@return string|number insertId The ID of the inserted record
MySQL.insert.await = function(query, parameters)
    return exports[resourceName]:insert_async(query, parameters or {})
end

MySQL.Sync.insert = MySQL.insert.await

---Execute a SELECT query and return all rows
---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@return table[] rows Array of result rows
MySQL.query.await = function(query, parameters)
    return exports[resourceName]:query_async(query, parameters or {})
end

MySQL.Sync.fetchAll = MySQL.query.await

---Execute a query and return a single row
---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@return table|nil row Single result row or nil
MySQL.single.await = function(query, parameters)
    return exports[resourceName]:single_async(query, parameters or {})
end

MySQL.Sync.fetchSingle = MySQL.single.await

---Execute a query and return a single scalar value
---@param query string SQL SELECT query
---@param parameters? table|array Query parameters
---@return any value Single scalar value
MySQL.scalar.await = function(query, parameters)
    return exports[resourceName]:scalar_async(query, parameters or {})
end

MySQL.Sync.fetchScalar = MySQL.scalar.await

---Execute a prepared statement
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return any result Query result
MySQL.prepare.await = function(query, parameters)
    return exports[resourceName]:prepare_async(query, parameters or {})
end

---Execute multiple queries as a transaction
---@param queries table[] Array of queries {query, parameters} or {query = "", values = {}}
---@return table[] results Array of results from each query
MySQL.transaction.await = function(queries)
    return exports[resourceName]:transaction_async(queries)
end

MySQL.Sync.transaction = MySQL.transaction.await

---Alias of MySQL.query - returns rows, NOT an affected-row count.
---MySQL.Sync.execute and MySQL.Async.execute are the mysql-async names and do
---mean "update"; that difference is oxmysql's, and it is preserved here.
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return table[] rows
MySQL.execute.await = function(query, parameters)
    return exports[resourceName]:execute_async(query, parameters or {})
end

---Alias of MySQL.query.
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return table[] rows
MySQL.fetch.await = function(query, parameters)
    return exports[resourceName]:fetch_async(query, parameters or {})
end

---Run a statement without the result unpacking prepare applies
---@param query string SQL query
---@param parameters? table|array Query parameters
---@return any result
MySQL.rawExecute.await = function(query, parameters)
    return exports[resourceName]:rawExecute_async(query, parameters or {})
end

-- ============================================================================
-- Callback-based API (make tables callable with metatables)
-- ============================================================================

---Execute a query with callback (returns affected rows)
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
            exports[resourceName]:update(query, parameters or {}, callback)
        else
            return exports[resourceName]:update(query, parameters or {})
        end
    end
})

MySQL.Async.execute = MySQL.update

---Execute an insert query with callback
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
            exports[resourceName]:insert(query, parameters or {}, callback)
        else
            return exports[resourceName]:insert(query, parameters or {})
        end
    end
})

MySQL.Async.insert = MySQL.insert

---Execute a SELECT query with callback
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
            exports[resourceName]:query(query, parameters or {}, callback)
        else
            return exports[resourceName]:query(query, parameters or {})
        end
    end
})

MySQL.Async.fetchAll = MySQL.query

---Execute a query and return single row with callback
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
            exports[resourceName]:single(query, parameters or {}, callback)
        else
            return exports[resourceName]:single(query, parameters or {})
        end
    end
})

MySQL.Async.fetchSingle = MySQL.single

---Execute a query and return scalar value with callback
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
            exports[resourceName]:scalar(query, parameters or {}, callback)
        else
            return exports[resourceName]:scalar(query, parameters or {})
        end
    end
})

MySQL.Async.fetchScalar = MySQL.scalar

---Execute a prepared statement with callback
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
            exports[resourceName]:prepare(query, parameters or {}, callback)
        else
            return exports[resourceName]:prepare(query, parameters or {})
        end
    end
})

---Execute a transaction with callback
---@param queries table[] Array of queries
---@param callback? function Callback function(results)
setmetatable(MySQL.transaction, {
    __call = function(_, queries, callback)
        if callback then
            exports[resourceName]:transaction(queries, callback)
        else
            return exports[resourceName]:transaction(queries)
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
            exports[resourceName]:execute(query, parameters or {}, callback)
        else
            return exports[resourceName]:execute(query, parameters or {})
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
            exports[resourceName]:fetch(query, parameters or {}, callback)
        else
            return exports[resourceName]:fetch(query, parameters or {})
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
            exports[resourceName]:rawExecute(query, parameters or {}, callback)
        else
            return exports[resourceName]:rawExecute(query, parameters or {})
        end
    end
})

-- ============================================================================
-- Additional helper to check if MySQL is ready
-- ============================================================================

---Check if the database connection is ready
---@param callback function Callback to execute when ready
function MySQL.ready(callback)
    if exports[resourceName]:isReady() then
        callback()
    else
        exports[resourceName]:onReady(callback)
    end
end

-- ============================================================================
-- Additional OxMySQL exports for compatibility
-- ============================================================================

---Check if connection is ready (OxMySQL compatibility)
---@return boolean ready True if ready
function MySQL.isReady()
    return exports[resourceName]:isReady()
end

---Wait for connection to be ready (OxMySQL compatibility)
---@return boolean connected True when connected
MySQL.awaitConnection = function()
    return exports[resourceName]:awaitConnection()
end

---Store a query (OxMySQL compatibility - returns query as-is)
---@param query string SQL query
---@param callback function Callback function(query)
function MySQL.store(query, callback)
    return exports[resourceName]:store(query, callback)
end

-- ============================================================================
-- Legacy ghmattimysql compatibility
-- ============================================================================

-- ghmattimysql.execute is an alias for MySQL.Async.execute
-- ghmattimysql.executeSync is an alias for MySQL.Sync.execute

print('^2[tDB]^7 MySQL compatibility library loaded')
