"use strict";
const http = require("http");
const { createLogger } = require("./utils/logger");
const config = require("../config");
const log = createLogger("HTTP");
function startStatusServer(bridge) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") { res.writeHead(200); res.end(JSON.stringify({ status: "ok", uptime: process.uptime() })); return; }
    if (req.url === "/status") { res.writeHead(200); res.end(JSON.stringify(bridge.status(), null, 2)); return; }
    res.writeHead(404); res.end(JSON.stringify({ error: "Not found" }));
  });
  server.listen(config.httpPort, () => log.info(`Status server: http://localhost:${config.httpPort}/status`));
  return server;
}
module.exports = { startStatusServer };
