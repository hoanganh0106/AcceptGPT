import type { AppConfig } from './config';
import type { Logger } from './logger';
import type { InviteHistory } from './history';
import { buildDailyReport } from './telegram';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Nhãn nút reply-keyboard để người dùng bấm 1 phát là xem báo cáo. */
const CHECK_BUTTON = '🔍 Check hôm nay';

/** Reply keyboard cố định (luôn hiện ở khung soạn tin). */
const CHECK_KEYBOARD = {
  keyboard: [[{ text: CHECK_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

interface TgResponse<T> {
  ok: boolean;
  result?: T;
}

interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
}

/**
 * Lắng nghe Telegram bằng long-polling getUpdates để nhận lệnh `/check` hoặc nút
 * "🔍 Check hôm nay", rồi gửi báo cáo mời trong ngày về CẢ các chat id đã cấu hình.
 * Chạy ĐỘC LẬP với worker — nên vẫn /check được kể cả khi worker đã dừng (session hết hạn).
 */
export class TelegramBot {
  private readonly apiBase: string;
  private readonly allowedChatIds: string[];
  private offset = 0;
  private running = false;

  constructor(
    config: AppConfig,
    private readonly logger: Logger,
    private readonly history: InviteHistory,
  ) {
    this.apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;
    this.allowedChatIds = config.telegramChatId
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.setup();
    void this.loop();
    this.logger.info('Telegram bot poller đã bắt đầu', { chatIds: this.allowedChatIds.length });
  }

  stop(): void {
    this.running = false;
  }

  /** Đăng ký menu lệnh + bỏ qua update tồn đọng trước khi bot khởi động. */
  private async setup(): Promise<void> {
    await this.call('setMyCommands', {
      commands: [{ command: 'check', description: 'Xem báo cáo mời trong ngày' }],
    }).catch(() => undefined);

    // Gửi nút cho từng chat id để người dùng có sẵn nút bấm (khỏi phải gõ /start).
    for (const chatId of this.allowedChatIds) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: 'Bot AcceptGPT sẵn sàng. Bấm nút bên dưới để xem báo cáo mời trong ngày.',
        reply_markup: CHECK_KEYBOARD,
      }).catch(() => undefined);
    }

    // Bỏ qua backlog: lấy update_id cuối cùng rồi đặt offset qua nó.
    const res = await this.call<TgUpdate[]>('getUpdates', { timeout: 0, offset: -1 }).catch(
      () => null,
    );
    const updates = res?.result;
    if (Array.isArray(updates) && updates.length > 0) {
      this.offset = updates[updates.length - 1].update_id + 1;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.call<TgUpdate[]>(
          'getUpdates',
          { timeout: 30, offset: this.offset },
          35_000,
        );
        if (res?.ok && Array.isArray(res.result)) {
          for (const update of res.result) {
            this.offset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        }
      } catch (err) {
        this.logger.warn('getUpdates lỗi, thử lại sau 2s', { err });
        await sleep(2000);
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return;

    const chatId = String(msg.chat?.id ?? '');
    if (!this.allowedChatIds.includes(chatId)) {
      this.logger.debug('Bỏ qua tin nhắn từ chat không cho phép', { chatId });
      return;
    }

    const text = msg.text.trim();

    if (text === '/start') {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: 'Bấm nút bên dưới để xem báo cáo mời trong ngày.',
        reply_markup: CHECK_KEYBOARD,
      }).catch(() => undefined);
      return;
    }

    if (text === '/check' || text === CHECK_BUTTON) {
      await this.sendDailyReport();
    }
  }

  /** Dựng báo cáo hôm nay và gửi tới TẤT CẢ chat id (kèm nút để giữ keyboard). */
  private async sendDailyReport(): Promise<void> {
    const key = this.history.dayKey();
    const [y, m, d] = key.split('-');
    const report = buildDailyReport(this.history.getDay(key), `${d}/${m}/${y}`);

    for (const chatId of this.allowedChatIds) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: report,
        disable_web_page_preview: true,
        reply_markup: CHECK_KEYBOARD,
      }).catch((err) => this.logger.warn('Gửi báo cáo /check thất bại', { chatId, err }));
    }
    this.logger.info('Đã gửi báo cáo /check', { day: key });
  }

  private async call<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<TgResponse<T>> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as TgResponse<T>;
  }
}
