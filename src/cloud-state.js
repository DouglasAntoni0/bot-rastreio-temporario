import { randomUUID } from 'node:crypto';
import { BotError, safeCode } from './errors.js';
import { requestJson } from './http.js';
import { shipmentIdentity, Store } from './store.js';
import { Monitor } from './engine.js';

const LEASE_MS = 300000;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const ACQUIRE = `
if not redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return {0} end
return {1, redis.call('GET', KEYS[2]) or ''}
`;
const SAVE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local exists = redis.call('EXISTS', KEYS[2])
if ARGV[4] == 'initialize' and exists == 1 then return -1 end
if ARGV[4] == 'update' and exists == 0 then return -2 end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

function parseSnapshot(raw) {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new BotError('STATE_RESPONSE_INVALID');
  if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw new BotError('STATE_TOO_LARGE');
  let snapshot;
  try { snapshot = JSON.parse(raw); }
  catch { throw new BotError('STATE_INVALID'); }
  if (!snapshot || typeof snapshot !== 'object') throw new BotError('STATE_INVALID');
  return snapshot;
}

export class CloudState {
  constructor({ url, token, namespace }, shipment, { request = requestJson, log = () => {} } = {}) {
    this.url = url;
    this.token = token;
    this.key = `${namespace}:v1:${shipmentIdentity(shipment)}`;
    this.leaseKey = `${this.key}:lease`;
    this.request = request;
    this.log = log;
  }

  async command(body, signal) {
    let response;
    try {
      response = await this.request(this.url, { body, headers: { authorization: `Bearer ${this.token}` }, timeoutMs: 12000, signal });
    } catch (error) {
      if (error.code === 'HTTP_RESPONSE_TOO_LARGE') throw new BotError('STATE_TOO_LARGE');
      throw new BotError('STATE_NETWORK_ERROR');
    }
    if (response.status === 401 || response.status === 403) throw new BotError('STATE_AUTH_FAILED');
    if (response.status === 429 || response.status >= 500) throw new BotError('STATE_NETWORK_ERROR');
    if (!response.ok || !response.json || !Object.hasOwn(response.json, 'result')) throw new BotError('STATE_RESPONSE_INVALID');
    return response.json.result;
  }

  async read(signal) {
    return parseSnapshot(await this.command(['GET', this.key], signal));
  }

  async withLease(run, signal) {
    const owner = randomUUID();
    const acquired = await this.command(['EVAL', ACQUIRE, 2, this.leaseKey, this.key, owner, LEASE_MS], signal);
    if (Array.isArray(acquired) && acquired[0] === 0) throw new BotError('STATE_BUSY');
    if (!Array.isArray(acquired) || acquired[0] !== 1) throw new BotError('STATE_RESPONSE_INVALID');
    try {
      const snapshot = parseSnapshot(acquired[1]);
      const save = async (value, { initialize = false } = {}) => {
        const raw = JSON.stringify(value);
        if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw new BotError('STATE_TOO_LARGE');
        // Finish the durable write even if the process received SIGTERM after a send.
        const result = await this.command(['EVAL', SAVE, 2, this.leaseKey, this.key, owner, raw, LEASE_MS, initialize ? 'initialize' : 'update']);
        if (result === 0) throw new BotError('STATE_LEASE_LOST');
        if (result === -1) throw new BotError('STATE_ALREADY_EXISTS');
        if (result === -2) throw new BotError('STATE_MISSING');
        if (result !== 1) throw new BotError('STATE_RESPONSE_INVALID');
      };
      return await run({ snapshot, save });
    } finally {
      try { await this.command(['EVAL', RELEASE, 1, this.leaseKey, owner]); }
      catch (error) { this.log('state_release_failed', { code: safeCode(error) }); }
    }
  }
}

export function cloudMonitor({ remote, shipment, initializeOnSuccess = false, log = () => {}, ...options }) {
  return {
    async cycle(signal) {
      try {
        return await remote.withLease(async ({ snapshot, save }) => {
          if (!snapshot && !initializeOnSuccess) throw new BotError('STATE_MISSING');
          const store = new Store(':memory:', shipment);
          try {
            if (snapshot) store.restoreSnapshot(snapshot);
            store.recoverSending();
            let initialize = !snapshot;
            const checkpoint = async () => {
              if (initialize && !store.getState().initialized) return;
              await save(store.exportSnapshot(), { initialize });
              initialize = false;
            };
            const monitor = new Monitor({ ...options, store, log, checkpoint });
            return await monitor.cycle(signal);
          } finally { store.close(); }
        }, signal);
      } catch (error) {
        if (signal?.aborted) return { stopped: true };
        if (!['STATE_BUSY', 'STATE_LEASE_LOST', 'STATE_NETWORK_ERROR'].includes(error.code)) throw error;
        log(error.code === 'STATE_BUSY' ? 'state_busy' : 'state_retry', { code: safeCode(error) });
        return { skipped: true };
      }
    },
  };
}
