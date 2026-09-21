/**
 * Reconciling PocketBase's SMTP/S3 settings with config.lua.
 *
 * One direction only: config.lua -> PocketBase. Nothing here ever writes
 * config.lua back.
 *
 * That is forced by the platform, not chosen for tidiness. PocketBase omits
 * `smtp.password` and `s3.secret` from GET /api/settings entirely - they come
 * back undefined, not masked. Measured against a real instance; re-prove it
 * with `node .dev/probe-settings-roundtrip.js`:
 *
 *     smtp: {"enabled":true,"port":587,"host":"smtp.example.com",...}
 *     smtp.password returned : undefined
 *     s3.secret returned     : undefined
 *
 * So a sync in the other direction cannot round-trip the only two fields that
 * really matter. It reads undefined, concludes that differs from what
 * config.lua holds, and writes an empty string over a working credential -
 * which the next start then pushes back to the instance, clearing it there
 * too. tDB did exactly that, on every shutdown, for any operator who had SMTP
 * or S3 enabled.
 *
 * Hence three states per block, rather than the two `Enabled` can express:
 *
 *   Manage = false                  tDB does not touch this block. The admin
 *                                   UI owns it and nothing can drift, because
 *                                   nothing is asserted. The default.
 *   Manage = true, Enabled = true   config.lua is the truth; every field is
 *                                   asserted on every boot, secrets included.
 *   Manage = true, Enabled = false  config.lua is still the truth, and the
 *                                   truth is "off". The old code could only
 *                                   ever turn these on - it wrote
 *                                   `enabled: true` or nothing at all, so
 *                                   disabling in config.lua left the instance
 *                                   happily sending mail.
 *
 * When managing, a difference the admin UI introduced is reported before being
 * overwritten. A silent revert is how config.lua ends up describing an
 * instance it does not describe.
 */
module.exports = (function () {
  // Fields PocketBase actually returns, so they can be compared. The secrets
  // are deliberately absent: they are asserted blind because they cannot be
  // read back.
  const COMPARABLE_FIELDS = {
    smtp: ["enabled", "host", "port", "username", "tls", "localName"],
    s3: [
      "enabled",
      "bucket",
      "region",
      "endpoint",
      "accessKey",
      "forcePathStyle",
    ],
  };

  // Non-empty string fields that suggest an operator filled the block in.
  const CONFIGURED_HINTS = {
    smtp: ["Host", "Username", "Password"],
    s3: ["Bucket", "Region", "Endpoint", "AccessKey"],
  };

  function desiredSmtp(smtp) {
    if (!smtp.Enabled) return { enabled: false };
    return {
      enabled: true,
      host: smtp.Host,
      port: smtp.Port,
      username: smtp.Username,
      password: smtp.Password,
      authMethod: "PLAIN",
      tls: smtp.TLS,
      localName: smtp.LocalName || "localhost",
    };
  }

  function desiredS3(s3) {
    if (!s3.Enabled) return { enabled: false };
    return {
      enabled: true,
      bucket: s3.Bucket,
      region: s3.Region,
      endpoint: s3.Endpoint,
      accessKey: s3.AccessKey,
      secret: s3.SecretKey,
      forcePathStyle: s3.ForcePathStyle,
    };
  }

  /**
   * Fields the instance disagrees with config.lua about, as readable strings.
   * Only fields PocketBase returns can be checked, so this never reports a
   * secret - it is for telling the operator what is about to be overwritten,
   * not for deciding whether to overwrite.
   */
  function describeDrift(key, current, desired) {
    const drifted = [];
    for (const field of COMPARABLE_FIELDS[key] || []) {
      if (!(field in desired)) continue;
      const now = current ? current[field] : undefined;
      if (now === undefined) continue; // not returned; nothing to compare
      if (now !== desired[field]) {
        drifted.push(
          `${field}: ${JSON.stringify(now)} -> ${JSON.stringify(desired[field])}`,
        );
      }
    }
    return drifted;
  }

  /** Does this block hold anything the operator plausibly typed? */
  function looksConfigured(block, key) {
    return (CONFIGURED_HINTS[key] || []).some((f) => {
      const v = block[f];
      return typeof v === "string" && v !== "";
    });
  }

  /**
   * Apply config.lua's SMTP/S3 to the instance.
   *
   * Never throws: a settings problem is worth reporting, not worth failing a
   * database resource over.
   *
   * @param {object} api `{ getSettings(), updateSettings(patch) }`
   * @param {object} advanced `config.Advanced`
   * @param {object} logger
   * @returns {Promise<{managed: string[], drift: string[], warnings: string[], ignored: string[]}>}
   */
  async function reconcile(api, advanced, logger) {
    const result = { managed: [], drift: [], warnings: [], ignored: [] };
    const blocks = [
      ["smtp", advanced.SMTP, desiredSmtp],
      ["s3", advanced.S3, desiredS3],
    ];

    // Say so when a filled-in block is not being applied, rather than letting
    // the operator believe config.lua describes the instance.
    for (const [key, block] of blocks) {
      if (!block.Manage && looksConfigured(block, key)) {
        const message =
          `${key.toUpperCase()} settings in config.lua are not applied ` +
          `(Manage = false) - the admin UI owns them`;
        result.ignored.push(key);
        logger.info(message);
      }
    }

    const managed = blocks.filter(([, block]) => block.Manage);
    if (!managed.length) return result;

    try {
      const current = (await api.getSettings()) || {};
      const updates = {};

      for (const [key, block, build] of managed) {
        const desired = build(block);
        const drifted = describeDrift(key, current[key], desired);

        if (drifted.length) {
          const message =
            `${key.toUpperCase()} on the instance differs from config.lua and is ` +
            `being overwritten (config.lua wins while Manage = true): ` +
            drifted.join(", ");
          result.drift.push(message);
          result.warnings.push(message);
          logger.warn(message);
        }

        // Asserted whole and unconditionally. A field-by-field comparison
        // cannot see the secrets, so it would skip a rotated password - which
        // is how the old code kept using a credential the operator had already
        // replaced in config.lua.
        updates[key] = desired;
        result.managed.push(key);
      }

      await api.updateSettings(updates);
      logger.debug?.(
        `PocketBase settings asserted from config.lua: ${Object.keys(updates).join(", ")}`,
      );
    } catch (err) {
      const message = `Failed to apply settings from config.lua: ${err.message}`;
      result.warnings.push(message);
      logger.warn(message);
    }

    return result;
  }

  return {
    COMPARABLE_FIELDS,
    desiredSmtp,
    desiredS3,
    describeDrift,
    looksConfigured,
    reconcile,
  };
})();
