# Third-party notices

tDB redistributes the components below. Each is MIT licensed, and MIT requires
the copyright notice and permission notice to travel with every copy -- which
is what this file is. It ships inside the release archive alongside them.

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

All four components above are distributed under these terms.

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
