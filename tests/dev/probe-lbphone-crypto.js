/**
 * Reproduce lb-phone's crypto price update, which fails on a live server with
 * nothing but "Something went wrong."
 *
 *   @lb-phone/server/apps/other/crypto.lua:534
 *   MySQL.prepare.await(
 *     "INSERT INTO phone_crypto_coins (coin, coin_value) VALUES (?, ?) " ..
 *     "ON DUPLICATE KEY UPDATE coin_value = VALUES(coin_value)",
 *     { {coin, value}, {coin, value}, ... })
 *
 * Two things are under test and they are easy to conflate:
 *   - the statement, which uses MySQL's VALUES(col) to mean "the value this row
 *     tried to insert", and
 *   - the CALL, which is `prepare` with a nested array: one parameter set per
 *     coin, which goes down the batch path rather than the ordinary one.
 *
 * Dev harness, not part of the suite. Run from the resource root:
 *   node tests/dev/probe-lbphone-crypto.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux"
);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-crypto-"));
const HOOKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-cryptohooks-"));
const PORT = 8213;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "crypto@example.com";
const PASSWORD = "crypto-password-123";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${URL_BASE}/api/health`)).ok) return true;
    } catch (_) {}
    await sleep(200);
  }
  return false;
}

async function main() {
  for (const file of fs.readdirSync(path.join(ROOT, "pb_hooks"))) {
    fs.copyFileSync(path.join(ROOT, "pb_hooks", file), path.join(HOOKS_DIR, file));
  }

  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", DATA_DIR], {
    encoding: "utf8",
  });

  const server = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      DATA_DIR,
      "--hooksDir",
      HOOKS_DIR,
      "--migrationsDir",
      path.join(DATA_DIR, "migrations"),
    ],
    { stdio: "ignore" }
  );

  try {
    if (!(await waitForHealth())) throw new Error("server never became healthy");

    const pb = new PocketBase(URL_BASE);
    pb.autoCancellation(false);
    await pb.collection("_superusers").authWithPassword(EMAIL, PASSWORD, { requestKey: null });

    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const adapter = new OxMySQLAdapter(pb, (fn) => fn, quiet);
    const call = (name, ...args) => adapter.handle(name, args);

    // lb-phone's own definition, sql/01-lb-phone.sql:783.
    await call(
      "update",
      "CREATE TABLE IF NOT EXISTS `phone_crypto_coins` (" +
        "`coin` VARCHAR(15) NOT NULL, " +
        "`coin_value` DOUBLE UNSIGNED NOT NULL DEFAULT 0, " +
        "PRIMARY KEY (`coin`)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    );

    const STATEMENT =
      "INSERT INTO phone_crypto_coins (coin, coin_value) VALUES (?, ?) " +
      "ON DUPLICATE KEY UPDATE coin_value = VALUES(coin_value)";

    const show = async (label, fn) => {
      try {
        const value = await fn();
        console.log(`  OK    ${label} -> ${JSON.stringify(value)}`);
      } catch (error) {
        console.log(`  FAIL  ${label}`);
        console.log(`        message : ${error.message}`);
        console.log(`        status  : ${error.status}`);
        console.log(`        response: ${JSON.stringify(error.response)}`);
      }
    };

    console.log("\n=== one set, the ordinary shape");
    await show("prepare with a single pair", () => call("prepare", STATEMENT, ["btc", 100]));

    console.log("\n=== a batch, which is what crypto.lua sends");
    await show("prepare with nested arrays", () =>
      call("prepare", STATEMENT, [
        ["btc", 101],
        ["eth", 52],
        ["doge", 1],
      ])
    );

    console.log("\n=== again, so the ON DUPLICATE half runs");
    await show("prepare with nested arrays, second time", () =>
      call("prepare", STATEMENT, [
        ["btc", 999],
        ["eth", 888],
      ])
    );

    console.log("\n=== a statement that really fails, to see the message");
    await show("insert into a table that does not exist", () =>
      call("insert", "INSERT INTO phone_not_a_table (a) VALUES (?)", [1])
    );

    console.log("\n=== what landed");
    await show("rows", () => call("query", "SELECT coin, coin_value FROM phone_crypto_coins", []));

    console.log("\nData dir:", DATA_DIR);
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error("PROBE ERROR:", e);
  process.exit(1);
});
