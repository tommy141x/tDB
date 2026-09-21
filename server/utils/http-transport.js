/**
 * A fetch-compatible transport built on node:http, and the hook that makes the
 * PocketBase SDK use it.
 *
 * Why this exists
 * ---------------
 * In FiveM's Node runtime (v26.3.0), *every* `fetch()` that carries a request
 * body leaks one unhandled promise rejection:
 *
 *     Unhandled promise rejection in resource tDB
 *     Uncaught TypeError: Invalid state: Reader released
 *       node:internal/webstreams/readablestream(159,19):  lazyReadableReleasedError
 *       node:internal/webstreams/readablestream(2311,30): readableStreamReaderGenericRelease
 *       ...
 *       node:internal/webstreams/readablestream(1902,5):  pullWithDefaultReader
 *       node:internal/webstreams/readablestream(3236,24): readableByteStreamControllerCallPullIfNeeded
 *
 * The request body is wrapped in a byte ReadableStream; when the request
 * finishes, closing that stream releases a reader whose pending read is still
 * pending, and nothing catches the resulting rejection. It is not reachable
 * from user code - there is no promise to attach a handler to.
 *
 * Measured on the live server (.dev/snippets/probe-bodytypes.js, detector
 * .dev/mcp-probe.js):
 *
 *     body: string | Uint8Array | Buffer | ArrayBuffer | Blob | URLSearchParams
 *                                       -> 1 rejection each, every time
 *     no body at all (GET, or POST without one)   -> clean
 *     node:http with the same body                -> clean
 *
 * Status code and path are irrelevant; two POSTs produce two rejections. On
 * Node 24 the same request is clean, so this is specific to the runtime FiveM
 * ships, not to PocketBase and not to tDB.
 *
 * Why it is not just noise: tDB is a drop-in oxmysql replacement, and every
 * query it serves is a POST with a JSON body. Left alone, a busy server prints
 * an eleven-line unhandled-rejection warning *per query*.
 *
 * The SDK resolves its transport as `(options.fetch || fetch)`, so supplying
 * `options.fetch` from a `beforeSend` hook routes everything through here
 * without touching the ~31 call sites in the adapters.
 *
 * Scope: this handles the bodies the SDK actually sends - JSON strings and
 * binary buffers. Anything else (FormData for file uploads, a streaming body)
 * falls back to the global fetch, because correctness there matters more than
 * a console line on a path that runs rarely.
 */
module.exports = (function () {
  const http = require("http");
  const https = require("https");

  // Reuse sockets. This is the hot path for every query the resource serves.
  const agents = {
    "http:": new http.Agent({ keepAlive: true, maxSockets: 64 }),
    "https:": new https.Agent({ keepAlive: true, maxSockets: 64 }),
  };

  const MAX_REDIRECTS = 5;

  /**
   * Can this body be sent as a plain buffer? If not, the caller falls back to
   * the global fetch rather than guessing at the encoding.
   */
  function toBuffer(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === "string") return Buffer.from(body, "utf8");
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return Buffer.from(body.toString(), "utf8");
    }
    return undefined; // "I cannot handle this" - distinct from "there is none"
  }

  /**
   * Accepts a Headers instance, a plain object, or an array of pairs - all
   * three are legal `fetch` input and the SDK passes a plain object.
   */
  function normalizeHeaders(headers) {
    const out = {};
    if (!headers) return out;

    if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }

    for (const [key, value] of Array.isArray(headers)
      ? headers
      : Object.entries(headers)) {
      if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  }

  function abortError() {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    return err;
  }

  /**
   * Only the surface the SDK touches: `status`, `url`, and `json()`. `text()`,
   * `ok` and `headers.get()` are here because they cost nothing and make this
   * usable from anywhere else in the resource.
   */
  function makeResponse(url, res, bodyBuffer) {
    const text = bodyBuffer.toString("utf8");
    return {
      url,
      status: res.statusCode,
      statusText: res.statusMessage || "",
      ok: res.statusCode >= 200 && res.statusCode < 300,
      headers: {
        get: (name) => {
          const value = res.headers[String(name).toLowerCase()];
          return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
        },
        has: (name) => res.headers[String(name).toLowerCase()] !== undefined,
        raw: () => res.headers,
      },
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => bodyBuffer,
    };
  }

  /**
   * A fetch-shaped request over node:http/node:https.
   *
   * @param {string} url
   * @param {object} [options] method, headers, body, signal, redirect
   * @returns {Promise<object>} a Response-like object
   */
  function nodeFetch(url, options = {}) {
    const body = toBuffer(options.body);

    // A body shape this transport does not encode - let the platform do it.
    if (body === undefined) return fetch(url, options);

    return request(url, options, body, 0);
  }

  function request(url, options, body, redirectCount) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch (err) {
        reject(new TypeError(`Invalid URL: ${url}`));
        return;
      }

      const transport = target.protocol === "https:" ? https : http;
      const signal = options.signal;

      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }

      const headers = normalizeHeaders(options.headers);
      if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
        headers["Content-Length"] = String(body.length);
      }

      const req = transport.request(
        target,
        {
          method: (options.method || "GET").toUpperCase(),
          headers,
          agent: agents[target.protocol] || undefined,
        },
        (res) => {
          // Follow redirects ourselves; node:http does not. Remote mode can sit
          // behind a proxy that upgrades http to https.
          const location = res.headers.location;
          if (
            location &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            options.redirect !== "manual" &&
            redirectCount < MAX_REDIRECTS
          ) {
            res.resume(); // discard, or the socket is never freed
            cleanup();
            const next = new URL(location, target).toString();
            // 303, and 301/302 on POST, become a bodyless GET - as fetch does.
            const drops =
              res.statusCode === 303 ||
              ((res.statusCode === 301 || res.statusCode === 302) &&
                (options.method || "GET").toUpperCase() === "POST");
            const nextOptions = drops
              ? { ...options, method: "GET", body: undefined }
              : options;
            request(next, nextOptions, drops ? null : body, redirectCount + 1).then(
              resolve,
              reject,
            );
            return;
          }

          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            cleanup();
            resolve(makeResponse(target.toString(), res, Buffer.concat(chunks)));
          });
          res.on("error", (err) => {
            cleanup();
            reject(err);
          });
        },
      );

      const onAbort = () => {
        req.destroy(abortError());
      };
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      req.on("error", (err) => {
        cleanup();
        reject(err);
      });

      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Point a PocketBase client at this transport.
   *
   * Chains onto any existing `beforeSend` rather than replacing it, because the
   * SDK installs its own wrapper during superuser auth and expects to find the
   * previous hook still in place.
   *
   * @param {object} pb a PocketBase client
   */
  function install(pb) {
    const previous = pb.beforeSend;

    pb.beforeSend = async (url, options) => {
      let result = { url, options };

      if (previous) {
        const chained = Object.assign({}, await previous(url, options));
        result = {
          url: chained.url || url,
          options: chained.options || chained.sendOptions || options,
        };
      }

      // Only set it if the caller has not asked for a specific transport.
      if (!result.options.fetch) result.options.fetch = nodeFetch;

      return result;
    };
  }

  return { nodeFetch, install };
})();
