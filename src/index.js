"use strict";

require("dotenv").config();

const PersistentDiscordClient     = require("./discord/persistentClient");
const { PersistentBridge }        = require("./relay/persistentBridge");
const { startStatusServer }       = require("./statusServer");
const { createLogger }            = require("./utils/logger");

const log = createLogger("Main");

async function main() {
  // Config is validated on require — throws early on missing vars
  require("../config");

  const discord = new PersistentDiscordClient();
  const bridge  = new PersistentBridge(discord);

  // HTTP status endpoint
  const httpServer = startStatusServer(bridge);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info(`\n${signal} received — shutting down...`);
    try {
      await bridge.stop();
      httpServer.close();
      log.info("Goodbye.");
      process.exit(0);
    } catch (err) {
      log.error("Error during shutdown:", err.message);
      process.exit(1);
    }
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (r) => log.error("Unhandled rejection:", r));

  try {
    // Bridge handles everything: Matrix sync, Discord voice, call loop
    await bridge.start();
  } catch (err) {
    log.error("Fatal error:", err.message);
    log.error(err.stack);
    process.exit(1);
  }
}

main();