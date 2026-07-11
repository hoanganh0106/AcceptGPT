import type { AppConfig } from './config';
import type { BrowserManager } from './browser-manager';
import type { InviteHistory } from './history';
import type { Logger } from './logger';
import type { Job, JobQueue } from './queue';
import {
  buildErrorMessage,
  buildResultMessage,
  buildSessionExpiredMessage,
  type TelegramNotifier,
} from './telegram';
import type { ProcessOutcome, WorkspacePage } from './workspace-page';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Worker xử lý job TUẦN TỰ (plan mục 5 & 6). Nhiều webhook tới sát nhau được GOM thành một
 * loạt (coalesce) và xử lý trong MỘT lần mở trang, tránh reload liên tục.
 * Khi session hết hạn -> dừng hẳn worker và báo Telegram (plan mục 10).
 */
export class Worker {
  private running = false;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly queue: JobQueue,
    private readonly browser: BrowserManager,
    private readonly workspace: WorkspacePage,
    private readonly telegram: TelegramNotifier,
    private readonly history: InviteHistory,
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
      const first = await this.queue.take();
      if (!this.running) break;

      // Gom thêm các webhook tới ngay sau đó (cùng lúc) để xử lý một lượt, một lần reload.
      if (this.config.queueCoalesceMs > 0) await sleep(this.config.queueCoalesceMs);
      const jobs = [first, ...this.queue.drainAll()];
      const emails = this.mergeEmails(jobs);
      const batchId = first.id;

      this.logger.info('Bắt đầu xử lý loạt webhook', {
        batchId,
        jobs: jobs.length,
        emails: emails.length,
        queued: this.queue.size,
      });

      const shouldStop = await this.handleBatch(emails, batchId);
      if (shouldStop) {
        this.running = false;
        this.stopped = true;
        this.logger.warn('Worker dừng do session hết hạn — cần đăng nhập lại trên VPS');
        break;
      }
    }
  }

  /** Gộp email của nhiều job, loại trùng, giữ thứ tự xuất hiện. */
  private mergeEmails(jobs: Job[]): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const job of jobs) {
      for (const email of job.emails) {
        if (seen.has(email)) continue;
        seen.add(email);
        merged.push(email);
      }
    }
    return merged;
  }

  /** Xử lý một loạt email. Trả về true nếu worker phải dừng (session hết hạn). */
  private async handleBatch(emails: string[], batchId: string): Promise<boolean> {
    const maxAttempts = 2; // 1 lần thử lại khi nghi crash

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const page = await this.browser.getPage();
        const outcome = await this.workspace.runAcceptFlow(page, emails);
        return await this.report(emails, outcome);
      } catch (err) {
        if (this.isBrowserCrash(err) && attempt < maxAttempts) {
          this.logger.warn('Nghi ngờ tab/browser crash — khởi động lại rồi thử lại', {
            batchId,
            attempt,
            err,
          });
          await this.browser.restart().catch((e) => this.logger.error('Restart browser lỗi', { err: e }));
          continue;
        }
        await this.reportError(emails, batchId, err);
        return false;
      }
    }

    return false;
  }

  /** Gửi Telegram theo kết quả. Trả về true nếu cần dừng worker. */
  private async report(emails: string[], outcome: ProcessOutcome): Promise<boolean> {
    switch (outcome.kind) {
      case 'processed': {
        const accepted = outcome.results.filter((r) => r.status === 'accepted').length;
        const notFound = outcome.results.length - accepted;
        this.logger.info('Kết quả duyệt', { accepted, notFound, count: outcome.count });
        // Ghi lịch sử trong ngày cho tính năng /check.
        for (const r of outcome.results) this.history.record(r.email, r.status);
        await this.telegram.send(buildResultMessage(outcome.results, outcome.count));
        return false;
      }

      case 'session-expired':
        this.logger.warn('Session hết hạn');
        // Các email chưa xử lý được -> ghi nhận là lỗi để /check phản ánh đúng.
        for (const email of emails) this.history.record(email, 'error');
        await this.telegram.send(buildSessionExpiredMessage());
        return true;
    }
  }

  private async reportError(emails: string[], batchId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error('Xử lý loạt webhook thất bại', { batchId, err });

    // Ghi nhận các email của loạt lỗi là 'error' cho tính năng /check.
    for (const email of emails) this.history.record(email, 'error');

    // Chụp screenshot phục vụ debug (đặc biệt khi UI đổi).
    try {
      const page = await this.browser.getPage();
      await this.workspace.screenshot(page, `error_${batchId}`);
    } catch (e) {
      this.logger.warn('Không chụp được screenshot cho loạt lỗi', { err: e });
    }

    await this.telegram.send(buildErrorMessage(emails, message.slice(0, 300)));
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
