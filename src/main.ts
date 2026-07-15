import path from 'node:path';
import { loadConfig, toServerConfig, type AppConfig } from './config';
import { createLogger, type Logger } from './logger';
import { TelegramNotifier } from './telegram';
import { BrowserManager } from './browser-manager';
import { WorkspacePage } from './workspace-page';
import { JobQueue } from './queue';
import { Worker } from './worker';
import { buildServer } from './server';
import { InviteHistory } from './history';
import { TelegramBot } from './telegram-bot';
import { createSupabaseClient } from './supabase-client';
import { SupabaseCdkStore } from './supabase-store';
import { CdkIssuer } from './cdk-issuer';
import { AdminAuth } from './admin-auth';
import { ChatGptJoinClient } from './chatgpt-join-client';
import { RedemptionService } from './redemption-service';
export async function buildApplication(config: AppConfig, logger: Logger) {
  const client = createSupabaseClient(config); const store = new SupabaseCdkStore(client);
  await store.getInviteWorkspaceId(); await store.markInterrupted();
  const telegram = new TelegramNotifier(config, logger); const browser = new BrowserManager(config, logger); const workspace = new WorkspacePage(config, logger); const queue = new JobQueue(config.maxQueueDepth); const history = new InviteHistory(config.historyFile, config.dayTzOffsetHours, logger);
  await browser.start(); try { await workspace.openMembersPage(await browser.getPage()); } catch (error) { logger.warn('Chưa mở được trang Members lúc khởi động', { err: error }); }
  const worker = new Worker(config, logger, queue, browser, workspace, telegram, history); worker.start();
  const bot = new TelegramBot(config, logger, history); await bot.start();
  const joinClient = new ChatGptJoinClient({ baseUrl: config.chatGptBaseUrl, timeoutMs: config.chatGptRequestTimeoutMs, maxRetries: config.joinMaxRetries, retryBackoffMs: config.joinRetryBackoffMs });
  const redemptions = new RedemptionService({ store, queue, worker, joinClient, cdkHashSecret: config.cdkHashSecret, logger });
  const adminAuth = await AdminAuth.create({ password: config.adminPassword, sessionSecret: config.adminSessionSecret, ttlMs: config.adminSessionTtlMs, publicOrigin: config.publicOrigin });
  const issuer = new CdkIssuer(store, config.cdkHashSecret); const app = buildServer(toServerConfig(config), logger, { queue, worker, redemptions, cdkStore: store, cdkIssuer: issuer, adminAuth });
  return { app, browser, bot, worker, adminAuth };
}
async function main(): Promise<void> {
  const config = loadConfig(); const logger = createLogger({ level: config.logLevel, filePath: path.join(config.logsDir, 'app.log') }); const application = await buildApplication(config, logger); await application.app.listen({ host: config.host, port: config.port }); logger.info('Webhook server đang lắng nghe', { host: config.host, port: config.port });
  let shuttingDown = false; const shutdown = async (signal: string): Promise<void> => { if (shuttingDown) return; shuttingDown = true; logger.warn('Nhận tín hiệu dừng, đang tắt service', { signal }); application.worker.stop(); await application.app.close().catch((error) => logger.error('Lỗi khi đóng server', { err: error })); application.bot.stop(); await application.browser.close().catch((error) => logger.error('Lỗi khi đóng browser', { err: error })); process.exit(0); };
  process.on('SIGINT', () => void shutdown('SIGINT')); process.on('SIGTERM', () => void shutdown('SIGTERM')); process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { err: reason })); process.on('uncaughtException', (error) => logger.error('uncaughtException', { err: error }));
}
main().catch((error) => { console.error('Khởi động thất bại:', error); process.exit(1); });
