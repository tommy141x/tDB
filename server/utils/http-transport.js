// A fetch-shaped transport over node:http, plus the hook that points the
// PocketBase SDK at it.
//
// On FiveM's Node runtime (v26.3.0) every `fetch()` carrying a request body
// leaks exactly one unhandled rejection ("Invalid state: Reader released"),
// thrown from inside the webstreams body wrapper where no user code can catch
// it. Measured with tests/dev/snippets/probe-bodytypes.js: any body type does it,
// no body is clean, node:http with the same body is clean, and Node 24 is
// clean. Every tDB query is a POST with a JSON body, so untreated this is an
// eleven-line warning per query.
//
// The SDK resolves its transport as `(options.fetch || fetch)`, so setting
// `options.fetch` in `beforeSend` covers all ~31 adapter call sites at once.
// Bodies this cannot encode (FormData, streams) fall back to global fetch.
module.exports = (function () {
  const http = require("http");
  const https = require("https");

  // Reuse sockets. This is the hot path for every query the resource serves.
  const agents = {
    "http:": new http.Agent({ keepAlive: true, maxSockets: 64 }),
    "https:": new https.Agent({ keepAlive: true, maxSockets: 64 }),
  };

  const MAX_REDIRECTS = 5;

  // Buffer, null for "no body", or undefined for "not mine" - see nodeFetch.
  function toBuffer(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === "string") return Buffer.from(body, "utf8");
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return Buffer.from(body.toString(), "utf8");
    }
    return undefined; // cannot encode this, distinct from having none
  }

  // Headers instance, plain object or array of pairs; all three are legal fetch
  // input. The SDK passes a plain object.
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

  // The SDK only touches status, url and json(). The rest is free and makes this
  // usable elsewhere in the resource.
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

  // options: method, headers, body, signal, redirect.
  function nodeFetch(url, options = {}) {
    const body = toBuffer(options.body);

    // A body shape this transport does not encode, let the platform do it.
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
          // node:http does not follow redirects. Remote mode can sit behind a
          // proxy that upgrades http to https.
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
            // 303, and 301/302 on POST, become a bodyless GET, as fetch does.
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

  // Chains onto any existing `beforeSend` rather than replacing it: the SDK
  // installs its own wrapper during superuser auth and expects the previous hook
  // to still be there.
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

      // Leave a transport the caller asked for alone.
      if (!result.options.fetch) result.options.fetch = nodeFetch;

      return result;
    };
  }

  return { nodeFetch, install };
})();
