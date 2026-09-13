/**
 * Publishing the admin UI through tLib's router, and keeping that claim honest.
 *
 * Two things changed and both matter here.
 *
 * 1. Health is checked against tLib's ACTUAL listener, not its public origin.
 *    tDB used to derive the router's port from GetHubUrl() and fall back to
 *    `https: ? 443 : 80` when the URL carried no explicit port. Behind a
 *    reverse proxy - which is the normal deployment - the public origin is
 *    https://host with no port while the listener is on loopback somewhere
 *    else entirely, so the probe dialled 127.0.0.1:443, got nothing, and
 *    reported the admin route broken while it was working perfectly. The
 *    status snapshot now carries localUrl, so there is nothing left to guess.
 *
 * 2. Publication is no longer a one-shot question answered at startup.
 *    tLib's HTTP listener can still be coming up when PocketBase is ready, and
 *    it can go away later. So:
 *
 *      - RegisterWebApp while tLib is not ready returns
 *        {ok:false, retryable:true} and reserves nothing. That is PENDING, not
 *        refused, and must not be reported to the operator as a refusal -
 *        "tLib refused the /db mount" for something that is merely still
 *        starting sends people to debug a non-problem.
 *      - Registration is retried when tLib signals ready, and when the tLib
 *        resource restarts.
 *      - A confirmed publication is CLEARED when tLib goes not-ready, because
 *        the mount no longer exists. Continuing to print an Admin URL for a
 *        route that is gone is the same class of lie as (1).
 *
 * The ordering rule from the contract is subscribe-then-query: take the event
 * subscription before asking for the current status, so a transition landing
 * between the two is caught by the subscription rather than lost.
 *
 * This module holds no FiveM globals - everything is injected - so the state
 * machine can be tested without a running server.
 */
module.exports = (function () {
  const HEALTH_PATH = "/api/health";

  /**
   * Normalise a status snapshot. Anything unusable becomes not-ready rather
   * than throwing: a malformed snapshot must not take the database down.
   *
   * @param {object|null} raw
   * @returns {{ready: boolean, listenerState: string|null, publicUrlState: string|null,
   *            publicUrl: string|null, localUrl: string|null, error: string|null}}
   */
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
      // ready is the contract's single gate. A truthy localUrl is not a
      // substitute: the listener can be up while the public URL is still
      // resolving, and tLib decides when that combination counts as ready.
      ready: raw.ready === true,
      listenerState: raw.listenerState || null,
      publicUrlState: raw.publicUrlState || null,
      publicUrl: raw.publicUrl || null,
      localUrl: raw.localUrl || null,
      error: raw.error || null,
    };
  }

  /**
   * Where to probe the mount. Uses the local listener deliberately - see the
   * header. Returns null when there is nothing to dial, rather than inventing
   * a localhost default, which is the mistake this replaces.
   */
  function healthUrl(status, mount) {
    const local = status && status.localUrl;
    if (!local) return null;
    return `${String(local).replace(/\/+$/, "")}${mount}${HEALTH_PATH}`;
  }

  /**
   * A short phrase for why publication has not happened, for the log. Reads
   * off the state fields so the operator is told which half is not up.
   */
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

  /**
   * The publication state machine.
   *
   * @param {object} deps
   * @param {string} deps.mount the mount path, e.g. "/db"
   * @param {function} deps.register performs RegisterWebApp, returns its result
   * @param {object} deps.logger
   * @param {function} [deps.onPublished] called with the public URL when a
   *   mount is confirmed
   * @param {function} [deps.onUnpublished] called with a reason when a
   *   previously confirmed mount is withdrawn
   * @param {function} [deps.onWarning] called with operator-facing text; only
   *   for real refusals, never for "still starting"
   */
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
    // Only warn once per cause; status events can arrive repeatedly and an
    // operator does not need the same line every time tLib twitches.
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
        // An accepted mount with no URL is not something to celebrate. The
        // caller's whole use for this is to print a link, and with nothing to
        // print it would fall back to showing the loopback address under
        // "Admin" - a link that works from a shell on the server and nowhere
        // else. Treat it as a refusal and say what happened.
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

      // Pending, not refused. No mount was reserved and tLib will tell us when
      // it is ready; saying "refused" here would be wrong and alarming.
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

      /** Whether a mount is wanted at all. Headless and remote pass false. */
      want(value) {
        wanted = value === true;
        if (!wanted) pending = false;
      },

      healthUrl() {
        return healthUrl(status, mount);
      },

      /**
       * Apply a status snapshot. Ready re-attempts a wanted-but-unpublished
       * mount; not-ready withdraws a confirmed one.
       */
      handleStatus(raw) {
        status = normalizeStatus(raw);
        if (!status.ready) {
          clearPublication(describeNotReady(status));
          // Set regardless of whether anything was published. A mount that has
          // never been claimed because tLib is still starting is pending too,
          // and callers read this to tell "waiting" from "failed".
          pending = wanted;
          return false;
        }
        return attempt();
      },

      /**
       * tLib restarted. Its registry went with it, so whatever we held is void
       * and has to be claimed again.
       */
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
