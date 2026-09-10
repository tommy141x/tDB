/**
 * Superuser auth token lifecycle management.
 *
 * This is the root of the "Only superusers can perform this action" spam.
 * A superuser token expires and nothing ever replaces it: the old code
 * authenticated once at startup and then held that token for the life of the
 * process. Every call after expiry answers 403 with exactly that message,
 * forever, until the resource restarts - which matches the report exactly
 * ("after a while it's like something expires").
 *
 * Measured on a virgin 0.40.3 data dir (.dev/probe-duration.js):
 *
 *     _superusers.authToken = {"duration": 86400}   // 1 day
 *     users.authToken       = {"duration": 432000}  // 5 days
 *     issued JWT: exp - now = 86400, refreshable: true
 *
 * A day is exactly long enough to look like it works. A FiveM server that is
 * restarted nightly never sees it; one left up over a weekend spams the
 * console from the first day onward.
 *
 * (An earlier version of this comment claimed the default was 10 seconds.
 * That number came from a data dir an older revision of the test harness had
 * itself patched down to 10 in order to watch a token expire, and was then
 * read back as if it were stock. It is 86400. The fix below does not depend
 * on which of the two it is - that is the point of deriving the schedule from
 * the token - but the comment should not have asserted a measurement it did
 * not make cleanly.)
 *
 * Two things follow:
 *
 *   1. Refresh scheduling adapts to whatever lifetime the server hands out.
 *      See scheduleRefresh - the delay comes from the token's own `exp`, so
 *      an operator who shortens or lengthens the setting gets a correct
 *      schedule without tDB knowing the number. The floor that stops a busy
 *      loop sits far below any plausible lifetime, so even a very short token
 *      is refreshed *proactively* rather than in a permanent cycle of
 *      expire-fail-recover.
 *
 *   2. On an instance we own, ensureSuperuserTokenDuration() holds the
 *      setting at a day or more. Against a stock instance that is a no-op;
 *      it exists so an instance whose duration was lowered - by an operator
 *      experimenting in the admin UI, or by tooling - is put back rather than
 *      quietly re-authenticating every few seconds forever. A remote instance
 *      belongs to somebody else and is left alone; there, (1) alone keeps the
 *      session healthy.
 *
 * The token is kept alive along two paths:
 *   - proactively, by refreshing well before `exp` (see scheduleRefresh)
 *   - reactively, via ensureAuthenticated(), which callers use to recover
 *     from a 401/403 and retry
 *
 * Both paths funnel through a single in-flight promise so a burst of failing
 * calls produces one re-authentication, not one per call.
 */
module.exports = (function () {
  const { retryWithBackoff } = require("./utils/process-utils.js");

  const SUPERUSERS_COLLECTION = "_superusers";

  // Refresh once this much of the token's lifetime has elapsed. At 0.75 of a
  // 1 day token that is a refresh roughly every 18h, which leaves three clear
  // retry windows before the token would actually expire.
  const REFRESH_AT_LIFETIME_FRACTION = 0.75;

  // Never schedule a refresh further out than this, so that a mis-parsed or
  // absurdly long `exp` can't disable refreshing entirely.
  const MAX_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000; // 6h

  // Only a floor against busy-looping when `exp` is already in the past. It
  // must stay well below any lifetime an operator might configure: a floor of
  // 30s against a 10s token would put every "proactive" refresh 20s after the
  // token had already expired, turning the proactive path into a permanent
  // 403-and-recover cycle - which is the bug this module exists to prevent.
  const MIN_REFRESH_DELAY_MS = 1000;

  // How long to wait before trying again after a re-authentication failed
  // outright (PocketBase down, wrong credentials). Unrelated to token
  // lifetime, so it does not belong in the clamp above.
  const RETRY_DELAY_MS = 30 * 1000;

  // Fallback cadence used when a token carries no usable `exp` claim.
  const FALLBACK_REFRESH_MS = 60 * 60 * 1000; // 1h

  // The floor tDB holds the `_superusers` token lifetime at on an instance it
  // manages. This is PocketBase's own default, so on a stock instance the
  // check finds it already satisfied and changes nothing. It is a floor, not
  // a target: a longer lifetime an operator chose deliberately is left alone.
  const MANAGED_TOKEN_DURATION_SECONDS = 24 * 60 * 60; // 1 day

  const SUPERUSERS_COLLECTION_PATH = "/api/collections/_superusers";

  /**
   * Decode a JWT's `exp` claim without verifying the signature.
   * We only need the expiry to schedule our own refresh; PocketBase remains
   * the authority on whether the token is actually valid.
   * @returns {number|null} Expiry as epoch milliseconds, or null.
   */
  function getTokenExpiryMs(token) {
    if (typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    try {
      const payload = Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");

      const exp = JSON.parse(payload).exp;
      if (typeof exp !== "number" || !isFinite(exp)) return null;

      return exp * 1000;
    } catch (err) {
      return null;
    }
  }

  /**
   * True for the errors that mean "your token is no longer accepted".
   * PocketBase answers an expired or missing superuser token with 401, and
   * an authenticated-but-insufficient one with 403 ("Only superusers can
   * perform this action"). Both are recoverable by re-authenticating.
   */
  function isAuthError(error) {
    if (!error) return false;
    return error.status === 401 || error.status === 403;
  }

  /**
   * Hold the `_superusers` token lifetime at a sane floor on an instance this
   * resource owns.
   *
   * PocketBase's own default is 86400s, so against a stock instance this
   * reads the collection, sees the floor is already met, and returns false
   * having changed nothing. It earns its place on an instance where the value
   * has been lowered - by an operator trying something in the admin UI, or by
   * tooling - because a service account on a short token means an auth round
   * trip every few seconds for the entire uptime of the server.
   *
   * Only ever raises. A longer lifetime somebody chose on purpose is left
   * alone, and so is a remote instance: that database belongs to somebody
   * else, and silently changing a global security setting on it would be
   * overreach. Adaptive refresh covers that case instead.
   *
   * Failure here is not fatal - it only means refreshes stay frequent - so
   * this reports the outcome rather than throwing.
   *
   * @param {Function} [reauth] Called once if the request is rejected for
   *   authentication. Not paranoia: on the instance this is worth running
   *   against, the token is short, so the very call that fixes the short
   *   token can be the one that outlives it.
   * @returns {Promise<boolean>} true if the duration was raised, which
   *   invalidates nothing but does leave the caller holding a short token
   *   that is worth replacing.
   */
  async function ensureSuperuserTokenDuration(pb, logger, reauth, seconds) {
    const target = seconds || MANAGED_TOKEN_DURATION_SECONDS;
    const log = logger || console;

    const apply = async () => {
      const collection = await pb.send(SUPERUSERS_COLLECTION_PATH, {
        method: "GET",
        requestKey: null,
      });

      const current = collection?.authToken?.duration;
      if (Number(current) >= target) return false;

      await pb.send(SUPERUSERS_COLLECTION_PATH, {
        method: "PATCH",
        body: { authToken: { duration: target } },
        requestKey: null,
      });

      log.debug?.(
        `Superuser token lifetime raised from ${current}s to ${target}s`,
      );
      return true;
    };

    try {
      return await apply();
    } catch (err) {
      if (isAuthError(err) && typeof reauth === "function") {
        try {
          await reauth();
          return await apply();
        } catch (retryErr) {
          err = retryErr;
        }
      }

      log.warn?.(
        `Could not raise the superuser token lifetime (${err.message}) - ` +
          "the session will be refreshed more often instead",
      );
      return false;
    }
  }

  class AuthManager {
    /**
     * @param {object} pb PocketBase client instance
     * @param {{Email: string, Password: string}} credentials
     * @param {object} logger
     */
    constructor(pb, credentials, logger) {
      this.pb = pb;
      this.credentials = credentials;
      this.logger = logger || console;

      this.isAuthenticated = false;
      this.refreshTimer = null;

      // Single-flight guard: concurrent callers share one auth attempt.
      this.pendingAuth = null;

      // Set once the manager is deliberately shut down, so a refresh that is
      // already in flight doesn't reschedule itself afterwards.
      this.stopped = false;
    }

    get hasCredentials() {
      return Boolean(this.credentials?.Email && this.credentials?.Password);
    }

    /**
     * Authenticate for the first time. Retries with backoff because
     * PocketBase may still be binding its port when the resource starts.
     * @returns {Promise<boolean>} whether authentication succeeded
     */
    async start() {
      if (!this.hasCredentials) {
        this.logger.warn(
          "No superuser credentials configured - running unauthenticated",
        );
        return false;
      }

      try {
        await retryWithBackoff(
          () => this._authWithPassword(),
          10, // maxAttempts
          100, // baseDelay
          2000, // maxDelay
        );

        this.isAuthenticated = true;
        this.scheduleRefresh();
        return true;
      } catch (err) {
        this.isAuthenticated = false;
        this.logger.error(`Authentication failed: ${err.message}`);
        return false;
      }
    }

    /**
     * Guarantee a usable token, re-authenticating if the current one is
     * missing, expired, or was just rejected by the server.
     *
     * @param {boolean} force Re-authenticate even if the token still looks
     *   valid locally. Used after a 401/403, where the server has told us
     *   the token is unusable despite an `exp` in the future (for example
     *   after the superuser's password was changed out from under us).
     * @returns {Promise<boolean>}
     */
    async ensureAuthenticated(force = false) {
      if (!this.hasCredentials) return false;

      if (!force && this.pb.authStore.isValid) {
        return true;
      }

      // Join an attempt that is already running rather than starting another.
      if (this.pendingAuth) {
        return this.pendingAuth;
      }

      this.pendingAuth = this._reauthenticate(force).finally(() => {
        this.pendingAuth = null;
      });

      return this.pendingAuth;
    }

    /**
     * Try the cheap path (refresh the existing token) before the expensive
     * one (full password login). A forced re-auth skips straight to the
     * password login, since the server has already rejected the token that
     * authRefresh would present.
     */
    async _reauthenticate(force) {
      if (!force && this.pb.authStore.isValid) {
        try {
          await this.pb
            .collection(SUPERUSERS_COLLECTION)
            .authRefresh({ requestKey: null });

          this.isAuthenticated = true;
          this.scheduleRefresh();
          return true;
        } catch (err) {
          // Fall through to a full login below.
          this.logger.debug?.(
            `Token refresh failed (${err.message}) - re-authenticating`,
          );
        }
      }

      try {
        await retryWithBackoff(
          () => this._authWithPassword(),
          5, // maxAttempts
          250, // baseDelay
          5000, // maxDelay
        );

        if (!this.isAuthenticated) {
          this.logger.info("Superuser session re-established");
        }

        this.isAuthenticated = true;
        this.scheduleRefresh();
        return true;
      } catch (err) {
        this.isAuthenticated = false;
        this.logger.error(`Re-authentication failed: ${err.message}`);

        // Keep trying on the timer so the resource can recover on its own
        // once PocketBase comes back, instead of needing a restart.
        this.scheduleRetry();
        return false;
      }
    }

    _authWithPassword() {
      // requestKey: null opts out of the SDK's auto-cancellation, which would
      // otherwise abort this login if another one is already in flight.
      return this.pb
        .collection(SUPERUSERS_COLLECTION)
        .authWithPassword(this.credentials.Email, this.credentials.Password, {
          requestKey: null,
        });
    }

    /**
     * Schedule the next proactive refresh based on the token's own expiry.
     */
    scheduleRefresh() {
      this.clearTimer();
      if (this.stopped) return;

      const expiryMs = getTokenExpiryMs(this.pb.authStore.token);

      let delay;
      if (expiryMs === null) {
        delay = FALLBACK_REFRESH_MS;
      } else {
        const remaining = expiryMs - Date.now();
        // Refresh after REFRESH_AT_LIFETIME_FRACTION of the *remaining* time,
        // which for a freshly issued token is the same as its lifetime.
        delay = remaining * REFRESH_AT_LIFETIME_FRACTION;
      }

      // Order matters: cap first, then floor. Flooring last guarantees a
      // positive delay for an already-expired token without ever pushing a
      // short-lived token's refresh out past its own expiry.
      delay = Math.max(
        MIN_REFRESH_DELAY_MS,
        Math.min(delay, MAX_REFRESH_DELAY_MS),
      );

      this.refreshTimer = setTimeout(() => {
        this.ensureAuthenticated(true).catch(() => {
          /* _reauthenticate already logged and rescheduled */
        });
      }, delay);

      // Don't hold the event loop open for a timer this long.
      this.refreshTimer.unref?.();
    }

    /**
     * Back off and try again after a failed re-authentication.
     */
    scheduleRetry() {
      this.clearTimer();
      if (this.stopped) return;

      this.refreshTimer = setTimeout(() => {
        this.ensureAuthenticated(true).catch(() => {});
      }, RETRY_DELAY_MS);

      this.refreshTimer.unref?.();
    }

    clearTimer() {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
    }

    stop() {
      this.stopped = true;
      this.clearTimer();
    }
  }

  return {
    AuthManager,
    isAuthError,
    getTokenExpiryMs,
    ensureSuperuserTokenDuration,
    MANAGED_TOKEN_DURATION_SECONDS,
  };
})();
