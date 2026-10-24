// The tDB SQL routes answer a bad statement with 400 and { success: false,
// error: "<what SQLite said>" }. The PocketBase SDK builds its
// ClientResponseError message from `response.message`, which these routes do not
// set, so the caller gets "Something went wrong." instead of "no such table:
// players". Dig the real message out.
module.exports = (function () {
  // The SDK's placeholder when the body carries no `message`.
  const GENERIC = "Something went wrong.";

  function describeRouteError(error) {
    const response = error && error.response;

    // What the tDB routes send.
    if (response && response.error) return response.error;

    // What PocketBase's own routes send.
    if (response && response.message && response.message !== GENERIC) {
      return `${response.message}${describeFields(response)}`;
    }

    // Nothing actionable in the body. Rather than passing the SDK's placeholder
    // through - which is what reached a live server as
    // `oxmysql:prepare_async: Something went wrong.` and told its operator
    // nothing at all - say what IS known: how far the request got.
    //
    // status 0 is the SDK's "no HTTP response", so the request never completed:
    // PocketBase starting, restarting, or too busy to answer. That is a
    // different problem from a statement it rejected, and the two were
    // indistinguishable.
    const status = error && typeof error.status === "number" ? error.status : null;

    if (status === 0) {
      return (
        "could not reach the database - the request never completed. PocketBase " +
        "may be starting, restarting, or too busy to answer"
      );
    }

    if (status === 404) {
      return "the database route was not found (status 404) - tDB's pb_hooks may not have loaded";
    }

    if (error?.message && error.message !== GENERIC) {
      return `${error.message}${describeFields(response)}`;
    }

    if (status) {
      return `the database rejected the request with status ${status}, and gave no reason`;
    }

    return String(error);
  }

  // PocketBase answers a validation failure with the generic message "An error
  // occurred while validating the submitted data." and puts the actionable part
  // in `data`, as { field: { code, message } }. Without this an operator is
  // told something failed validation but never which field or why - which is
  // what happened when a backup name containing an uppercase letter was
  // rejected as "Must be in a valid format" and nobody could see the field.
  function describeFields(response) {
    const data = response && response.data;
    if (!data || typeof data !== "object") return "";

    const parts = [];
    for (const [field, detail] of Object.entries(data)) {
      if (!detail || typeof detail !== "object") continue;
      const message = detail.message || detail.code;
      if (message) parts.push(`${field}: ${message}`);
    }

    return parts.length ? ` (${parts.join("; ")})` : "";
  }

  return { describeRouteError };
})();
