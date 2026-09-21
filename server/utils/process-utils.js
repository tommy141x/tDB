// Wrap in module.exports function to avoid global scope pollution
module.exports = (function () {
  const { spawn } = require("child_process");

  /**
   * Shared utilities for process management
   * Reduces duplication of process spawning and timeout logic
   */

  /**
   * Spawn a process with timeout and proper cleanup
   * @param {string} command - Command to execute
   * @param {array} args - Command arguments
   * @param {object} options - Spawn options
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<{code, stdout, stderr}>}
   */
  function spawnWithTimeout(command, args, options = {}, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const childProcess = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...options,
      });

      let stdout = "";
      let stderr = "";

      childProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      childProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      childProcess.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({ code, stdout, stderr });
      });

      childProcess.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({ code: -1, stdout, stderr: err.message });
      });

      // Timeout handler
      const timeoutId = setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill("SIGTERM");
          setTimeout(() => {
            if (!childProcess.killed) {
              childProcess.kill("SIGKILL");
            }
          }, 1000);
        }
      }, timeoutMs);
    });
  }

  /**
   * Retry an async function with exponential backoff
   * @param {function} fn - Async function to retry
   * @param {number} maxAttempts - Maximum retry attempts
   * @param {number} baseDelay - Base delay in milliseconds
   * @param {number} maxDelay - Maximum delay cap in milliseconds
   * @returns {Promise<any>} Result of successful attempt
   */
  async function retryWithBackoff(
    fn,
    maxAttempts = 10,
    baseDelay = 100,
    maxDelay = 2000,
  ) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts) {
          const delay = Math.min(
            baseDelay * Math.pow(2, attempt - 1),
            maxDelay,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  // Return the utilities
  return {
    spawnWithTimeout,
    retryWithBackoff,
  };
})();
