export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private level: number;
  constructor(level: LogLevel = "info") {
    this.level = LEVELS[level] ?? LEVELS.info;
  }
  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < this.level) return;
    const line = `[${level.toUpperCase()}] ${msg}`;
    const suffix = fields ? " " + JSON.stringify(fields) : "";
    console.error(line + suffix);
  }
  debug(msg: string, fields?: Record<string, unknown>) { this.write("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>) { this.write("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>) { this.write("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>) { this.write("error", msg, fields); }
}
