import { randomUUID } from 'node:crypto';

/** Một job = một webhook đã được chuẩn hóa (plan mục 5). */
export interface Job {
  id: string;
  emails: string[];
  receivedAt: number;
}

export function createJob(emails: string[]): Job {
  return { id: randomUUID(), emails, receivedAt: Date.now() };
}

/**
 * Hàng đợi FIFO trong RAM (plan mục 5 & 14.7).
 * - Không dùng SQL, không persist. VPS restart => mất job đang chờ (chấp nhận được).
 * - `take()` chờ tới khi có job, đảm bảo worker xử lý tuần tự, không chạy song song.
 */
export class JobQueue {
  private readonly items: Job[] = [];
  private readonly waiters: Array<(job: Job) => void> = [];

  enqueue(job: Job): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Có worker đang chờ -> giao thẳng, không xếp hàng.
      waiter(job);
    } else {
      this.items.push(job);
    }
  }

  /** Lấy job kế tiếp; nếu rỗng thì chờ tới khi có job mới được enqueue. */
  take(): Promise<Job> {
    const existing = this.items.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<Job>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Lấy HẾT job đang chờ (không block, có thể rỗng). Dùng để gom nhiều webhook tới sát
   * nhau thành một lượt xử lý, tránh reload trang liên tục.
   */
  drainAll(): Job[] {
    return this.items.splice(0, this.items.length);
  }

  get size(): number {
    return this.items.length;
  }
}
