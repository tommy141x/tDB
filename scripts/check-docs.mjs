#!/usr/bin/env node

// Validates docs/ before the sync workflow publishes it. The site's own CI only
// runs after that push has landed, so a bad page would already be live.
//
// Run: bun run docs:check

import fs from "node:fs";
import path from "node:path";

const SLUG = "tDB";
const ROOT = path.resolve(import.meta.dirname, "..");
const CONTENT_DIR = path.join(ROOT, "docs", "content");
const CHANGELOG_DIR = path.join(ROOT, "docs", "changelog");
const PUBLIC_DIR = path.join(ROOT, "docs", "public");
const ASSET_PREFIX = `/assets/${SLUG}/`;
const DOCS_PREFIX = `/docs/${SLUG}/`;

const assetRe = new RegExp(`/assets/${SLUG}/([A-Za-z0-9._-]+)`, "g");
const docsLinkRe = new RegExp(`\\]\\((/docs/${SLUG}/[A-Za-z0-9/_-]+)(#([A-Za-z0-9._-]+))?\\)`, "g");

const errors = [];
const warnings = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const mdxFiles = walk(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));
// Changelog entries sync to the site with the docs and break the same ways, so they go
// through every scan below. They are a separate set rather than more pages because they
// are not pages: the frontmatter is product/version/date, and they have no docs slug.
const changelogFiles = walk(CHANGELOG_DIR).filter((f) => f.endsWith(".mdx"));

const sources = [
  ...mdxFiles.map((rel) => ({ rel, changelog: false, abs: path.join(CONTENT_DIR, rel) })),
  ...changelogFiles.map((rel) => ({
    rel: `changelog/${rel}`,
    changelog: true,
    abs: path.join(CHANGELOG_DIR, rel),
  })),
];
const mediaFiles = new Set(walk(PUBLIC_DIR).filter((f) => !f.startsWith(".")));

if (mdxFiles.length === 0) {
  console.error("check-docs: no .mdx files in docs/content, refusing to publish nothing.");
  process.exit(1);
}

// Close enough to the site's GithubSlugger to catch real broken links.
function slugify(heading) {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const pages = new Map();
const referenced = new Set();

for (const { rel, changelog, abs } of sources) {
  const text = fs.readFileSync(abs, "utf8");

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    fail(rel, "no frontmatter block; the docs schema requires at least `title`");
    continue;
  }
  const field = (name) => fm[1].match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  if (changelog) {
    // The changelog collection's own schema. `title`, `order` and `group` are the docs
    // sidebar's, and a changelog entry has none of them \u2014 requiring them here would
    // report every entry rather than find anything.
    for (const required of ["product", "version", "date"]) {
      if (!field(required)) fail(rel, `frontmatter is missing required \`${required}\``);
    }
  } else {
    if (!field("title")) fail(rel, "frontmatter is missing required `title`");
    for (const optional of ["description", "order", "group"]) {
      if (!field(optional)) warn(rel, `frontmatter has no \`${optional}\``);
    }
  }

  // A folder index collapses to the folder slug, so x.mdx and x/index.mdx collide.
  // `changelog:` cannot come out of a /docs link, so an entry is never a link target.
  const slug = changelog ? `changelog:${rel}` : rel.replace(/\.mdx$/, "").replace(/\/index$/, "");
  if (pages.has(slug)) {
    fail(rel, `collapses to the same URL as ${pages.get(slug).file} (${DOCS_PREFIX}${slug})`);
    continue;
  }

  const anchors = new Set();
  const body = text.slice(fm[0].length).replace(/^```[\s\S]*?^```/gm, "");
  for (const m of body.matchAll(/^#{2,6}\s+(.+)$/gm)) anchors.add(slugify(m[1]));
  if (!changelog && /^#\s+/m.test(body)) {
    warn(rel, "body starts a level-1 heading; the h1 is rendered from frontmatter `title`");
  }
  pages.set(slug, { file: rel, anchors, body });

  for (const m of text.matchAll(assetRe)) {
    referenced.add(m[1]);
    if (!mediaFiles.has(m[1])) {
      fail(rel, `references ${ASSET_PREFIX}${m[1]}, which is not in docs/public/`);
    }
  }
}

for (const file of mediaFiles) {
  if (!referenced.has(file)) warn("docs/public", `${file} is not referenced by any page`);
}

for (const page of pages.values()) {
  for (const m of page.body.matchAll(/\]\(#([A-Za-z0-9._-]+)\)/g)) {
    if (!page.anchors.has(m[1])) fail(page.file, `link to #${m[1]}, no such heading on this page`);
  }
  for (const m of page.body.matchAll(docsLinkRe)) {
    const dest = pages.get(m[1].slice(DOCS_PREFIX.length));
    if (!dest) fail(page.file, `link to ${m[1]}, no such page`);
    else if (m[3] && !dest.anchors.has(m[3])) {
      fail(page.file, `link to ${m[1]}#${m[3]}, no such heading on ${dest.file}`);
    }
  }
}

for (const w of warnings) console.warn(`  warn  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);

console.log(
  `\ncheck-docs: ${mdxFiles.length} pages, ${changelogFiles.length} changelog entries, ` +
    `${mediaFiles.size} media files, ${warnings.length} warning(s), ${errors.length} error(s)`,
);
if (errors.length === 0) {
  console.log(
    `  pages: ${[...pages.keys()]
      .filter((s) => !s.startsWith("changelog:"))
      .sort()
      .join(", ")}`,
  );
}

process.exit(errors.length > 0 ? 1 : 0);
