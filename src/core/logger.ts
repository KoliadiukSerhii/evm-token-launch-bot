import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { describeError } from "./errors.js";

type Level = "info" | "warn" | "error";
type AlertSink = (text: string) => void;

const LOG_DIR = resolve(process.cwd(), "logs");

function serialize(data: unknown): string {
  return JSON.stringify(data, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

class Logger {
  private stream: WriteStream | null = null;
  private streamDay = "";
  private alertSink: AlertSink | null = null;

  constructor() {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  setAlertSink(sink: AlertSink): void {
    this.alertSink = sink;
  }

  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }

  error(message: string, error?: unknown): void {
    this.write(
      "error",
      message,
      error === undefined ? undefined : { error: describeError(error) },
    );
  }

  alert(message: string, data?: unknown): void {
    this.write("info", message, data);
    this.alertSink?.(
      data === undefined ? message : `${message}\n${serialize(data)}`,
    );
  }

  alertError(message: string, error: unknown): void {
    const detail = describeError(error);
    this.write("error", message, { error: detail });
    this.alertSink?.(`❌ ${message}\n${detail}`);
  }

  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    return new Promise((done) => (stream ? stream.end(done) : done()));
  }

  private write(level: Level, message: string, data?: unknown): void {
    const now = new Date();
    const suffix = data === undefined ? "" : ` ${serialize(data)}`;
    const line = `${now.toISOString()} [${level.toUpperCase()}] ${message}${suffix}`;

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    this.fileFor(now)?.write(`${line}\n`);
  }

  private fileFor(now: Date): WriteStream | null {
    const day = now.toISOString().slice(0, 10);
    if (this.stream && this.streamDay === day) return this.stream;
    this.stream?.end();
    this.streamDay = day;
    this.stream = createWriteStream(resolve(LOG_DIR, `bot-${day}.log`), {
      flags: "a",
    });
    this.stream.on("error", (error) =>
      console.error(`log file unavailable: ${describeError(error)}`),
    );
    return this.stream;
  }
}

export const log = new Logger();
