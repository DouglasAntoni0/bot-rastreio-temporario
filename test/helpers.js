import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/engine.js';
import { parseTracking } from '../src/normalize.js';
export const shipment = { protocol: '900000001', cte: '900000002', cnpj: '00000000000000', invoice: '999991' };
export const first = { description: 'Mercadoria recebida pela transportadora na unidade de Alfa-PR.', occurredAt: '2024-07-01T17:20:13-03:00' };
export const next = { description: 'EM TRÂNSITO PARA A UNIDADE DE TRANSFERÊNCIA BETA-SP.', occurredAt: '2024-07-02T01:37:21-03:00' };
export function payload({ steps = [first], status = 1, eta = '2024-07-06' } = {}) {
  return { data: [{ protocolNumber: shipment.protocol, cTeNumber: shipment.cte, serviceType: 1, invoiceNumbers: ['000999991'], status, steps, historicDetails: [], estimatedDeliveryDate: eta }] };
}
export const snapshot = options => parseTracking(payload(options), shipment);
export function harness(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'rodonaves-test-'));
  const filename = path.join(directory, 'tracking.sqlite');
  let store = new Store(filename, shipment);
  const sent = [], logs = [];
  const telegram = { send: async text => { sent.push(text); return sent.length; } };
  const source = { consult: async () => snapshot() };
  let now = Date.now();
  const monitor = new Monitor({ store, source, telegram, link: 'https://rodonaves.com.br/rastreamento/900000001?modal=rodoviario', clock: () => now, log: (event, metadata) => logs.push({ event, metadata }) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { monitor, source, telegram, sent, logs, get store() { return store; }, directory, filename, advance: seconds => { now += seconds * 1000; }, reopen() { store.close(); store = new Store(filename, shipment); monitor.store = store; store.recoverSending(); } };
}
