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

const SENSITIVE_KEYS = new Set([
  'session', 'authorization', 'apikey', 'supabasesecretkey', 'supabase_secret_key',
  'accesstoken', 'access_token', 'at', 'refreshtoken', 'refresh_token',
  'sessiontoken', 'session_token', 'idtoken', 'id_token', 'password', 'secret',
]);

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED]');
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value instanceof Error) return { name: value.name, message: redactSecretText(value.message), stack: value.stack ? redactSecretText(value.stack) : undefined };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redactSensitive(item)]));
  return typeof value === 'string' ? redactSecretText(value) : value;
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

    const record = redactSensitive({
      time: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(meta ?? {}),
    });

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
