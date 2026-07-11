import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import type { AppConfig } from './config';
import type { Logger } from './logger';
import {
  confirmCandidates,
  loggedInIndicatorCandidates,
  loginIndicatorCandidates,
  memberCountRegionCandidates,
  MEMBER_COUNT_PATTERNS,
  LOGIN_URL_PATTERNS,
  searchBoxCandidates,
  requestRowCandidates,
  rowAcceptButton,
} from './selectors';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Phiên ChatGPT đã hết hạn — worker phải dừng và báo Telegram. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Phiên đăng nhập ChatGPT đã hết hạn');
    this.name = 'SessionExpiredError';
  }
}

/** Giao diện Members không nhận diện được — không click bừa, chụp màn hình. */
export class UiChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiChangedError';
  }
}

/** Trạng thái duyệt của TỪNG email trong webhook. */
export type EmailStatus = 'accepted' | 'not-found';

export interface EmailResult {
  email: string;
  status: EmailStatus;
}

/** Kết quả một lần chạy flow duyệt theo email. */
export type ProcessOutcome =
  | { kind: 'processed'; results: EmailResult[]; count: number | null }
  | { kind: 'session-expired' };

/**
 * Đóng gói mọi thao tác trên trang Members (theo plan mục 6 & 9).
 * Không giữ state ngoài — mỗi lần chạy nhận `page` từ BrowserManager.
 */
export class WorkspacePage {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Chạy flow của một webhook: mở trang -> kiểm tra session -> duyệt ĐÚNG từng email
   * trong danh sách (không "Accept all") -> đọc tổng thành viên.
   * Mỗi email: tìm bằng ô Search, nếu thấy thì bấm Accept của dòng đó; nếu chưa thấy
   * (có thể đến trễ) thì chờ tới `pendingAppearWaitMs` rồi mới kết luận không thấy.
   */
  async runAcceptFlow(page: Page, emails: string[]): Promise<ProcessOutcome> {
    await this.openMembersPage(page);

    if (!(await this.isLoggedIn(page))) {
      return { kind: 'session-expired' };
    }

    // Đọc TRƯỚC khi duyệt: header số members của ChatGPT cập nhật trễ vài giây sau khi
    // duyệt, nên cần số nền để tính bù, tránh báo số cũ.
    const beforeCount = await this.readMemberCount(page);

    const results: EmailResult[] = [];
    for (const email of emails) {
      const accepted = await this.acceptOne(page, email);
      results.push({ email, status: accepted ? 'accepted' : 'not-found' });
    }

    const acceptedCount = results.filter((r) => r.status === 'accepted').length;

    // Không reload, không đọc lại header để đếm: cộng thẳng số vừa duyệt vào số nền đọc
    // lúc đầu. Header ChatGPT cập nhật trễ (eventual consistency) nên số tính bù này vừa
    // chính xác vừa nhanh, khỏi phải load lại trang. Nếu lúc đầu không đọc được số nền thì
    // để null ("Không xác định").
    const count = beforeCount !== null ? beforeCount + acceptedCount : null;

    this.logger.info('Hoàn tất xử lý webhook', {
      total: emails.length,
      accepted: acceptedCount,
      notFound: emails.length - acceptedCount,
      count,
    });
    return { kind: 'processed', results, count };
  }

  /**
   * Duyệt đúng MỘT email. Trả về true nếu đã bấm Accept dòng của email đó,
   * false nếu email không xuất hiện trong danh sách chờ trong hạn `pendingAppearWaitMs`.
   * Ném lỗi nếu gặp sự cố bất thường (để worker quyết định restart/thử lại).
   */
  private async acceptOne(page: Page, email: string): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, this.config.pendingAppearWaitMs);
    let sawRowButNoButton = false;
    let iteration = 0;
    let lastReload = Date.now();

    do {
      // Reload ĐỊNH KỲ (mỗi ~4s) để bắt request đến trễ, KHÔNG reload mỗi vòng lặp:
      // openMembersPage tốn vài giây, reload liên tục sẽ ăn hết ngân sách chờ.
      if (iteration > 0 && Date.now() - lastReload > 4000) {
        await this.openMembersPage(page);
        lastReload = Date.now();
      }
      iteration += 1;

      await this.searchFor(page, email);

      // Chờ dòng xuất hiện sau khi lọc (XHR có thể trả chậm) thay vì kiểm tra tức thời.
      let row = await this.waitRequestRow(page, email, 2500);
      // Fallback: một số UI, ô "Search" lọc theo TÊN chứ không theo email -> gõ email
      // vào sẽ lọc sạch danh sách. Xóa lọc rồi quét lại toàn bộ để không bỏ sót.
      if (!row) row = await this.findAfterClearingSearch(page, email);

      if (row) {
        const acceptBtn = rowAcceptButton(row).first();
        if (await acceptBtn.isVisible().catch(() => false)) {
          await acceptBtn.click({ timeout: this.config.actionTimeoutMs });
          await this.confirmIfModal(page);
          // Dòng biến mất khỏi danh sách => đã duyệt xong.
          await row.waitFor({ state: 'detached', timeout: this.config.actionTimeoutMs }).catch(() => undefined);
          this.logger.info('Đã duyệt email', { email });
          return true;
        }
        // Thấy dòng nhưng chưa khớp nút Accept — ghi lại để phân biệt với "không có dòng".
        sawRowButNoButton = true;
        this.logger.warn('Thấy dòng yêu cầu nhưng chưa thấy nút Accept của dòng đó', { email });
      }

      await sleep(600);
    } while (Date.now() < deadline);

    // Chẩn đoán khi trượt: đếm số dòng chờ đang hiển thị + chụp screenshot, để biết
    // là request chưa xuất hiện, hay đã xuất hiện nhưng selector không khớp.
    const visiblePendingRows = await this.countVisiblePendingRows(page).catch(() => -1);
    this.logger.warn('Không tìm thấy email trong danh sách chờ', {
      email,
      sawRowButNoButton,
      visiblePendingRows,
    });
    await this.screenshot(page, `notfound_${email}`).catch(() => undefined);
    return false;
  }

  /** Gõ email vào ô Search để lọc danh sách. Không có ô search thì bỏ qua (quét cả trang). */
  private async searchFor(page: Page, email: string): Promise<void> {
    const box = await this.firstVisibleNow(searchBoxCandidates(page));
    if (!box) return;
    try {
      await box.fill('');
      await box.fill(email);
      // Chờ ngắn cho filter bắt đầu; waitRequestRow bên dưới sẽ poll chờ dòng render.
      await sleep(300);
    } catch (err) {
      this.logger.debug('Không gõ được vào ô search (bỏ qua, quét cả trang)', { err });
    }
  }

  /** Tìm dòng yêu cầu ứng với email (thử nhiều selector), kiểm tra tức thời. */
  private async findRequestRow(page: Page, email: string): Promise<Locator | null> {
    return this.firstVisibleNow(requestRowCandidates(page, email));
  }

  /** Poll chờ dòng của email xuất hiện trong hạn timeoutMs (sau khi lọc/render chậm). */
  private async waitRequestRow(page: Page, email: string, timeoutMs: number): Promise<Locator | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const row = await this.findRequestRow(page, email);
      if (row) return row;
      await sleep(250);
    } while (Date.now() < deadline);
    return null;
  }

  /** Xóa bộ lọc Search rồi quét lại — phòng khi ô Search lọc theo tên, không theo email. */
  private async findAfterClearingSearch(page: Page, email: string): Promise<Locator | null> {
    const box = await this.firstVisibleNow(searchBoxCandidates(page));
    if (!box) return this.findRequestRow(page, email);
    await box.fill('').catch(() => undefined);
    await sleep(500);
    return this.findRequestRow(page, email);
  }

  /** Đếm sơ bộ số dòng chờ đang hiển thị (sau khi xóa lọc) để chẩn đoán khi trượt. */
  private async countVisiblePendingRows(page: Page): Promise<number> {
    const box = await this.firstVisibleNow(searchBoxCandidates(page));
    if (box) {
      await box.fill('').catch(() => undefined);
      await sleep(400);
    }
    const counts = await Promise.all([
      page.getByRole('row').count().catch(() => 0),
      page.locator('tr').count().catch(() => 0),
      page.locator('li').count().catch(() => 0),
    ]);
    return Math.max(...counts);
  }

  /** Nếu có modal xác nhận thì bấm nút xác nhận (một số UI hỏi lại). */
  private async confirmIfModal(page: Page): Promise<void> {
    const confirm = await this.firstVisibleNow(confirmCandidates(page));
    if (confirm) {
      this.logger.info('Có modal xác nhận — bấm nút xác nhận');
      await confirm.click({ timeout: this.config.actionTimeoutMs }).catch((err) =>
        this.logger.warn('Bấm nút xác nhận lỗi (bỏ qua)', { err }),
      );
    }
  }

  /** Điều hướng về trang Members và chờ render xong, có retry (plan mục 6.4–6.6). */
  async openMembersPage(page: Page): Promise<void> {
    const retries = Math.max(1, this.config.pageLoadRetries);
    let lastErr: unknown;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await page.goto(this.config.membersUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.config.navTimeoutMs,
        });
        // Chờ SPA render: xuất hiện dấu hiệu đã-đăng-nhập hoặc màn hình login.
        await this.waitAnyVisible(
          [...loggedInIndicatorCandidates(page), ...loginIndicatorCandidates(page)],
          this.config.navTimeoutMs,
        );
        // Chờ dữ liệu SPA (danh sách requests, tổng thành viên) tải xong — không chỉ
        // khung trang. Nếu không, đọc trạng thái nút/số members quá sớm sẽ sai.
        // Trang admin có thể poll nền nên networkidle có thể không đạt -> bỏ qua timeout.
        await page
          .waitForLoadState('networkidle', { timeout: Math.min(this.config.navTimeoutMs, 8000) })
          .catch(() => undefined);
        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn('Tải trang Members thất bại, thử lại', { attempt, err });
        await sleep(1000 * attempt);
      }
    }

    throw new Error(`Không tải được trang Members sau ${retries} lần: ${String(lastErr)}`);
  }

  /** Kiểm tra còn đăng nhập không (plan mục 6.3). */
  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (LOGIN_URL_PATTERNS.some((re) => re.test(url))) {
      this.logger.warn('URL cho thấy đã bị đưa về trang đăng nhập', { url });
      return false;
    }

    const loginMarker = await this.firstVisibleNow(loginIndicatorCandidates(page));
    if (loginMarker) {
      this.logger.warn('Phát hiện màn hình đăng nhập');
      return false;
    }

    return true;
  }

  /**
   * Đọc tổng số thành viên hiển thị trực tiếp trên UI (plan mục 9).
   * KHÔNG đếm số dòng. Không đọc được -> null ("Không xác định").
   */
  async readMemberCount(page: Page): Promise<number | null> {
    for (const region of memberCountRegionCandidates(page)) {
      let text: string | null = null;
      try {
        if (!(await region.first().isVisible())) continue;
        text = (await region.first().innerText({ timeout: 2000 })).trim();
      } catch {
        continue;
      }
      if (!text) continue;

      for (const pattern of MEMBER_COUNT_PATTERNS) {
        const match = text.match(pattern);
        if (match && match[1]) {
          const numeric = Number.parseInt(match[1].replace(/[.,\s]/g, ''), 10);
          if (Number.isFinite(numeric)) {
            this.logger.info('Đọc được tổng thành viên', { count: numeric, source: text.slice(0, 80) });
            return numeric;
          }
        }
      }
    }

    this.logger.warn('Không đọc được tổng số thành viên');
    return null;
  }

  /** Chụp screenshot phục vụ debug khi lỗi/giao diện đổi. Trả về đường dẫn file. */
  async screenshot(page: Page, label: string): Promise<string | null> {
    try {
      fs.mkdirSync(this.config.screenshotsDir, { recursive: true });
      const safeLabel = label.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
      const file = path.join(
        this.config.screenshotsDir,
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeLabel}.png`,
      );
      await page.screenshot({ path: file, fullPage: true });
      this.logger.info('Đã lưu screenshot', { file });
      return file;
    } catch (err) {
      this.logger.warn('Không chụp được screenshot', { err });
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers tìm locator
  // -----------------------------------------------------------------------

  /** Trả về locator ứng viên đầu tiên đang hiển thị NGAY (không chờ). */
  private async firstVisibleNow(candidates: Locator[]): Promise<Locator | null> {
    for (const loc of candidates) {
      try {
        const first = loc.first();
        if (await first.isVisible()) return first;
      } catch {
        // selector không hợp lệ với DOM hiện tại -> thử cái tiếp theo
      }
    }
    return null;
  }

  /** Poll tới khi một trong các ứng viên hiển thị, hoặc hết timeout -> null. */
  private async waitAnyVisible(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const found = await this.firstVisibleNow(candidates);
      if (found) return found;
      await sleep(300);
    } while (Date.now() < deadline);
    return null;
  }
}
