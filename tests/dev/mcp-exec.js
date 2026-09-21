// Run a JS file on the live FXServer through dolu_fivem_mcp's execute_server.
//   node .dev/mcp-exec.js <file.js> [timeoutMs]
// Avoids shell quoting entirely - the snippet is read from disk and JSON-encoded.
const fs = require("fs");

const file = process.argv[2];
const timeout = Number(process.argv[3] || 30000);
const code = fs.readFileSync(file, "utf8");

const body = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "execute_server",
    arguments: { language: "javascript", code, wait: true, timeoutMs: timeout },
  },
};

fetch("http://127.0.0.1:3210/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify(body),
})
  .then((r) => r.json())
  .then((j) => {
    if (j.error) return console.log("ERROR:", JSON.stringify(j.error, null, 2));
    for (const c of j.result?.content || []) {
      if (c.type !== "text") continue;
      try {
        console.log(JSON.stringify(JSON.parse(c.text), null, 2));
      } catch (_) {
        console.log(c.text);
      }
    }
  })
  .catch((e) => console.log("REQUEST FAILED:", e.message));
