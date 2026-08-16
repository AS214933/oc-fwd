#!/usr/bin/env bun
/**
 * Status UI entrypoint.
 */
import { Logger } from "../log";
import { loadStatusConfig, startStatusUI } from "../status/server";

const cfg = loadStatusConfig();
const log = new Logger((process.env.LOG_LEVEL as never) ?? "info");
const server = startStatusUI(cfg, log);
const shutdown = () => {
  server.stop(true);
  setTimeout(() => process.exit(0), 100);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
