/**
 * `bun run thumb` — the store/docs hero and banner.
 *
 * The frame, the light rig and the guards are tLib's (`shared/ts/build/hero.ts`); this file is
 * only tDB's words and its layer placement.
 *
 * Inputs are the two real PocketBase admin captures in `assets/hero/`.
 *
 *   bun run thumb
 *   bun run thumb -- --format banner
 *   bun run thumb -- --subtitle "..."
 */

import path from "node:path";
import { cliArg } from "../../tLib/shared/ts/build/argv.ts";
import { type HeroLayer, renderHero } from "../../tLib/shared/ts/build/hero.ts";

const REPO = path.resolve(import.meta.dir, "..");
const shot = (name: string) => path.join(REPO, "assets", "hero", `${name}.webp`);
const out = (name: string) => path.join(REPO, "docs", "public", name);

const headline = cliArg("headline") ?? "tDatabase";
const subtitle = cliArg("subtitle") ?? "Full database in a single FiveM resource";
const only = cliArg("format");

const collections = shot("collections");
const logs = shot("logs");

/** The log view leads in both formats: it carries the one piece of colour in either capture, and
 *  a wall of live traffic says "database" faster than an empty three-row table does. */
const thumb: HeroLayer[] = [
  {
    file: collections,
    css: `width: 1020px; left: -86px; top: 88px;
          transform: rotateY(7deg) rotateX(2.5deg) rotateZ(-1.1deg);
          filter: brightness(1.12) saturate(.95);
          box-shadow: 0 60px 120px rgba(0,0,0,.75);`,
  },
  {
    file: logs,
    css: `width: 1390px; left: 468px; top: 0;
          transform: rotateX(1.6deg) rotateZ(-.5deg);
          box-shadow: 0 50px 140px rgba(0,0,0,.85), 0 0 0 1px rgba(255,255,255,.07);`,
  },
];

const banner: HeroLayer[] = [
  {
    file: collections,
    css: `width: 760px; left: 648px; top: 150px;
          transform: rotateY(9deg) rotateX(3deg) rotateZ(-1.4deg);
          filter: brightness(1.1) saturate(.95);
          box-shadow: 0 40px 90px rgba(0,0,0,.75);`,
  },
  {
    file: logs,
    css: `width: 1000px; left: 900px; top: 52px;
          transform: rotateY(-10deg) rotateX(3deg) rotateZ(-1deg);
          box-shadow: 0 40px 110px rgba(0,0,0,.85), 0 0 0 1px rgba(255,255,255,.07);`,
  },
];

/** Nine characters against tRadio's thirteen, so this runs a little above the 148px default to
 *  land on a comparable lockup width — the two sit side by side in a store listing, and matching
 *  the font-size rather than the occupied width makes the shorter name look small. */
if (only !== "banner") {
  await renderHero({
    format: "thumb",
    headline,
    subtitle,
    headlineSize: 162,
    stageCss: "top: 430px; height: 650px;",
    layers: thumb,
    out: out("thumb.jpg"),
  });
}
if (only !== "thumb") {
  await renderHero({
    format: "banner",
    headline,
    subtitle,
    layers: banner,
    out: out("banner.jpg"),
  });
}
