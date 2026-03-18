"use strict";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: "\x1b[36m", info: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m", reset: "\x1b[0m",
};

const config    = require("../../config");
const minLevel  = LEVELS[config.logLevel] ?? LEVELS.info;

function log(level, context, ...args) {
  if (LEVELS[level] < minLevel) return;
  const ts    = new Date().toISOString();
  const color = COLORS[level];
  const label = `[${level.toUpperCase().padEnd(5)}]`;
  const ctx   = context ? `[${context}]` : "";
  console.log(`${color}${ts} ${label}${COLORS.reset} ${ctx}`, ...args);
}

function createLogger(context) {
  return {
    debug: (...a) => log("debug", context, ...a),
    info:  (...a) => log("info",  context, ...a),
    warn:  (...a) => log("warn",  context, ...a),
    error: (...a) => log("error", context, ...a),
  };
}

module.exports = { createLogger };
