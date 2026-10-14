/**
 * Runs every standalone test under tests/dev.
 *
 * These are not bun:test files -- each one is a plain script that throws on
 * failure and exits 0 on success, so `bun test` does not discover them. That
 * predates this runner and is not worth converting: the suites assert against
 * a real SQLite engine and a real PocketBase process, and they are readable as
 * scripts. What they lacked was a single entry point, so `bun run test` now
 * means the same thing here as it does in every sibling resource.
 *
 * Each file gets its own process, because they install globals (the FiveM
 * `require` shim in particular) that would leak between suites in one.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "tests", "dev");

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (files.length === 0) {
  console.error("No .test.js files found in tests/dev -- refusing to report success.");
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, [join(DIR, file)], {
    stdio: "inherit",
    cwd: join(import.meta.dir, ".."),
  });
  const ok = result.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${file}`);
}

console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
