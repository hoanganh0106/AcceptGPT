import { randomUUID } from 'node:crypto';
import type { EmailResult } from './workspace-page';
export type JobSource = 'webhook' | 'redemption';
export type JobCompletion = { kind: 'processed'; results: EmailResult[]; count: number | null } | { kind: 'session-expired' } | { kind: 'error'; code: 'automation-error' | 'worker-stopped' };
export interface Job { id: string; emails: string[]; receivedAt: number; source: JobSource; complete?: (result: JobCompletion) => void; }
export interface AwaitableJob { job: Job; completion: Promise<JobCompletion>; }
export function createWebhookJob(emails: string[]): Job { return { id: randomUUID(), emails: [...emails], receivedAt: Date.now(), source: 'webhook' }; }
export function createJob(emails: string[]): Job { return createWebhookJob(emails); }
export function createAwaitableJob(emails: string[]): AwaitableJob {
  let settled = false; let resolveCompletion!: (result: JobCompletion) => void;
  const completion = new Promise<JobCompletion>((resolve) => { resolveCompletion = resolve; });
  const job: Job = { id: randomUUID(), emails: [...emails], receivedAt: Date.now(), source: 'redemption', complete: (result) => { if (!settled) { settled = true; resolveCompletion(result); } } };
  return { job, completion };
}
export class JobQueue {
  private readonly items: Job[] = []; private readonly waiters: Array<(job: Job | null) => void> = []; private closed = false;
  constructor(private readonly maxDepth = 100) {}
  enqueue(job: Job): void { if (this.closed) { job.complete?.({ kind: 'error', code: 'worker-stopped' }); throw new Error('QUEUE_CLOSED'); } if (this.items.length >= this.maxDepth && this.waiters.length === 0) throw new Error('QUEUE_FULL'); const waiter = this.waiters.shift(); if (waiter) waiter(job); else this.items.push(job); }
  take(): Promise<Job | null> { const existing = this.items.shift(); if (existing) return Promise.resolve(existing); if (this.closed) return Promise.resolve(null); return new Promise((resolve) => this.waiters.push(resolve)); }
  drainAll(): Job[] { return this.items.splice(0); }
  close(completion: JobCompletion = { kind: 'error', code: 'worker-stopped' }): void { if (this.closed) return; this.closed = true; for (const job of this.items.splice(0)) job.complete?.(completion); for (const waiter of this.waiters.splice(0)) waiter(null); }
  get size(): number { return this.items.length; }
  get isClosed(): boolean { return this.closed; }
}
