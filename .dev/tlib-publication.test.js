/**
 * The admin-UI publication state machine.
 *
 * Pure logic, no server: every FiveM global is injected into createPublisher,
 * which is why it was written that way. What is being pinned down here is the
 * set of behaviours that were wrong before:
 *
 *   - a mount that is merely PENDING was reported to the operator as refused
 *   - a mount that went away was still advertised as live
 *   - the health probe guessed a port instead of using tLib's listener address
 *
 * Dev harness. Run from the resource root: node .dev/tlib-publication.test.js
 */
const path = require("path");

const ROOT = require("./fivem-require.js");
const pub = require(path.join(ROOT, "utils/tlib-publication.js"));

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
  failures.push(`${label}${detail ? `\n      ${detail}` : ""}`);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

function section(name) {
  console.log(`\n=== ${name}`);
}

const READY = {
  ready: true,
  listenerState: "listening",
  publicUrlState: "ready",
  publicUrl: "https://play.example.com",
  localUrl: "http://127.0.0.1:30120",
  error: null,
};

const STARTING = {
  ready: false,
  listenerState: "starting",
  publicUrlState: "resolving",
  publicUrl: null,
  localUrl: null,
  error: null,
};

/** A publisher plus a record of everything it did to the outside world. */
function harness(registerResults) {
  const events = [];
  const results = Array.isArray(registerResults) ? [...registerResults] : [registerResults];
  let calls = 0;

  const publisher = pub.createPublisher({
    mount: "/db",
    register: () => {
      calls++;
      const next = results.length > 1 ? results.shift() : results[0];
      if (next instanceof Error) throw next;
      return next;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onPublished: (url) => events.push(`published:${url}`),
    onUnpublished: (reason) => events.push(`unpublished:${reason}`),
    onWarning: (msg) => events.push(`warn:${msg}`),
  });

  return {
    publisher,
    events,
    get calls() {
      return calls;
    },
    warnings: () => events.filter((e) => e.startsWith("warn:")),
  };
}

const accepted = { ok: true, url: "https://play.example.com/db" };
const pending = { ok: false, retryable: true, error: "http not ready" };
const refused = { ok: false, retryable: false, error: "mount /db already taken" };

// --------------------------------------------------------------------------
section("Reading a status snapshot");

ok(pub.normalizeStatus(null).ready === false, "a missing snapshot is not ready");
ok(pub.normalizeStatus("nonsense").ready === false, "a nonsense snapshot is not ready");
ok(
  pub.normalizeStatus({ localUrl: "http://127.0.0.1:30120" }).ready === false,
  "a listener address alone is not readiness - only tLib decides that",
);
ok(pub.normalizeStatus(READY).ready === true, "the contract's ready flag is honoured");
ok(
  pub.normalizeStatus({ ready: "yes" }).ready === false,
  "ready is strict - a truthy string is not true",
);

// --------------------------------------------------------------------------
section("Where the health probe dials");

ok(
  pub.healthUrl(READY, "/db") === "http://127.0.0.1:30120/db/api/health",
  "the local listener, carrying the mount",
  pub.healthUrl(READY, "/db"),
);
ok(
  pub.healthUrl({ ...READY, localUrl: "http://127.0.0.1:30120/" }, "/db") ===
    "http://127.0.0.1:30120/db/api/health",
  "a trailing slash does not produce a doubled one",
);
ok(
  pub.healthUrl({ ...READY, localUrl: null }, "/db") === null,
  "no listener address means no probe - NOT a guessed localhost, which is the bug this replaces",
);
ok(
  !String(pub.healthUrl(READY, "/db")).includes("play.example.com"),
  "the public origin is never dialled - behind a proxy it is unreachable from here",
);

// --------------------------------------------------------------------------
section("Nothing is registered unless a mount is wanted");
{
  const h = harness(accepted);
  h.publisher.handleStatus(READY);
  ok(h.calls === 0, "a headless resource never calls RegisterWebApp");
  ok(h.publisher.published === false, "and never claims to be published");
}

// --------------------------------------------------------------------------
section("Wanted, and tLib is ready");
{
  const h = harness(accepted);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "the mount is claimed");
  ok(
    h.publisher.publishedUrl === "https://play.example.com/db",
    "the advertised URL is the one tLib returned, not one we built",
  );
  ok(h.events.includes("published:https://play.example.com/db"), "and it is announced once");
  ok(h.warnings().length === 0, "with no warnings");

  h.publisher.handleStatus(READY);
  ok(h.calls === 1, "a repeated ready event does not register a second time");
}

// --------------------------------------------------------------------------
section("Wanted, but tLib's HTTP is still coming up");
{
  const h = harness(accepted);
  h.publisher.want(true);
  h.publisher.handleStatus(STARTING);
  ok(h.calls === 0, "registration is not attempted against a listener that is not up");
  ok(h.publisher.pending === true, "it is remembered as pending");
  ok(
    h.warnings().length === 0,
    "and the operator is NOT told anything failed - nothing has",
    JSON.stringify(h.events),
  );

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "it is claimed as soon as tLib reports ready");
  ok(h.calls === 1, "exactly once");
}

// --------------------------------------------------------------------------
section("tLib answers 'not yet' rather than 'no'");
{
  const h = harness([pending, accepted]);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === false, "a retryable result does not count as published");
  ok(h.publisher.pending === true, "it stays pending");
  ok(
    h.warnings().length === 0,
    "and is never reported as a refusal - no mount was reserved, tLib will tell us",
    JSON.stringify(h.events),
  );

  // A later ready event - tLib finished coming up.
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "the retry succeeds");
}

// --------------------------------------------------------------------------
section("A real refusal is reported");
{
  const h = harness(refused);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === false, "nothing is claimed");
  ok(h.publisher.pending === false, "and it is not left pending - retrying will not help");
  ok(
    h.warnings().some((w) => w.includes("mount /db already taken")),
    "the operator is told why, in tLib's own words",
    JSON.stringify(h.events),
  );
}

{
  const h = harness(new Error("export missing"));
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(
    h.warnings().some((w) => w.includes("export missing")),
    "a throwing export is a warning, not an exception that fails the database",
    JSON.stringify(h.events),
  );
  ok(h.publisher.published === false, "and nothing is claimed");
}

// --------------------------------------------------------------------------
section("An accepted mount with no URL is not a publication");
{
  for (const [label, result] of [
    ["no url field", { ok: true }],
    ["an empty url", { ok: true, url: "" }],
    ["whitespace", { ok: true, url: "   " }],
    ["a non-string url", { ok: true, url: 7 }],
  ]) {
    const h = harness(result);
    h.publisher.want(true);
    h.publisher.handleStatus(READY);
    ok(
      h.publisher.published === false,
      `ok:true with ${label} does not count as published`,
      JSON.stringify(h.events),
    );
    ok(
      h.warnings().some((w) => w.includes("returned no URL")),
      `...and says so (${label})`,
      JSON.stringify(h.events),
    );
  }
  // Why it matters: the caller prints publishedUrl as the Admin link, and with
  // nothing to print it falls back to the loopback address - a link that works
  // only from a shell on the server.
  const h = harness({ ok: true, url: "https://play.example.com/db" });
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(
    typeof h.publisher.publishedUrl === "string" && h.publisher.publishedUrl.length > 0,
    "a real publication always carries a non-empty URL",
  );
}

// --------------------------------------------------------------------------
section("A mount that goes away stops being advertised");
{
  const h = harness(accepted);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "published to begin with");

  h.publisher.handleStatus({ ...STARTING, listenerState: "stopped" });
  ok(h.publisher.published === false, "tLib going not-ready withdraws the claim");
  ok(h.publisher.publishedUrl === null, "the URL goes with it");
  ok(
    h.events.some((e) => e.startsWith("unpublished:")),
    "the caller is told, so it can stop printing an Admin URL for a dead route",
    JSON.stringify(h.events),
  );
  ok(h.publisher.pending === true, "still wanted, so it is pending again");

  h.publisher.handleStatus({ ...STARTING, listenerState: "stopped" });
  ok(
    h.events.filter((e) => e.startsWith("unpublished:")).length === 1,
    "a second not-ready event does not withdraw it twice",
    JSON.stringify(h.events),
  );

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "and it is re-claimed when tLib comes back");
  ok(h.calls === 2, "by registering again - tLib's registry did not keep the old one");
}

// --------------------------------------------------------------------------
section("tLib restarting voids whatever we held");
{
  const h = harness(accepted);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);

  h.publisher.handleTLibRestart();
  ok(h.publisher.published === false, "the mount is not assumed to have survived");
  ok(
    h.events.some((e) => e === "unpublished:tLib restarted"),
    "and the reason says so",
    JSON.stringify(h.events),
  );
  ok(
    h.publisher.status.ready === false,
    "the last known status is discarded too - it described a process that is gone",
  );

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "re-registering on the new instance works");
}

// --------------------------------------------------------------------------
section("Why publication has not happened, in words");

ok(
  pub.describeNotReady(pub.normalizeStatus(STARTING)).includes("starting"),
  "names the half that is not up",
  pub.describeNotReady(pub.normalizeStatus(STARTING)),
);
ok(
  pub.describeNotReady(pub.normalizeStatus({ ...STARTING, listenerState: "listening" })).includes(
    "resolving",
  ),
  "including when it is the public URL rather than the listener",
);
ok(
  pub.describeNotReady(pub.normalizeStatus({ ready: false, error: "bind EADDRINUSE" })) ===
    "bind EADDRINUSE",
  "tLib's own error wins when it gave one",
);

// --------------------------------------------------------------------------
section("How server.js wires the lifecycle up");
{
  // Normalised: server.js is CRLF on disk, so a \n literal matches nothing.
  const src = require("fs")
    .readFileSync(require("path").join(ROOT, "utils/server.js"), "utf8")
    .replace(/\r\n/g, "\n");

  const watch = src.slice(
    src.indexOf("function watchTLibStatus()"),
    src.indexOf("let routeProbeGeneration"),
  );
  const startHandler = watch.slice(watch.indexOf('on("onResourceStart"'));

  ok(watch.includes('on("onResourceStop"'), "tLib stopping is handled at all");
  ok(
    watch.indexOf('on("onResourceStop"') < watch.indexOf('on("onResourceStart"'),
    "the reset is bound to stop, before start",
  );
  ok(
    !startHandler.includes("handleTLibRestart"),
    "the start handler does NOT reset - tLib emits its status as it comes up with no " +
      "ordering guarantee against onResourceStart, so resetting there can tear down a " +
      "mount this same fresh tLib already granted and then register against it twice",
  );
  ok(
    startHandler.includes("handleStatus(readTLibHttpStatus())"),
    "it only asks where things stand",
  );

  ok(
    /generation !== routeProbeGeneration \|\| !publisher\.published/.test(src),
    "a health probe result is discarded if the mount changed while it was in flight",
  );
  ok(
    /routeProbeGeneration\+\+/.test(src.slice(src.indexOf("onUnpublished:"))),
    "withdrawing a mount invalidates any probe already running against it",
  );

  ok(
    !/getRouterPort/.test(src),
    "the port-guessing health check is gone entirely",
  );
}

// --------------------------------------------------------------------------
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exitCode = fail === 0 ? 0 : 1;
