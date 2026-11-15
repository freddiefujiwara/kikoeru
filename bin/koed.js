#!/usr/bin/env node
'use strict';

const { createServer, loadConfig } = require('../src/server');

const cfg = loadConfig();
const server = createServer(cfg);
server.listen(cfg.port, cfg.host, () => {
  console.log(
    `[koed] listening on http://${cfg.host}:${cfg.port}/<token>/<videoId>`,
  );
});
