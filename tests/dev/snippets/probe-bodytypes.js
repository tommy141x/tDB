// Any fetch carrying a request body leaks one unhandled rejection in FiveM's
// Node v26.3.0. Which body representations avoid it, and does node:http?
const V = globalThis.__variant || "string";
const BASE = "http://127.0.0.1:8090";
const AUTH = `${BASE}/api/collections/_superusers/auth-with-password`;
const PAYLOAD = JSON.stringify({ identity: "x@example.com", password: "nope" });
const JSONH = { "content-type": "application/json" };

const post = async (body, extra) => {
  const r = await fetch(AUTH, { method: "POST", headers: JSONH, body, ...extra });
  const t = await r.text();
  return `${r.status}/${t.length}`;
};

let out;
switch (V) {
  case "string":
    out = await post(PAYLOAD);
    break;
  case "uint8array":
    out = await post(new TextEncoder().encode(PAYLOAD));
    break;
  case "buffer":
    out = await post(Buffer.from(PAYLOAD));
    break;
  case "arraybuffer":
    out = await post(new TextEncoder().encode(PAYLOAD).buffer);
    break;
  case "blob":
    out = await post(new Blob([PAYLOAD], { type: "application/json" }));
    break;
  case "urlsearchparams":
    out = await post(new URLSearchParams({ identity: "x@example.com", password: "nope" }), {
      headers: {},
    });
    break;
  case "node-http": {
    const http = require("http");
    out = await new Promise((resolve, reject) => {
      const req = http.request(
        AUTH,
        {
          method: "POST",
          headers: { ...JSONH, "content-length": Buffer.byteLength(PAYLOAD) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(`${res.statusCode}/${data.length}`));
        },
      );
      req.on("error", reject);
      req.end(PAYLOAD);
    });
    break;
  }
  default:
    out = "unknown variant";
}

await ctx.sleep(2500);
return { variant: V, out };
