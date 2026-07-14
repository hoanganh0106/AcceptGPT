import { config as loadDotenv } from 'dotenv';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  host: string; port: number; webhookPath: string; webhookSecret: string | null;
  membersUrl: string; telegramBotToken: string; telegramChatId: string; telegramAdminChatId: string;
  browserProfileDir: string; headless: boolean; chromiumExecutablePath: string | null; browserChannel: string | null;
  logsDir: string; screenshotsDir: string; historyFile: string; dayTzOffsetHours: number;
  navTimeoutMs: number; actionTimeoutMs: number; pageLoadRetries: number; telegramRetries: number;
  pendingAppearWaitMs: number; queueCoalesceMs: number; logLevel: LogLevel;
  publicOrigin: string; supabaseUrl: string; supabaseSecretKey: string; adminPassword: string;
  adminSessionSecret: string; cdkHashSecret: string; adminSessionTtlMs: number;
  redeemRateLimitMax: number; loginRateLimitMax: number; rateLimitWindowMs: number; maxQueueDepth: number;
  chatGptBaseUrl: string; chatGptRequestTimeoutMs: number; joinMaxRetries: number; joinRetryBackoffMs: number;
}

export interface ServerConfig {
  host: string; port: number; webhookPath: string; webhookSecret: string | null;
  publicOrigin: string; adminSessionSecret: string; redeemRateLimitMax: number;
  loginRateLimitMax: number; rateLimitWindowMs: number;
}

const requiredFrom = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  return value.trim();
};
const optionalFrom = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => env[name]?.trim() || fallback;
const toIntFrom = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name]?.trim(); if (!raw) return fallback;
  const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new Error(`${name} phải là số nguyên không âm`);
  return value;
};
const toBoolFrom = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase(); if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n'].includes(raw)) return false;
  throw new Error(`${name} phải là boolean`);
};
const absoluteFrom = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const value = optionalFrom(env, name, fallback); return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
};
const httpsUrl = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = requiredFrom(env, name); let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} phải là URL HTTPS hợp lệ`); }
  if (url.protocol !== 'https:') throw new Error(`${name} phải là URL HTTPS`);
  return value.replace(/\/$/, '');
};
const secret = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = requiredFrom(env, name); if (value.length < 32) throw new Error(`${name} phải có ít nhất 32 ký tự`); return value;
};

function parseLogLevel(value: string): LogLevel {
  if (['debug', 'info', 'warn', 'error'].includes(value)) return value as LogLevel;
  throw new Error(`LOG_LEVEL không hợp lệ`);
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const webhookSecret = optionalFrom(env, 'WEBHOOK_SECRET', '');
  const supabaseSecretKey = requiredFrom(env, 'SUPABASE_SECRET_KEY');
  if (!supabaseSecretKey.startsWith('sb_secret_')) throw new Error('SUPABASE_SECRET_KEY phải dùng định dạng sb_secret_');
  return {
    host: optionalFrom(env, 'HOST', '127.0.0.1'), port: toIntFrom(env, 'PORT', 8080), webhookPath: optionalFrom(env, 'WEBHOOK_PATH', '/webhook'), webhookSecret: webhookSecret || null,
    membersUrl: requiredFrom(env, 'MEMBERS_URL'), telegramBotToken: requiredFrom(env, 'TELEGRAM_BOT_TOKEN'), telegramChatId: requiredFrom(env, 'TELEGRAM_CHAT_ID'), telegramAdminChatId: optionalFrom(env, 'TELEGRAM_ADMIN_CHAT_ID', '5846376104'),
    browserProfileDir: absoluteFrom(env, 'BROWSER_PROFILE_DIR', './data/browser-profile'), headless: toBoolFrom(env, 'HEADLESS', false), chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH?.trim() ? absoluteFrom(env, 'CHROMIUM_EXECUTABLE_PATH', '') : null, browserChannel: env.BROWSER_CHANNEL?.trim() || null,
    logsDir: absoluteFrom(env, 'LOGS_DIR', './logs'), screenshotsDir: absoluteFrom(env, 'SCREENSHOTS_DIR', './screenshots'), historyFile: absoluteFrom(env, 'INVITE_HISTORY_FILE', './data/invite-history.json'), dayTzOffsetHours: toIntFrom(env, 'DAY_TZ_OFFSET_HOURS', 7),
    navTimeoutMs: toIntFrom(env, 'NAV_TIMEOUT_MS', 45000), actionTimeoutMs: toIntFrom(env, 'ACTION_TIMEOUT_MS', 15000), pageLoadRetries: toIntFrom(env, 'PAGE_LOAD_RETRIES', 3), telegramRetries: toIntFrom(env, 'TELEGRAM_RETRIES', 3), pendingAppearWaitMs: toIntFrom(env, 'PENDING_APPEAR_WAIT_MS', 8000), queueCoalesceMs: toIntFrom(env, 'QUEUE_COALESCE_MS', 1000), logLevel: parseLogLevel(optionalFrom(env, 'LOG_LEVEL', 'info')),
    publicOrigin: httpsUrl(env, 'PUBLIC_ORIGIN'), supabaseUrl: httpsUrl(env, 'SUPABASE_URL'), supabaseSecretKey, adminPassword: requiredFrom(env, 'ADMIN_PASSWORD'), adminSessionSecret: secret(env, 'ADMIN_SESSION_SECRET'), cdkHashSecret: secret(env, 'CDK_HASH_SECRET'),
    adminSessionTtlMs: toIntFrom(env, 'ADMIN_SESSION_TTL_MS', 8 * 60 * 60 * 1000), redeemRateLimitMax: toIntFrom(env, 'REDEEM_RATE_LIMIT_MAX', 10), loginRateLimitMax: toIntFrom(env, 'LOGIN_RATE_LIMIT_MAX', 5), rateLimitWindowMs: toIntFrom(env, 'RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), maxQueueDepth: toIntFrom(env, 'MAX_QUEUE_DEPTH', 100), chatGptBaseUrl: optionalFrom(env, 'CHATGPT_BASE_URL', 'https://chatgpt.com').replace(/\/$/, ''), chatGptRequestTimeoutMs: toIntFrom(env, 'CHATGPT_REQUEST_TIMEOUT_MS', 30000), joinMaxRetries: toIntFrom(env, 'JOIN_MAX_RETRIES', 3), joinRetryBackoffMs: toIntFrom(env, 'JOIN_RETRY_BACKOFF_MS', 5000),
  };
}

export function toServerConfig(config: AppConfig): ServerConfig {
  return { host: config.host, port: config.port, webhookPath: config.webhookPath, webhookSecret: config.webhookSecret, publicOrigin: config.publicOrigin, adminSessionSecret: config.adminSessionSecret, redeemRateLimitMax: config.redeemRateLimitMax, loginRateLimitMax: config.loginRateLimitMax, rateLimitWindowMs: config.rateLimitWindowMs };
}

let cached: AppConfig | null = null;
export function loadConfig(): AppConfig { if (!cached) { loadDotenv(); cached = parseConfig(process.env); } return cached; }
