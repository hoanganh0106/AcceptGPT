import type { BrowserManager } from './browser-manager';
import type { Logger } from './logger';
import type { Job, JobQueue } from './queue';
import {
  buildErrorMessage,
  buildResultMessage,
  buildSessionExpiredMessage,
  type TelegramNotifier,
} from './telegram';
import type { ProcessOutcome, WorkspacePage } from './workspace-page';

/**
 * Worker xử lý job TUẦN TỰ, một job tại một thời điểm (plan mục 5 & 6).
 * Khi session hết hạn -> dừng hẳn worker và báo Telegram (plan mục 10).
 */
export class Worker {
  private running = false;
  private stopped = false;

  constructor(
    private readonly logger: Logger,
    private readonly queue: JobQueue,
    private readonly browser: BrowserManager,
    private readonly workspace: WorkspacePage,
    private readonly telegram: TelegramNotifier,
  ) {}

  /** Bắt đầu vòng lặp tiêu thụ job (fire-and-forget). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
    this.logger.info('Worker đã bắt đầu');
  }

  /** Yêu cầu dừng (graceful shutdown). Job đang chạy vẫn chạy nốt. */
  stop(): void {
    this.running = false;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const job = await this.queue.take();
      if (!this.running) break;

      this.logger.info('Bắt đầu xử lý job', {
        jobId: job.id,
        emails: job.emails.length,
        queued: this.queue.size,
      });

      const shouldStop = await this.handleJob(job);
      if (shouldStop) {
        this.running = false;
        this.stopped = true;
        this.logger.warn('Worker dừng do session hết hạn — cần đăng nhập lại trên VPS');
        break;
      }
    }
  }

  /** Xử lý một job. Trả về true nếu worker phải dừng (session hết hạn). */
  private async handleJob(job: Job): Promise<boolean> {
    const maxAttempts = 2; // 1 lần thử lại khi nghi crash

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const page = await this.browser.getPage();
        const outcome = await this.workspace.runAcceptFlow(page, job.emails);
        return await this.report(job, outcome);
      } catch (err) {
        if (this.isBrowserCrash(err) && attempt < maxAttempts) {
          this.logger.warn('Nghi ngờ tab/browser crash — khởi động lại rồi thử lại', {
            jobId: job.id,
            attempt,
            err,
          });
          await this.browser.restart().catch((e) => this.logger.error('Restart browser lỗi', { err: e }));
          continue;
        }
        await this.reportError(job, err);
        return false;
      }
    }

    return false;
  }

  /** Gửi Telegram theo kết quả. Trả về true nếu cần dừng worker. */
  private async report(job: Job, outcome: ProcessOutcome): Promise<boolean> {
    switch (outcome.kind) {
      case 'processed': {
        const accepted = outcome.results.filter((r) => r.status === 'accepted').length;
        const notFound = outcome.results.length - accepted;
        this.logger.info('Kết quả duyệt', {
          jobId: job.id,
          accepted,
          notFound,
          count: outcome.count,
        });
        await this.telegram.send(buildResultMessage(outcome.results, outcome.count));
        return false;
      }

      case 'session-expired':
        this.logger.warn('Session hết hạn', { jobId: job.id });
        await this.telegram.send(buildSessionExpiredMessage());
        return true;
    }
  }

  private async reportError(job: Job, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error('Xử lý job thất bại', { jobId: job.id, err });

    // Chụp screenshot phục vụ debug (đặc biệt khi UI đổi).
    try {
      const page = await this.browser.getPage();
      await this.workspace.screenshot(page, `error_${job.id}`);
    } catch (e) {
      this.logger.warn('Không chụp được screenshot cho job lỗi', { err: e });
    }

    await this.telegram.send(buildErrorMessage(job.emails, message.slice(0, 300)));
  }

  /** Nhận diện lỗi do tab/browser chết để quyết định restart & thử lại. */
  private isBrowserCrash(err: unknown): boolean {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return [
      'target closed',
      'target page, context or browser has been closed',
      'has been closed',
      'browser has been closed',
      'page crashed',
      'crash',
      'websocket',
    ].some((needle) => message.includes(needle));
  }
}
