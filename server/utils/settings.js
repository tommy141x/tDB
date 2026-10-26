// S3 storage settings, config.lua -> PocketBase and never back.
//
// One direction because PocketBase omits `s3.secret` from GET /api/settings
// entirely; it comes back undefined, not masked (re-prove with
// `node tests/dev/probe-settings-roundtrip.js`). A reverse sync reads undefined,
// calls it drift, and blanks a working credential on both sides.
//
// So the block has three states, not the two `Enabled` can express: Manage =
// false leaves it alone and the admin UI owns it (default); Manage = true
// asserts config.lua wholesale on every boot, `Enabled = false` included.
// Drift the admin UI introduced is reported before it is overwritten.
//
// Mail is the admin UI's alone; see the note in config-loader.js.
module.exports = (function () {
  // Fields PocketBase actually returns, so they can be compared. The secrets
  // are not among them: they cannot be read back, so they are asserted blind.
  const COMPARABLE_FIELDS = {
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
    s3: ["Bucket", "Region", "Endpoint", "AccessKey"],
  };

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

  // Readable strings for the operator, not an input to the overwrite decision:
  // only fields PocketBase returns can be compared, so secrets never appear.
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

  // Has the operator asked for something this block is not delivering?
  //
  // ⚠️ `Enabled` first. Filled-in fields alone used to be enough, so a block
  // that is switched OFF still warned it was "not applied" - true and
  // meaningless, since desiredS3 reduces it to `{enabled: false}` either way.
  // It fired on stock installs still carrying a template value, putting a
  // permanent yellow `Running with warnings` on a healthy server.
  function looksConfigured(block, key) {
    if (!block.Enabled) return false;
    return (CONFIGURED_HINTS[key] || []).some((f) => {
      const v = block[f];
      return typeof v === "string" && v !== "";
    });
  }

  // Apply config.lua's S3 block to the instance. `api` is
  // `{ getSettings(), updateSettings(patch) }`. Never throws; a settings problem
  // is not worth failing a database resource over.
  async function reconcile(api, advanced, logger) {
    const result = { managed: [], drift: [], warnings: [], ignored: [] };
    const blocks = [["s3", advanced.S3, desiredS3]];

    // Say so when a filled-in block is not applied, so an operator does not
    // keep believing config.lua describes the instance.
    //
    // A warning ROW, not a loose `logger.info` line above the banner in the
    // green that means "normal" - this is a config file disagreeing with the
    // running instance. reconcileSettings() drains `result.warnings` into the
    // banner.
    for (const [key, block] of blocks) {
      if (!block.Manage && looksConfigured(block, key)) {
        result.ignored.push(key);
        result.warnings.push(
          `${key.toUpperCase()} settings in config.lua are not applied ` +
            `(Manage = false) - the admin UI owns them`,
        );
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
          // Banner row only. Pushing to `warnings` AND calling logger.warn
          // printed the same sentence twice: once loose above the box and once
          // inside it.
          result.warnings.push(message);
        }

        // Whole and unconditional: a field-by-field diff cannot see the secrets,
        // so it would skip a rotated password.
        updates[key] = desired;
        result.managed.push(key);
      }

      await api.updateSettings(updates);
      logger.debug?.(
        `PocketBase settings asserted from config.lua: ${Object.keys(updates).join(", ")}`,
      );
    } catch (err) {
      // Banner row only, as above.
      result.warnings.push(`Failed to apply settings from config.lua: ${err.message}`);
    }

    return result;
  }

  return {
    desiredS3,
    describeDrift,
    reconcile,
  };
})();
