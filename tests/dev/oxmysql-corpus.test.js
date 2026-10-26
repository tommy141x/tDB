/**
 * Real SQL from real resources, through the translator.
 *
 * `fixtures/oxmysql-corpus.json` holds statements harvested from the
 * open-source resources people actually run on oxmysql: esx_core, qbx_core,
 * ox_inventory, ox_doorlock, qb-core, qb-banking, qb-garages, qb-phone,
 * qbx_vehicles, qbx_management, qbx_garages.
 *
 * This exists because every dialect gap so far was found by an outage. One
 * resource (night_shifts) hit five in sequence and took the server down, and it
 * has since been retired, so the live reproducer is gone. A corpus is the only
 * way to find the rest before an operator does.
 *
 * The bar is NOT "everything translates". Some constructs genuinely have no
 * SQLite form and are refused by name on purpose. The bar is:
 *   - nothing silently produces wrong SQL,
 *   - the pass rate does not regress,
 *   - every refusal names a construct, so it is actionable.
 *
 * Run from the resource root: node tests/dev/oxmysql-corpus.test.js
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = require("./fivem-require.js");

const translator = require(path.join(ROOT, "server/utils/sql-translator.js"));
const conditionalDdl = require(path.join(ROOT, "server/utils/conditional-ddl.js"));
const triggerRewrite = require(path.join(ROOT, "server/utils/trigger-rewrite.js"));
const sqlImport = require(path.join(ROOT, "server/utils/sql-import.js"));

// Two waves, harvested separately so the second could target constructs the
// first did not reach: wave 1 is the big frameworks, wave 2 is 45 further
// resources. Both load together, and a missing file is skipped rather than
// failing so the suite still runs on a checkout without the fixtures.
const CORPORA = [
  path.join(ROOT, "tests/dev/fixtures/oxmysql-corpus.json"),
  path.join(ROOT, "tests/dev/fixtures/oxmysql-corpus-2.json"),
];

// Raise only when the real rate improves; a drop means a regression.
//
// Measured over verbatim statements only, and this harness sees the TRANSLATOR
// alone. Three things the production pipeline also does are not counted here,
// so the figure it reports is a floor, not the compatibility number:
//
//   * sql-import drops mysqldump's session preamble before translating.
//   * conditional-ddl.js interprets the SET/PREPARE/EXECUTE and
//     CREATE PROCEDURE/CALL dance by evaluating its conditions live.
//   * trigger-rewrite.js is retried for a CREATE TRIGGER the ordinary path
//     refuses.
//
// What remains at this threshold is not translator failure: the two entries
// still refused are not valid MySQL either - an ALTER with a duplicated comma,
// and a bare WHERE fragment the harvester captured mid-statement - and both are
// now refused BY NAME rather than as a parse error pointing at a token.
const MIN_TRANSLATED = 0.91;

// The whole pipeline, which is what a real .sql file meets: the importer's
// session-noise filter, then the translator, then conditional-ddl.js for the
// SET/PREPARE and CREATE PROCEDURE dance, then trigger-rewrite.js retried for a
// CREATE TRIGGER the ordinary path refuses.
//
// This is the compatibility figure. MIN_TRANSLATED above is kept as a separate
// floor so a translator regression cannot hide behind a later stage absorbing
// it.
const MIN_PIPELINE = 0.99;

// Failures that are the corpus's own, not the translator's. Any NEW one pushes
// these over and fails the suite, which is the point.
//
// Zero unnamed, deliberately. A refusal that names nothing tells an operator
// which token upset the parser rather than what to change in the file, and the
// last two - a duplicated comma and a bare WHERE - are now named in
// MALFORMED_STATEMENTS. If this has to be raised again, name the construct
// instead.
const MAX_UNNAMED = 0;
const MAX_INVALID = 3;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
    return;
  }
  fail++;
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log(`        ${detail}`);
}

// A placeholder count the translator will accept: it now matches oxmysql and
// throws when given more parameters than the statement has.
function paramsFor(sql) {
  const mask = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const positional = (mask.match(/\?(?!\?)/g) || []).length;
  if (positional) return new Array(positional).fill("x");

  const named = new Set();
  for (const m of mask.matchAll(/[:@]([A-Za-z_][A-Za-z0-9_]*)/g)) named.add(m[1]);
  if (named.size) {
    const out = {};
    for (const name of named) out[name] = "x";
    return out;
  }
  return [];
}

async function main() {
  const present = CORPORA.filter((f) => fs.existsSync(f));

  if (!present.length) {
    console.log("  SKIP  no corpus fixtures present");
    console.log("\n==== 0 passed, 0 failed ====");
    return;
  }

  await translator.init();

  const statements = [];
  const repos = new Set();
  for (const file of present) {
    const corpus = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const entry of corpus.statements || []) statements.push(entry);
    for (const source of corpus.sources || []) repos.add(source.repo);
  }

  console.log(
    `\n=== Corpus: ${statements.length} statement(s) from ${repos.size} repo(s), ${present.length} wave(s)`
  );

  const translated = [];
  const refused = [];
  const byConstruct = new Map();

  for (const entry of statements) {
    try {
      const out = translator.translate(entry.sql, paramsFor(entry.sql), {
        // Real schemas are not loaded here, so an upsert cannot resolve its
        // conflict target from the table. Supply one so ON DUPLICATE KEY is
        // exercised rather than refused for an unrelated reason.
        resolveConflictTarget: () => ["id"],
      });
      translated.push({ entry, sql: out.sql, rebuild: out.rebuild });
    } catch (error) {
      const construct = error.construct || "parse error";
      byConstruct.set(construct, (byConstruct.get(construct) || 0) + 1);
      refused.push({ entry, construct, message: error.message });
    }
  }

  // Rate is measured over VERBATIM statements only. A `normalised` entry had an
  // unresolvable Lua interpolation replaced with `?`, which can leave `?` as a
  // table or column name - that is not valid MySQL either, so counting it as a
  // translation failure would measure the harvester, not the translator.
  const verbatim = statements.filter((e) => !e.normalised);
  const verbatimTranslated = translated.filter((t) => !t.entry.normalised);
  const verbatimRefused = refused.filter((r) => !r.entry.normalised);
  const rate = verbatimTranslated.length / verbatim.length;

  console.log(
    `  all:      translated ${translated.length}/${statements.length}, refused ${refused.length}`
  );
  console.log(
    `  verbatim: translated ${verbatimTranslated.length}/${verbatim.length} ` +
      `(${(rate * 100).toFixed(1)}%), refused ${verbatimRefused.length}`
  );
  console.log(
    `  (${statements.length - verbatim.length} normalised entries excluded from the rate)`
  );

  console.log("\n=== Refusals by construct");
  for (const [construct, count] of [...byConstruct].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${construct}`);
  }

  // Every corpus statement that uses named placeholders, bound BOTH ways.
  //
  // paramsFor() above hands back bare keys, so the whole harness could stay
  // green while a prefixed key bound to NULL - which is exactly how that bug
  // reached a live server. oxmysql takes `{ x = 1 }` and `{ ['@x'] = 1 }`
  // alike, so the two have to produce identical bindings. The sweep is over the
  // corpus rather than one hand-written statement because placeholders are
  // paired with the rewritten SQL by POSITION, so a rewrite that reorders them
  // would still pass on a simple case.
  const namedMismatches = [];
  let namedSwept = 0;
  for (const entry of statements) {
    const bare = paramsFor(entry.sql);
    if (Array.isArray(bare) || !Object.keys(bare).length) continue;

    let reference;
    try {
      reference = translator.translate(entry.sql, bare, {
        resolveConflictTarget: () => ["id"],
      });
    } catch (_) {
      // Refused for an unrelated reason; nothing to compare against.
      continue;
    }

    for (const prefix of ["@", ":"]) {
      const supplied = {};
      for (const key of Object.keys(bare)) supplied[prefix + key] = bare[key];

      let got;
      try {
        got = translator.translate(entry.sql, supplied, {
          resolveConflictTarget: () => ["id"],
        });
      } catch (error) {
        namedMismatches.push(`${entry.repo}: the ${prefix} form threw: ${error.message}`);
        continue;
      }

      if (JSON.stringify(got.params) !== JSON.stringify(reference.params)) {
        namedMismatches.push(
          `${entry.repo}: the ${prefix} form bound ${JSON.stringify(got.params)}, ` +
            `the bare form bound ${JSON.stringify(reference.params)}`
        );
      }
    }
    namedSwept++;
  }

  console.log(`\n=== Named placeholders: ${namedSwept} statement(s) bound bare, @ and :`);

  const viaRebuild = translated.filter((t) => t.rebuild);
  console.log(`\n=== Table rebuilds: ${viaRebuild.length} ALTER(s) handed over as a descriptor`);

  // The pipeline pass, over the same verbatim statements.
  let pipelineHandled = 0;
  let pipelineSeen = 0;
  const pipelineRefused = new Map();

  for (const entry of verbatim) {
    // 1. The importer drops mysqldump's session preamble before translating.
    //    A `/*!NNNNN ... */` conditional never even reaches isSessionNoise:
    //    splitStatements strips it while splitting the file, because it is a
    //    COMMENT to any engine that is not MySQL. The harness is handed
    //    pre-split statements, so it has to drop them here instead.
    if (/^\s*\/\*!\d+/.test(entry.sql)) continue;
    if (sqlImport.isSessionNoise(entry.sql)) continue;
    pipelineSeen++;

    // 2. MySQL's conditional-DDL dance is interpreted, not translated: its
    //    conditions are evaluated against the live database at import time.
    if (conditionalDdl.claims(entry.sql)) {
      pipelineHandled++;
      continue;
    }

    try {
      translator.translate(entry.sql, paramsFor(entry.sql), {
        resolveConflictTarget: () => ["id"],
        // At import time every table is one the dump itself created, so its
        // live column order IS the order a positional INSERT means.
        resolveColumnOrder: () => ["c1", "c2", "c3"],
      });
      pipelineHandled++;
      continue;
    } catch (error) {
      // 3. A CREATE TRIGGER gets a second pass through the rewriter.
      if (/CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\b/i.test(entry.sql)) {
        try {
          const rewritten = triggerRewrite.rewrite(
            entry.sql,
            (piece) => translator.translate(piece, {}, { resolveConflictTarget: () => ["id"] }).sql
          );
          if (rewritten.handled) {
            pipelineHandled++;
            continue;
          }
        } catch (_) {
          // Fall through to the refusal below.
        }
      }

      const construct = error.construct || "parse error";
      pipelineRefused.set(construct, (pipelineRefused.get(construct) || 0) + 1);
    }
  }

  const pipelineRate = pipelineHandled / pipelineSeen;

  console.log(
    `\n=== Pipeline: ${pipelineHandled}/${pipelineSeen} (${(pipelineRate * 100).toFixed(1)}%), ` +
      `refused ${pipelineSeen - pipelineHandled}`
  );
  for (const [construct, count] of [...pipelineRefused].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${construct}`);
  }

  console.log("\n=== Assertions");

  ok(
    pipelineRate >= MIN_PIPELINE,
    `at least ${(MIN_PIPELINE * 100).toFixed(0)}% of real-world SQL survives the whole pipeline`,
    `rate was ${(pipelineRate * 100).toFixed(1)}%`
  );

  // The untranslated original must never be mistaken for runnable SQL.
  ok(
    viaRebuild.every((t) => /^\s*ALTER\s+TABLE/i.test(t.sql)),
    "a rebuild descriptor leaves `sql` as the original ALTER, for the executor to replace",
    JSON.stringify(viaRebuild.slice(0, 2).map((t) => t.sql))
  );

  ok(
    namedMismatches.length === 0,
    "a named parameter keyed with its @ or : prefix binds exactly as the bare name does",
    namedMismatches.slice(0, 8).join(`\n        `)
  );

  ok(
    rate >= MIN_TRANSLATED,
    `at least ${(MIN_TRANSLATED * 100).toFixed(0)}% of real-world SQL translates`,
    `rate was ${(rate * 100).toFixed(1)}%`
  );

  const unnamed = verbatimRefused.filter((r) => r.construct === "parse error");
  ok(
    unnamed.length <= MAX_UNNAMED,
    `at most ${MAX_UNNAMED} refusals go unnamed, and those are invalid SQL as shipped`,
    unnamed.length
      ? `${unnamed.length} unnamed:\n        ` +
          unnamed
            .slice(0, 6)
            .map((r) => `${r.entry.repo}: ${r.entry.sql.replace(/\s+/g, " ").slice(0, 90)}`)
            .join("\n        ")
      : undefined
  );

  // Anything that did translate has to be SQL a real engine accepts: a bad
  // translation reaches the database before it fails, where a refusal never
  // leaves the translator.
  const db = new DatabaseSync(":memory:");
  const rejected = [];
  for (const item of verbatimTranslated) {
    // An ALTER that needs the table rebuilt reports a DESCRIPTOR, and its `sql`
    // is deliberately the untranslated original - the executor plans the
    // rebuild from the live schema and never runs that text. Preparing it here
    // would report `near "MODIFY": syntax error` for a statement that is fully
    // supported, which is what it did before this check existed.
    if (item.rebuild) continue;
    const prepared = item.sql.replace(/\{:(\w+)\}/g, ":$1");
    try {
      db.prepare(prepared);
    } catch (error) {
      // "no such table/column" is expected: the corpus has no schema loaded.
      // Only a syntax-level complaint means the translation itself is bad.
      if (
        /no such (table|column|function|index|trigger|view|collation)|unknown/i.test(error.message)
      )
        continue;
      rejected.push({ entry: item.entry, message: error.message, sql: prepared });
    }
  }

  ok(
    rejected.length <= MAX_INVALID,
    `at most ${MAX_INVALID} translations are invalid SQLite, and those are corpus fragments`,
    rejected.length
      ? `${rejected.length} rejected:\n        ` +
          rejected
            .slice(0, 8)
            .map(
              (r) =>
                `${r.message.slice(0, 70)}\n          <- ${r.sql.replace(/\s+/g, " ").slice(0, 100)}`
            )
            .join("\n        ")
      : undefined
  );

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  // A regex escape written through a shell or Python layer can arrive as the
  // literal control character it names: `\b` as 0x08 instead of a word
  // boundary. The pattern then silently matches nothing, which looks exactly
  // like a rule that was never reached. That happened four separate times
  // while building this translator, so it is checked rather than remembered.
  const guarded = [
    "server/utils/sql-translator.js",
    "server/utils/pb-adopt.js",
    "server/utils/trigger-rewrite.js",
  ];
  const withControls = [];
  for (const rel of guarded) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const found = [...text].filter((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    });
    if (found.length) {
      withControls.push(
        `${rel}: ${found.length} control char(s), first 0x${found[0].charCodeAt(0).toString(16)}`
      );
    }
  }
  ok(
    withControls.length === 0,
    "no stray control characters in the translator sources",
    withControls.join("; ")
  );

  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
