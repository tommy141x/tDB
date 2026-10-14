# Drop `.sql` files here

A script that ships a `.sql` file normally expects you to load it into MySQL by
hand. Put it in this folder instead. tDB applies it on startup, before any other
resource can query.

```
sql/
  01-qb-core.sql
  02-qb-inventory.sql
  03-my-shop.sql
```

Files run in filename order, so number them if one depends on another. Numbering
is only needed when order matters.

## What to expect

- **A file runs once, ever.** Applying a dump twice duplicates every row its
  `INSERT`s carry, so tDB records what has run in the `tdb_sql_imports` table
  and skips it afterwards.
- **A file lands whole or not at all.** Every statement goes out in one
  transaction. A dump that fails halfway leaves nothing behind.
- **A failure does not stop the server.** tDB reports the file, the line and the
  statement, then starts anyway, and tries again on the next restart.
- **mysqldump session noise is ignored.** `SET NAMES`, `LOCK TABLES`,
  `/*!40000 ALTER TABLE ... DISABLE KEYS */` and friends mean nothing here.

## Changing a file after it has run

tDB notices and tells you, but will not re-run it on its own; replaying a dump
replays its `INSERT`s. When you do want that:

```
tdb sql import 01-qb-core.sql --force
```

## Commands

```
tdb sql status                      what has run, what is pending, what changed
tdb sql import <file>               apply one file now
tdb sql import <file> --force       apply it again
```

Configure the folder and the drift behaviour under `Config.Sql` in `config.lua`.
