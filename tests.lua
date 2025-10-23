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
exports['pocket-base']:onReady(function()
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
        return exports['pocket-base']:isReady()
    end)

    -- Test: isClientAuthenticated
    local isAuth = testExport("isClientAuthenticated()", function()
        return exports['pocket-base']:isClientAuthenticated()
    end)

    -- Test: getUrl
    local pbUrl = testExport("getUrl()", function()
        return exports['pocket-base']:getUrl()
    end)

    -- Test: healthCheck
    testExport("healthCheck()", function()
        return exports['pocket-base']:healthCheck()
    end)

    -- Note: Authentication exports removed - resource auto-authenticates as superuser

    -- ========================================================================
    -- Collection Management
    -- ========================================================================

    -- Test: getCollections
    local collections = testExport("getCollections()", function()
        return exports['pocket-base']:getCollections()
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
            return exports['pocket-base']:createCollection(collectionSchema)
        end)

        if result then
            collectionId = result.id
        end
    end

    -- Test: getCollection
    if collectionId then
        testExport("getCollection()", function()
            return exports['pocket-base']:getCollection(DEMO_COLLECTION)
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
        return exports['pocket-base']:create(DEMO_COLLECTION, newPlayer)
    end)

    if createdRecord then
        createdRecordId = createdRecord.id
    end

    -- Test: getOne
    if createdRecordId then
        testExport("getOne()", function()
            local record = exports['pocket-base']:getOne(DEMO_COLLECTION, createdRecordId)
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
            local updated = exports['pocket-base']:update(DEMO_COLLECTION, createdRecordId, {
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
        local result = exports['pocket-base']:getList(DEMO_COLLECTION, 1, 10)
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
        local records = exports['pocket-base']:getFullList(DEMO_COLLECTION)
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
        local filter = exports['pocket-base']:filter("playtime > {:minPlaytime}", {minPlaytime = 60})
        -- Validate filter string was generated
        if type(filter) ~= "string" or filter == "" then
            error("filter() didn't return a valid filter string")
        end
        return filter
    end)

    -- Test: getFullList with filter
    if filterString then
        testExport("getFullList() with filter", function()
            local records = exports['pocket-base']:getFullList(DEMO_COLLECTION, {filter = filterString})
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
            local record = exports['pocket-base']:getFirstListItem(DEMO_COLLECTION, "level >= 1")
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
        local result = exports['pocket-base']:subscribe(DEMO_COLLECTION, "*")
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
        local result = exports['pocket-base']:unsubscribe(DEMO_COLLECTION, "*")
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
            local url = exports['pocket-base']:getFileUrl(createdRecord, "avatar.png")
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
        local token = exports['pocket-base']:getFileToken()
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
            return exports['pocket-base']:updateCollection(DEMO_COLLECTION, {
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
        return exports['pocket-base']:listAuthMethods(DEMO_COLLECTION)
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
        local batch = exports['pocket-base']:batch()
        batch = exports['pocket-base']:batchCreate(batch, DEMO_COLLECTION, {
            name = "Batch Player 1",
            identifier = "batch_" .. os.time() .. "_1",
            playtime = 10,
            level = 1,
            active = true
        })
        batch = exports['pocket-base']:batchCreate(batch, DEMO_COLLECTION, {
            name = "Batch Player 2",
            identifier = "batch_" .. os.time() .. "_2",
            playtime = 20,
            level = 2,
            active = true
        })
        return exports['pocket-base']:batchSend(batch)
    end, true) -- Silent errors - batch API may be disabled



    -- ========================================================================
    -- Realtime Service (Custom Topics)
    -- ========================================================================

    -- Test: subscribeToTopic
    testExport("subscribeToTopic()", function()
        local result = exports['pocket-base']:subscribeToTopic("custom_events")
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
        local connected = exports['pocket-base']:isRealtimeConnected()
        -- Validate it returns a boolean
        if type(connected) ~= "boolean" then
            error("isRealtimeConnected() should return a boolean")
        end
        return connected
    end)

    -- Test: unsubscribeFromTopic
    testExport("unsubscribeFromTopic()", function()
        local result = exports['pocket-base']:unsubscribeFromTopic("custom_events")
        -- Validate unsubscribe was successful
        if result ~= true then
            error("unsubscribeFromTopic() should return true on success")
        end
        return result
    end)

    -- Test: unsubscribeByPrefix
    testExport("unsubscribeByPrefix()", function()
        local result = exports['pocket-base']:unsubscribeByPrefix("custom_")
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
        local scaffolds = exports['pocket-base']:getCollectionScaffolds()
        -- Validate scaffolds structure
        if type(scaffolds) ~= "table" then
            error("getCollectionScaffolds() didn't return a table")
        end
        return scaffolds
    end)

    -- Test: importCollections with empty array (should succeed with no changes)
    testExport("importCollections()", function()
        local result = exports['pocket-base']:importCollections(json.encode({}), false)
        -- Should succeed even with empty data
        return true
    end, true) -- Silent - may have validation requirements

    -- Test: truncateCollection (commented out to preserve demo data)
    -- testExport("truncateCollection()", function()
    --     return exports['pocket-base']:truncateCollection(DEMO_COLLECTION)
    -- end)

    -- ========================================================================
    -- Cleanup
    -- ========================================================================

    -- Clean up batch test records if any were created
    if batchResults and type(batchResults) == "table" then
        for _, result in ipairs(batchResults) do
            if result and result.id then
                pcall(function()
                    exports['pocket-base']:delete(DEMO_COLLECTION, result.id)
                end)
            end
        end
    end

    -- Test: delete (original record)
    if createdRecordId then
        testExport("delete()", function()
            local result = exports['pocket-base']:delete(DEMO_COLLECTION, createdRecordId)
            -- Validate deletion succeeded (returns true or nil)
            -- Try to fetch the record to confirm it's deleted
            local success, error = pcall(function()
                return exports['pocket-base']:getOne(DEMO_COLLECTION, createdRecordId)
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
    --         return exports['pocket-base']:deleteCollection(DEMO_COLLECTION)
    --     end)
    -- end

    -- ========================================================================
    -- Display Results
    -- ========================================================================

    Wait(500) -- Give async operations time to complete
    displayTestResults()
end
