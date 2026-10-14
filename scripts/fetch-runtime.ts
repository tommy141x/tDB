/**
 * Fetch the PocketBase binary into .runtime/, one pinned version for every
 * platform. Committing the binaries instead cost a 57 MB .git and still let the
 * two platforms drift a patch apart.
 *
 * Integrity is checked against the checksums.txt PocketBase publishes with the
 * release, not hashes recorded here, so a tampered mirror cannot pass by also
 * editing our copy of the expected hash.
 *
 *   bun scripts/fetch-runtime.ts            # current platform
 *   bun scripts/fetch-runtime.ts --all      # both, for building a release
 *   bun scripts/fetch-runtime.ts --force    # re-download even if present
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Bump this one line to upgrade PocketBase on every platform at once. */
const PB_VERSION = "0.40.4";

const ROOT = join(import.meta.dir, "..");
const RUNTIME = join(ROOT, ".runtime");
const BASE = `https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}`;

type Target = { platform: string; asset: string; member: string; out: string };

const TARGETS: Target[] = [
  {
    platform: "windows",
    asset: `pocketbase_${PB_VERSION}_windows_amd64.zip`,
    member: "pocketbase.exe",
    out: "pocketbase-win.exe",
  },
  {
    platform: "linux",
    asset: `pocketbase_${PB_VERSION}_linux_amd64.zip`,
    member: "pocketbase",
    out: "pocketbase-linux",
  },
];

const sha256 = (buf: Uint8Array) =>
  createHash("sha256").update(buf).digest("hex");

// The release's checksums.txt as { asset -> sha256 }. Fetched once and reused,
// so --all does not pull it twice.
async function publishedChecksums(): Promise<Map<string, string>> {
  const res = await fetch(`${BASE}/checksums.txt`);
  if (!res.ok) {
    throw new Error(
      `could not read checksums.txt for v${PB_VERSION} (HTTP ${res.status}). ` +
        `If the release exists, the asset naming may have changed.`,
    );
  }
  const map = new Map<string, string>();
  for (const line of (await res.text()).split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) map.set(name.replace(/^\*/, ""), hash);
  }
  return map;
}

// Extract one member from a ZIP, in process. Shelling out is not portable
// enough: the `tar` on PATH under Git Bash is GNU tar, which cannot read a ZIP,
// and the bsdtar that can is a Windows-only absolute path.
function extractMember(zip: Uint8Array, member: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);

  // End of central directory: fixed 22 bytes, then a comment of up to 64 KB,
  // so scan backwards for the signature rather than assuming it is last.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 22 - 65536; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive: no end-of-central-directory");

  let entry = u32(eocd + 16);
  const count = u16(eocd + 10);

  for (let n = 0; n < count; n++) {
    if (u32(entry) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = u16(entry + 10);
    const compressedSize = u32(entry + 20);
    const nameLen = u16(entry + 28);
    const extraLen = u16(entry + 30);
    const commentLen = u16(entry + 32);
    const localOffset = u32(entry + 42);
    const name = new TextDecoder().decode(
      zip.subarray(entry + 46, entry + 46 + nameLen),
    );

    if (name === member) {
      // The local header repeats the name and extra fields, and its extra
      // length routinely differs from the central one. Read it, never reuse.
      if (u32(localOffset) !== 0x04034b50) throw new Error("corrupt local header");
      const dataStart =
        localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
      const body = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return new Uint8Array(body);
      if (method === 8) return inflateRawSync(body);
      throw new Error(`${member}: unsupported compression method ${method}`);
    }

    entry += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`${member} not found in archive`);
}

async function fetchTarget(t: Target, sums: Map<string, string>, force: boolean) {
  const dest = join(RUNTIME, t.out);

  if (existsSync(dest) && !force) {
    console.log(`  ${t.out} already present (use --force to replace)`);
    return;
  }

  const expected = sums.get(t.asset);
  if (!expected) {
    throw new Error(`${t.asset} is not listed in the release checksums`);
  }

  console.log(`  downloading ${t.asset}`);
  const res = await fetch(`${BASE}/${t.asset}`);
  if (!res.ok) throw new Error(`${t.asset}: HTTP ${res.status}`);
  const archive = new Uint8Array(await res.arrayBuffer());

  const actual = sha256(archive);
  if (actual !== expected) {
    // These are not the bytes PocketBase published, so do not run them.
    throw new Error(
      `checksum mismatch for ${t.asset}\n  expected ${expected}\n  got      ${actual}`,
    );
  }

  const binary = extractMember(archive, t.member);
  await writeFile(dest, binary);
  await chmod(dest, 0o755);

  console.log(
    `  ${t.out}  ok  (${(binary.length / 1048576).toFixed(1)} MB, sha256 ${sha256(binary).slice(0, 16)}…)`,
  );
}

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const wanted = args.has("--all")
  ? TARGETS
  : TARGETS.filter((t) =>
      process.platform === "win32" ? t.platform === "windows" : t.platform === "linux",
    );

await mkdir(RUNTIME, { recursive: true });
console.log(`PocketBase v${PB_VERSION} -> .runtime/`);

const sums = await publishedChecksums();
for (const t of wanted) await fetchTarget(t, sums, force);

console.log("done");
