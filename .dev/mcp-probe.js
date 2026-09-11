// Run a snippet on the live FXServer and report any unhandled rejection it
// caused, read from the server console.
//
//   node .dev/mcp-probe.js <file.js> [settleMs]
//
// The console is the ONLY working detector here: FiveM reports unhandled
// rejections through V8's per-isolate callback and never emits Node's
// `process.on("unhandledRejection")` event. Verified with a deliberate
// Promise.reject control (.dev/snippets/probe-trap-works.js) - the process
// listener did not fire, the console line did appear. Any probe that trusts
// the process event silently reports zero rejections no matter what happens.
const fs = require("fs");

const ENDPOINT = "http://127.0.0.1:3210/mcp";

async function call(name, args) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  const text = (json.result?.content || []).find((c) => c.type === "text")?.text;
  return JSON.parse(text);
}

async function main() {
  const file = process.argv[2];
  const settle = Number(process.argv[3] || 3000);
  const code = fs.readFileSync(file, "utf8");

  const before = (await call("read_logs", { limit: 1 })).result.nextCursor;

  const run = await call("execute_server", {
    language: "javascript",
    code,
    wait: true,
    timeoutMs: 60000,
  });
  console.log("--- snippet result ---");
  console.log(JSON.stringify(run.result?.outcome ?? run, null, 2));

  await new Promise((r) => setTimeout(r, settle));

  const after = await call("read_logs", { after: before, limit: 200 });
  const warnings = (after.result?.lines || []).filter((l) =>
    /Unhandled promise rejection|Uncaught /.test(l.message),
  );
  console.log(`--- console rejections since seq ${before}: ${warnings.length} ---`);
  for (const w of warnings) console.log(w.seq, "|", w.message.replace(/\r/g, ""));
}

main().catch((e) => console.log("PROBE FAILED:", e.message));
