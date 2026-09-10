/**
 * Superuser auth token lifecycle management.
 *
 * PocketBase issues `_superusers` tokens with a 1 day lifetime by default
 * (migrations/1640988000_init.go: `superusers.AuthToken.Duration = 86400`),
 * which is a fifth of the 5 day default used by normal auth collections.
 * A FiveM server that stays up longer than that will silently lose its
 * authentication and every subsequent call fails with
 * "Only superusers can perform this action" until the resource is restarted.
 *
 * This module keeps the token alive:
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

  // Refresh once this much of the token's lifetime has elapsed. 0.75 of a
  // 1 day token means a refresh roughly every 18h, which leaves three
  // clear retry windows before the token would actually expire.
  const REFRESH_AT_LIFETIME_FRACTION = 0.75;

  // Never schedule a refresh further out than this, so that a mis-parsed or
  // absurdly long `exp` can't disable refreshing entirely.
  const MAX_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000; // 6h

  // Never busy-loop if `exp` is already in the past or very close.
  const MIN_REFRESH_DELAY_MS = 30 * 1000;

  // Fallback cadence used when a token carries no usable `exp` claim.
  const FALLBACK_REFRESH_MS = 60 * 60 * 1000; // 1h

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
      }, MIN_REFRESH_DELAY_MS);

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

  return { AuthManager, isAuthError, getTokenExpiryMs };
})();
