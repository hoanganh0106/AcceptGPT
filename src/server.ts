import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import type { Logger } from './logger';
import { createJob, type JobQueue } from './queue';

interface WebhookBody {
  emails?: unknown;
}

/**
 * Chuẩn hóa danh sách email từ webhook (plan mục 5):
 * chỉ giữ string, trim, bỏ rỗng, chuyển chữ thường, loại trùng.
 */
export function normalizeEmails(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const email = item.trim().toLowerCase();
    if (email === '' || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}

/** So sánh secret an toàn trước timing attack. */
function secretMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function buildServer(config: AppConfig, logger: Logger, queue: JobQueue): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.get('/health', async () => ({
    status: 'ok',
    queued: queue.size,
    time: new Date().toISOString(),
  }));

  app.post(config.webhookPath, async (request, reply) => {
    // Xác thực secret (nếu bật).
    if (config.webhookSecret !== null) {
      const provided = request.headers['x-webhook-secret'];
      const header = Array.isArray(provided) ? provided[0] : provided;
      if (!secretMatches(config.webhookSecret, header)) {
        logger.warn('Webhook bị từ chối: secret sai', { ip: request.ip });
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }

    const body = (request.body ?? {}) as WebhookBody;

    if (!Array.isArray(body.emails)) {
      return reply.code(400).send({ error: 'emails phải là một mảng' });
    }

    const emails = normalizeEmails(body.emails);
    if (emails.length === 0) {
      return reply.code(400).send({ error: 'không có email hợp lệ sau khi chuẩn hóa' });
    }

    const job = createJob(emails);
    queue.enqueue(job);
    logger.info('Nhận webhook, đã đưa vào queue', {
      jobId: job.id,
      emails: emails.length,
      queued: queue.size,
    });

    // Trả về ngay, không chờ Playwright (plan mục 5).
    return reply.code(202).send({ queued: true, jobId: job.id, count: emails.length });
  });

  return app;
}
