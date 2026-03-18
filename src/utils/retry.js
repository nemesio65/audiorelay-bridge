"use strict";

const { createLogger } = require("./logger");
const log = createLogger("Retry");

/**
 * Retry an async function with exponential backoff.
 *
 * @param {function}  fn           - Async function to retry
 * @param {object}    opts
 * @param {string}    opts.name    - Label for logging
 * @param {number}    opts.baseMs  - Initial delay (ms)
 * @param {number}    opts.maxMs   - Max delay cap (ms)
 * @param {number}    opts.max     - Max attempts (0 = infinite)
 * @param {function}  opts.signal  - Optional: returns true to abort
 */
async function retryWithBackoff(fn, opts = {}) {
  const {
    name      = "operation",
    baseMs    = 5000,
    maxMs     = 60000,
    max       = 0,
    signal    = () => false,
  } = opts;

  let attempt = 0;
  let delay   = baseMs;

  while (true) {
    if (signal()) {
      log.info(`${name}: abort signal received, stopping retries`);
      return;
    }

    attempt++;

    try {
      await fn(attempt);
      return; // success
    } catch (err) {
      const isLast = max > 0 && attempt >= max;

      if (isLast) {
        log.error(`${name}: failed after ${attempt} attempts. Last error: ${err.message}`);
        throw err;
      }

      log.warn(`${name}: attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms...`);
      await sleep(delay);

      // Exponential backoff with jitter, capped at maxMs
      delay = Math.min(maxMs, delay * 2) * (0.8 + Math.random() * 0.4);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { retryWithBackoff, sleep };
