import path from 'node:path';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { TelegramNotifier } from './telegram';
import { BrowserManager } from './browser-manager';
import { WorkspacePage } from './workspace-page';
import { JobQueue } from './queue';
import { Worker } from './worker';
import { buildServer } from './server';
import { InviteHistory } from './history';
import { TelegramBot } from './telegram-bot';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    filePath: path.join(config.logsDir, 'app.log'),
  });

  logger.info('Khởi động AcceptGPT', {
    membersUrl: config.membersUrl,
    headless: config.headless,
    webhook: `${config.host}:${config.port}${config.webhookPath}`,
  });

  const telegram = new TelegramNotifier(config, logger);
  const browser = new BrowserManager(config, logger);
  const workspace = new WorkspacePage(config, logger);
  const queue = new JobQueue();
  const history = new InviteHistory(config.historyFile, config.dayTzOffsetHours, logger);

  // 1) Mở Chromium bằng persistent profile và mở sẵn trang Members (plan mục 4).
  await browser.start();
  try {
    const page = await browser.getPage();
    await workspace.openMembersPage(page);
    logger.info('Đã mở sẵn trang Members');
  } catch (err) {
    // Lần đầu chạy có thể chưa đăng nhập — không coi là fatal.
    logger.warn('Chưa mở được trang Members lúc khởi động (có thể cần đăng nhập qua noVNC)', { err });
  }

  // 2) Worker tiêu thụ queue tuần tự.
  const worker = new Worker(config, logger, queue, browser, workspace, telegram, history);
  worker.start();

  // 3) Telegram bot poller (nút "/check" báo cáo trong ngày). Độc lập với worker.
  const bot = new TelegramBot(config, logger, history);
  await bot.start();

  // 4) Webhook server.
  const app = buildServer(config, logger, queue);
  await app.listen({ host: config.host, port: config.port });
  logger.info('Webhook server đang lắng nghe', { host: config.host, port: config.port });

  // --- Graceful shutdown --------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn('Nhận tín hiệu dừng, đang tắt service', { signal });

    worker.stop();
    bot.stop();
    try {
      await app.close();
    } catch (err) {
      logger.error('Lỗi khi đóng server', { err });
    }
    try {
      await browser.close();
    } catch (err) {
      logger.error('Lỗi khi đóng browser', { err });
    }

    logger.info('Đã tắt service');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { err });
  });
}

main().catch((err) => {
  // Lỗi lúc khởi động là fatal.
  // eslint-disable-next-line no-console
  console.error('Khởi động thất bại:', err);
  process.exit(1);
});
