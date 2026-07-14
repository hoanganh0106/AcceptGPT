import test from 'node:test';
import assert from 'node:assert/strict';
import { createAwaitableJob, JobQueue } from '../src/queue';
test('queue closes awaitable redemption tickets without forbidden fields', async () => { const queue = new JobQueue(1); const ticket = createAwaitableJob(['user@example.com']); assert.equal(ticket.job.source, 'redemption'); assert.equal('workspaceId' in ticket.job, false); queue.enqueue(ticket.job); queue.close(); assert.deepEqual(await ticket.completion, { kind: 'error', code: 'worker-stopped' }); assert.equal(await queue.take(), null); });
