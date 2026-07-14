import type { AppConfig } from './config';
import type { BrowserManager } from './browser-manager';
import type { InviteHistory } from './history';
import type { Logger } from './logger';
import type { Job, JobCompletion, JobQueue } from './queue';
import { buildErrorMessage, buildResultMessage, buildSessionExpiredMessage, type TelegramNotifier } from './telegram';
import type { ProcessOutcome, WorkspacePage } from './workspace-page';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export class Worker {
  private running = false; private stopped = false;
  constructor(private readonly config: AppConfig, private readonly logger: Logger, private readonly queue: JobQueue, private readonly browser: BrowserManager, private readonly workspace: WorkspacePage, private readonly telegram: TelegramNotifier, private readonly history: InviteHistory) {}
  start(): void { if (this.running) return; this.running = true; void this.loop(); this.logger.info('Worker đã bắt đầu'); }
  stop(): void { this.running = false; this.queue.close(); }
  get isStopped(): boolean { return this.stopped; }
  get isReadyForRedemptions(): boolean { return this.running && !this.stopped && !this.queue.isClosed; }
  private async loop(): Promise<void> { while (this.running) { const first = await this.queue.take(); if (!first || !this.running) break; if (this.config.queueCoalesceMs > 0) await sleep(this.config.queueCoalesceMs); const jobs = [first, ...this.queue.drainAll()]; const emails = this.mergeEmails(jobs); const shouldStop = await this.handleBatch(emails, first.id, jobs); if (shouldStop) { this.running = false; this.stopped = true; break; } } }
  private mergeEmails(jobs: Job[]): string[] { const seen = new Set<string>(); const result: string[] = []; for (const job of jobs) for (const email of job.emails) if (!seen.has(email)) { seen.add(email); result.push(email); } return result; }
  private async handleBatch(emails: string[], batchId: string, jobs: Job[]): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) { try { const page = await this.browser.getPage(); const outcome = await this.workspace.runAcceptFlow(page, emails); return await this.report(emails, outcome, jobs); } catch (err) { if (this.isBrowserCrash(err) && attempt < 2) { await this.browser.restart().catch((restartError) => this.logger.error('Restart browser lỗi', { err: restartError })); continue; } this.reportError(emails, batchId, err); this.completeJobs(jobs, { kind: 'error', code: 'automation-error' }); return false; } }
    return false;
  }
  private async report(emails: string[], outcome: ProcessOutcome, jobs: Job[]): Promise<boolean> {
    if (outcome.kind === 'session-expired') { for (const email of emails) this.history.record(email, 'error'); await this.telegram.send(buildSessionExpiredMessage()); this.completeJobs(jobs, outcome); return true; }
    const byEmail = new Map(outcome.results.map((item) => [item.email, item]));
    for (const job of jobs) { const projected: JobCompletion = { kind: 'processed', results: job.emails.map((email) => byEmail.get(email) ?? { email, status: 'not-found' as const }), count: outcome.count }; job.complete?.(projected); }
    const webhookJobs = jobs.filter((job) => job.source === 'webhook'); const webhookEmails = this.mergeEmails(webhookJobs); const webhookResults = webhookEmails.map((email) => byEmail.get(email) ?? { email, status: 'not-found' as const });
    for (const result of webhookResults) this.history.record(result.email, result.status);
    if (webhookResults.length) await this.telegram.send(buildResultMessage(webhookResults, outcome.count));
    return false;
  }
  private completeJobs(jobs: Job[], result: JobCompletion): void { for (const job of jobs) job.complete?.(result); }
  private reportError(emails: string[], batchId: string, err: unknown): void { const message = err instanceof Error ? err.message : 'automation error'; this.logger.error('Xử lý loạt webhook thất bại', { batchId, err }); for (const email of emails) this.history.record(email, 'error'); void this.telegram.send(buildErrorMessage(emails, message.slice(0, 300))); }
  private isBrowserCrash(err: unknown): boolean { const message = (err instanceof Error ? err.message : String(err)).toLowerCase(); return ['target closed','has been closed','browser has been closed','page crashed','crash','websocket'].some((needle) => message.includes(needle)); }
}
