import { eventMessage, failureMessage, stateMessage } from './messages.js';
import { safeCode } from './errors.js';
import { setTimeout as delay } from 'node:timers/promises';

export class Monitor {
  constructor({ store, source, telegram, link, checkpoint, log = () => {}, clock = () => Date.now() }) {
    Object.assign(this, { store, source, telegram, link, checkpoint, log, clock });
    this.busy = false;
  }
  recordSuccess(snapshot) {
    const now = new Date(this.clock()).toISOString();
    return this.store.transaction(() => {
      const old = this.store.getState();
      const stored = this.store.events();
      const incomingIds = new Set(snapshot.events.map(x => x.id));
      const frontier = stored.filter(x => x.occurred_at === old.latestAt);
      const newer = !old.latestAt || snapshot.latestAt > old.latestAt;
      const anchored = snapshot.latestAt === old.latestAt && frontier.every(x => incomingIds.has(x.id));
      const fresh = newer || anchored;
      const known = new Set(stored.map(x => x.id));
      const newEvents = [];
      for (const event of snapshot.events) {
        if (known.has(event.id)) continue;
        const announce = old.initialized && fresh && event.occurredAt >= old.latestAt;
        this.store.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(event.id, event.occurredAt, event.description, announce ? 0 : 1);
        if (announce) newEvents.push(event);
      }
      const current = { ...old, initialized: true, lastSuccess: now, failures: 0, failureAlertSent: false };
      // Cancel unsent failure notices when the carrier has recovered; a new sequence gets a new ID.
      this.store.db.exec("UPDATE outbox SET status='cancelled' WHERE kind='failure' AND status='pending'");
      if (fresh) {
        current.latestAt = snapshot.latestAt;
        // A stale/open response must never undo a completed delivery.
        current.status = old.status === 2 || old.status === 3 ? old.status : snapshot.status;
        current.eta = snapshot.eta ?? old.eta;
      }
      for (const event of newEvents) this.store.queue({ id: `event:${event.id}`, kind: 'event', eventId: event.id, text: eventMessage(event, current, this.link), now });
      if (old.initialized && fresh && (old.status !== current.status || old.eta !== current.eta)) {
        current.revision++;
        this.store.queue({ id: `state:${current.revision}`, kind: 'state', text: stateMessage(old, current, this.link), now });
      }
      this.store.setState(current);
      return { baseline: !old.initialized, fresh, newEvents: newEvents.length };
    });
  }
  recordFailure() {
    const now = new Date(this.clock()).toISOString();
    return this.store.transaction(() => {
      const state = this.store.getState();
      if (state.failures === 0) state.failureSeq++;
      state.failures++;
      if (state.failures >= 3 && !state.failureAlertSent) this.store.queue({ id: `failure:${state.failureSeq}`, kind: 'failure', failureSeq: state.failureSeq, text: failureMessage, now });
      this.store.setState(state);
      return state.failures;
    });
  }
  async flush(signal) {
    for (const item of this.store.pending(this.clock())) {
      if (signal?.aborted) break;
      this.store.markSending(item.id);
      await this.checkpoint?.();
      let messageId;
      try {
        messageId = await this.telegram.send(item.text, signal);
      } catch (error) {
        if (!error.code) throw error;
        this.store.markFailed(item.id, error.ambiguous !== false, this.clock() + (error.retryAfter || 300) * 1000);
        await this.checkpoint?.();
        this.log(error.ambiguous ? 'telegram_delivery_uncertain' : 'telegram_retry_pending', { code: safeCode(error) });
        break;
      }
      try {
        this.store.markSent(item, messageId, new Date(this.clock()).toISOString());
        await this.checkpoint?.();
      } catch (error) {
        // The last durable state is either 'sending' or 'sent'. Never resend based on a failed save.
        this.log('telegram_ack_save_failed', { code: safeCode(error) });
        throw error;
      }
      this.log('telegram_sent', { kind: item.kind });
    }
  }
  async cycle(signal) {
    if (this.busy) return { skipped: true };
    this.busy = true;
    try {
      let snapshot;
      try { snapshot = await this.source.consult(signal); }
      catch (error) {
        if (signal?.aborted) return { stopped: true };
        const failures = this.recordFailure();
        await this.checkpoint?.();
        this.log('tracking_failed', { code: safeCode(error), failures });
      }
      if (snapshot) {
        const result = this.recordSuccess(snapshot);
        await this.checkpoint?.();
        this.log(result.baseline ? 'baseline_saved' : result.fresh ? 'tracking_ok' : 'stale_snapshot_ignored', { newEvents: result.newEvents });
      }
      await this.flush(signal);
      return { success: !!snapshot };
    } finally { this.busy = false; }
  }
}

export async function runLoop(monitor, { pollSeconds = 300, signal, sleep = delay, clock = () => Date.now() } = {}) {
  while (!signal?.aborted) {
    const started = clock();
    await monitor.cycle(signal);
    try { await sleep(Math.max(1000, pollSeconds * 1000 - (clock() - started)), undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
