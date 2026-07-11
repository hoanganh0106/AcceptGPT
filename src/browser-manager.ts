import fs from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppConfig } from './config';
import type { Logger } from './logger';

/**
 * Giữ một Chromium persistent context mở liên tục cùng MỘT tab (theo plan mục 4).
 * - Không đóng browser sau mỗi webhook.
 * - Tab crash  -> tạo tab mới.
 * - Browser crash -> mở lại bằng cùng profile.
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private contextClosed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /** Khởi động browser lần đầu và mở sẵn một tab. */
  async start(): Promise<void> {
    await this.ensureContext();
    await this.ensurePage();
    this.logger.info('BrowserManager đã khởi động', {
      profile: this.config.browserProfileDir,
      headless: this.config.headless,
    });
  }

  /**
   * Trả về tab đang hoạt động, tự phục hồi nếu context hoặc tab đã chết.
   * Đây là điểm vào chuẩn cho worker mỗi lần xử lý job.
   */
  async getPage(): Promise<Page> {
    await this.ensureContext();
    return this.ensurePage();
  }

  /** Mở lại Chromium từ đầu (dùng khi nghi ngờ browser hỏng nặng). */
  async restart(): Promise<Page> {
    this.logger.warn('Khởi động lại Chromium');
    await this.closeContextQuietly();
    this.context = null;
    this.page = null;
    await this.ensureContext();
    return this.ensurePage();
  }

  async close(): Promise<void> {
    await this.closeContextQuietly();
    this.context = null;
    this.page = null;
  }

  // -----------------------------------------------------------------------
  // Nội bộ
  // -----------------------------------------------------------------------

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && !this.contextClosed) {
      return this.context;
    }

    fs.mkdirSync(this.config.browserProfileDir, { recursive: true });

    this.logger.info('Mở Chromium persistent context', { channel: this.config.browserChannel });
    const context = await chromium.launchPersistentContext(this.config.browserProfileDir, {
      headless: this.config.headless,
      executablePath: this.config.chromiumExecutablePath ?? undefined,
      channel: this.config.browserChannel ?? undefined,
      viewport: { width: 1366, height: 900 },
      // Giảm dấu hiệu "trình duyệt tự động" khiến ChatGPT/Cloudflare bắt CAPTCHA liên tục.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    context.setDefaultNavigationTimeout(this.config.navTimeoutMs);
    context.setDefaultTimeout(this.config.actionTimeoutMs);

    this.contextClosed = false;
    context.on('close', () => {
      this.contextClosed = true;
      this.logger.warn('Chromium context đã đóng (có thể do crash)');
    });

    this.context = context;
    this.page = null; // buộc tạo tab mới cho context mới
    return context;
  }

  private async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();

    // Tab hiện tại còn sống thì dùng lại.
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    // Tái sử dụng tab sẵn có của persistent context nếu có, nếu không thì mở mới.
    const existing = context.pages().find((p) => !p.isClosed());
    const page = existing ?? (await context.newPage());

    page.on('crash', () => {
      this.logger.error('Tab bị crash');
    });
    page.on('close', () => {
      this.logger.warn('Tab đã đóng');
    });

    this.page = page;
    this.logger.info('Đã sẵn sàng tab làm việc');
    return page;
  }

  private async closeContextQuietly(): Promise<void> {
    if (!this.context) return;
    try {
      await this.context.close();
    } catch (err) {
      this.logger.warn('Lỗi khi đóng context (bỏ qua)', { err });
    }
  }
}
