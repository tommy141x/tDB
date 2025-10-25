# PocketBase for FiveM

A production-ready [PocketBase](https://pocketbase.io/) instance in one FiveM resource with automatic setup, realtime events, backups, SQL queries, transactions, and comprehensive exports.

---

## 🚀 Quick Start

### Installation

1. Download and extract to your `resources` folder
2. The resource folder name should be `pb`
3. Add `ensure pb` to your `server.cfg`
4. Start your server

**That's it!** PocketBase will automatically:
- Start on `127.0.0.1:8090`
- Create a superuser account
- Authenticate your scripts
- Work immediately with zero configuration

---

## ⚙️ Basic Configuration

### Admin UI Access

By default, the admin UI is **not exposed** (most secure). Your scripts can still access PocketBase.

**To enable public admin UI access:**

```lua
Config.ExposeAdmin = true  -- Set to true in config.lua
```

When enabled, configure your public URL:

```lua
Config.Host = ""  -- Leave empty to auto-detect, or set to your IP/domain
Config.Port = 8090
```

**Important:** If you enable `ExposeAdmin`, you must:
- Open port 8090 in your firewall
- Configure port forwarding if needed
- Set a strong superuser password

### Superuser Credentials

Credentials are auto-generated on first startup. Find them in `config.lua`:

```lua
Config.Superuser = {
    Email = "admin@localhost.local",    -- Auto-generated
    Password = "qOl9dbdZHF54ixFfM9th", -- Auto-generated (20 char random)
}
```

**Security:** These credentials are stored in plain text. Protect your `config.lua` file!

### Backups

Enable automatic database backups:

```lua
Config.Backup = {
    Enabled = true,        -- Enable backup system
    OnStartup = true,      -- Backup before each startup (recommended)
    Schedule = 86400,      -- Auto-backup every 24 hours (0 = disabled)
    KeepLast = 7,         -- Keep last 7 backups, delete older
    BackupPrefix = "auto_",
}
```

Backups are stored in the `pb_data/backups` directory.

---

## 🔧 Advanced Configuration

### SMTP (Email)

Configure email sending for password resets, verifications, etc:

```lua
Config.Advanced = {
    SMTP = {
        Enabled = true,
        Host = "smtp.gmail.com",
        Port = 587,
        Username = "your-email@gmail.com",
        Password = "your-app-password",
        TLS = true,
    },
}
```

### S3 Storage

Offload file uploads to S3-compatible storage:

```lua
Config.Advanced = {
    S3 = {
        Enabled = true,
        Bucket = "my-bucket",
        Region = "us-east-1",
        Endpoint = "",  -- Leave empty for AWS S3
        AccessKey = "your-access-key",
        SecretKey = "your-secret-key",
        ForcePathStyle = false,  -- Set true for MinIO
    },
}
```

### Migrations

Auto-apply database migrations on startup:

```lua
Config.Migrations = {
    AutoApply = true,  -- Apply pending migrations automatically
    Dir = "pb_migrations",
}
```

PocketBase automatically generates migration files when you modify collections via the admin UI.

---

## 📚 Exports Reference

All examples use `exports['pb']:functionName()`

### ⚠️ Wait for Ready

**Important:** PocketBase must be ready before using any exports. Use the callback or check manually:

#### Using Callback (Recommended)
```lua
exports['pb']:onReady(function()
    -- PocketBase is ready, safe to use all exports
    local players = exports['pb']:getFullList("players")
end)
```

#### Manual Check
```lua
if exports['pb']:isReady() then
    local players = exports['pb']:getFullList("players")
else
    print("PocketBase not ready yet!")
end
```

**Note:** The resource usually takes 1-2 seconds to start. Using `onReady()` ensures your code runs at the right time.

---

### Collections

#### Get Collections
```lua
local collections = exports['pb']:getCollections()
```

#### Create Collection
```lua
local collection = exports['pb']:createCollection({
    name = "players",
    type = "base",
    fields = {
        { name = "username", type = "text", required = true },
        { name = "score", type = "number" },
        { name = "banned", type = "bool" }
    }
})
```

#### Update/Delete Collection
```lua
exports['pb']:updateCollection("players", { ... })
exports['pb']:deleteCollection("players")
```

#### Advanced Operations
```lua
-- Delete all records in collection
exports['pb']:truncateCollection("logs")

-- Get collection templates
local scaffolds = exports['pb']:getCollectionScaffolds()
```

---

### Records (CRUD)

#### Create Record
```lua
local player = exports['pb']:create("players", {
    username = "John",
    score = 100,
    banned = false
})
```

#### Get Record
```lua
local player = exports['pb']:getOne("players", recordId)
```

#### Get Multiple Records
```lua
-- Paginated
local result = exports['pb']:getList("players", 1, 50)
print(result.totalItems, result.page, result.totalPages)

-- All records
local players = exports['pb']:getFullList("players")
```

#### Update Record
```lua
local updated = exports['pb']:update("players", recordId, {
    score = 150
})
```

#### Delete Record
```lua
exports['pb']:delete("players", recordId)
```

---

### Filtering & Searching

#### Build Safe Filters
```lua
local filter = exports['pb']:filter("score > {:min} && banned = {:banned}", {
    min = 100,
    banned = false
})

local players = exports['pb']:getFullList("players", { filter = filter })
```

#### Get First Match
```lua
local player = exports['pb']:getFirstListItem("players", "username = 'John'")
```

---

### Batch Operations

Perform multiple operations in a single request:

```lua
local batch = exports['pb']:batch()
batch = exports['pb']:batchCreate(batch, "players", { username = "Alice", score = 50 })
batch = exports['pb']:batchCreate(batch, "players", { username = "Bob", score = 75 })
batch = exports['pb']:batchUpdate(batch, "players", playerId, { score = 100 })
batch = exports['pb']:batchDelete(batch, "players", oldPlayerId)

local results = exports['pb']:batchSend(batch)
```

**Note:** Batch API must be enabled in PocketBase Admin > Settings > Batch API

---

### Realtime (Collection)

Subscribe to collection changes:

```lua
-- Subscribe
exports['pb']:subscribe("players", "*")

-- Listen for events
RegisterNetEvent('pocketbase:players:*', function(data)
    print("Action:", data.action)  -- "create", "update", "delete"
    print("Record:", json.encode(data.record))
end)

-- Unsubscribe
exports['pb']:unsubscribe("players", "*")
```

### Realtime (Custom Topics)

Subscribe to custom server events:

```lua
-- Subscribe
exports['pb']:subscribeToTopic("server_events")

-- Listen
RegisterNetEvent('pocketbase:topic:server_events', function(data)
    print("Event:", json.encode(data))
end)

-- Unsubscribe
exports['pb']:unsubscribeFromTopic("server_events")
exports['pb']:unsubscribeByPrefix("server_")
```

### Realtime (Server Broadcasts)

Send custom messages from server to connected clients:

```lua
-- Send message to all clients subscribed to topic
local sentCount = exports['pb']:sendRealtimeMessage("server_events", {
    type = "announcement",
    message = "Server restart in 5 minutes"
})

-- Get list of connected clients
local clients = exports['pb']:getRealtimeClients()
print("Connected clients:", #clients)
```

---

## 🗄️ SQL Queries

Execute SQL queries directly against the SQLite database:

```lua
-- Complex queries with JOINs
local topPlayers = exports['pb']:sqlQuery([[
    SELECT users.name, COUNT(orders.id) as total
    FROM users
    LEFT JOIN orders ON orders.user_id = users.id
    GROUP BY users.id
    HAVING total > 5
    ORDER BY total DESC
]], {})

-- Get single value (COUNT, SUM, etc.)
local totalPlayers = exports['pb']:sqlScalar("SELECT COUNT(*) FROM players")

-- Get single row
local player = exports['pb']:sqlSingle("SELECT * FROM players WHERE id = {:id} LIMIT 1", {id = "abc"})

-- Execute INSERT/UPDATE/DELETE
local insertId = exports['pb']:sqlExecute("INSERT INTO logs (message) VALUES ({:msg})", {msg = "Player joined"})

-- Transaction (all succeed or all fail)
local success = exports['pb']:sqlTransaction({
    {sql = "UPDATE accounts SET balance = balance - 1000 WHERE id = {:from}", params = {from = "acc1"}},
    {sql = "UPDATE accounts SET balance = balance + 1000 WHERE id = {:to}", params = {to = "acc2"}}
})
```

---

## 🔄 Transactions

Execute multiple record operations atomically:

```lua
-- All operations succeed or all fail together
local results = exports['pb']:runTransaction({
    {type = "create", collection = "players", data = {name = "John"}},
    {type = "update", collection = "stats", id = "stat_id", data = {total = 100}},
    {type = "delete", collection = "temp_data", id = "temp_id"}
})

print("Created player:", results[1].id)
```

---

## 📊 Advanced Record Operations

```lua
-- Batch fetch by IDs
local players = exports['pb']:findRecordsByIds("players", {"id1", "id2", "id3"})

-- Count records with filter
local activeCount = exports['pb']:countRecords("players", "active = true")
```

---

## 📧 Email Sending

Send emails programmatically (requires SMTP configuration):

```lua
local success = exports['pb']:sendEmail(
    "user@example.com",
    "Welcome!",
    "<h1>Welcome to the server!</h1>",
    "Welcome to the server!" -- Plain text fallback
)
```

---

### User Authentication

For auth-type collections (like `users`):

#### List Auth Methods
```lua
local methods = exports['pb']:listAuthMethods("users")
```

#### Authenticate User
```lua
local result = exports['pb']:authWithPassword("users", "user@email.com", "password")
print("Token:", result.token)
print("User:", json.encode(result.record))
```

#### Password Reset
```lua
-- Request reset email
exports['pb']:requestPasswordReset("users", "user@email.com")

-- Confirm with token
exports['pb']:confirmPasswordReset("users", token, newPassword, newPasswordConfirm)
```

#### Email Verification
```lua
-- Request verification email
exports['pb']:requestVerification("users", "user@email.com")

-- Confirm with token
exports['pb']:confirmVerification("users", token)
```

#### OAuth2
```lua
-- Get available providers
local methods = exports['pb']:listAuthMethods("users")

-- Authenticate with OAuth2 code
local result = exports['pb']:authWithOAuth2Code("users", "google", code, codeVerifier, redirectUrl)
```

---

### Files

#### Get File URL
```lua
local url = exports['pb']:getFileUrl(record, "avatar.png")
```

#### Get Protected File Token
```lua
local token = exports['pb']:getFileToken()
```

---

### Utilities

#### Health Check
```lua
local health = exports['pb']:healthCheck()
```

#### Check Ready Status
```lua
local ready = exports['pb']:isReady()
```

#### Get PocketBase URL
```lua
local url = exports['pb']:getUrl()
```

#### Check Realtime Connection
```lua
local connected = exports['pb']:isRealtimeConnected()
```

---

## 💡 Examples

### Player System
```lua
-- Wait for PocketBase to be ready on resource start
exports['pb']:onReady(function()
    print("PocketBase is ready!")
end)

-- Create player on join
AddEventHandler('playerJoining', function()
    local source = source
    local identifiers = GetPlayerIdentifiers(source)

    local player = exports['pb']:create("players", {
        identifier = identifiers[1],
        name = GetPlayerName(source),
        playtime = 0,
        joined = os.date("!%Y-%m-%dT%H:%M:%SZ")
    })
end)

-- Update playtime on quit
AddEventHandler('playerDropped', function()
    local source = source
    local identifiers = GetPlayerIdentifiers(source)

    local filter = exports['pb']:filter("identifier = {:id}", {id = identifiers[1]})
    local player = exports['pb']:getFirstListItem("players", filter)

    if player then
        exports['pb']:update("players", player.id, {
            playtime = player.playtime + 60  -- Add 1 hour
        })
    end
end)
```

### Ban System with Realtime
```lua
-- Subscribe to ban updates when ready
exports['pb']:onReady(function()
    exports['pb']:subscribe("bans", "*")
end)

RegisterNetEvent('pocketbase:bans:*', function(data)
    if data.action == "create" then
        local ban = data.record
        -- Kick player if online
        for _, playerId in ipairs(GetPlayers()) do
            local ids = GetPlayerIdentifiers(playerId)
            if ids[1] == ban.identifier then
                DropPlayer(playerId, "You have been banned: " .. ban.reason)
            end
        end
    end
end)
```

### Leaderboard
```lua
-- Get top 10 players
local filter = exports['pb']:filter("banned = false")
local topPlayers = exports['pb']:getFullList("players", {
    filter = filter,
    sort = "-score",  -- Descending
    limit = 10
})

for i, player in ipairs(topPlayers) do
    print(i, player.name, player.score)
end
```

---

## 🐛 Troubleshooting

### "Batch requests are not allowed"
Enable Batch API in PocketBase Admin > Settings > Batch API

### "Public URL not accessible"
Check firewall settings and port forwarding. This doesn't affect local script access.

### Authentication failed
Check `Config.Superuser` credentials in `config.lua`. Delete and restart to regenerate.

---

## Note
This resource bundles the Windows AMD64 & Linux AMD64 PocketBase binaries, if you wish to download them yourself you can find them here: https://github.com/pocketbase/pocketbase/releases

---

## 📖 Documentation

- **PocketBase Docs**: https://pocketbase.io/docs/
- **JavaScript SDK**: https://github.com/pocketbase/js-sdk
- **Admin UI**: http://127.0.0.1:8090/_/ (when running)

---
