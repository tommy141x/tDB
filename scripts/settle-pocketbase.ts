/**
 * Wait for the PocketBase processes a test suite started to actually exit, and
 * force-kill the ones that do not.
 *
 * Why this exists: every suite that needs a real database spawns
 * `.runtime/pocketbase-*` and kills it in a `finally`. `kill()` only SIGNALS,
 * so the child can outlive the suite that owned it - and with 19 suites running
 * back to back the leftovers accumulate. Measured symptom: suites began failing
 * with `ClientResponseError 0` and an empty url, i.e. a connection that never
 * opened, while each one passed on its own. Three different suites were blamed
 * for regressions that were really this (`auth-manager`, `setup-repair`,
 * `sql-import`), and one genuine orphan from an interrupted run sat holding a
 * port for an hour.
 *
 * The LIVE instance is never touched. tDB in a running FiveM server keeps its
 * data in `.runtime/pb_data` under the resource, where a test instance always
 * uses a temp directory - so the data-dir path is what separates them, not the
 * executable name.
 */
import { spawnSync } from "node:child_process";

const LIVE_DATA_DIR = ".runtime/pb_data";

type Found = { pid: number; commandLine: string };

/** Test-owned PocketBase processes, newest first. Empty on an unsupported host. */
function findTestInstances(): Found[] {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='pocketbase-win.exe'\" | " +
          "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }",
      ],
      { encoding: "utf8" }
    );

    return (result.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("|");
        return { pid: Number(line.slice(0, at)), commandLine: line.slice(at + 1) };
      })
      .filter((p) => Number.isInteger(p.pid) && !p.commandLine.includes(LIVE_DATA_DIR));
  }

  // POSIX: `ps` is enough, and the data dir is in the same argv.
  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("pocketbase-linux"))
    .map((line) => {
      const at = line.indexOf(" ");
      return { pid: Number(line.slice(0, at)), commandLine: line.slice(at + 1) };
    })
    .filter((p) => Number.isInteger(p.pid) && !p.commandLine.includes(LIVE_DATA_DIR));
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (_) {
    // Already gone, which is the outcome we wanted.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves once no test-owned PocketBase remains. Returns how many had to be
 * killed, so the caller can say so rather than hiding it.
 */
export async function settlePocketBase(timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (findTestInstances().length === 0) return 0;
    await sleep(150);
  }

  // Still there after the grace period: the owning suite either leaked it or
  // crashed before its finally ran. Killing it is safe - the data dir is a temp
  // directory nothing else reads.
  const stragglers = findTestInstances();
  for (const p of stragglers) kill(p.pid);

  if (stragglers.length) await sleep(250);
  return stragglers.length;
}

// Usable on its own, for clearing leftovers before a run.
if (import.meta.main) {
  settlePocketBase().then((killed) => {
    console.log(
      killed
        ? `settle-pocketbase: force-killed ${killed} leftover test instance(s)`
        : "settle-pocketbase: no test instances running"
    );
  });
}
