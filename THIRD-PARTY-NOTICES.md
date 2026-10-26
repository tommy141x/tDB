# Third-party notices

tDB redistributes the four components below. Each is MIT licensed, and MIT
requires the copyright notice and permission notice to travel with every copy --
which is what this file is. It ships inside the release archive alongside them.

Two of those four are not source files but compiled artifacts, and a compiled
artifact carries everything that was linked into it. What is inside them is
listed in "Bundled inside the PocketBase binaries" and "Bundled inside
polyglot_sql.wasm" below, read out of the shipped files themselves rather than
from an upstream dependency list. Not all of it is MIT.

tDB's own licence is in `LICENSE.md` and covers tDB only.

## PocketBase — the embedded database engine

Shipped as `.runtime/pocketbase-linux` and `.runtime/pocketbase-win.exe`,
pinned to **v0.40.4** by `scripts/fetch-runtime.ts` and fetched from the
project's own GitHub releases, checksum-verified.

- https://github.com/pocketbase/pocketbase
- Copyright (c) 2022 - present, Gani Georgiev

## PocketBase JavaScript SDK

Shipped as `server/vendor/pocketbase.cjs.js`.

- https://github.com/pocketbase/js-sdk
- Copyright (c) 2022 - present, Gani Georgiev

## EventSource polyfill

Shipped as `server/vendor/eventsource.min.js`. It carries its own `@license`
banner; the copyright line is reproduced here because the banner does not.

- https://github.com/Yaffle/EventSource
- Copyright (c) 2012 vic99999@yandex.ru

## polyglot

Shipped as `server/vendor/polyglot/index.cjs` and `polyglot_sql.wasm`, the
MySQL-to-SQLite translation layer. Its upstream `LICENSE` also ships verbatim
next to it.

- Copyright (c) 2026 TobiLG <github@tobilg.com>

## The MIT License (MIT)

The four components named above are distributed under these terms. The
components bundled *inside* two of them are listed after this licence, and they
are not all MIT.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Bundled inside the PocketBase binaries

PocketBase is a statically linked Go program with its admin UI embedded in the
executable, so shipping the two files in `.runtime/` also ships everything
below. The lists were read out of the shipped binaries themselves — the Go
module graph each one records about itself, and the licence banners left in the
embedded admin-UI assets — not from an upstream dependency list.

### Go modules linked into both binaries (PocketBase 0.40.4)

    github.com/asaskevich/govalidator      v0.0.0-20230301143203-a9d515a09cc2
    github.com/disintegration/imaging       v1.6.2
    github.com/dlclark/regexp2/v2           v2.7.1
    github.com/domodwyer/mailyak/v3         v3.6.2
    github.com/dop251/base64dec             v0.0.0-20231022112746-c6c9f9a96217
    github.com/dop251/goja                  v0.0.0-20260901132549-43234fa61381
    github.com/dop251/goja_nodejs           v0.0.0-20260212111938-1f56ff5bcf14
    github.com/dustin/go-humanize           v1.0.1
    github.com/fatih/color                  v1.19.0
    github.com/fsnotify/fsnotify            v1.10.1
    github.com/gabriel-vasile/mimetype      v1.4.15
    github.com/ganigeorgiev/fexpr           v0.6.0
    github.com/go-sourcemap/sourcemap       v2.1.4+incompatible
    github.com/golang-jwt/jwt/v5            v5.3.1
    github.com/google/pprof                 v0.0.0-20260902005441-ca85771921e4
    github.com/mattn/go-colorable           v0.1.15
    github.com/mattn/go-isatty              v0.0.24
    github.com/pocketbase/dbx               v1.12.0
    github.com/pocketbase/ozzo-validation/v4 v4.3.0
    github.com/remyoudompheng/bigfft        v0.0.0-20230129092748-24d4a6f8daec
    github.com/spf13/cast                   v1.10.0
    github.com/spf13/cobra                  v1.10.2
    github.com/spf13/pflag                  v1.0.10
    golang.org/x/crypto                     v0.57.0
    golang.org/x/image                      v0.46.0
    golang.org/x/net                        v0.59.0
    golang.org/x/oauth2                     v0.36.0
    golang.org/x/sync                       v0.23.0
    golang.org/x/sys                        v0.48.0
    golang.org/x/text                       v0.42.0
    modernc.org/libc                        v1.74.4
    modernc.org/mathutil                    v1.7.1
    modernc.org/memory                      v1.12.0
    modernc.org/sqlite                      v1.57.0

Plus, per platform: `github.com/google/uuid` v1.6.0 in the Linux binary only,
and `github.com/inconshreveable/mousetrap` v1.1.0 and
`github.com/ncruces/go-strftime` v1.0.0 in the Windows binary only. Both also
contain the Go standard library and runtime (`go1.27`), which is distributed by
the Go Authors under a BSD 3-clause licence.

The licence of each module above is the one its own project publishes; this file
does not restate them, and nobody here has verified all 37 one by one. Several
are **not** MIT — `spf13/cobra`, `google/pprof` and
`inconshreveable/mousetrap` are Apache-2.0, the `golang.org/x/*` modules and
`modernc.org/*` are BSD 3-clause, and `go-sourcemap/sourcemap` is BSD 2-clause.
Both Apache-2.0 (§4) and BSD (clause 2) ask a binary redistribution to carry a
copy of the licence and the copyright notice, which this file does not yet do.

### Embedded in PocketBase's admin UI

Two of the admin UI's JavaScript dependencies keep their licence banner in the
shipped bundle, which is inside the executable:

- **TinyMCE 6.8.6** — MIT License, Copyright (c) 2022 Ephox Corporation DBA Tiny
  Technologies, Inc. The MIT text above applies to it.
- **DOMPurify 3.2.4** — (c) Cure53 and other contributors, released under the
  Apache License 2.0 **and** the Mozilla Public License 2.0, at the recipient's
  choice (github.com/cure53/DOMPurify/blob/3.2.4/LICENSE).

### Fonts embedded in PocketBase's admin UI

Seven web fonts are compiled into each binary. They were identified by reading
each face's own OpenType `name` table out of the executable:

- **IBM Plex Mono** 2.3 (Regular, SemiBold) and **IBM Plex Sans** 3.201
  (Regular, Italic, SemiBold, SemiBold Italic). nameID 0 reads "Copyright 2017
  / 2019 IBM Corp. All rights reserved." and carries no nameID 13, but nameID 14
  points at `http://scripts.sil.org/OFL`: these are SIL Open Font License 1.1
  faces, and OFL 1.1 condition 2 requires the copyright notice and the licence
  to travel with every bundled copy. `OFL-IBMPlex.txt`, next to this file in the
  archive, is that copy.
- **Remix Icon** 4.6 (`remixicon.woff2`). The face carries neither a nameID 13
  nor a nameID 14, so its terms cannot be read off the artifact. Upstream
  (github.com/Remix-Design/RemixIcon) now publishes the "Remix Icon License
  v1.0", under which distributing the icons as part of a larger product is
  permitted and attribution is optional; releases of the 4.x era were published
  under Apache-2.0. Which of the two governs this copy has not been established
  here.

## Bundled inside polyglot_sql.wasm

`server/vendor/polyglot/polyglot_sql.wasm` is a 21 MB Rust artifact built with
`wasm-bindgen`, so it carries the Rust standard library and the crates linked
into it. These are the crates whose paths survive in the shipped module, read
from the module itself:

    console_error_panic_hook  0.1.7     js-sys               0.3.85
    dlmalloc                  0.2.13    serde                1.0.228
    hashbrown                 0.17.1    serde_core           1.0.228
    itoa                      1.0.17    serde_json           1.0.149
    serde-wasm-bindgen        0.6.5     wasm-bindgen         0.2.108

That is a lower bound, not an inventory: only crates that left a panic path
behind can be seen this way. The Rust standard library (`library/std`,
`library/core`) is present too. The Rust project and each of those crates
publish dual MIT **or** Apache-2.0 terms; the MIT text above is the option taken
for them here. Nothing in the module is Emscripten or musl output — it contains
no musl libc and no SQLite C code; "MySQL" appears in it only as dialect names
in the translator's own tables.

## SIL Open Font License 1.1

Full text in `OFL-IBMPlex.txt`, shipped beside this file, with IBM's copyright
line as published by the IBM/plex project.
