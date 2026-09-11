# tDB

A database resource for FiveM. It is a drop-in replacement for **oxmysql** — the
same exports, the same return values, MySQL SQL translated to SQLite — backed by
an embedded [PocketBase](https://pocketbase.io/) instance that also gives you
collections, realtime subscriptions, file storage and an admin UI if you want
them.

Nothing to install alongside it. No MySQL server, no connection string.

```lua
-- Existing oxmysql code. Unchanged.
local row = exports.oxmysql:single_async('SELECT * FROM players WHERE citizenid = ?', { cid })
```

---

## Install

1. Drop the folder into `resources/` and keep the name **`tDB`**.
2. `ensure tDB` in `server.cfg` — before any resource that queries the database.
3. Start the server.

On first start tDB provisions PocketBase itself: it creates the superuser,
writes the credentials into `config.lua`, and authenticates. **The PocketBase
web installer never appears**, and if the superuser account is ever lost or
broken the resource repairs it in place without a restart.

### Replacing oxmysql

Remove `oxmysql` from `server.cfg`. tDB declares `provide 'oxmysql'` (and
`mysql-async` and `ghmattimysql`), so `exports.oxmysql:...` calls and
`dependency 'oxmysql'` lines resolve to tDB with no edits to any script.

The one thing `provide` cannot cover is a **file** reference. If a resource has

```lua
server_script '@oxmysql/lib/MySQL.lua'
```

change it to

```lua
server_script '@tDB/lib/MySQL.lua'
```

Scripts that only call `exports.oxmysql` need no change.

> Running tDB and a real oxmysql at the same time is not supported — two
> resources answering the same export name is ambiguous, and they would be
> talking to two different databases.

---

## The oxmysql API

Every oxmysql export, with the `_async` and `Sync` variants, plus the
`mysql_*` names from mysql-async.

| Export | Returns |
|---|---|
| `query`, `execute`, `fetch` | array of rows |
| `single` | one row, or `nil` |
| `scalar` | the first column of the first row, or `nil` |
| `insert` | the new row's id |
| `update` | affected row count |
| `prepare` | one row per parameter set; unpacked when a callback is given |
| `rawExecute` | the raw result |
| `transaction` | `true`, or `false` if it rolled back |
| `store` | the query, unchanged |

`execute` and `fetch` are aliases of `query` and return **rows**, not a count —
that is oxmysql's own behaviour, taken from its source. The mysql-async
`MySQL.Sync.execute` / `mysql_execute` names do mean "update"; that difference
is preserved too.

```lua
-- Placeholders: ?, @name and :name all work
local rows   = exports.oxmysql:query_async('SELECT * FROM players WHERE money > ?', { 1000 })
local row    = exports.oxmysql:single_async('SELECT * FROM players WHERE citizenid = @cid', { cid = cid })
local name   = exports.oxmysql:scalar_async('SELECT name FROM players WHERE id = ?', { 1 })
local id     = exports.oxmysql:insert_async('INSERT INTO logs (msg) VALUES (?)', { 'joined' })
local n      = exports.oxmysql:update_async('UPDATE players SET money = money + ? WHERE id = ?', { 500, 1 })

local ok = exports.oxmysql:transaction_async({
    { 'UPDATE accounts SET balance = balance - ? WHERE id = ?', { 1000, 'a' } },
    { 'UPDATE accounts SET balance = balance + ? WHERE id = ?', { 1000, 'b' } },
})
```

With the library file:

```lua
-- fxmanifest.lua:  server_script '@tDB/lib/MySQL.lua'
local rows = MySQL.query.await('SELECT * FROM players')
local id   = MySQL.insert.await('INSERT INTO logs (msg) VALUES (?)', { 'joined' })

MySQL.ready(function() print('database up') end)
```

### Query cache

Off by default. When on, row queries are cached and **any** write through tDB
clears the cache, so a cached read cannot outlive the data it described.

```lua
exports.tDB:enableCache(60000, 100)   -- ttl ms, max entries
exports.tDB:invalidateCache('players') -- or a substring match
exports.tDB:disableCache()
exports.tDB:setSlowQueryThreshold(150) -- ms; 0 disables the warning
```

---

## MySQL compatibility

SQL is translated from MySQL to SQLite per statement and cached by shape.
Handled for you:

- `ON DUPLICATE KEY UPDATE` → `ON CONFLICT (...) DO UPDATE`, with the conflict
  target resolved from the table's real unique indexes
- `AUTO_INCREMENT`, `ENGINE=`, `DEFAULT CHARSET=` and the other table options
- inline `KEY` / `UNIQUE KEY` in `CREATE TABLE` → separate `CREATE INDEX`
- `ON UPDATE CURRENT_TIMESTAMP` → a trigger
- `DELETE ... LIMIT`, `LIMIT offset, count`
- backticks, `IF()`, `IFNULL()`, `CONCAT()`, `NOW()`, `UNIX_TIMESTAMP()`
- **case-insensitive text.** MySQL's default collation compares text
  case-insensitively and SQLite does not, so text columns are created
  `COLLATE NOCASE`. `WHERE license = 'LICENSE:AB12'` finds `license:ab12`, and a
  `UNIQUE` key rejects the same value in another case, exactly as MySQL does. A
  column declared `BINARY` or with a `_bin` / `_cs` collation stays byte-exact.

**Anything that cannot be translated faithfully raises an error naming the
construct**, rather than running something subtly different. A wrong row is far
worse than a failed call: it corrupts save data silently, and the script author
has no reason to suspect the database layer. Currently refused by name:
`DATE_ADD`/`DATE_SUB`, `INTERVAL`, `STRAIGHT_JOIN`, `SQL_CALC_FOUND_ROWS`,
`GROUP_CONCAT ... SEPARATOR`.

Known limits worth stating plainly:

- `COLLATE NOCASE` folds ASCII only. `Ä` and `ä` still differ; MySQL's
  `general_ci` folds them.
- Collation is applied when a table is created. A table that predates tDB keeps
  binary collation until it is recreated.
- `RETURNING` is not supported through the query path — MySQL has no equivalent,
  so no MySQL-dialect script can ask for it.

---

## Configuration

Everything lives in `config.lua`. The defaults are meant to be usable as-is.

```lua
Config.Port = 8090
Config.ExposeAdmin = false   -- true publishes the admin UI on Config.Host
Config.Host = "localhost"    -- "" auto-detects the public IP

Config.Superuser = {         -- generated on first start if left empty
    Email = "",
    Password = "",
}
```

The superuser credentials are stored in plain text — protect `config.lua`.

### Local or remote

By default tDB starts and manages its own PocketBase process on `127.0.0.1`.
To point it at an instance you already run:

```lua
Config.Advanced = {
    RemoteHost = "db.example.com",
    RemotePort = "8090",
}
```

Both must be set. In remote mode no local process is started and tDB treats the
instance as somebody else's: it will not alter its settings.

### Backups

```lua
Config.Backup = {
    Enabled = true,
    OnStartup = true,      -- back up before each start
    Schedule = 86400,      -- seconds; 0 disables
    KeepLast = 7,
    BackupPrefix = "auto_",
}
```

Backups land in `pb_data/backups`.

### SMTP, S3, migrations

```lua
Config.Advanced = {
    SMTP = { Enabled = true, Host = "smtp.example.com", Port = 587,
             Username = "", Password = "", TLS = true },

    S3 = { Enabled = true, Bucket = "", Region = "", Endpoint = "",
           AccessKey = "", SecretKey = "", ForcePathStyle = false },
}

Config.Migrations = { AutoApply = true, Dir = "pb_migrations" }
```

PocketBase writes a migration file whenever you change a collection in the admin
UI, so schema changes travel with the resource.

---

## Beyond SQL

tDB also exposes PocketBase itself, under `exports.tDB`. Use it or ignore it —
the oxmysql surface does not depend on any of it.

### Waiting for startup

Every export below needs the database to be up. PocketBase takes a second or two
to start.

```lua
exports.tDB:onReady(function()
    local players = exports.tDB:getFullList('players')
end)

-- or
if exports.tDB:isReady() then ... end
exports.tDB:awaitConnection()
```

### Records

```lua
local player  = exports.tDB:create('players', { username = 'John', score = 100 })
local one     = exports.tDB:getOne('players', recordId)
local page    = exports.tDB:getList('players', 1, 50)   -- .totalItems, .page, .totalPages
local all     = exports.tDB:getFullList('players', { sort = '-score' })
exports.tDB:update('players', recordId, { score = 150 })
exports.tDB:delete('players', recordId)

-- Build filters safely; values are bound, not interpolated
local filter = exports.tDB:filter('score > {:min} && banned = {:banned}', { min = 100, banned = false })
local top    = exports.tDB:getFullList('players', { filter = filter })
local first  = exports.tDB:getFirstListItem('players', filter)

local some   = exports.tDB:findRecordsByIds('players', { 'id1', 'id2' })
local n      = exports.tDB:countRecords('players', 'active = true')
```

### Collections

```lua
exports.tDB:createCollection({
    name = 'players',
    type = 'base',
    fields = {
        { name = 'username', type = 'text', required = true },
        { name = 'score',    type = 'number' },
        { name = 'banned',   type = 'bool' },
    },
})

exports.tDB:getCollections()
exports.tDB:updateCollection('players', { ... })
exports.tDB:deleteCollection('players')
exports.tDB:truncateCollection('logs')
exports.tDB:getCollectionScaffolds()
```

### Realtime

```lua
exports.tDB:subscribe('bans', '*')

RegisterNetEvent('pocketbase:bans:*', function(data)
    -- data.action is "create" | "update" | "delete"
    if data.action == 'create' then
        -- data.record
    end
end)

exports.tDB:unsubscribe('bans', '*')
```

Custom topics, and broadcasting to them from the server:

```lua
exports.tDB:subscribeToTopic('server_events')
RegisterNetEvent('pocketbase:topic:server_events', function(data) end)

exports.tDB:sendRealtimeMessage('server_events', { type = 'announcement', message = '...' })
local clients = exports.tDB:getRealtimeClients()

exports.tDB:unsubscribeFromTopic('server_events')
exports.tDB:unsubscribeByPrefix('server_')
```

### Record transactions and batches

```lua
local results = exports.tDB:runTransaction({
    { type = 'create', collection = 'players', data = { name = 'John' } },
    { type = 'update', collection = 'stats', id = statId, data = { total = 100 } },
    { type = 'delete', collection = 'temp',  id = tempId },
})

local batch = exports.tDB:batch()
batch = exports.tDB:batchCreate(batch, 'players', { username = 'Alice' })
batch = exports.tDB:batchUpdate(batch, 'players', playerId, { score = 100 })
local out = exports.tDB:batchSend(batch)
```

The batch API must be enabled in Admin → Settings → Batch API.

### Raw SQL, PocketBase-flavoured

The same database the oxmysql exports use, with `{:name}` placeholders and no
MySQL translation:

```lua
local rows  = exports.tDB:sqlQuery('SELECT p.name, COUNT(o.id) AS n FROM players p LEFT JOIN orders o ON o.player = p.id GROUP BY p.id')
local row   = exports.tDB:sqlSingle('SELECT * FROM players WHERE id = {:id}', { id = 1 })
local total = exports.tDB:sqlScalar('SELECT COUNT(*) FROM players')
local newId = exports.tDB:sqlExecute('INSERT INTO logs (msg) VALUES ({:m})', { m = 'hello' })

exports.tDB:sqlTransaction({
    { sql = 'UPDATE accounts SET balance = balance - {:n} WHERE id = {:a}', params = { n = 100, a = 'a' } },
    { sql = 'UPDATE accounts SET balance = balance + {:n} WHERE id = {:b}', params = { n = 100, b = 'b' } },
})
```

Result shapes are discovered from the database, so `SELECT *` returns the table's
real columns, integers arrive as numbers, and `NULL` arrives as `nil` rather
than an empty string.

### Users, files, mail

```lua
local result  = exports.tDB:authWithPassword('users', email, password)
exports.tDB:requestPasswordReset('users', email)
exports.tDB:confirmPasswordReset('users', token, new, newConfirm)
exports.tDB:requestVerification('users', email)
exports.tDB:authWithOAuth2Code('users', 'google', code, verifier, redirect)

local url   = exports.tDB:getFileUrl(record, 'avatar.png')
local token = exports.tDB:getFileToken()

exports.tDB:sendEmail('user@example.com', 'Welcome', '<h1>Hi</h1>', 'Hi')
```

### Admin UI

Off by default; scripts do not need it. To reach it:

```lua
Config.ExposeAdmin = true
Config.Host = ""    -- auto-detect, or set a domain
```

Then open `http://<host>:8090/_/` and sign in with `Config.Superuser`. Opening
the port to the internet means opening it in the firewall too — put it behind a
reverse proxy or a tunnel if you can.

---

## Troubleshooting

**"Only superusers can perform this action", repeating in the console.**
Fixed. PocketBase superuser tokens last a day; the old code authenticated once
at startup and never replaced the token, so a server left up longer than that
spammed until it was restarted. tDB now refreshes ahead of expiry — on a
schedule read from the token itself, so a lifetime you change in the admin UI
is honoured — and recovers from a rejection automatically. If you still see it,
the credentials in `config.lua` no longer match the database; delete them and
restart to have them reprovisioned.

**The PocketBase setup screen opened in my browser.**
It should never appear. tDB provisions the superuser before PocketBase serves,
and repairs it in place if it goes missing. If you see the installer, the
resource is not the one that started that instance — check for a second
PocketBase already bound to the port.

**"Unhandled promise rejection … Invalid state: Reader released".**
Fixed. FiveM's Node runtime (v26.3.0) leaks one unhandled rejection for every
`fetch()` that carries a request body, and every query tDB serves is a POST
with a body — so this appeared once at startup and would have appeared once per
query under load. tDB now sends over `node:http` instead. If you still see it,
it is coming from a different resource, not this one.

**"Batch requests are not allowed".**
Enable the batch API in Admin → Settings.

**An error naming a SQL construct.**
That statement has no faithful SQLite translation and was refused rather than
silently changed. Rewrite it, or open an issue with the statement.

**Nothing is reachable from outside.**
Only affects the admin UI. Script access is local and unaffected.

---

## Credits and licence

Bundles the Windows and Linux AMD64 [PocketBase](https://github.com/pocketbase/pocketbase/releases)
binaries (0.40.3, MIT, by Gani Georgiev), and the Polyglot SQL transpiler
(`@polyglot-sql/sdk`, MIT, by TobiLG) as WebAssembly in `bin/polyglot/`.

- PocketBase docs — https://pocketbase.io/docs/
- PocketBase JS SDK — https://github.com/pocketbase/js-sdk

See `LICENSE.md`.
