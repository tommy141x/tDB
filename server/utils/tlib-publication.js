// Publishing the admin UI through tLib's router, and keeping that claim honest.
//
// Health is probed against the status snapshot's localUrl, never the public
// origin: behind a reverse proxy (the normal deployment) the public origin is
// https://host with no port while the listener sits on loopback elsewhere, so
// deriving a port from it dialled 127.0.0.1:443 and called a working route dead.
//
// Publication is a state machine, not a startup question. tLib's listener can
// still be coming up when PocketBase is ready, and can go away later.
// RegisterWebApp against a not-ready tLib returns {ok:false, retryable:true} and
// reserves nothing; that is pending, and reporting it as a refusal sends the
// operator to debug a non-problem. Registration retries on ready and on a tLib
// restart, and a confirmed publication is cleared when tLib goes not-ready,
// since the mount is gone.
//
// Callers must subscribe to the status events before querying current status, or
// a transition landing between the two is lost.
//
// No FiveM globals here; everything is injected so this is testable offline.
module.exports = (function () {
  const HEALTH_PATH = "/api/health";

  // Anything unusable becomes not-ready rather than throwing: a malformed
  // snapshot must not take the database down.
  function normalizeStatus(raw) {
    if (!raw || typeof raw !== "object") {
      return {
        ready: false,
        listenerState: null,
        publicUrlState: null,
        publicUrl: null,
        localUrl: null,
        error: null,
      };
    }
    return {
      // The contract's single gate. A truthy localUrl is no substitute; the
      // listener can be up while the public URL is still resolving.
      ready: raw.ready === true,
      listenerState: raw.listenerState || null,
      publicUrlState: raw.publicUrlState || null,
      publicUrl: raw.publicUrl || null,
      localUrl: raw.localUrl || null,
      error: raw.error || null,
    };
  }

  // Null when there is nothing to dial, never an invented localhost default.
  function healthUrl(status, mount) {
    const local = status && status.localUrl;
    if (!local) return null;
    return `${String(local).replace(/\/+$/, "")}${mount}${HEALTH_PATH}`;
  }

  // A log phrase naming which half is not up.
  function describeNotReady(status) {
    if (!status) return "tLib reported no HTTP status";
    if (status.error) return status.error;
    if (status.listenerState && status.listenerState !== "listening") {
      return `tLib's HTTP listener is ${status.listenerState}`;
    }
    if (status.publicUrlState && status.publicUrlState !== "ready") {
      return `tLib's public URL is ${status.publicUrlState}`;
    }
    return "tLib's HTTP is not ready";
  }

  // deps: { mount, register, logger, onPublished(url), onUnpublished(reason),
  // onWarning(text) }. onWarning is operator-facing and fires only for real
  // refusals, never for "still starting".
  function createPublisher(deps) {
    const { mount, register, logger } = deps;
    const onPublished = deps.onPublished || (() => {});
    const onUnpublished = deps.onUnpublished || (() => {});
    const onWarning = deps.onWarning || (() => {});

    let wanted = false;
    let published = false;
    let publishedUrl = null;
    let pending = false;
    let status = normalizeStatus(null);
    // Once per cause; status events repeat and the operator does not need the
    // same line every time tLib twitches.
    let warnedPendingFor = null;

    function attempt() {
      if (!wanted || published) return published;

      if (!status.ready) {
        pending = true;
        const reason = describeNotReady(status);
        if (warnedPendingFor !== reason) {
          warnedPendingFor = reason;
          logger.debug?.(`Admin UI mount deferred - ${reason}`);
        }
        return false;
      }

      let result;
      try {
        result = register();
      } catch (err) {
        pending = false;
        onWarning(`Could not register with tLib: ${err.message}`);
        return false;
      }

      if (result && result.ok === true) {
        // An accepted mount with no URL is useless: the caller would fall back
        // to printing the loopback address, a link that works only from a shell
        // on the server. Treat it as a refusal.
        const url = typeof result.url === "string" ? result.url.trim() : "";
        if (!url) {
          pending = false;
          onWarning(
            `tLib accepted the ${mount} mount but returned no URL for it - ` +
              `the admin UI cannot be advertised`,
          );
          return false;
        }

        published = true;
        pending = false;
        warnedPendingFor = null;
        publishedUrl = url;
        logger.debug?.(`Admin UI published at ${publishedUrl}`);
        onPublished(publishedUrl);
        return true;
      }

      // Pending, not refused: no mount was reserved and tLib will signal ready.
      if (result && result.retryable === true) {
        pending = true;
        const reason = (result && result.error) || describeNotReady(status);
        if (warnedPendingFor !== reason) {
          warnedPendingFor = reason;
          logger.debug?.(`Admin UI mount pending - ${reason}`);
        }
        return false;
      }

      pending = false;
      onWarning(
        `tLib refused the ${mount} mount: ${(result && result.error) || "unknown error"}`,
      );
      return false;
    }

    function clearPublication(reason) {
      if (!published) return;
      published = false;
      publishedUrl = null;
      // Still wanted, so the next ready signal re-attempts.
      pending = wanted;
      logger.warn?.(`Admin UI is no longer published - ${reason}`);
      onUnpublished(reason);
    }

    return {
      get published() {
        return published;
      },
      get publishedUrl() {
        return publishedUrl;
      },
      get pending() {
        return pending;
      },
      get status() {
        return status;
      },

      // Headless and remote pass false.
      want(value) {
        wanted = value === true;
        if (!wanted) pending = false;
      },

      healthUrl() {
        return healthUrl(status, mount);
      },

      // Ready re-attempts a wanted-but-unpublished mount, not-ready withdraws a
      // confirmed one.
      handleStatus(raw) {
        status = normalizeStatus(raw);
        if (!status.ready) {
          clearPublication(describeNotReady(status));
          // Set even if nothing was published: a never-claimed mount is pending
          // too, and callers read this to tell "waiting" from "failed".
          pending = wanted;
          return false;
        }
        return attempt();
      },

      // tLib's registry went with it, so the mount has to be claimed again.
      handleTLibRestart() {
        if (published) {
          published = false;
          publishedUrl = null;
          pending = wanted;
          onUnpublished("tLib restarted");
        }
        status = normalizeStatus(null);
        warnedPendingFor = null;
      },

      attempt,
    };
  }

  return { normalizeStatus, healthUrl, describeNotReady, createPublisher, HEALTH_PATH };
})();
