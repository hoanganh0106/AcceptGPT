import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger';

/** Trạng thái xử lý của một email trong ngày. */
export type InviteStatus = 'accepted' | 'not-found' | 'error';

export interface InviteEntry {
  email: string;
  status: InviteStatus;
  /** Thời điểm ghi (ISO, UTC). */
  at: string;
}

interface HistoryFile {
  /** key = ngày theo múi giờ cấu hình, dạng "YYYY-MM-DD" -> danh sách entry. */
  days: Record<string, InviteEntry[]>;
}

/** Số ngày lịch sử giữ lại trong file (để file không phình vô hạn). */
const KEEP_DAYS = 14;

/**
 * Lịch sử email đã mời, gộp theo NGÀY (giờ VN). Ghi ra file JSON (không SQL) nên restart
 * service / reboot VPS vẫn giữ được số liệu trong ngày. Dùng cho tính năng "/check".
 */
export class InviteHistory {
  private data: HistoryFile = { days: {} };

  constructor(
    private readonly filePath: string,
    private readonly tzOffsetHours: number,
    private readonly logger: Logger,
  ) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HistoryFile>;
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        this.data = { days: parsed.days };
      }
    } catch {
      // Chưa có file hoặc file hỏng -> bắt đầu rỗng (không coi là lỗi nghiêm trọng).
      this.data = { days: {} };
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
    } catch (err) {
      this.logger.warn('Không ghi được file lịch sử mời', { err });
    }
  }

  /** Khóa ngày theo múi giờ cấu hình (VD +7 = giờ VN), dạng "YYYY-MM-DD". */
  dayKey(epochMs: number = Date.now()): string {
    const shifted = new Date(epochMs + this.tzOffsetHours * 3_600_000);
    return shifted.toISOString().slice(0, 10);
  }

  /** Ghi một email đã xử lý vào ngày hiện tại rồi lưu file ngay. */
  record(email: string, status: InviteStatus): void {
    const key = this.dayKey();
    const list = this.data.days[key] ?? (this.data.days[key] = []);
    list.push({ email, status, at: new Date().toISOString() });
    this.prune();
    this.persist();
  }

  /** Xóa các ngày cũ hơn KEEP_DAYS. */
  private prune(): void {
    const keys = Object.keys(this.data.days).sort();
    while (keys.length > KEEP_DAYS) {
      const oldest = keys.shift();
      if (oldest) delete this.data.days[oldest];
    }
  }

  /**
   * Danh sách email của MỘT ngày (mặc định hôm nay theo giờ VN), đã GỘP TRÙNG theo email —
   * trạng thái mới nhất thắng. VD một email lỗi rồi được duyệt lại thì chỉ tính là đã duyệt.
   */
  getDay(key: string = this.dayKey()): InviteEntry[] {
    const raw = this.data.days[key] ?? [];
    const latest = new Map<string, InviteEntry>();
    for (const entry of raw) latest.set(entry.email, entry); // cái sau ghi đè cái trước
    return [...latest.values()];
  }
}
