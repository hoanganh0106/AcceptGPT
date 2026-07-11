import type { AppConfig } from './config';
import type { Logger } from './logger';
import type { EmailResult } from './workspace-page';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Định dạng danh sách email thành bullet list cho tin nhắn Telegram. */
function formatEmailList(emails: string[]): string {
  if (emails.length === 0) return '- (không có email)';
  return emails.map((email) => `- ${email}`).join('\n');
}

/** Chuẩn hóa tổng số thành viên: null -> "Không xác định". */
function formatCount(count: number | null): string {
  return count === null ? 'Không xác định' : String(count);
}

// -------------------------------------------------------------------------
// Message builders (theo plan mục 8)
// -------------------------------------------------------------------------

/**
 * Tin nhắn tổng hợp kết quả duyệt theo TỪNG email.
 * - Tất cả duyệt được: ✅
 * - Có email không thấy trong danh sách chờ: ⚠️ (kèm danh sách không thấy)
 */
export function buildResultMessage(results: EmailResult[], count: number | null): string {
  const accepted = results.filter((r) => r.status === 'accepted').map((r) => r.email);
  const notFound = results.filter((r) => r.status === 'not-found').map((r) => r.email);

  let header: string;
  if (notFound.length === 0) header = '✅ Đã duyệt thành viên';
  else if (accepted.length === 0) header = '⚠️ Không tìm thấy yêu cầu chờ cho email nào';
  else header = '⚠️ Đã duyệt một phần';

  const lines: string[] = [header, ''];
  if (accepted.length > 0) {
    lines.push('Đã duyệt:', formatEmailList(accepted), '');
  }
  if (notFound.length > 0) {
    lines.push('Không thấy trong danh sách chờ:', formatEmailList(notFound), '');
  }
  lines.push(`Tổng thành viên hiện tại: ${formatCount(count)}`);
  return lines.join('\n');
}

export function buildSessionExpiredMessage(): string {
  return (
    '⚠️ Phiên đăng nhập ChatGPT đã hết hạn\n\n' +
    'Bot đã dừng xử lý.\n' +
    'Hãy đăng nhập lại trên VPS.'
  );
}

export function buildErrorMessage(emails: string[], errorText: string): string {
  return (
    '❌ Duyệt thành viên thất bại\n\n' +
    'Email:\n' +
    `${formatEmailList(emails)}\n\n` +
    `Lỗi: ${errorText}`
  );
}

// -------------------------------------------------------------------------
// Sender
// -------------------------------------------------------------------------

export class TelegramNotifier {
  private readonly apiBase: string;
  /** Cho phép nhiều người nhận: TELEGRAM_CHAT_ID ngăn cách bởi dấu phẩy. */
  private readonly chatIds: string[];

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;
    this.chatIds = config.telegramChatId
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }

  /**
   * Gửi một tin nhắn text tới TẤT CẢ chat id đã cấu hình.
   * Không ném lỗi ra ngoài — chỉ log, để một lần Telegram lỗi không làm chết worker.
   * Trả về true nếu gửi thành công tới mọi chat id.
   */
  async send(text: string): Promise<boolean> {
    let allOk = true;
    for (const chatId of this.chatIds) {
      const ok = await this.sendToChat(chatId, text);
      if (!ok) allOk = false;
    }
    return allOk;
  }

  /** Gửi tới một chat id, thử lại tối đa `TELEGRAM_RETRIES` lần với backoff. */
  private async sendToChat(chatId: string, text: string): Promise<boolean> {
    const attempts = Math.max(1, this.config.telegramRetries);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(`${this.apiBase}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
          // fetch có timeout mặc định vô hạn; đặt AbortSignal để tránh treo.
          signal: AbortSignal.timeout(this.config.actionTimeoutMs),
        });

        if (response.ok) {
          this.logger.debug('Đã gửi Telegram', { attempt, chatId });
          return true;
        }

        const body = await response.text().catch(() => '');
        this.logger.warn('Telegram trả về lỗi HTTP', {
          attempt,
          chatId,
          status: response.status,
          body: body.slice(0, 500),
        });
      } catch (err) {
        this.logger.warn('Gửi Telegram thất bại', { attempt, chatId, err });
      }

      if (attempt < attempts) {
        await sleep(500 * attempt);
      }
    }

    this.logger.error('Không gửi được Telegram sau khi thử lại', { attempts, chatId });
    return false;
  }
}
