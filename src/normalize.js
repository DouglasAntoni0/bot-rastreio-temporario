import { createHash } from 'node:crypto';
import { BotError } from './errors.js';

export const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
const digits = value => String(value ?? '').replace(/^0+(?=\d)/, '');
const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function canonicalTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) throw new BotError('TRACKING_DATE_INVALID');
  const calendar = new Date(value.slice(0, 10) + 'T12:00:00Z');
  if (!Number.isFinite(+calendar) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new BotError('TRACKING_DATE_INVALID');
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + '-03:00';
  const date = new Date(zoned);
  if (!Number.isFinite(+date) || +date > Date.now() + 86400000) throw new BotError('TRACKING_DATE_INVALID');
  const p = Object.fromEntries(parts.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00-03:00`;
}
export function deliveryDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  const date = new Date(text + 'T12:00:00Z');
  if (!/^\d{4}-\d\d-\d\d$/.test(text) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== text) throw new BotError('TRACKING_ETA_INVALID');
  return text;
}
export const displayDate = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : 'Não informada';
export function parseTracking(body, shipment, source = 'protocol') {
  if (!body || !Array.isArray(body.data)) throw new BotError('TRACKING_RESPONSE_INVALID');
  const candidates = body.data.filter(row => row && digits(row.protocolNumber) === digits(shipment.protocol) && digits(row.cTeNumber) === digits(shipment.cte) && row.serviceType === 1);
  if (candidates.length !== 1) throw new BotError('TRACKING_IDENTITY_MISMATCH');
  const row = candidates[0];
  if (!Array.isArray(row.invoiceNumbers) || !row.invoiceNumbers.some(n => digits(n) === digits(shipment.invoice))) throw new BotError('TRACKING_INVOICE_MISMATCH');
  if (![1, 2, 3].includes(row.status)) throw new BotError('TRACKING_STATUS_INVALID');
  const history = Array.isArray(row.historicDetails) && row.historicDetails.length ? row.historicDetails : row.steps;
  if (!Array.isArray(history) || !history.length || history.length > 10000) throw new BotError('TRACKING_HISTORY_EMPTY');
  const unique = new Map();
  for (const event of history) {
    if (!event || typeof event !== 'object') throw new BotError('TRACKING_EVENT_INVALID');
    const occurredAt = canonicalTime(event.occurredAt);
    const raw = event.reason ?? event.detailMessage ?? event.description;
    const description = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 1500) : '';
    const normalized = normalize(description);
    // An actual dated event with no description still produces a generic notice.
    const id = hash(`${occurredAt}|${normalized || 'sem-descricao'}`);
    unique.set(id, { id, occurredAt, description: normalized ? description : '', normalized });
  }
  const events = [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return { protocol: shipment.protocol, cte: shipment.cte, status: row.status, eta: deliveryDate(row.estimatedDeliveryDate ?? row.additionalDetails?.estimatedDeliveryDate), events, latestAt: events.at(-1).occurredAt, source };
}
