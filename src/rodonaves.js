import { randomBytes } from 'node:crypto';
import { requestJson } from './http.js';
import { encryptRequest, decryptResponse } from './jwe.js';
import { parseTracking } from './normalize.js';
import { BotError, safeCode } from './errors.js';
const BASE = 'https://rodonaves.com.br/api';

export class Rodonaves {
  constructor(shipment, { request = requestJson, log = () => {} } = {}) {
    this.shipment = shipment;
    this.request = request;
    this.log = log;
    this.key = null;
    this.keyAt = 0;
  }
  async search(query, signal, refreshed = false) {
    if (!this.key || Date.now() - this.keyAt > 1800000) {
      const r = await this.request(`${BASE}/security/jwe-key`, { signal });
      if (!r.ok || !r.json?.data?.enabled || !r.json.data.keyId || !r.json.data.publicKeyPem) throw new BotError('TRACKING_KEY_UNAVAILABLE');
      this.key = r.json.data;
      this.keyAt = Date.now();
    }
    const responseKey = randomBytes(32);
    const r = await this.request(`${BASE}/tracking/search`, {
      body: { key: encryptRequest(Buffer.from(JSON.stringify(query)), this.key) },
      headers: { 'X-Jwe-Response-Key': encryptRequest(responseKey, this.key) }, signal,
    });
    const json = r.headers.get('X-Jwe-Encrypted') === '1' ? decryptResponse(r.json, responseKey) : r.json;
    if (!r.ok) {
      if (!refreshed && r.status === 400 && ['jwe.invalid', 'jwe.required'].includes(json?.title)) {
        this.key = null;
        return this.search(query, signal, true);
      }
      if ([401, 403, 429].includes(r.status) || /captcha|gate|unauthorized/i.test(json?.title ?? '')) throw new BotError('TRACKING_ACCESS_RESTRICTED');
      throw new BotError('TRACKING_HTTP_ERROR');
    }
    return json;
  }
  async consult(signal) {
    // Same official API, two independently verified selectors; at most one fallback.
    const sources = [
      ['protocol', { protocolNumber: this.shipment.protocol }],
      ['cte', { cTeNumber: this.shipment.cte, taxIdRegistration: this.shipment.cnpj }],
    ];
    for (const [source, query] of sources) {
      try { return parseTracking(await this.search(query, signal), this.shipment, source); }
      catch (error) {
        this.log('source_failed', { source, code: safeCode(error) });
        if (signal?.aborted || error.code === 'TRACKING_ACCESS_RESTRICTED') throw error;
      }
    }
    throw new BotError('TRACKING_ALL_SOURCES_FAILED');
  }
}
