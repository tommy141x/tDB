#!/usr/bin/env bash
# Call a tool on the local dolu_fivem_mcp endpoint.
#   .dev/mcp.sh <tool> '<json args>'
# Claude Code has not connected this server this session (it was refused at
# startup, before FXServer was up), so this talks to it directly.
set -euo pipefail
tool="$1"
args="${2:-{\}}"
curl -s --max-time 120 -X POST http://127.0.0.1:3210/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
| node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try { j=JSON.parse(s); } catch(e) { console.log(s); process.exit(0); }
  if (j.error) { console.log("ERROR: "+JSON.stringify(j.error)); process.exit(0); }
  for (const c of (j.result?.content||[])) {
    if (c.type==="text") { try { console.log(JSON.stringify(JSON.parse(c.text),null,2)); } catch(e) { console.log(c.text); } }
    else console.log(`[${c.type}]`);
  }
});'
