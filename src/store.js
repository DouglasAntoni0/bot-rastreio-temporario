import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { hash } from './normalize.js';
import { BotError } from './errors.js';

export const shipmentIdentity = shipment => hash(JSON.stringify(shipment));

export class Store {
  constructor(filename, shipment) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, description TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', text TEXT NOT NULL,
        event_id TEXT, failure_seq INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT, message_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, next_attempt);
    `);
    const identity = shipmentIdentity(shipment);
    const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get('shipment');
    if (existing && existing.value !== identity) { this.db.close(); throw new BotError('DATABASE_SHIPMENT_MISMATCH'); }
    this.identity = identity;
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('shipment', identity);
    if (!this.getState()) this.setState({ initialized: false, status: null, eta: null, latestAt: null, lastSuccess: null, failures: 0, failureSeq: 0, failureAlertSent: false, revision: 0 });
  }
  getState() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('state');
    return row ? JSON.parse(row.value) : null;
  }
  setState(state) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('state', JSON.stringify(state)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  queue({ id, kind, text, eventId = null, failureSeq = null, now }) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,kind,text,event_id,failure_seq,created_at) VALUES (?,?,?,?,?,?)').run(id, kind, text, eventId, failureSeq, now);
  }
  events() { return this.db.prepare('SELECT * FROM events ORDER BY occurred_at,id').all(); }
  notifications() { return this.db.prepare('SELECT * FROM outbox ORDER BY rowid').all(); }
  pending(now) { return this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 20").all(now); }
  recoverSending() { this.db.exec("UPDATE outbox SET status='uncertain' WHERE status='sending'"); }
  markSending(id) { this.db.prepare("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='pending'").run(id); }
  markFailed(id, ambiguous, nextAttempt) {
    this.db.prepare('UPDATE outbox SET status=?,next_attempt=? WHERE id=?').run(ambiguous ? 'uncertain' : 'pending', nextAttempt, id);
  }
  markSent(item, messageId, now) {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET status='sent',message_id=?,sent_at=? WHERE id=?").run(messageId, now, item.id);
      if (item.event_id) this.db.prepare('UPDATE events SET notified=1 WHERE id=?').run(item.event_id);
      const state = this.getState();
      if (item.kind === 'failure' && item.failure_seq === state.failureSeq && state.failures >= 3) { state.failureAlertSent = true; this.setState(state); }
    });
  }
  resolve(id, action) {
    const item = this.db.prepare("SELECT * FROM outbox WHERE id=? AND status='uncertain'").get(id);
    if (!item) throw new BotError('OUTBOX_UNCERTAIN_NOT_FOUND');
    if (action === 'sent') this.markSent(item, null, new Date().toISOString());
    else if (action === 'retry') this.markFailed(id, false, 0);
    else throw new BotError('OUTBOX_ACTION_INVALID');
  }
  exportSnapshot() {
    return this.transaction(() => ({ format: 1, shipment: this.identity, state: this.getState(),
      events: this.events().map(row => ({ ...row })), outbox: this.notifications().map(row => ({ ...row })) }));
  }
  restoreSnapshot(snapshot) {
    if (snapshot?.format !== 1 || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.outbox)) throw new BotError('STATE_INVALID');
    if (snapshot.shipment !== this.identity) throw new BotError('DATABASE_SHIPMENT_MISMATCH');
    const { state, events, outbox } = snapshot;
    if (typeof state?.initialized !== 'boolean' || typeof state.failureAlertSent !== 'boolean' ||
        ![state.failures, state.failureSeq, state.revision].every(n => Number.isSafeInteger(n) && n >= 0) ||
        ![null, 1, 2, 3].includes(state.status) || ![state.eta, state.latestAt, state.lastSuccess].every(x => x === null || typeof x === 'string') ||
        (state.initialized && (typeof state.latestAt !== 'string' || !events.length)) ||
        outbox.some(x => !['pending', 'sending', 'sent', 'uncertain', 'cancelled'].includes(x?.status))) {
      throw new BotError('STATE_INVALID');
    }
    try {
      this.transaction(() => {
        this.db.exec('DELETE FROM outbox; DELETE FROM events;');
        const insertEvent = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
        for (const event of events) insertEvent.run(event.id, event.occurred_at, event.description, event.notified);
        const insertNotice = this.db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const item of outbox) insertNotice.run(item.id, item.kind, item.status, item.text, item.event_id, item.failure_seq, item.attempts, item.next_attempt, item.created_at, item.sent_at, item.message_id);
        this.setState(state);
      });
    } catch { throw new BotError('STATE_INVALID'); }
  }
  close() { this.db.close(); }
}

export class InstanceLock {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try { this.db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { this.db.close(); throw new BotError('INSTANCE_ALREADY_RUNNING'); }
  }
  close() { this.db.exec('ROLLBACK'); this.db.close(); }
}
