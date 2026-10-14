/**
 * Rewriting MySQL trigger bodies into SQLite, checked by behaviour.
 *
 * A trigger that parses is not a trigger that is correct: these maintain
 * counters, so every case below applies the generated SQL to a real SQLite
 * engine, exercises it with rows, and asserts the counter lands where MySQL
 * would have put it. Shapes it does not claim to understand must come back
 * handled: false, because refusing is cheap and a silently wrong counter is
 * permanent.
 *
 * Run from the resource root: node tests/dev/trigger-rewrite.test.js
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = require("./fivem-require.js");

const translator = require(path.join(ROOT, "server/utils/sql-translator.js"));
const triggerRewrite = require(path.join(ROOT, "server/utils/trigger-rewrite.js"));

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

const section = (n) => console.log(`\n=== ${n}`);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ig_posts (id INTEGER PRIMARY KEY, like_count INTEGER DEFAULT 0);
    CREATE TABLE ig_comments (id INTEGER PRIMARY KEY, like_count INTEGER DEFAULT 0);
    CREATE TABLE ig_likes (id INTEGER, is_comment INTEGER);
    CREATE TABLE tk_accounts (username TEXT PRIMARY KEY, like_count INTEGER DEFAULT 0);
    CREATE TABLE tk_videos (id INTEGER PRIMARY KEY, username TEXT, comments INTEGER DEFAULT 0);
    CREATE TABLE tk_likes (video_id INTEGER);
    CREATE TABLE tk_comments (id INTEGER PRIMARY KEY, reply_to INTEGER, video_id INTEGER);
    INSERT INTO ig_posts (id) VALUES (1);
    INSERT INTO ig_comments (id) VALUES (1);
    INSERT INTO tk_accounts VALUES ('ada', 0);
    INSERT INTO tk_videos VALUES (7, 'ada', 10);
    INSERT INTO tk_comments VALUES (100, NULL, 7), (101, 100, 7), (102, 100, 7);
  `);
  return db;
}

const translateStatement = (piece) => translator.translate(piece, {}).sql;
const scalar = (db, sql) => Object.values(db.prepare(sql).get())[0];

// Applies a rewritten trigger to real SQLite, runs `act`, and reports the value.
function behaves(label, mysql, act, expected, read) {
  const result = triggerRewrite.rewrite(mysql, translateStatement);

  if (!result.handled) {
    ok(false, label, "rewrite returned handled: false");
    return;
  }

  const db = freshDb();
  try {
    for (const statement of result.statements) db.exec(statement);
  } catch (e) {
    ok(false, label, `SQLite rejected the rewrite: ${e.message}\n      ${result.statements[0]}`);
    return;
  }

  try {
    db.exec(act);
  } catch (e) {
    ok(false, label, `the trigger errored when it fired: ${e.message}`);
    return;
  }

  const got = read(db);
  ok(
    got === expected,
    `${label} (${result.shapes.join(" + ")})`,
    `expected ${expected}, got ${got}`
  );
}

async function main() {
  await translator.init();

  section("Shape A: IF/ELSE becomes two WHEN triggers");

  behaves(
    "the THEN branch fires for a matching row",
    `CREATE TRIGGER t_a AFTER INSERT ON ig_likes FOR EACH ROW
     BEGIN
       IF NEW.is_comment = 0 THEN
         UPDATE ig_posts SET like_count = like_count + 1 WHERE id = NEW.id;
       ELSE
         UPDATE ig_comments SET like_count = like_count + 1 WHERE id = NEW.id;
       END IF;
     END`,
    "INSERT INTO ig_likes VALUES (1, 0);",
    "1/0",
    (db) =>
      `${scalar(db, "SELECT like_count FROM ig_posts")}/${scalar(db, "SELECT like_count FROM ig_comments")}`
  );

  behaves(
    "the ELSE branch fires for the other case",
    `CREATE TRIGGER t_a2 AFTER INSERT ON ig_likes FOR EACH ROW
     BEGIN
       IF NEW.is_comment = 0 THEN
         UPDATE ig_posts SET like_count = like_count + 1 WHERE id = NEW.id;
       ELSE
         UPDATE ig_comments SET like_count = like_count + 1 WHERE id = NEW.id;
       END IF;
     END`,
    "INSERT INTO ig_likes VALUES (1, 1);",
    "0/1",
    (db) =>
      `${scalar(db, "SELECT like_count FROM ig_posts")}/${scalar(db, "SELECT like_count FROM ig_comments")}`
  );

  behaves(
    "exactly one branch fires per row, never both",
    `CREATE TRIGGER t_a3 AFTER INSERT ON ig_likes FOR EACH ROW
     BEGIN
       IF NEW.is_comment = 0 THEN
         UPDATE ig_posts SET like_count = like_count + 1 WHERE id = NEW.id;
       ELSE
         UPDATE ig_posts SET like_count = like_count + 10 WHERE id = NEW.id;
       END IF;
     END`,
    "INSERT INTO ig_likes VALUES (1, 0); INSERT INTO ig_likes VALUES (1, 1);",
    11,
    (db) => scalar(db, "SELECT like_count FROM ig_posts")
  );

  section("Shape C: UPDATE ... JOIN becomes UPDATE ... FROM");

  behaves(
    "the joined row is found and the counter moves",
    `CREATE TRIGGER t_c AFTER INSERT ON tk_likes FOR EACH ROW
     BEGIN
       UPDATE tk_accounts
       JOIN tk_videos ON tk_videos.username = tk_accounts.username
       SET tk_accounts.like_count = tk_accounts.like_count + 1
       WHERE tk_videos.id = NEW.video_id;
     END`,
    "INSERT INTO tk_likes VALUES (7);",
    1,
    (db) => scalar(db, "SELECT like_count FROM tk_accounts")
  );

  behaves(
    "a row that joins nothing changes nothing",
    `CREATE TRIGGER t_c2 AFTER INSERT ON tk_likes FOR EACH ROW
     BEGIN
       UPDATE tk_accounts
       JOIN tk_videos ON tk_videos.username = tk_accounts.username
       SET tk_accounts.like_count = tk_accounts.like_count + 1
       WHERE tk_videos.id = NEW.video_id;
     END`,
    "INSERT INTO tk_likes VALUES (999);",
    0,
    (db) => scalar(db, "SELECT like_count FROM tk_accounts")
  );

  section("Shape B: DECLARE becomes a correlated subquery");

  behaves(
    "the subquery is evaluated, not left as a bare name",
    `CREATE TRIGGER t_b BEFORE DELETE ON tk_comments FOR EACH ROW
     BEGIN
       DECLARE v_replies_count INT;
       SELECT COUNT(*) INTO v_replies_count FROM tk_comments WHERE reply_to = OLD.id;
       UPDATE tk_videos SET comments = comments - (1 + v_replies_count) WHERE id = OLD.video_id;
     END`,
    "DELETE FROM tk_comments WHERE id = 100;",
    7,
    (db) => scalar(db, "SELECT comments FROM tk_videos")
  );

  behaves(
    "a comment with no replies subtracts only itself",
    `CREATE TRIGGER t_b2 BEFORE DELETE ON tk_comments FOR EACH ROW
     BEGIN
       DECLARE v_replies_count INT;
       SELECT COUNT(*) INTO v_replies_count FROM tk_comments WHERE reply_to = OLD.id;
       UPDATE tk_videos SET comments = comments - (1 + v_replies_count) WHERE id = OLD.video_id;
     END`,
    "DELETE FROM tk_comments WHERE id = 101;",
    9,
    (db) => scalar(db, "SELECT comments FROM tk_videos")
  );

  section("Shapes it must refuse rather than guess");

  function refuses(label, mysql) {
    const r = triggerRewrite.rewrite(mysql, translateStatement);
    ok(!r.handled, label, r.handled ? `rewrote it as: ${r.statements[0]}` : undefined);
  }

  // The real lb-phone trigger this does not handle: the variable is assigned by
  // SET inside an IF/ELSEIF chain, which is a CASE expression, not a subquery.
  refuses(
    "DECLARE assigned by SET in an IF/ELSEIF chain",
    `CREATE TRIGGER t_r1 AFTER INSERT ON tk_comments FOR EACH ROW
     BEGIN
       DECLARE modified TEXT;
       IF NEW.reply_to IS NULL THEN
         SET modified = 'a';
       ELSEIF NEW.id > 50 THEN
         SET modified = 'b';
       ELSE
         SET modified = 'c';
       END IF;
       UPDATE tk_videos SET comments = comments WHERE id = NEW.video_id;
     END`
  );

  refuses(
    "two DECLAREs",
    `CREATE TRIGGER t_r2 BEFORE DELETE ON tk_comments FOR EACH ROW
     BEGIN
       DECLARE a INT;
       DECLARE b INT;
       SELECT COUNT(*) INTO a FROM tk_comments WHERE reply_to = OLD.id;
       UPDATE tk_videos SET comments = comments - a WHERE id = OLD.video_id;
     END`
  );

  refuses(
    "a DECLARE that is reassigned",
    `CREATE TRIGGER t_r3 BEFORE DELETE ON tk_comments FOR EACH ROW
     BEGIN
       DECLARE a INT;
       SELECT COUNT(*) INTO a FROM tk_comments WHERE reply_to = OLD.id;
       SET a = a + 1;
       UPDATE tk_videos SET comments = comments - a WHERE id = OLD.video_id;
     END`
  );

  refuses(
    "a nested IF",
    `CREATE TRIGGER t_r4 AFTER INSERT ON ig_likes FOR EACH ROW
     BEGIN
       IF NEW.is_comment = 0 THEN
         IF NEW.id > 1 THEN
           UPDATE ig_posts SET like_count = like_count + 1 WHERE id = NEW.id;
         END IF;
       ELSE
         UPDATE ig_comments SET like_count = like_count + 1 WHERE id = NEW.id;
       END IF;
     END`
  );

  refuses(
    "an UPDATE with two JOINs",
    `CREATE TRIGGER t_r5 AFTER INSERT ON tk_likes FOR EACH ROW
     BEGIN
       UPDATE tk_accounts
       JOIN tk_videos ON tk_videos.username = tk_accounts.username
       JOIN tk_comments ON tk_comments.video_id = tk_videos.id
       SET tk_accounts.like_count = tk_accounts.like_count + 1
       WHERE tk_videos.id = NEW.video_id;
     END`
  );

  refuses("something that is not a trigger at all", "SELECT 1");

  section("IF NOT EXISTS survives, and both halves get distinct names");

  const split = triggerRewrite.rewrite(
    `CREATE TRIGGER IF NOT EXISTS t_named AFTER INSERT ON ig_likes FOR EACH ROW
     BEGIN
       IF NEW.is_comment = 0 THEN
         UPDATE ig_posts SET like_count = like_count + 1 WHERE id = NEW.id;
       ELSE
         UPDATE ig_comments SET like_count = like_count + 1 WHERE id = NEW.id;
       END IF;
     END`,
    translateStatement
  );

  ok(split.handled && split.statements.length === 2, "an IF/ELSE yields two triggers");
  ok(
    split.statements.every((s) => /CREATE TRIGGER IF NOT EXISTS/i.test(s)),
    "both keep IF NOT EXISTS, so a re-import stays idempotent"
  );
  ok(
    split.statements[0].includes('"t_named"') && split.statements[1].includes('"t_named_else"'),
    "the second is suffixed rather than colliding",
    split.statements.map((s) => s.slice(0, 60)).join(" | ")
  );

  const db = freshDb();
  for (const s of split.statements) db.exec(s);
  db.exec("INSERT INTO ig_likes VALUES (1, 0);");
  for (const s of split.statements) {
    // Re-applying must not throw, which is what IF NOT EXISTS is for.
    db.exec(s);
  }
  ok(
    scalar(db, "SELECT like_count FROM ig_posts") === 1,
    "re-applying does not double-fire",
    String(scalar(db, "SELECT like_count FROM ig_posts"))
  );

  section("Shape D: IF with no ELSE, and SIGNAL as RAISE(ABORT)");

  // A capacity-check trigger from a community resource, verbatim. It combines
  // three things nothing else in this suite does together: a DECLARE read ONLY
  // by the condition, an IF with no ELSE, and SIGNAL SQLSTATE as the body.
  //
  // SQLite's RAISE(ABORT, '<msg>') inside a trigger is a direct equivalent of
  // SIGNAL: it aborts the statement with that text. The SQLSTATE has no
  // counterpart and is dropped, because nothing here can read it back.
  //
  // Note the body ends `END$$` - a DELIMITER block's terminator. The header
  // pattern accepted only `END;`, so this was rejected before any shape was
  // tried.
  const capacityTrigger = `CREATE TRIGGER \`trg_vslot_capacity_ins\`
BEFORE INSERT ON \`cm_house_vehicle_slots\`
FOR EACH ROW
BEGIN
    DECLARE cap INT DEFAULT 0;
    SELECT IFNULL(g.capacity, 0) INTO cap
    FROM cm_houses h
    LEFT JOIN cm_house_garage_templates g ON g.id = h.garage_template_id
    WHERE h.id = NEW.house_id;

    IF NEW.slot_index < 1 OR NEW.slot_index > cap THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'slot_index exceeds the garage template capacity';
    END IF;
END$$`;

  const capacity = triggerRewrite.rewrite(capacityTrigger, translateStatement);
  ok(capacity.handled === true, "the trigger is rewritten", JSON.stringify(capacity.shapes));
  ok(
    capacity.handled &&
      ["IF/THEN", "DECLARE", "SIGNAL"].every((shape) => capacity.shapes.includes(shape)),
    "and it takes all three shapes at once",
    JSON.stringify(capacity.shapes)
  );
  ok(
    capacity.handled && capacity.statements.length === 1,
    "one trigger out, because there is no ELSE branch to split",
    capacity.handled ? String(capacity.statements.length) : ""
  );
  ok(
    capacity.handled && /WHEN[\s\S]*\(SELECT IFNULL/i.test(capacity.statements[0]),
    "the DECLARE became a subquery inside the WHEN guard, not a dropped statement",
    capacity.handled ? capacity.statements[0] : ""
  );
  ok(
    capacity.handled &&
      /RAISE\(ABORT, 'slot_index exceeds the garage template capacity'\)/.test(
        capacity.statements[0]
      ),
    "and SIGNAL became RAISE(ABORT) with the message verbatim",
    capacity.handled ? capacity.statements[0] : ""
  );

  // Executed, because a guard that never fires would pass every check above.
  {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE cm_house_garage_templates (id INTEGER PRIMARY KEY, capacity INT)");
    db.exec("CREATE TABLE cm_houses (id INTEGER PRIMARY KEY, garage_template_id INT)");
    db.exec(
      "CREATE TABLE cm_house_vehicle_slots (id INTEGER PRIMARY KEY, house_id INT, slot_index INT)"
    );
    db.exec("INSERT INTO cm_house_garage_templates VALUES (1, 2)");
    db.exec("INSERT INTO cm_houses VALUES (10, 1)");
    for (const statement of capacity.statements) db.exec(statement);

    const attempt = (slot) => {
      try {
        db.prepare("INSERT INTO cm_house_vehicle_slots (house_id, slot_index) VALUES (?, ?)").run(
          10,
          slot
        );
        return null;
      } catch (error) {
        return error.message;
      }
    };

    ok(attempt(1) === null, "a slot within capacity is accepted");
    ok(attempt(2) === null, "and so is the last one");
    const over = attempt(3);
    ok(
      over !== null && /slot_index exceeds the garage template capacity/.test(over),
      "a slot over capacity is rejected, with the resource's own message",
      String(over)
    );
    ok(attempt(0) !== null, "and so is a slot below 1, which is the other half of the condition");
    ok(
      db.prepare("SELECT COUNT(*) AS c FROM cm_house_vehicle_slots").get().c === 2,
      "only the accepted rows are stored"
    );
  }

  // A nested IF is still refused: an inner IF consumes the inner END IF, so the
  // outer block looks unterminated and guessing would mis-scope the guard.
  const nested = triggerRewrite.rewrite(
    `CREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW BEGIN
       IF NEW.x > 1 THEN IF NEW.y > 2 THEN UPDATE b SET c = 1; END IF; END IF;
     END`,
    translateStatement
  );
  ok(nested.handled === false, "a nested IF is refused rather than mis-scoped");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
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
