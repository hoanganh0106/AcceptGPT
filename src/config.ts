import { config as loadDotenv } from 'dotenv';
import path from 'node:path';

loadDotenv();

/**
 * Cấu hình toàn cục của service, đọc một lần khi khởi động từ biến môi trường.
 * Mọi giá trị nhạy cảm (Telegram token, secret) chỉ nằm trong `.env`.
 */
export interface AppConfig {
  host: string;
  port: number;
  webhookPath: string;
  webhookSecret: string | null;

  membersUrl: string;

  telegramBotToken: string;
  telegramChatId: string;

  browserProfileDir: string;
  headless: boolean;
  chromiumExecutablePath: string | null;
  /** Kênh trình duyệt Playwright, vd 'chrome' để dùng Google Chrome thật (ít bị CAPTCHA hơn). */
  browserChannel: string | null;

  logsDir: string;
  screenshotsDir: string;
  /** File JSON lưu lịch sử email đã mời theo ngày (cho tính năng /check). */
  historyFile: string;
  /** Lệch múi giờ (giờ) để tính mốc "trong ngày". VN = 7. */
  dayTzOffsetHours: number;

  navTimeoutMs: number;
  actionTimeoutMs: number;
  pageLoadRetries: number;
  telegramRetries: number;
  /** Thời gian chờ (ms) một email xuất hiện trong danh sách chờ trước khi kết luận không thấy. */
  pendingAppearWaitMs: number;

  logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function toInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Biến môi trường ${name} phải là số nguyên không âm, nhận: "${raw}"`);
  }
  return parsed;
}

function toBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Biến môi trường ${name} phải là boolean (true/false), nhận: "${raw}"`);
}

function toAbsolute(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function parseLogLevel(raw: string): LogLevel {
  const normalized = raw.toLowerCase();
  if (['debug', 'info', 'warn', 'error'].includes(normalized)) {
    return normalized as LogLevel;
  }
  throw new Error(`LOG_LEVEL không hợp lệ: "${raw}" (dùng debug|info|warn|error)`);
}

let cached: AppConfig | null = null;

/** Đọc và validate cấu hình. Ném lỗi ngay nếu thiếu biến bắt buộc. */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const secretRaw = optional('WEBHOOK_SECRET', '');
  const executableRaw = optional('CHROMIUM_EXECUTABLE_PATH', '');
  const channelRaw = optional('BROWSER_CHANNEL', '');

  cached = {
    host: optional('HOST', '127.0.0.1'),
    port: toInt('PORT', 8080),
    webhookPath: optional('WEBHOOK_PATH', '/webhook'),
    webhookSecret: secretRaw === '' ? null : secretRaw,

    membersUrl: required('MEMBERS_URL'),

    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),

    browserProfileDir: toAbsolute(optional('BROWSER_PROFILE_DIR', './data/browser-profile')),
    headless: toBool('HEADLESS', false),
    chromiumExecutablePath: executableRaw === '' ? null : toAbsolute(executableRaw),
    browserChannel: channelRaw === '' ? null : channelRaw,

    logsDir: toAbsolute(optional('LOGS_DIR', './logs')),
    screenshotsDir: toAbsolute(optional('SCREENSHOTS_DIR', './screenshots')),
    historyFile: toAbsolute(optional('INVITE_HISTORY_FILE', './data/invite-history.json')),
    dayTzOffsetHours: toInt('DAY_TZ_OFFSET_HOURS', 7),

    navTimeoutMs: toInt('NAV_TIMEOUT_MS', 45000),
    actionTimeoutMs: toInt('ACTION_TIMEOUT_MS', 15000),
    pageLoadRetries: toInt('PAGE_LOAD_RETRIES', 3),
    telegramRetries: toInt('TELEGRAM_RETRIES', 3),
    pendingAppearWaitMs: toInt('PENDING_APPEAR_WAIT_MS', 8000),

    logLevel: parseLogLevel(optional('LOG_LEVEL', 'info')),
  };

  return cached;
}
