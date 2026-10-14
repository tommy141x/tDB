// Keeps the superuser session alive.
//
// PocketBase superuser tokens last 86400s by default. Authenticating once at
// startup and holding that token means every call 403s after a day, until the
// resource restarts. The refresh schedule is derived from the token's own exp
// claim, so changing the lifetime in the admin UI does not break it.
module.exports = (function () {
  // Resolved from this file, not the resource root.
  const { retryWithBackoff } = require("./process-utils.js");

  const SUPERUSERS_COLLECTION = "_superusers";

  // At 0.75 of a 1-day token: ~18h, leaving three retry windows before expiry.
  const REFRESH_AT_LIFETIME_FRACTION = 0.75;

  // Caps a mis-parsed or absurdly long exp, which would otherwise stop refreshes.
  const MAX_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000; // 6h

  // Floor against busy-looping on an already-expired exp. Must stay below any
  // lifetime an operator might set, or every refresh lands after expiry.
  const MIN_REFRESH_DELAY_MS = 1000;

  // After an outright auth failure (server down, bad credentials).
  const RETRY_DELAY_MS = 30 * 1000;

  // Used when a token carries no usable exp.
  const FALLBACK_REFRESH_MS = 60 * 60 * 1000; // 1h

  // PocketBase's own default, so this is a no-op on a stock instance. A floor,
  // not a target: a longer lifetime someone chose is left alone.
  const MANAGED_TOKEN_DURATION_SECONDS = 24 * 60 * 60; // 1 day

  const SUPERUSERS_COLLECTION_PATH = "/api/collections/_superusers";

  // Expiry only, unverified - PocketBase stays the authority on validity.
  // Returns epoch ms, or null.
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

  // 401 = expired or missing token, 403 = not a superuser. Both recoverable.
  function isAuthError(error) {
    if (!error) return false;
    return error.status === 401 || error.status === 403;
  }

  // Raise the token lifetime to a sane floor on an instance we own. Only ever
  // raises, never lowers, and never touches a remote instance. Reports failure
  // rather than throwing: it only means refreshes stay frequent.
  //
  // reauth is retried once because the short token this exists to fix can
  // expire during the very call that fixes it.
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
    constructor(pb, credentials, logger) {
      this.pb = pb;
      this.credentials = credentials;
      this.logger = logger || console;

      this.isAuthenticated = false;
      this.refreshTimer = null;

      // Concurrent callers share one auth attempt.
      this.pendingAuth = null;

      // Stops an in-flight refresh from rescheduling after shutdown.
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
