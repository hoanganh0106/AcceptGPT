import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './config';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  level: LogLevel;
  /** Nếu có, log JSON được ghi append vào file này (ngoài stdout). */
  filePath?: string | null;
}

/**
 * Logger nhẹ, không phụ thuộc thư viện ngoài.
 * - Ghi JSON một dòng ra stdout để journald thu thập.
 * - Tùy chọn ghi thêm vào file log để tiện xem lại trên VPS.
 */
class JsonLogger implements Logger {
  private readonly threshold: number;
  private readonly stream: fs.WriteStream | null;

  constructor(
    private readonly options: LoggerOptions,
    private readonly bindings: Record<string, unknown> = {},
    stream?: fs.WriteStream | null,
  ) {
    this.threshold = LEVELS[options.level];

    if (stream !== undefined) {
      this.stream = stream;
    } else if (options.filePath) {
      fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
      this.stream = fs.createWriteStream(options.filePath, { flags: 'a' });
    } else {
      this.stream = null;
    }
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < this.threshold) return;

    const record = {
      time: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(meta ?? {}),
    };

    const line = JSON.stringify(record, replaceErrors);
    // stdout -> journald
    process.stdout.write(line + '\n');
    // file (nếu bật)
    this.stream?.write(line + '\n');
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(this.options, { ...this.bindings, ...bindings }, this.stream);
  }
}

/** Serialize Error thành object đọc được thay vì `{}`. */
function replaceErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  return new JsonLogger(options);
}
