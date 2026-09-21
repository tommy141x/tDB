/**
 * The node:http transport, and the hook that installs it.
 *
 * This exists because FiveM's Node (v26.3.0) leaks one unhandled promise
 * rejection for every `fetch()` that carries a request body - and every query
 * tDB serves is a POST with a body. See utils/http-transport.js for the
 * measurements. The leak itself cannot be reproduced here (local Node is
 * clean), so what this pins is the replacement: that the SDK really does stop
 * using global fetch, and that the transport behaves like fetch where the SDK
 * and the adapters depend on it.
 *
 * Dev harness. Run from the resource root: node .dev/http-transport.test.js
 */
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = require("./fivem-require.js");

const PocketBase = require(path.join(ROOT, "server/vendor/pocketbase.cjs.js"));
const OxMySQLAdapter = require(path.join(ROOT, "server/adapters/oxmysql.js"));
const httpTransport = require(path.join(ROOT, "server/utils/http-transport.js"));

const PB_BIN = path.join(
  ROOT,
  process.platform === "win32" ? ".runtime/pocketbase-win.exe" : ".runtime/pocketbase-linux",
);
const PORT = 8182;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "transport@example.com";
const PASSWORD = "transport-password-123";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => JSON.stringify(v);

async function main() {
  // ----------------------------------------------------------------------
  // A local server that reports exactly what it received, so the transport's
  // wire behaviour can be checked without involving PocketBase.
  // ----------------------------------------------------------------------
  const seenRequests = [];
  const echo = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seenRequests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/landed" });
        res.end();
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"slow":true}');
        }, 3000);
        return;
      }
      if (req.url === "/teapot") {
        res.writeHead(418, { "content-type": "application/json", "x-note": "hi" });
        res.end('{"teapot":true}');
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-note": "hi" });
        res.end(JSON.stringify({ method: req.method, echoed: body }));
      }
    });
  });
  await new Promise((r) => echo.listen(8183, "127.0.0.1", r));
  const ECHO = "http://127.0.0.1:8183";

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdb-transport-"));
  // The OxMySQL adapter talks to the /api/tdb/* routes the hooks register.
  const hooksDir = `${dataDir}-hooks`;
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const file of fs.readdirSync(path.join(ROOT, "pb_hooks"))) {
    fs.copyFileSync(path.join(ROOT, "pb_hooks", file), path.join(hooksDir, file));
  }

  spawnSync(PB_BIN, ["superuser", "upsert", EMAIL, PASSWORD, "--dir", dataDir], {
    encoding: "utf8",
  });
  const server = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      "--dir",
      dataDir,
      "--hooksDir",
      hooksDir,
      "--migrationsDir",
      path.join(dataDir, "migrations"),
    ],
    { stdio: "ignore" },
  );

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${URL_BASE}/api/health`)).ok) break;
      } catch (_) {}
      await sleep(200);
    }

    // --------------------------------------------------------------------
    console.log("\n=== It behaves like fetch");

    const { nodeFetch } = httpTransport;

    const posted = await nodeFetch(`${ECHO}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    ok(posted.status === 200, "a POST with a string body gets a response", show(posted.status));
    ok(
      (await posted.json()).echoed === '{"a":1}',
      "the body arrives intact",
      show(seenRequests.at(-1) && seenRequests.at(-1).body),
    );
    ok(
      seenRequests.at(-1).headers["content-length"] === "7",
      "Content-Length is set from the body",
      show(seenRequests.at(-1).headers["content-length"]),
    );

    for (const [label, body, expected] of [
      ["a Buffer", Buffer.from('{"b":2}'), '{"b":2}'],
      ["a Uint8Array", new TextEncoder().encode('{"c":3}'), '{"c":3}'],
      ["an ArrayBuffer", new TextEncoder().encode('{"d":4}').buffer, '{"d":4}'],
      ["URLSearchParams", new URLSearchParams({ e: "5" }), "e=5"],
    ]) {
      const res = await nodeFetch(`${ECHO}/echo`, { method: "POST", body });
      ok((await res.json()).echoed === expected, `${label} body is sent verbatim`);
    }

    const teapot = await nodeFetch(`${ECHO}/teapot`);
    ok(teapot.status === 418 && teapot.ok === false, "a 4xx resolves rather than throwing");
    ok(teapot.headers.get("x-note") === "hi", "response headers are readable");
    ok(teapot.headers.get("X-NOTE") === "hi", "header lookup is case-insensitive");
    ok(teapot.headers.get("nope") === null, "a missing header reads as null");
    ok(await teapot.text().then((t) => t === '{"teapot":true}'), "text() returns the body");

    const before = seenRequests.length;
    const redirected = await nodeFetch(`${ECHO}/redirect`, {
      method: "POST",
      body: '{"x":1}',
    });
    ok(redirected.status === 200, "a 302 is followed", show(redirected.status));
    ok(
      seenRequests.at(-1).method === "GET" && seenRequests.at(-1).body === "",
      "a POST redirected by 302 becomes a bodyless GET, as fetch does",
      show({ method: seenRequests.at(-1).method, body: seenRequests.at(-1).body }),
    );
    ok(seenRequests.length === before + 2, "exactly one extra request was made");

    // A body shape this transport does not encode must not be mangled - it
    // falls through to the platform fetch.
    const form = new FormData();
    form.append("field", "value");
    const viaPlatform = await nodeFetch(`${ECHO}/echo`, { method: "POST", body: form });
    ok(viaPlatform.status === 200, "an unsupported body type falls back to global fetch");
    ok(
      /form-data/.test(seenRequests.at(-1).headers["content-type"] || ""),
      "and the platform encoded it as multipart",
      show(seenRequests.at(-1).headers["content-type"]),
    );

    // Abort.
    const controller = new AbortController();
    const pending = nodeFetch(`${ECHO}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const aborted = await pending.then(
      () => "resolved",
      (e) => e.name,
    );
    ok(aborted === "AbortError", "an aborted request rejects with AbortError", show(aborted));

    const preAborted = new AbortController();
    preAborted.abort();
    const already = await nodeFetch(`${ECHO}/echo`, { signal: preAborted.signal }).then(
      () => "resolved",
      (e) => e.name,
    );
    ok(already === "AbortError", "an already-aborted signal rejects immediately");

    const refused = await nodeFetch("http://127.0.0.1:8099/nothing").then(
      () => "resolved",
      (e) => e.code || e.name,
    );
    ok(refused !== "resolved", "a connection failure rejects", show(refused));

    // --------------------------------------------------------------------
    console.log("\n=== install() routes the SDK through it");

    const pb = new PocketBase(URL_BASE);
    pb.autoCancellation(false);
    httpTransport.install(pb);

    // If the SDK still reached for global fetch, this would go unnoticed -
    // so make global fetch fail loudly for the duration.
    const realFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = (...args) => {
      globalFetchCalls++;
      return realFetch(...args);
    };

    try {
      await pb
        .collection("_superusers")
        .authWithPassword(EMAIL, PASSWORD, { requestKey: null });
      ok(pb.authStore.isValid, "the SDK authenticates through the transport");

      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const ox = new OxMySQLAdapter(pb, (fn) => fn, logger);
      const call = (name, ...args) => ox.handle(name, args);

      await call(
        "update",
        `CREATE TABLE IF NOT EXISTS transport_probe (
           id INT NOT NULL AUTO_INCREMENT,
           tag VARCHAR(50),
           n INT DEFAULT 0,
           PRIMARY KEY (id)
         )`,
      );
      await call("insert", "INSERT INTO transport_probe (tag, n) VALUES (?, ?)", [
        "probe",
        1,
      ]);
      const row = await call("single", "SELECT * FROM transport_probe WHERE tag = ?", [
        "probe",
      ]);
      ok(row && row.n === 1, "a query round-trips through the transport", show(row));

      const burst = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          call("update", "UPDATE transport_probe SET n = n + 1 WHERE tag = ?", ["probe"]),
        ),
      );
      ok(
        burst.every((r) => r.status === "fulfilled"),
        "20 concurrent writes all resolve",
        show(burst.find((r) => r.status === "rejected")?.reason?.message),
      );
      const total = await call("scalar", "SELECT n FROM transport_probe WHERE tag = ?", [
        "probe",
      ]);
      ok(total === 21, "all 20 increments applied", show(total));

      ok(
        globalFetchCalls === 0,
        "global fetch was never called during any of it",
        show(globalFetchCalls),
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    // --------------------------------------------------------------------
    console.log("\n=== install() chains rather than replaces");

    const chained = new PocketBase(URL_BASE);
    let priorCalls = 0;
    chained.beforeSend = (url, options) => {
      priorCalls++;
      options.headers = { ...options.headers, "x-prior": "ran" };
      return { url, options };
    };
    httpTransport.install(chained);

    await chained.send("/api/health", { method: "GET", requestKey: null });
    ok(priorCalls === 1, "an existing beforeSend still runs", show(priorCalls));

    // The SDK installs its own beforeSend during superuser auth and expects to
    // find the previous one intact. Losing ours would silently restore fetch.
    const sdkWrapped = new PocketBase(URL_BASE);
    sdkWrapped.autoCancellation(false);
    httpTransport.install(sdkWrapped);
    await sdkWrapped
      .collection("_superusers")
      .authWithPassword(EMAIL, PASSWORD, { autoRefreshThreshold: 30, requestKey: null });

    let transportUsed = false;
    const originalHook = sdkWrapped.beforeSend;
    sdkWrapped.beforeSend = async (url, options) => {
      const r = await originalHook(url, options);
      transportUsed = Boolean((r.options || options).fetch);
      return r;
    };
    await sdkWrapped.collections.getFullList({ requestKey: null });
    ok(
      transportUsed,
      "the transport survives the SDK wrapping beforeSend during auth",
      show(transportUsed),
    );

    // --------------------------------------------------------------------
    console.log("\n=== the resource actually installs it");

    const clientSource = fs.readFileSync(path.join(ROOT, "server/utils/client.js"), "utf8");
    ok(
      /httpTransport\.install\(pb\)/.test(clientSource),
      "server/utils/client.js installs the transport on the client it hands out",
    );
  } finally {
    server.kill();
    echo.close();
    await sleep(500);
    for (const d of [dataDir, hooksDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
});
