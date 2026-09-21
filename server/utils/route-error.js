/**
 * Turning a failed pb.send() into a message worth reading.
 *
 * The tDB SQL routes answer a bad statement with 400 and a body of
 * { success: false, error: "<what SQLite actually said>" }. The PocketBase
 * SDK rejects on that status before any caller sees the body, and builds its
 * ClientResponseError message from `response.message` - which these routes do
 * not set. The result is the useless "Something went wrong." in place of, say,
 * "no such table: players".
 *
 * That matters more than it looks: a script author debugging a query gets the
 * database's own diagnosis or nothing at all.
 */
module.exports = (function () {
  /**
   * @param {Error|object} error A rejected pb.send() error.
   * @returns {string} The most specific message available.
   */
  function describeRouteError(error) {
    const response = error && error.response;

    // What the tDB routes send.
    if (response && response.error) return response.error;

    // What PocketBase's own routes send.
    if (response && response.message && response.message !== "Something went wrong.") {
      return response.message;
    }

    if (error && error.message) return error.message;

    return String(error);
  }

  return { describeRouteError };
})();
