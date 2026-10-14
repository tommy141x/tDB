// The tDB SQL routes answer a bad statement with 400 and { success: false,
// error: "<what SQLite said>" }. The PocketBase SDK builds its
// ClientResponseError message from `response.message`, which these routes do not
// set, so the caller gets "Something went wrong." instead of "no such table:
// players". Dig the real message out.
module.exports = (function () {
  function describeRouteError(error) {
    const response = error && error.response;

    // What the tDB routes send.
    if (response && response.error) return response.error;

    // What PocketBase's own routes send.
    if (response && response.message && response.message !== "Something went wrong.") {
      return `${response.message}${describeFields(response)}`;
    }

    if (error && error.message) return `${error.message}${describeFields(response)}`;

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
