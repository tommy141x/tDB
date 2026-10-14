// The admin-UI publication state machine. Pure logic, no server: every FiveM
// global is injected into createPublisher.
const path = require("path");

const ROOT = require("./fivem-require.js");
const pub = require(path.join(ROOT, "server/utils/tlib-publication.js"));

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

// A publisher plus a record of everything it did to the outside world.
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

section("Reading a status snapshot");

ok(pub.normalizeStatus(null).ready === false, "a missing snapshot is not ready");
ok(pub.normalizeStatus("nonsense").ready === false, "a nonsense snapshot is not ready");
ok(
  pub.normalizeStatus({ localUrl: "http://127.0.0.1:30120" }).ready === false,
  "a listener address alone is not readiness"
);
ok(pub.normalizeStatus(READY).ready === true, "the contract's ready flag is honoured");
ok(
  pub.normalizeStatus({ ready: "yes" }).ready === false,
  "ready is strict: a truthy string is not true"
);

section("Where the health probe dials");

ok(
  pub.healthUrl(READY, "/db") === "http://127.0.0.1:30120/db/api/health",
  "the local listener, carrying the mount",
  pub.healthUrl(READY, "/db")
);
ok(
  pub.healthUrl({ ...READY, localUrl: "http://127.0.0.1:30120/" }, "/db") ===
    "http://127.0.0.1:30120/db/api/health",
  "a trailing slash does not produce a doubled one"
);
ok(
  pub.healthUrl({ ...READY, localUrl: null }, "/db") === null,
  "no listener address means no probe, never a guessed localhost"
);
ok(
  !String(pub.healthUrl(READY, "/db")).includes("play.example.com"),
  "the public origin is never dialled; behind a proxy it is unreachable from here"
);

section("Nothing is registered unless a mount is wanted");
{
  const h = harness(accepted);
  h.publisher.handleStatus(READY);
  ok(h.calls === 0, "a headless resource never calls RegisterWebApp");
  ok(h.publisher.published === false, "and never claims to be published");
}

section("Wanted, and tLib is ready");
{
  const h = harness(accepted);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "the mount is claimed");
  ok(
    h.publisher.publishedUrl === "https://play.example.com/db",
    "the advertised URL is the one tLib returned, not one we built"
  );
  ok(h.events.includes("published:https://play.example.com/db"), "and it is announced once");
  ok(h.warnings().length === 0, "with no warnings");

  h.publisher.handleStatus(READY);
  ok(h.calls === 1, "a repeated ready event does not register a second time");
}

section("Wanted, but tLib's HTTP is still coming up");
{
  const h = harness(accepted);
  h.publisher.want(true);
  h.publisher.handleStatus(STARTING);
  ok(h.calls === 0, "registration is not attempted against a listener that is not up");
  ok(h.publisher.pending === true, "it is remembered as pending");
  ok(h.warnings().length === 0, "and nothing is reported as failed", JSON.stringify(h.events));

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "it is claimed as soon as tLib reports ready");
  ok(h.calls === 1, "exactly once");
}

section("tLib answers 'not yet' rather than 'no'");
{
  const h = harness([pending, accepted]);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === false, "a retryable result does not count as published");
  ok(h.publisher.pending === true, "it stays pending");
  ok(h.warnings().length === 0, "and is never reported as a refusal", JSON.stringify(h.events));

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "the retry succeeds");
}

section("A real refusal is reported");
{
  const h = harness(refused);
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(h.publisher.published === false, "nothing is claimed");
  ok(h.publisher.pending === false, "and it is not left pending; retrying will not help");
  ok(
    h.warnings().some((w) => w.includes("mount /db already taken")),
    "the operator is told why, in tLib's own words",
    JSON.stringify(h.events)
  );
}

{
  const h = harness(new Error("export missing"));
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(
    h.warnings().some((w) => w.includes("export missing")),
    "a throwing export is a warning, not a failed database",
    JSON.stringify(h.events)
  );
  ok(h.publisher.published === false, "and nothing is claimed");
}

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
      JSON.stringify(h.events)
    );
    ok(
      h.warnings().some((w) => w.includes("returned no URL")),
      `...and says so (${label})`,
      JSON.stringify(h.events)
    );
  }
  // The caller prints publishedUrl as the Admin link; with nothing to print it
  // falls back to loopback, which only works from a shell on the server.
  const h = harness({ ok: true, url: "https://play.example.com/db" });
  h.publisher.want(true);
  h.publisher.handleStatus(READY);
  ok(
    typeof h.publisher.publishedUrl === "string" && h.publisher.publishedUrl.length > 0,
    "a real publication always carries a non-empty URL"
  );
}

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
    "the caller is told, so it stops printing an Admin URL for a dead route",
    JSON.stringify(h.events)
  );
  ok(h.publisher.pending === true, "still wanted, so it is pending again");

  h.publisher.handleStatus({ ...STARTING, listenerState: "stopped" });
  ok(
    h.events.filter((e) => e.startsWith("unpublished:")).length === 1,
    "a second not-ready event does not withdraw it twice",
    JSON.stringify(h.events)
  );

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "and it is re-claimed when tLib comes back");
  ok(h.calls === 2, "by registering again; tLib's registry did not keep the old one");
}

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
    JSON.stringify(h.events)
  );
  ok(h.publisher.status.ready === false, "the last known status is discarded too");

  h.publisher.handleStatus(READY);
  ok(h.publisher.published === true, "re-registering on the new instance works");
}

section("Why publication has not happened, in words");

ok(
  pub.describeNotReady(pub.normalizeStatus(STARTING)).includes("starting"),
  "names the half that is not up",
  pub.describeNotReady(pub.normalizeStatus(STARTING))
);
ok(
  pub
    .describeNotReady(pub.normalizeStatus({ ...STARTING, listenerState: "listening" }))
    .includes("resolving"),
  "including when it is the public URL rather than the listener"
);
ok(
  pub.describeNotReady(pub.normalizeStatus({ ready: false, error: "bind EADDRINUSE" })) ===
    "bind EADDRINUSE",
  "tLib's own error wins when it gave one"
);

section("How server.js wires the lifecycle up");
{
  const src = require("fs")
    .readFileSync(require("path").join(ROOT, "server/utils/server.js"), "utf8")
    .replace(/\r\n/g, "\n");

  const watch = src.slice(
    src.indexOf("function watchTLibStatus()"),
    src.indexOf("let routeProbeGeneration")
  );
  const startHandler = watch.slice(watch.indexOf('on("onResourceStart"'));

  ok(watch.includes('on("onResourceStop"'), "tLib stopping is handled at all");
  ok(
    watch.indexOf('on("onResourceStop"') < watch.indexOf('on("onResourceStart"'),
    "the reset is bound to stop, before start"
  );
  ok(
    !startHandler.includes("handleTLibRestart"),
    "the start handler does not reset; tLib's status and onResourceStart have no ordering guarantee"
  );
  ok(
    startHandler.includes("handleStatus(readTLibHttpStatus())"),
    "it only asks where things stand"
  );

  ok(
    /generation !== routeProbeGeneration \|\| !publisher\.published/.test(src),
    "a health probe result is discarded if the mount changed while it was in flight"
  );
  ok(
    /routeProbeGeneration\+\+/.test(src.slice(src.indexOf("onUnpublished:"))),
    "withdrawing a mount invalidates any probe already running against it"
  );

  ok(!/getRouterPort/.test(src), "the port-guessing health check is gone entirely");

  // A single dial made a mount that was live a second later read as permanently
  // broken, and the banner then said so on every boot. A warning that is always
  // there is a warning nobody reads.
  const probe = src.slice(
    src.indexOf("async function checkRouteHealth"),
    src.indexOf("async function createSuperuser")
  );
  ok(
    /for \(let attempt = 1; attempt <= ROUTE_PROBE_ATTEMPTS/.test(probe),
    "the route probe retries rather than convicting on one dial"
  );
  const attempts = Number((/const ROUTE_PROBE_ATTEMPTS = (\d+);/.exec(src) || [])[1]);
  ok(
    attempts > 1,
    "and more than one attempt is actually configured",
    `ROUTE_PROBE_ATTEMPTS = ${attempts}`
  );
  ok(
    /req\.destroy\(\)/.test(probe),
    "a timed-out probe tears its request down instead of leaving the socket open"
  );
  ok(
    /detail: `HTTP \$\{resp\.statusCode\}`/.test(probe),
    "a non-200 is reported as the status code it was"
  );
  ok(
    /detail: err\.code \|\| err\.message/.test(probe),
    "and a connection failure as the errno, not as silence"
  );
  // The ✓/✗ prefixes left these strings when the startup box moved to one tLib
  // info row per fact: tLib colours each row itself, so the glyph was carrying
  // information the colour already carries.
  const warning = src.slice(src.indexOf('healthStatus = "Not reachable through tLib"'));
  const warningPush = warning.slice(0, warning.indexOf(");") + 2);
  ok(
    /startupStatus\.routeProbeUrl/.test(warningPush) &&
      /startupStatus\.routeProbeDetail/.test(warningPush),
    "the warning names the URL probed and what came back"
  );
  ok(
    !/"tLib accepted the mount but is not forwarding it; check tLib's log"/.test(src),
    "the old unactionable wording is gone"
  );

  section("The startup box is one tLib info row per fact");

  // tLib pads `key:` to a 10-column gutter and indents every CONTINUATION line
  // of a value by 12 spaces with no key. tDB used to pass the whole box as a
  // single `Database` value, so every other fact rendered as a continuation of
  // that one value - a different indent from tRadio's box, blank separator
  // lines silently dropped, and one row wrapping mid-phrase. The renderer was
  // never the problem; tDB was not using it.
  const box = src.slice(
    src.indexOf("function displayStartupStatus()"),
    src.indexOf("function probeTLibRoute")
  );

  ok(
    !/boxContent/.test(src),
    "the single multi-line value is gone; nothing builds a boxContent array"
  );
  ok(
    /emit\("tdb:startupStatus", JSON\.stringify\(rows\)\)/.test(box),
    "the rows are emitted as structured data, not as a pre-rendered string"
  );
  for (const key of ["Status", "Mode", "Admin", "Email", "Pass"]) {
    ok(
      new RegExp(`row\\("${key}"`).test(box),
      `${key} is its own row, so it gets its own key in the gutter`
    );
  }

  // The rows that are NOT there, and must not come back. Each said something
  // the operator could already read elsewhere: Binding is a config value they
  // set themselves, and Health was a second verdict printing "Started" next to
  // Status's "System ready" on every healthy boot.
  for (const key of ["Binding", "Health"]) {
    ok(
      !new RegExp(`row\\("${key}"`).test(box),
      `${key} is not a row; it repeated something the box already said`
    );
  }
  // A row's value must not carry its own colour codes: tLib prefixes the row
  // colour to every line it emits, so an embedded ^7 resets it mid-row.
  ok(
    !/row\((?:[^)]*)colors\./.test(box),
    "row values are plain text, with the colour passed separately"
  );
  // Keys longer than 8 characters overrun the 10-column gutter, which is the
  // misalignment this change exists to remove.
  const keys = [...box.matchAll(/row\("([^"]+)"/g)].map((m) => m[1]);
  ok(keys.length > 0, "the rows are findable at all", JSON.stringify(keys));
  ok(
    keys.every((k) => k.length <= 8),
    "every key fits tLib's 10-column gutter",
    JSON.stringify(keys.filter((k) => k.length > 8))
  );

  section("Readiness comes from GetHttpStatus and nothing else");

  const reader = src.slice(
    src.indexOf("function readTLibHttpStatus()"),
    src.indexOf("function registerWithTLib()")
  );

  // A call, not the word: the comment above readTLibHttpStatus names GetHubUrl
  // to record why it is not used.
  ok(
    !/GetHubUrl\s*\(/.test(src),
    "GetHubUrl is never called; it answers even after a failed bind, so it never meant serving"
  );
  ok(!/ready:\s*true/.test(reader), "it never synthesises readiness it cannot verify");
  // The tLib-version feature detection is GONE, not relocated. `tlib_min_version
  // '1.0'` is what makes GetHttpStatus present, so a `typeof ... === "function"`
  // probe here could only ever be dead code pretending to be a safety net.
  ok(
    !/tlibTooOld\s*=/.test(src) && !/too old/.test(src.replace(reader, "")),
    "no tlibTooOld latch and no 'too old' operator-facing state survives"
  );
  ok(
    !/typeof\s+api\.GetHttpStatus/.test(src) && !/GetHttpStatus\s*===\s*"function"/.test(src),
    "and GetHttpStatus is called, not feature-detected"
  );
  ok(
    /return null/.test(reader) && /GetResourceState\("tLib"\) !== "started"/.test(reader),
    "a tLib that is not started still yields null rather than a guessed URL"
  );
  ok(
    !/exposeAdmin\s*=|ExposeAdmin\s*=\s*(true|false)/.test(reader),
    "the operator's ExposeAdmin setting is read, never rewritten"
  );

  section("Listing on the hub is separate from being exposed");

  const loaderSrc = require("fs")
    .readFileSync(require("path").join(ROOT, "server/utils/config-loader.js"), "utf8")
    .replace(/\r\n/g, "\n");
  // The defaults moved into buildDefaults() when they became the single source
  // of truth; the parser starts at the Lua string literal note below it.
  const defaults = loaderSrc.slice(
    loaderSrc.indexOf("function buildDefaults()"),
    loaderSrc.indexOf("// A Lua string literal")
  );

  ok(
    /ShowInHub:\s*true/.test(defaults),
    "ShowInHub defaults to true, so a config.lua predating the key stays listed"
  );
  ok(/"Config\\\\\.ShowInHub"/.test(loaderSrc), "and it is parsed out of config.lua");
  ok(
    /listed:\s*config\.ShowInHub !== false/.test(src),
    "the flag reaches RegisterWebApp's `listed`, via !== false so an absent key means listed"
  );

  // Delisting is cosmetic; registration is gated only by ExposeAdmin.
  const registerBody = src.slice(
    src.indexOf("function registerWithTLib()"),
    src.indexOf("* Owns whether the admin UI is currently published")
  );
  ok(
    !/ShowInHub/.test(registerBody.slice(0, registerBody.indexOf("listed:"))),
    "ShowInHub does not gate whether we register"
  );
  ok(
    /not a security|NOT a security/i.test(
      src.slice(
        src.indexOf("listed: config.ShowInHub"),
        src.indexOf("listed: config.ShowInHub") + 40
      )
    ) || /NOT a security control/.test(registerBody),
    "and the code says so"
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => {
    console.log(`  - ${f}`);
  });
}
process.exitCode = fail === 0 ? 0 : 1;
