import { eventMessage, failureMessage, stateMessage } from './messages.js';
import { safeCode } from './errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { normalize } from './normalize.js';

export class Monitor {
  constructor({ store, source, telegram, link, carrier, failureAlerts = true, checkpoint, log = () => {}, clock = () => Date.now() }) {
    Object.assign(this, { store, source, telegram, link, carrier, failureAlerts, checkpoint, log, clock });
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
      const known = new Set(stored.map(x => x.id));
      const hasCarrierStatus = snapshot.statusText !== undefined;
      const anchored = snapshot.latestAt === old.latestAt && (hasCarrierStatus
        ? snapshot.events.some(event => event.occurredAt === old.latestAt && known.has(event.id) && normalize(event.statusText) === normalize(old.statusText))
        : frontier.every(x => incomingIds.has(x.id)));
      // A carrier may correct the latest SSW row without changing its timestamp.
      const newFrontier = hasCarrierStatus && snapshot.latestAt === old.latestAt &&
        snapshot.events.some(event => event.occurredAt === snapshot.latestAt && !known.has(event.id));
      const fresh = newer || anchored || newFrontier;
      const newEvents = [];
      for (const event of snapshot.events) {
        if (known.has(event.id) || (hasCarrierStatus && !fresh)) continue;
        const announce = old.initialized && fresh && (hasCarrierStatus || event.occurredAt >= old.latestAt);
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
        if (hasCarrierStatus) {
          const previousStillLatest = !newer && !newFrontier && snapshot.events.some(event =>
            event.occurredAt === old.latestAt && normalize(event.statusText) === normalize(old.statusText));
          current.statusText = previousStillLatest || normalize(old.statusText) === normalize(snapshot.statusText)
            ? old.statusText : snapshot.statusText;
        }
      }
      for (const event of newEvents) this.store.queue({ id: `event:${event.id}`, kind: 'event', eventId: event.id, text: eventMessage(event, current, this.link, this.carrier), now });
      const statusInEvent = hasCarrierStatus && newEvents.some(event => event.occurredAt === current.latestAt && event.statusText === current.statusText);
      const statusChanged = old.status !== current.status || old.statusText !== current.statusText;
      const etaChanged = old.eta !== current.eta;
      if (old.initialized && fresh && ((statusChanged && !statusInEvent) || (etaChanged && !(hasCarrierStatus && newEvents.length)))) {
        current.revision++;
        this.store.queue({ id: `state:${current.revision}`, kind: 'state', text: stateMessage(old, current, this.link, this.carrier), now });
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
      if (this.failureAlerts && state.failures >= 3 && !state.failureAlertSent) this.store.queue({ id: `failure:${state.failureSeq}`, kind: 'failure', failureSeq: state.failureSeq, text: failureMessage, now });
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

export function combinedMonitor(monitors, log) {
  return {
    async cycle(signal) {
      return Promise.all(monitors.map(async ([source, monitor]) => {
        try { return await monitor.cycle(signal); }
        catch (error) {
          if (!signal?.aborted) log('source_cycle_failed', { source, code: safeCode(error) });
          return { success: false };
        }
      }));
    },
  };
}

export async function runLoop(monitor, { pollSeconds = 300, signal, sleep = delay, clock = () => Date.now() } = {}) {
  while (!signal?.aborted) {
    const started = clock();
    await monitor.cycle(signal);
    try { await sleep(Math.max(1000, pollSeconds * 1000 - (clock() - started)), undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}
