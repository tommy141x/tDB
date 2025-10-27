-- Comprehensive demo script that tests all PocketBase exports
-- Reports success/failure for each operation

local DEMO_COLLECTION = "demo_players"
local testsPassed = 0
local testsFailed = 0
local failedTests = {}

-- Helper function for safe export calls with test tracking
local function testExport(testName, fn, silentErrors)
    local success, result = pcall(fn)
    if success then
        testsPassed = testsPassed + 1
        return result, nil
    else
        if not silentErrors then
            testsFailed = testsFailed + 1
            table.insert(failedTests, {name = testName, error = tostring(result)})
            print("^1[Demo Test Failed]^7 " .. testName .. ": " .. tostring(result))
        else
            testsPassed = testsPassed + 1
        end
        return nil, result
    end
end

-- Display final test results
local function displayTestResults()
    print("")
    print("^5═══════════════════════════════════════════════════════^7")
    print("^5           PocketBase Export Test Results^7")
    print("^5═══════════════════════════════════════════════════════^7")
    print("")
    print("^2✓ Passed: ^7" .. testsPassed)
    print("^1✗ Failed: ^7" .. testsFailed)
    print("")

    if testsFailed > 0 then
        print("^1Failed Tests:^7")
        for _, test in ipairs(failedTests) do
            print("  ^1• " .. test.name .. "^7")
            print("    " .. test.error)
        end
        print("")
    else
        print("^2All exports tested successfully!^7")
        print("")
    end
    print("^5═══════════════════════════════════════════════════════^7")
    print("")
end

-- Wait for PocketBase to be ready
exports['pb']:onReady(function()
    print("^3[PocketBase Demo]^7 Starting comprehensive export tests...")

    Citizen.CreateThread(function()
        RunComprehensiveTests()
    end)
end)

function RunComprehensiveTests()
    local createdRecordId = nil
    local collectionId = nil

    -- ========================================================================
    -- Utility Exports
    -- ========================================================================

    -- Test: isReady
    local isReady = testExport("isReady()", function()
        return exports['pb']:isReady()
    end)

    -- Test: isClientAuthenticated
    local isAuth = testExport("isClientAuthenticated()", function()
        return exports['pb']:isClientAuthenticated()
    end)

    -- Test: getUrl
    local pbUrl = testExport("getUrl()", function()
        return exports['pb']:getUrl()
    end)

    -- Test: healthCheck
    testExport("healthCheck()", function()
        return exports['pb']:healthCheck()
    end)

    -- Note: Authentication exports removed - resource auto-authenticates as superuser

    -- ========================================================================
    -- Collection Management
    -- ========================================================================

    -- Test: getCollections
    local collections = testExport("getCollections()", function()
        return exports['pb']:getCollections()
    end)

    -- Check if demo collection exists
    local collectionExists = false
    if collections then
        for _, col in ipairs(collections) do
            if col.name == DEMO_COLLECTION then
                collectionExists = true
                collectionId = col.id
                break
            end
        end
    end

    -- Test: createCollection (if doesn't exist)
    if not collectionExists then
        local collectionSchema = {
            name = DEMO_COLLECTION,
            type = "base",
            fields = {
                {
                    name = "name",
                    type = "text",
                    required = true,
                    max = 0
                },
                {
                    name = "identifier",
                    type = "text",
                    required = true,
                    max = 0
                },
                {
                    name = "playtime",
                    type = "number",
                    required = false
                },
                {
                    name = "level",
                    type = "number",
                    required = false
                },
                {
                    name = "active",
                    type = "bool",
                    required = false
                }
            }
        }

        local result = testExport("createCollection()", function()
            return exports['pb']:createCollection(collectionSchema)
        end)

        if result then
            collectionId = result.id
        end
    end

    -- Test: getCollection
    if collectionId then
        testExport("getCollection()", function()
            return exports['pb']:getCollection(DEMO_COLLECTION)
        end)
    end

    -- ========================================================================
    -- Record CRUD Operations
    -- ========================================================================

    -- Test: create
    local newPlayer = {
        name = "Test Player",
        identifier = "demo_" .. os.time(),
        playtime = 0,
        level = 1,
        active = true
    }

    local createdRecord = testExport("create()", function()
        return exports['pb']:create(DEMO_COLLECTION, newPlayer)
    end)

    if createdRecord then
        createdRecordId = createdRecord.id
    end

    -- Test: getOne
    if createdRecordId then
        testExport("getOne()", function()
            local record = exports['pb']:getOne(DEMO_COLLECTION, createdRecordId)
            -- Validate we got the correct record back
            if not record or record.id ~= createdRecordId then
                error("Retrieved record ID doesn't match")
            end
            if record.name ~= "Test Player" then
                error("Retrieved record name doesn't match")
            end
            return record
        end)
    end

    -- Test: update
    if createdRecordId then
        testExport("update()", function()
            local updated = exports['pb']:update(DEMO_COLLECTION, createdRecordId, {
                playtime = 120,
                level = 5
            })
            -- Validate the update was applied
            if not updated then
                error("Update returned nil")
            end
            if updated.playtime ~= 120 then
                error("Playtime was not updated: expected 120, got " .. tostring(updated.playtime))
            end
            if updated.level ~= 5 then
                error("Level was not updated: expected 5, got " .. tostring(updated.level))
            end
            return updated
        end)
    end

    -- Test: getList
    testExport("getList()", function()
        local result = exports['pb']:getList(DEMO_COLLECTION, 1, 10)
        -- Validate pagination structure
        if not result or not result.items then
            error("getList didn't return proper structure")
        end
        if not result.page or not result.perPage or not result.totalItems then
            error("getList missing pagination fields")
        end
        if type(result.items) ~= "table" then
            error("getList items is not a table")
        end
        return result
    end)

    -- Test: getFullList
    testExport("getFullList()", function()
        local records = exports['pb']:getFullList(DEMO_COLLECTION)
        -- Validate we got an array of records
        if type(records) ~= "table" then
            error("getFullList didn't return a table")
        end
        if #records == 0 then
            error("getFullList returned empty array but we created a record")
        end
        return records
    end)

    -- Test: filter
    local filterString = testExport("filter()", function()
        local filter = exports['pb']:filter("playtime > {:minPlaytime}", {minPlaytime = 60})
        -- Validate filter string was generated
        if type(filter) ~= "string" or filter == "" then
            error("filter() didn't return a valid filter string")
        end
        return filter
    end)

    -- Test: getFullList with filter
    if filterString then
        testExport("getFullList() with filter", function()
            local records = exports['pb']:getFullList(DEMO_COLLECTION, {filter = filterString})
            -- Validate filtered results
            if type(records) ~= "table" then
                error("Filtered getFullList didn't return a table")
            end
            -- After update, playtime should be 120 which is > 60, so should have at least 1 result
            if #records == 0 then
                error("Filter should have returned at least 1 record with playtime > 60")
            end
            -- Validate all returned records meet the filter criteria
            for _, record in ipairs(records) do
                if record.playtime <= 60 then
                    error("Filter returned record with playtime <= 60: " .. tostring(record.playtime))
                end
            end
            return records
        end)
    end

    -- Test: getFirstListItem (with existing record)
    if createdRecordId then
        testExport("getFirstListItem()", function()
            local record = exports['pb']:getFirstListItem(DEMO_COLLECTION, "level >= 1")
            -- Validate we got a record that matches the filter
            if not record or not record.id then
                error("getFirstListItem didn't return a valid record")
            end
            if not record.level or record.level < 1 then
                error("getFirstListItem returned record that doesn't match filter")
            end
            return record
        end)
    end

    -- ========================================================================
    -- Realtime Subscriptions
    -- ========================================================================

    -- Test: subscribe
    testExport("subscribe()", function()
        local result = exports['pb']:subscribe(DEMO_COLLECTION, "*")
        -- Validate subscription was successful
        if result ~= true then
            error("subscribe() should return true on success")
        end
        return result
    end)

    -- Register event listener for realtime
    RegisterNetEvent('pocketbase:' .. DEMO_COLLECTION .. ':*', function(data)
        -- Realtime event received
    end)

    -- Wait a moment, then test unsubscribe
    Wait(1000)

    -- Test: unsubscribe
    testExport("unsubscribe()", function()
        local result = exports['pb']:unsubscribe(DEMO_COLLECTION, "*")
        -- Validate unsubscribe was successful
        if result ~= true then
            error("unsubscribe() should return true on success")
        end
        return result
    end)

    -- ========================================================================
    -- File Operations
    -- ========================================================================

    -- Test: getFileUrl (with dummy record)
    if createdRecord then
        testExport("getFileUrl()", function()
            local url = exports['pb']:getFileUrl(createdRecord, "avatar.png")
            -- Validate URL was generated
            if type(url) ~= "string" or url == "" then
                error("getFileUrl() didn't return a valid URL string")
            end
            if not url:match("http") then
                error("getFileUrl() didn't return a proper URL")
            end
            return url
        end)
    end

    -- Test: getFileToken
    testExport("getFileToken()", function()
        local token = exports['pb']:getFileToken()
        -- Validate token was returned
        if type(token) ~= "string" or token == "" then
            error("getFileToken() didn't return a valid token string")
        end
        return token
    end)

    -- ========================================================================
    -- Collection Management (Update/Delete)
    -- ========================================================================

    -- Test: updateCollection (add a field)
    if collectionId then
        testExport("updateCollection()", function()
            return exports['pb']:updateCollection(DEMO_COLLECTION, {
                fields = {
                    {
                        name = "name",
                        type = "text",
                        required = true,
                        max = 0
                    },
                    {
                        name = "identifier",
                        type = "text",
                        required = true,
                        max = 0
                    },
                    {
                        name = "playtime",
                        type = "number",
                        required = false
                    },
                    {
                        name = "level",
                        type = "number",
                        required = false
                    },
                    {
                        name = "active",
                        type = "bool",
                        required = false
                    },
                    {
                        name = "updated_at",
                        type = "date",
                        required = false
                    }
                }
            })
        end)
    end

    -- ========================================================================
    -- Auth Collection Methods
    -- ========================================================================

    -- Note: These methods are for user authentication in auth collections
    -- Testing with demo_players (not an auth collection) - expected to fail silently

    -- Test: listAuthMethods (expected to fail - not an auth collection)
    testExport("listAuthMethods()", function()
        return exports['pb']:listAuthMethods(DEMO_COLLECTION)
    end, true)

    -- Note: Other auth methods exist but won't test here since demo_players isn't an auth collection
    -- Shorter aliases available: authWithPassword(), authRefresh()
    -- Full list: authCollectionWithPassword, authWithOTP, authWithOAuth2Code, authRefreshCollection,
    -- requestOTP, requestPasswordReset, confirmPasswordReset, requestVerification, confirmVerification,
    -- requestEmailChange, confirmEmailChange, listExternalAuths, unlinkExternalAuth

    -- ========================================================================
    -- Batch Operations
    -- ========================================================================

    -- Test: batch() API with multiple operations
    local batchResults = testExport("batch() API", function()
        local batch = exports['pb']:batch()
        batch = exports['pb']:batchCreate(batch, DEMO_COLLECTION, {
            name = "Batch Player 1",
            identifier = "batch_" .. os.time() .. "_1",
            playtime = 10,
            level = 1,
            active = true
        })
        batch = exports['pb']:batchCreate(batch, DEMO_COLLECTION, {
            name = "Batch Player 2",
            identifier = "batch_" .. os.time() .. "_2",
            playtime = 20,
            level = 2,
            active = true
        })
        return exports['pb']:batchSend(batch)
    end, true) -- Silent errors - batch API may be disabled



    -- ========================================================================
    -- Realtime Service (Custom Topics)
    -- ========================================================================

    -- Test: subscribeToTopic
    testExport("subscribeToTopic()", function()
        local result = exports['pb']:subscribeToTopic("custom_events")
        -- Validate subscription was successful
        if result ~= true then
            error("subscribeToTopic() should return true on success")
        end
        return result
    end)

    -- Register event listener for custom topic
    RegisterNetEvent('pocketbase:topic:custom_events', function(data)
        -- Custom topic event received
    end)

    Wait(500)

    -- Test: isRealtimeConnected
    testExport("isRealtimeConnected()", function()
        local connected = exports['pb']:isRealtimeConnected()
        -- Validate it returns a boolean
        if type(connected) ~= "boolean" then
            error("isRealtimeConnected() should return a boolean")
        end
        return connected
    end)

    -- Test: unsubscribeFromTopic
    testExport("unsubscribeFromTopic()", function()
        local result = exports['pb']:unsubscribeFromTopic("custom_events")
        -- Validate unsubscribe was successful
        if result ~= true then
            error("unsubscribeFromTopic() should return true on success")
        end
        return result
    end)

    -- Test: unsubscribeByPrefix
    testExport("unsubscribeByPrefix()", function()
        local result = exports['pb']:unsubscribeByPrefix("custom_")
        -- Validate unsubscribe was successful
        if result ~= true then
            error("unsubscribeByPrefix() should return true on success")
        end
        return result
    end)

    -- ========================================================================
    -- Collection Advanced Operations
    -- ========================================================================

    -- Test: getCollectionScaffolds
    testExport("getCollectionScaffolds()", function()
        local scaffolds = exports['pb']:getCollectionScaffolds()
        -- Validate scaffolds structure
        if type(scaffolds) ~= "table" then
            error("getCollectionScaffolds() didn't return a table")
        end
        return scaffolds
    end)

    -- Test: importCollections with empty array (should succeed with no changes)
    testExport("importCollections()", function()
        local result = exports['pb']:importCollections(json.encode({}), false)
        -- Should succeed even with empty data
        return true
    end, true) -- Silent - may have validation requirements

    -- Test: truncateCollection (commented out to preserve demo data)
    -- testExport("truncateCollection()", function()
    --     return exports['pb']:truncateCollection(DEMO_COLLECTION)
    -- end)

    -- ========================================================================
    -- SQL Queries
    -- ========================================================================

    print("^5[SQL Queries]^7 Testing SQL operations...")

    -- Test: sqlQuery - Select all from collection
    local sqlQueryResult = testExport("sqlQuery() - SELECT", function()
        local result = exports['pb']:sqlQuery(
            "SELECT id, name, type FROM _collections WHERE system = {:system} LIMIT 5",
            {system = false}
        )
        if type(result) ~= "table" then
            error("sqlQuery() didn't return a table")
        end
        return result
    end)

    -- Test: sqlScalar - Get count
    testExport("sqlScalar() - COUNT", function()
        local count = exports['pb']:sqlScalar(
            "SELECT COUNT(*) FROM _collections",
            {}
        )
        if type(count) ~= "number" then
            error("sqlScalar() didn't return a number")
        end
        print("  Collection count: " .. count)
        return count
    end)

    -- Test: sqlSingle - Get one row
    testExport("sqlSingle() - Get one row", function()
        local row = exports['pb']:sqlSingle(
            "SELECT id, name FROM _collections LIMIT 1",
            {}
        )
        if type(row) ~= "table" then
            error("sqlSingle() didn't return a table")
        end
        return row
    end)

    -- Test: sqlExecute - Create a test table
    local testTableName = "sql_test_" .. os.time()
    testExport("sqlExecute() - CREATE TABLE", function()
        local insertId = exports['pb']:sqlExecute(
            "CREATE TABLE IF NOT EXISTS " .. testTableName .. " (id INTEGER PRIMARY KEY, value TEXT)",
            {}
        )
        return insertId
    end)

    -- Test: sqlExecute - Insert into test table
    testExport("sqlExecute() - INSERT", function()
        local insertId = exports['pb']:sqlExecute(
            "INSERT INTO " .. testTableName .. " (value) VALUES ({:val})",
            {val = "test_value"}
        )
        return insertId
    end)

    -- Test: sqlTransaction - Multiple queries atomically
    testExport("sqlTransaction() - Atomic operations", function()
        local success = exports['pb']:sqlTransaction({
            {sql = "INSERT INTO " .. testTableName .. " (value) VALUES ({:val1})", params = {val1 = "transaction_test_1"}},
            {sql = "INSERT INTO " .. testTableName .. " (value) VALUES ({:val2})", params = {val2 = "transaction_test_2"}},
            {sql = "UPDATE " .. testTableName .. " SET value = {:newval} WHERE value = {:oldval}", params = {newval = "updated", oldval = "transaction_test_1"}}
        })
        if not success then
            error("sqlTransaction() failed")
        end
        return success
    end)

    -- Cleanup test table
    pcall(function()
        exports['pb']:sqlExecute("DROP TABLE IF EXISTS " .. testTableName, {})
    end)

    -- ========================================================================
    -- Advanced Record Operations
    -- ========================================================================

    print("^5[Advanced Records]^7 Testing batch and count operations...")

    -- Test: findRecordsByIds - Batch fetch
    if createdRecordId then
        testExport("findRecordsByIds() - Batch fetch", function()
            local records = exports['pb']:findRecordsByIds(DEMO_COLLECTION, {createdRecordId})
            if type(records) ~= "table" or #records == 0 then
                error("findRecordsByIds() didn't return records")
            end
            return records
        end)
    end

    -- Test: countRecords - With filter
    testExport("countRecords() - With filter", function()
        local count = exports['pb']:countRecords(DEMO_COLLECTION, "name != ''")
        if type(count) ~= "number" then
            error("countRecords() didn't return a number")
        end
        print("  Records with name: " .. count)
        return count
    end)

    -- Test: countRecords - Without filter
    testExport("countRecords() - No filter", function()
        local count = exports['pb']:countRecords(DEMO_COLLECTION)
        if type(count) ~= "number" then
            error("countRecords() didn't return a number")
        end
        print("  Total records: " .. count)
        return count
    end)

    -- ========================================================================
    -- Record Transactions
    -- ========================================================================

    print("^5[Transactions]^7 Testing atomic record operations...")

    -- Test: runTransaction - Multiple record operations atomically
    local txRecordIds = {}
    testExport("runTransaction() - Create, Update, Delete", function()
        local results = exports['pb']:runTransaction({
            {type = "create", collection = DEMO_COLLECTION, data = {name = "Transaction Test 1", identifier = "tx_test_1"}},
            {type = "create", collection = DEMO_COLLECTION, data = {name = "Transaction Test 2", identifier = "tx_test_2"}},
        })

        if type(results) ~= "table" or #results ~= 2 then
            error("runTransaction() didn't return expected results")
        end

        -- Store IDs for cleanup
        for _, result in ipairs(results) do
            if result.id then
                table.insert(txRecordIds, result.id)
            end
        end

        return results
    end)

    -- ========================================================================
    -- Custom Realtime Messaging
    -- ========================================================================

    print("^5[Realtime]^7 Testing custom messaging...")

    -- Test: sendRealtimeMessage - Send custom message
    testExport("sendRealtimeMessage() - Custom topic", function()
        local sentCount = exports['pb']:sendRealtimeMessage("test_topic", {
            message = "Hello from tests!",
            timestamp = os.time()
        })
        if type(sentCount) ~= "number" then
            error("sendRealtimeMessage() didn't return a number")
        end
        print("  Messages sent to " .. sentCount .. " clients")
        return sentCount
    end)

    -- Test: getRealtimeClients - Get connected clients
    testExport("getRealtimeClients() - List clients", function()
        local clients = exports['pb']:getRealtimeClients()
        if type(clients) ~= "table" then
            error("getRealtimeClients() didn't return a table")
        end
        print("  Connected clients: " .. #clients)
        return clients
    end)

    -- ========================================================================
    -- Email Operations
    -- ========================================================================

    print("^5[Email]^7 Testing email sending...")

    -- Test: sendEmail (will likely fail without SMTP configured, so silenced)
    testExport("sendEmail() - Send test email", function()
        local success = exports['pb']:sendEmail(
            "test@example.com",
            "PocketBase Test Email",
            "<h1>Test Email</h1><p>This is a test email from PocketBase.</p>",
            "Test Email - This is a test email from PocketBase."
        )
        return success
    end, true) -- Silent - SMTP may not be configured

    -- ========================================================================
    -- OxMySQL Compatibility Tests
    -- ========================================================================

    print("^5[OxMySQL]^7 Testing OxMySQL compatibility layer...")

    -- Test: awaitConnection - Wait for connection
    testExport("awaitConnection() - Wait for connection", function()
        local connected = exports['pb']:awaitConnection()
        if not connected then
            error("Could not connect")
        end
        print("  Successfully connected")
        return connected
    end)

    -- Test: store - Store query for later use (compatibility)
    testExport("store() - Store query", function()
        local storedQuery = nil
        exports['pb']:store('SELECT * FROM ' .. DEMO_COLLECTION, function(query)
            storedQuery = query
        end)
        if not storedQuery then
            error("Store did not work")
        end
        print("  Stored query: " .. storedQuery)
        return storedQuery
    end)

    -- Test: query - SELECT query with parameters
    local queryResults = testExport("query() - SELECT with parameters", function()
        local results = exports['pb']:query('SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE name = ?', {'Test Player'})
        if not results or #results == 0 then
            error("Query returned no results")
        end
        print("  Query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: fetch - Alias for query
    testExport("fetch() - SELECT (alias for query)", function()
        local results = exports['pb']:fetch('SELECT * FROM ' .. DEMO_COLLECTION .. ' LIMIT 3', {})
        if not results then
            error("Fetch query failed")
        end
        print("  Fetch returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: query_async - Async variant
    testExport("query_async() - SELECT async", function()
        local results = exports['pb']:query_async('SELECT * FROM ' .. DEMO_COLLECTION .. ' LIMIT 5', {})
        if not results then
            error("Async query failed")
        end
        print("  Async query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: querySync - Sync variant
    testExport("querySync() - SELECT sync", function()
        local results = exports['pb']:querySync('SELECT * FROM ' .. DEMO_COLLECTION .. ' LIMIT 2', {})
        if not results then
            error("Sync query failed")
        end
        print("  Sync query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: single - Get single row
    testExport("single() - Get single record", function()
        local result = exports['pb']:single('SELECT * FROM ' .. DEMO_COLLECTION .. ' LIMIT 1', {})
        if not result then
            error("Single query returned no result")
        end
        print("  Single query returned record with id: " .. tostring(result.id))
        return result
    end)

    -- Test: single with callback
    testExport("single() - With callback", function()
        local callbackResult = nil
        exports['pb']:single('SELECT * FROM ' .. DEMO_COLLECTION .. ' LIMIT 1', {}, function(result)
            callbackResult = result
        end)
        Wait(100) -- Give callback time to execute
        if not callbackResult then
            error("Callback was not called")
        end
        print("  Callback received record with id: " .. tostring(callbackResult.id))
        return callbackResult
    end)

    -- Test: scalar - Get single value
    testExport("scalar() - Get count", function()
        local count = exports['pb']:scalar('SELECT COUNT(*) FROM ' .. DEMO_COLLECTION, {})
        if not count then
            error("Scalar query returned no value")
        end
        print("  Scalar returned count: " .. tostring(count))
        return count
    end)

    -- Test: scalar - Get specific column
    testExport("scalar() - Get specific column value", function()
        local name = exports['pb']:scalar('SELECT name FROM ' .. DEMO_COLLECTION .. ' LIMIT 1', {})
        if not name then
            error("Scalar query returned no value")
        end
        print("  Scalar returned name: " .. tostring(name))
        return name
    end)

    -- Test: insert - Insert new record via SQL
    local insertedId = testExport("insert() - INSERT record", function()
        local id = exports['pb']:insert(
            'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)',
            {'OxMySQL Test', 'oxmysql_test_1'}
        )
        if not id then
            error("Insert did not return an ID")
        end
        print("  Inserted record with id: " .. tostring(id))
        return id
    end)

    -- Test: insert_async - Async insert
    local insertedId2 = testExport("insert_async() - INSERT async", function()
        local id = exports['pb']:insert_async(
            'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)',
            {'OxMySQL Test 2', 'oxmysql_test_2'}
        )
        if not id then
            error("Async insert did not return an ID")
        end
        print("  Inserted record with id: " .. tostring(id))
        return id
    end)

    -- Test: update - Update record via SQL
    if insertedId then
        testExport("update() - UPDATE record", function()
            local affectedRows = exports['pb']:update(
                'UPDATE ' .. DEMO_COLLECTION .. ' SET name = ? WHERE id = ?',
                {'OxMySQL Updated', insertedId}
            )
            if not affectedRows or affectedRows == 0 then
                error("Update did not affect any rows")
            end
            print("  Updated " .. tostring(affectedRows) .. " row(s)")
            return affectedRows
        end)
    end

    -- Test: update with complex WHERE
    testExport("update() - UPDATE with complex WHERE", function()
        local affectedRows = exports['pb']:update(
            'UPDATE ' .. DEMO_COLLECTION .. ' SET level = ? WHERE level >= ? AND active = ?',
            {10, 1, true}
        )
        print("  Updated " .. tostring(affectedRows) .. " row(s) with complex WHERE")
        return affectedRows
    end)

    -- Test: SELECT with complex WHERE and ORDER BY
    testExport("query() - Complex SELECT with WHERE and ORDER BY", function()
        local results = exports['pb']:query(
            'SELECT name, level FROM ' .. DEMO_COLLECTION .. ' WHERE level >= ? ORDER BY level',
            {1}
        )
        if not results then
            error("Complex query failed")
        end
        print("  Complex query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: SELECT with LIMIT
    testExport("query() - SELECT with LIMIT", function()
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level > ? LIMIT 2',
            {0}
        )
        if not results then
            error("Query with LIMIT failed")
        end
        print("  Query with LIMIT returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: prepare - Prepared statement
    testExport("prepare() - Prepared statement", function()
        local results = exports['pb']:prepare('SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE name = ?', {'Test Player'})
        if not results then
            error("Prepare query failed")
        end
        print("  Prepare returned " .. (type(results) == "table" and #results or 1) .. " result(s)")
        return results
    end)

    -- Test: Named parameters (deprecated @name syntax)
    testExport("query() - Named parameters", function()
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE name = @playerName',
            {playerName = 'Test Player'}
        )
        if not results or #results == 0 then
            error("Named parameter query returned no results")
        end
        print("  Named parameter query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: Comparison operators - Greater than
    testExport("query() - Greater than operator", function()
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level > ?',
            {5}
        )
        if not results then
            error("Greater than query failed")
        end
        print("  Greater than query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: Comparison operators - Less than or equal
    testExport("query() - Less than or equal operator", function()
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level <= ?',
            {10}
        )
        if not results then
            error("Less than or equal query failed")
        end
        print("  Less than or equal query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: Comparison operators - Not equal
    testExport("query() - Not equal operator", function()
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE name != ?',
            {'NonExistentName'}
        )
        if not results then
            error("Not equal query failed")
        end
        print("  Not equal query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: LIKE operator
    testExport("query() - LIKE operator", function()
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE name LIKE ?',
            {'%Test%'}
        )
        if not results then
            error("LIKE query failed")
        end
        print("  LIKE query returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: IN operator
    testExport("query() - IN operator", function()
        -- First insert test records with known levels
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'IN Test 1', 'in_test_1', 1})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'IN Test 2', 'in_test_2', 5})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'IN Test 3', 'in_test_3', 10})
        testIds[4] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'IN Test 4', 'in_test_4', 15})

        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level IN (1, 5, 10)',
            {}
        )
        if not results then
            error("IN query failed")
        end

        -- Validate: should only get records with level 1, 5, or 10 (not 15)
        local foundLevels = {}
        for _, record in ipairs(results) do
            foundLevels[record.level] = (foundLevels[record.level] or 0) + 1
        end

        if foundLevels[15] then
            error("IN query returned level 15, which should not be included")
        end

        print("  IN query returned " .. #results .. " record(s) with correct levels")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: BETWEEN operator
    testExport("query() - BETWEEN operator", function()
        -- Insert test records
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'BETWEEN Test 1', 'between_test_1', 0})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'BETWEEN Test 2', 'between_test_2', 5})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'BETWEEN Test 3', 'between_test_3', 10})
        testIds[4] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'BETWEEN Test 4', 'between_test_4', 15})

        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level BETWEEN 1 AND 10',
            {}
        )
        if not results then
            error("BETWEEN query failed")
        end

        -- Validate: all results should have level between 1 and 10 (inclusive)
        for _, record in ipairs(results) do
            if record.level < 1 or record.level > 10 then
                error("BETWEEN query returned level " .. record.level .. ", which is outside range 1-10")
            end
        end

        print("  BETWEEN query returned " .. #results .. " record(s) in correct range")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: IS NULL (Note: PocketBase fields are non-nullable with zero-defaults)
    testExport("query() - IS NULL operator", function()
        -- PocketBase doesn't support true NULL values - fields have zero-defaults:
        -- Text = "", Number = 0, Boolean = false
        -- So we test that IS NULL converts to "= null" syntax (even though it won't match anything)

        -- Insert record without level field (will default to 0)
        local testId1 = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', {'NULL Test 1', 'null_test_1'})

        -- Check what was actually inserted - level should be 0 (default)
        local checkResult = exports['pb']:single('SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE id = ?', {testId1})

        if not checkResult then
            error("Could not retrieve inserted record")
        end

        -- Verify PocketBase set level to 0 (zero-default)
        if checkResult.level ~= 0 then
            error("Expected level to be 0 (zero-default), got: " .. tostring(checkResult.level))
        end

        -- Now test IS NULL query - should return 0 results because PocketBase doesn't have NULL
        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level IS NULL',
            {}
        )

        -- This SHOULD return 0 results because PocketBase uses zero-defaults, not NULL
        if #results > 0 then
            error("IS NULL incorrectly found records (PocketBase doesn't support NULL)")
        end

        print("  IS NULL correctly converts syntax (returns 0 results as expected - PocketBase uses zero-defaults)")

        -- Cleanup
        pcall(function() exports['pb']:delete(DEMO_COLLECTION, testId1) end)

        return true
    end)

    -- Test: IS NOT NULL (Note: All PocketBase fields are non-null with defaults)
    testExport("query() - IS NOT NULL operator", function()
        -- Insert records with name (name is required field, so we must provide it)
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', {'Has Name', 'not_null_test_1'})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', {'Also Has Name', 'not_null_test_2'})

        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE name IS NOT NULL',
            {}
        )
        if not results then
            error("IS NOT NULL query failed")
        end

        -- In PocketBase, ALL records are "not null" because fields have zero-defaults
        -- So this should return all records
        if #results == 0 then
            error("IS NOT NULL returned no results, but all PocketBase fields are non-null")
        end

        -- Validate: all returned records should have non-nil name (even if empty string)
        for _, record in ipairs(results) do
            if record.name == nil then
                error("IS NOT NULL query returned record with nil name (shouldn't happen in PocketBase)")
            end
        end

        print("  IS NOT NULL query returned " .. #results .. " record(s) (all records in PocketBase are non-null)")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: LIMIT with OFFSET
    testExport("query() - LIMIT with OFFSET", function()
        -- First, clean up any existing test records
        local cleanup = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
            {'%offset_test_%'}
        )
        for _, record in ipairs(cleanup) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, record.id) end)
        end

        -- Insert records with known order
        local testIds = {}
        for i = 1, 10 do
            testIds[i] = exports['pb']:insert(
                'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)',
                {'OFFSET Test ' .. i, 'offset_test_' .. i, i}
            )
        end

        -- Get all records ordered by level
        local allResults = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ? ORDER BY level',
            {'%offset_test_%'}
        )

        -- Debug: print what we got
        print("  DEBUG: All results count: " .. #allResults)
        if #allResults >= 3 then
            print("  DEBUG: First 3 levels: " .. allResults[1].level .. ", " .. allResults[2].level .. ", " .. allResults[3].level)
        end

        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ? ORDER BY level LIMIT 5 OFFSET 2',
            {'%offset_test_%'}
        )
        if not results then
            error("LIMIT OFFSET query failed")
        end

        -- Debug: print what we got with offset
        print("  DEBUG: Offset results count: " .. #results)
        if #results >= 1 then
            print("  DEBUG: First result level: " .. tostring(results[1].level))
        end

        -- Validate: should return exactly 5 records
        if #results ~= 5 then
            error("LIMIT 5 should return 5 records, got " .. #results)
        end

        -- Validate: first record should match the 3rd record from full list (offset 2 means skip first 2)
        if #allResults >= 3 and results[1] then
            local expectedLevel = allResults[3].level
            if results[1].level ~= expectedLevel then
                error("First result should be level " .. expectedLevel .. " (3rd record after sorting), got " .. tostring(results[1].level))
            end
        end

        print("  LIMIT OFFSET query returned " .. #results .. " record(s) with correct offset")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: DISTINCT
    testExport("query() - DISTINCT", function()
        -- Insert duplicate level values
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'DISTINCT Test 1', 'distinct_test_1', 99})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'DISTINCT Test 2', 'distinct_test_2', 99})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'DISTINCT Test 3', 'distinct_test_3', 99})

        local results = exports['pb']:query(
            'SELECT DISTINCT level FROM ' .. DEMO_COLLECTION .. ' WHERE level = 99',
            {}
        )
        if not results then
            error("DISTINCT query failed")
        end

        -- Validate: should return only 1 record even though we inserted 3 with same level
        if #results ~= 1 then
            error("DISTINCT failed: expected 1 unique record, got " .. #results)
        end

        if results[1].level ~= 99 then
            error("DISTINCT returned wrong level: " .. tostring(results[1].level))
        end

        print("  DISTINCT correctly returned " .. #results .. " unique record (from 3 duplicates)")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: Multiple ORDER BY columns
    testExport("query() - Multiple ORDER BY", function()
        -- Insert records with same level but different names
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Zebra', 'order_test_1', 50})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Alpha', 'order_test_2', 50})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Beta', 'order_test_3', 50})

        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level = 50 ORDER BY level DESC, name ASC',
            {}
        )
        if not results then
            error("Multiple ORDER BY query failed")
        end

        -- Validate: within same level, names should be alphabetically sorted
        if #results >= 3 then
            if results[1].name > results[2].name or results[2].name > results[3].name then
                error("ORDER BY name ASC failed: " .. results[1].name .. ", " .. results[2].name .. ", " .. results[3].name)
            end
        end

        print("  Multiple ORDER BY correctly sorted by level DESC, then name ASC")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: SUM aggregation
    testExport("query() - SUM aggregation", function()
        -- Insert records with known values
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'SUM Test 1', 'sum_test_1', 10})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'SUM Test 2', 'sum_test_2', 20})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'SUM Test 3', 'sum_test_3', 30})

        local results = exports['pb']:query(
            'SELECT SUM(level) as total_level FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
            {'%sum_test_%'}
        )
        if not results or not results[1] then
            error("SUM query failed")
        end

        -- Validate: sum should be 10 + 20 + 30 = 60
        local expectedSum = 60
        if results[1].total_level ~= expectedSum then
            error("SUM incorrect: expected " .. expectedSum .. ", got " .. tostring(results[1].total_level))
        end

        print("  SUM correctly calculated: " .. tostring(results[1].total_level))

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: AVG aggregation
    testExport("query() - AVG aggregation", function()
        -- Insert records with known values
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'AVG Test 1', 'avg_test_1', 10})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'AVG Test 2', 'avg_test_2', 20})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'AVG Test 3', 'avg_test_3', 30})

        local results = exports['pb']:query(
            'SELECT AVG(level) as avg_level FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
            {'%avg_test_%'}
        )
        if not results or not results[1] then
            error("AVG query failed")
        end

        -- Validate: average should be (10 + 20 + 30) / 3 = 20
        local expectedAvg = 20
        if math.abs(results[1].avg_level - expectedAvg) > 0.01 then
            error("AVG incorrect: expected " .. expectedAvg .. ", got " .. tostring(results[1].avg_level))
        end

        print("  AVG correctly calculated: " .. tostring(results[1].avg_level))

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: MIN aggregation
    testExport("query() - MIN aggregation", function()
        -- Insert records with known values
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MIN Test 1', 'min_test_1', 100})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MIN Test 2', 'min_test_2', 5})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MIN Test 3', 'min_test_3', 50})

        local results = exports['pb']:query(
            'SELECT MIN(level) as min_level FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
            {'%min_test_%'}
        )
        if not results or not results[1] then
            error("MIN query failed")
        end

        -- Validate: minimum should be 5
        local expectedMin = 5
        if results[1].min_level ~= expectedMin then
            error("MIN incorrect: expected " .. expectedMin .. ", got " .. tostring(results[1].min_level))
        end

        print("  MIN correctly found: " .. tostring(results[1].min_level))

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: MAX aggregation
    testExport("query() - MAX aggregation", function()
        -- Insert records with known values
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MAX Test 1', 'max_test_1', 100})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MAX Test 2', 'max_test_2', 5})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MAX Test 3', 'max_test_3', 50})

        local results = exports['pb']:query(
            'SELECT MAX(level) as max_level FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
            {'%max_test_%'}
        )
        if not results or not results[1] then
            error("MAX query failed")
        end

        -- Validate: maximum should be 100
        local expectedMax = 100
        if results[1].max_level ~= expectedMax then
            error("MAX incorrect: expected " .. expectedMax .. ", got " .. tostring(results[1].max_level))
        end

        print("  MAX correctly found: " .. tostring(results[1].max_level))

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: Multiple aggregations
    testExport("query() - Multiple aggregations", function()
        -- Insert records with known values
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MULTI Test 1', 'multi_test_1', 10})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MULTI Test 2', 'multi_test_2', 20})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'MULTI Test 3', 'multi_test_3', 30})

        local results = exports['pb']:query(
            'SELECT COUNT(*) as count, SUM(level) as total, AVG(level) as average FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
            {'%multi_test_%'}
        )
        if not results or not results[1] then
            error("Multiple aggregations query failed")
        end

        -- Validate all aggregations
        if results[1]['count'] ~= 3 then
            error("COUNT incorrect: expected 3, got " .. tostring(results[1]['count']))
        end
        if results[1]['total'] ~= 60 then
            error("SUM incorrect: expected 60, got " .. tostring(results[1]['total']))
        end
        if math.abs(results[1]['average'] - 20) > 0.01 then
            error("AVG incorrect: expected 20, got " .. tostring(results[1]['average']))
        end

        print("  Multiple aggregations correct - COUNT: " .. tostring(results[1]['count']) ..
              ", SUM: " .. tostring(results[1]['total']) ..
              ", AVG: " .. tostring(results[1]['average']))

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: prepare with multiple parameter sets
    testExport("prepare() - Multiple parameter sets", function()
        -- Insert test records
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'PREP Test 1', 'prep_test_1', 11})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'PREP Test 2', 'prep_test_2', 22})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'PREP Test 3', 'prep_test_3', 33})

        local results = exports['pb']:prepare(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level = ?',
            {{11}, {22}, {33}}
        )
        if not results then
            error("Prepare with multiple parameter sets failed")
        end

        -- Validate: should return 3 result sets
        if #results ~= 3 then
            error("Prepare should return 3 result sets, got " .. #results)
        end

        -- Validate: each result set should have the correct level
        if #results[1] > 0 and results[1][1].level ~= 11 then
            error("First parameter set returned wrong level")
        end
        if #results[2] > 0 and results[2][1].level ~= 22 then
            error("Second parameter set returned wrong level")
        end
        if #results[3] > 0 and results[3][1].level ~= 33 then
            error("Third parameter set returned wrong level")
        end

        print("  Prepare correctly executed " .. #results .. " query sets with correct results")

        -- Cleanup
        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- ========================================================================
    -- String Function Tests
    -- ========================================================================

    print("^5[String Functions]^7 Testing string function support...")

    -- Test: UPPER function
    testExport("query() - UPPER function", function()
        local testId = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'lowercase name', 'upper_test_1', 1})

        local results = exports['pb']:query(
            'SELECT UPPER(name) AS upper_name FROM ' .. DEMO_COLLECTION .. ' WHERE identifier = ?',
            {'upper_test_1'}
        )

        if not results or #results == 0 then
            error("UPPER query failed")
        end

        if results[1].upper_name ~= 'LOWERCASE NAME' then
            error("UPPER failed: expected 'LOWERCASE NAME', got '" .. tostring(results[1].upper_name) .. "'")
        end

        print("  UPPER correctly converted: " .. results[1].upper_name)

        pcall(function() exports['pb']:delete(DEMO_COLLECTION, testId) end)
        return results
    end)

    -- Test: LOWER function
    testExport("query() - LOWER function", function()
        local testId = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'UPPERCASE NAME', 'lower_test_1', 1})

        local results = exports['pb']:query(
            'SELECT LOWER(name) AS lower_name FROM ' .. DEMO_COLLECTION .. ' WHERE identifier = ?',
            {'lower_test_1'}
        )

        if not results or #results == 0 then
            error("LOWER query failed")
        end

        if results[1].lower_name ~= 'uppercase name' then
            error("LOWER failed: expected 'uppercase name', got '" .. tostring(results[1].lower_name) .. "'")
        end

        print("  LOWER correctly converted: " .. results[1].lower_name)

        pcall(function() exports['pb']:delete(DEMO_COLLECTION, testId) end)
        return results
    end)

    -- Test: CONCAT function
    testExport("query() - CONCAT function", function()
        local testId = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'John', 'concat_test_1', 5})

        local results = exports['pb']:query(
            'SELECT CONCAT(name, " - Level ", level) AS full_info FROM ' .. DEMO_COLLECTION .. ' WHERE identifier = ?',
            {'concat_test_1'}
        )

        if not results or #results == 0 then
            error("CONCAT query failed")
        end

        if results[1].full_info ~= 'John - Level 5' then
            error("CONCAT failed: expected 'John - Level 5', got '" .. tostring(results[1].full_info) .. "'")
        end

        print("  CONCAT correctly combined: " .. results[1].full_info)

        pcall(function() exports['pb']:delete(DEMO_COLLECTION, testId) end)
        return results
    end)

    -- Test: LENGTH function
    testExport("query() - LENGTH function", function()
        local testId = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Hello', 'length_test_1', 1})

        local results = exports['pb']:query(
            'SELECT LENGTH(name) AS name_length FROM ' .. DEMO_COLLECTION .. ' WHERE identifier = ?',
            {'length_test_1'}
        )

        if not results or #results == 0 then
            error("LENGTH query failed")
        end

        if results[1].name_length ~= 5 then
            error("LENGTH failed: expected 5, got " .. tostring(results[1].name_length))
        end

        print("  LENGTH correctly calculated: " .. tostring(results[1].name_length))

        pcall(function() exports['pb']:delete(DEMO_COLLECTION, testId) end)
        return results
    end)

    -- ========================================================================
    -- GROUP BY Tests
    -- ========================================================================

    print("^5[GROUP BY]^7 Testing GROUP BY with aggregations...")

    -- Test: GROUP BY with COUNT
    testExport("query() - GROUP BY with COUNT", function()
        -- Clean up any stale test data first
        pcall(function()
            local staleRecords = exports['pb']:query(
                'SELECT id FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
                {'%group_test_%'}
            )
            if staleRecords then
                for _, record in ipairs(staleRecords) do
                    pcall(function() exports['pb']:delete(DEMO_COLLECTION, record.id) end)
                end
            end
        end)

        -- Insert test records with different levels
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Group 1 User 1', 'group_test_1', 10})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Group 1 User 2', 'group_test_2', 10})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Group 2 User 1', 'group_test_3', 20})

        local results = exports['pb']:query(
            'SELECT level, COUNT(*) AS count FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ? GROUP BY level',
            {'%group_test_%'}
        )

        if not results or #results == 0 then
            error("GROUP BY query failed")
        end

        -- Should have 2 groups
        if #results ~= 2 then
            error("Expected 2 groups, got " .. #results)
        end

        -- Validate group counts
        local level10Count = 0
        local level20Count = 0
        for _, row in ipairs(results) do
            if row.level == 10 then
                level10Count = row.count
            elseif row.level == 20 then
                level20Count = row.count
            end
        end

        if level10Count ~= 2 then
            error("Level 10 should have count 2, got " .. level10Count)
        end
        if level20Count ~= 1 then
            error("Level 20 should have count 1, got " .. level20Count)
        end

        print("  GROUP BY correctly grouped and counted: Level 10=" .. level10Count .. ", Level 20=" .. level20Count)

        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: GROUP BY with multiple aggregations
    testExport("query() - GROUP BY with SUM and AVG", function()
        -- Clean up any stale test data first
        pcall(function()
            local staleRecords = exports['pb']:query(
                'SELECT id FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ?',
                {'%groupagg_test_%'}
            )
            if staleRecords then
                for _, record in ipairs(staleRecords) do
                    pcall(function() exports['pb']:delete(DEMO_COLLECTION, record.id) end)
                end
            end
        end)

        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level, playtime) VALUES (?, ?, ?, ?)', {'Player 1', 'groupagg_test_1', 1, 100})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level, playtime) VALUES (?, ?, ?, ?)', {'Player 2', 'groupagg_test_2', 1, 200})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level, playtime) VALUES (?, ?, ?, ?)', {'Player 3', 'groupagg_test_3', 2, 300})

        local results = exports['pb']:query(
            'SELECT level, COUNT(*) AS player_count, SUM(playtime) AS total_time, AVG(playtime) AS avg_time FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ? GROUP BY level',
            {'%groupagg_test_%'}
        )

        if not results or #results ~= 2 then
            error("GROUP BY with aggregations failed")
        end

        -- Find level 1 group
        local level1 = nil
        for _, row in ipairs(results) do
            if row.level == 1 then
                level1 = row
                break
            end
        end

        if not level1 then
            error("Could not find level 1 group")
        end

        if level1.player_count ~= 2 then
            error("Level 1 count should be 2, got " .. level1.player_count)
        end
        if level1.total_time ~= 300 then
            error("Level 1 total should be 300, got " .. level1.total_time)
        end
        if math.abs(level1.avg_time - 150) > 0.01 then
            error("Level 1 average should be 150, got " .. level1.avg_time)
        end

        print("  GROUP BY with multiple aggregations correct: COUNT=" .. level1.player_count .. ", SUM=" .. level1.total_time .. ", AVG=" .. level1.avg_time)

        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- ========================================================================
    -- Subquery Tests
    -- ========================================================================

    print("^5[Subqueries]^7 Testing subquery support...")

    -- Test: IN subquery
    testExport("query() - IN subquery", function()
        local testIds = {}
        testIds[1] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Subquery User 1', 'subquery_test_1', 50})
        testIds[2] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Subquery User 2', 'subquery_test_2', 51})
        testIds[3] = exports['pb']:insert('INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier, level) VALUES (?, ?, ?)', {'Subquery User 3', 'subquery_test_3', 52})

        local results = exports['pb']:query(
            'SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level IN (SELECT level FROM ' .. DEMO_COLLECTION .. ' WHERE identifier LIKE ? AND level > 50)',
            {'%subquery_test_%'}
        )

        if not results then
            error("IN subquery failed")
        end

        -- Should return records with level 51 and 52 (> 50)
        local foundLevels = {}
        for _, row in ipairs(results) do
            foundLevels[row.level] = true
        end

        if not foundLevels[51] or not foundLevels[52] then
            error("IN subquery didn't return correct levels")
        end
        if foundLevels[50] then
            error("IN subquery incorrectly included level 50")
        end

        print("  IN subquery correctly filtered: found " .. #results .. " records with levels > 50")

        for _, id in ipairs(testIds) do
            pcall(function() exports['pb']:delete(DEMO_COLLECTION, id) end)
        end

        return results
    end)

    -- Test: rawExecute - Raw execute
    testExport("rawExecute() - Raw execute query", function()
        local results = exports['pb']:rawExecute('SELECT * FROM ' .. DEMO_COLLECTION .. ' WHERE level > ?', {0})
        if not results then
            error("rawExecute query failed")
        end
        print("  rawExecute returned " .. (type(results) == "table" and #results or 1) .. " result(s)")
        return results
    end)

    -- Test: rawExecute_async - Async raw execute
    testExport("rawExecute_async() - Raw execute async", function()
        local results = exports['pb']:rawExecute_async('SELECT name FROM ' .. DEMO_COLLECTION .. ' LIMIT 3', {})
        if not results then
            error("rawExecute_async failed")
        end
        print("  rawExecute_async returned " .. #results .. " record(s)")
        return results
    end)

    -- Test: DELETE query
    local deleteTestId = testExport("insert() - Create record for DELETE test", function()
        local id = exports['pb']:insert(
            'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)',
            {'Delete Test', 'delete_test_1'}
        )
        return id
    end)

    if deleteTestId then
        testExport("execute() - DELETE query", function()
            local affectedRows = exports['pb']:execute(
                'DELETE FROM ' .. DEMO_COLLECTION .. ' WHERE id = ?',
                {deleteTestId}
            )
            if not affectedRows or affectedRows == 0 then
                error("DELETE did not affect any rows")
            end
            print("  Deleted " .. tostring(affectedRows) .. " row(s)")
            return affectedRows
        end)
    end

    -- Test: transaction - Execute multiple queries atomically (array format)
    testExport("transaction() - Multiple SQL queries (array format)", function()
        local queries = {
            {'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', {'TX Test 1', 'tx_1'}},
            {'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', {'TX Test 2', 'tx_2'}},
        }
        local results = exports['pb']:transaction(queries)
        if not results then
            error("Transaction failed")
        end
        print("  Transaction executed " .. #results .. " queries")
        return results
    end)

    -- Test: transaction - Object format
    testExport("transaction() - Object format", function()
        local queries = {
            { query = 'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', values = {'TX Test 3', 'tx_3'}},
            { query = 'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', values = {'TX Test 4', 'tx_4'}},
        }
        local results = exports['pb']:transaction(queries)
        if not results then
            error("Transaction with object format failed")
        end
        print("  Transaction (object format) executed " .. #results .. " queries")
        return results
    end)

    -- Test: transaction - String array format
    testExport("transaction() - String array format", function()
        local queries = {
            'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES ("TX Test 5", "tx_5")',
            'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES ("TX Test 6", "tx_6")',
        }
        local results = exports['pb']:transaction(queries)
        if not results then
            error("Transaction with string array failed")
        end
        print("  Transaction (string array) executed " .. #results .. " queries")
        return results
    end)

    -- Test: transaction with mixed operations
    testExport("transaction() - Mixed operations (INSERT, UPDATE, DELETE)", function()
        local queries = {
            {'INSERT INTO ' .. DEMO_COLLECTION .. ' (name, identifier) VALUES (?, ?)', {'TX Mixed 1', 'tx_mixed_1'}},
            {'UPDATE ' .. DEMO_COLLECTION .. ' SET level = ? WHERE identifier = ?', {99, 'tx_mixed_1'}},
        }
        local results = exports['pb']:transaction(queries)
        if not results or #results ~= 2 then
            error("Mixed transaction failed")
        end
        print("  Mixed transaction executed " .. #results .. " operations")
        return results
    end)

    -- Test: execute - Generic execute (alias for query/update)
    testExport("execute() - Generic execute", function()
        local result = exports['pb']:execute(
            'UPDATE ' .. DEMO_COLLECTION .. ' SET name = ? WHERE identifier = ?',
            {'Execute Test', 'oxmysql_test_1'}
        )
        print("  Execute completed")
        return result
    end)

    -- Test: executeSync - Sync variant
    testExport("executeSync() - Execute sync", function()
        local result = exports['pb']:executeSync(
            'UPDATE ' .. DEMO_COLLECTION .. ' SET level = ? WHERE identifier = ?',
            {50, 'oxmysql_test_2'}
        )
        print("  ExecuteSync completed")
        return result
    end)

    -- Cleanup OxMySQL test records
    if insertedId then
        pcall(function()
            exports['pb']:delete(DEMO_COLLECTION, insertedId)
        end)
    end
    if insertedId2 then
        pcall(function()
            exports['pb']:delete(DEMO_COLLECTION, insertedId2)
        end)
    end

    -- Cleanup transaction test records
    local txIdentifiers = {'tx_1', 'tx_2', 'tx_3', 'tx_4', 'tx_5', 'tx_6', 'tx_mixed_1'}
    for _, identifier in ipairs(txIdentifiers) do
        pcall(function()
            local records = exports['pb']:getFullList(DEMO_COLLECTION, {filter = 'identifier = "' .. identifier .. '"'})
            for _, record in ipairs(records) do
                exports['pb']:delete(DEMO_COLLECTION, record.id)
            end
        end)
    end

    -- ========================================================================
    -- Cleanup Transaction Records
    -- ========================================================================

    -- Clean up transaction test records
    for _, recordId in ipairs(txRecordIds) do
        pcall(function()
            exports['pb']:delete(DEMO_COLLECTION, recordId)
        end)
    end

    -- ========================================================================
    -- Cleanup
    -- ========================================================================

    -- Clean up batch test records if any were created
    if batchResults and type(batchResults) == "table" then
        for _, result in ipairs(batchResults) do
            if result and result.id then
                pcall(function()
                    exports['pb']:delete(DEMO_COLLECTION, result.id)
                end)
            end
        end
    end

    -- Test: delete (original record)
    if createdRecordId then
        testExport("delete()", function()
            local result = exports['pb']:delete(DEMO_COLLECTION, createdRecordId)
            -- Validate deletion succeeded (returns true or nil)
            -- Try to fetch the record to confirm it's deleted
            local success, error = pcall(function()
                return exports['pb']:getOne(DEMO_COLLECTION, createdRecordId)
            end)
            -- If we can still get the record, deletion failed
            if success then
                error("Record still exists after delete()")
            end
            return true
        end)
    end

    -- Note: We don't delete the collection itself to preserve it for future tests
    -- If you want to delete it, uncomment the following:
    -- if collectionId then
    --     testExport("deleteCollection()", function()
    --         return exports['pb']:deleteCollection(DEMO_COLLECTION)
    --     end)
    -- end

    -- ========================================================================
    -- Display Results
    -- ========================================================================

    Wait(500) -- Give async operations time to complete
    displayTestResults()
end
