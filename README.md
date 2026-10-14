# tDB

A database resource for FiveM, and a drop-in replacement for oxmysql: the same
exports, the same return values, MySQL SQL translated to SQLite. Underneath it is
an embedded [PocketBase](https://pocketbase.io/) instance, which also gives you
collections, realtime subscriptions, file storage and an admin UI if you want
them. No MySQL server, no connection string, nothing to install alongside it.

```lua
-- Existing oxmysql code. Unchanged.
local row = exports.oxmysql:single_async('SELECT * FROM players WHERE citizenid = ?', { cid })
```

## Install

1. Install [tLib](https://github.com/tommy141x/tLib/releases) v1.0 or later. tDB
   requires it, and it must be `ensure`d first.
2. Drop the folder into `resources/` and keep the name `tDB`.
3. `ensure tDB` in `server.cfg`, before any resource that queries the database.
4. Remove `oxmysql` from `server.cfg`. tDB publishes every oxmysql export under
   the `oxmysql`, `mysql-async` and `ghmattimysql` names, so `exports.oxmysql:...`
   calls resolve to it with no script edits.
5. Start the server.

On first start tDB creates `config.lua` from the committed `config.example.lua`,
then provisions PocketBase itself: it creates the superuser, writes the
credentials into `config.lua`, and authenticates. The PocketBase web installer
never appears. The generated password is printed once, on that run only.

`config.lua` is gitignored — it holds that password in plain text. Edit it;
`config.example.lua` is the template and is overwritten by updates.

Full instructions, including the one case `provide` cannot cover, are in
[Installation](https://timmygstudios.com/docs/tDB/installation).

## Documentation

- [Installation](https://timmygstudios.com/docs/tDB/installation)
- [Configuration](https://timmygstudios.com/docs/tDB/configuration)
- [MySQL compatibility](https://timmygstudios.com/docs/tDB/mysql-compatibility)
- [Importing `.sql` files](https://timmygstudios.com/docs/tDB/sql-imports)
- [Beyond SQL](https://timmygstudios.com/docs/tDB/pocketbase)
- [API reference](https://timmygstudios.com/docs/tDB/api-reference)
- [Troubleshooting](https://timmygstudios.com/docs/tDB/troubleshooting)

## Working from a git clone

A release download already contains the PocketBase binary. A source checkout does
not, so fetch it once:

```bash
bun scripts/fetch-runtime.ts          # this platform
bun scripts/fetch-runtime.ts --all    # both, for building a release
```

It downloads the pinned version into `.runtime/` and verifies it against
PocketBase's published checksums, failing rather than warning on a mismatch.

```bash
bun run test          # the JS suites
bun run docs:check    # validate docs/content
bun run verify        # lint, test, docs
```

## Credits and licence

Bundles the Windows and Linux AMD64 [PocketBase](https://github.com/pocketbase/pocketbase/releases)
binaries (0.40.4, MIT, by Gani Georgiev), and the Polyglot SQL transpiler
(`@polyglot-sql/sdk`, MIT, by TobiLG) as WebAssembly in `server/vendor/polyglot/`.

- PocketBase docs: https://pocketbase.io/docs/
- PocketBase JS SDK: https://github.com/pocketbase/js-sdk

See `LICENSE.md`.
