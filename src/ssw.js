import { parse } from 'parse5';
import { BotError } from './errors.js';
import { readBody } from './http.js';
import { canonicalTime, deliveryDate, hash, normalize } from './normalize.js';

export const SSW_FORM = 'https://ssw.inf.br/2/rastreamento_dest?pwd=2';
const ORIGIN = new URL(SSW_FORM).origin;
const RESULT = `${ORIGIN}/2/resultSSW_dest_nro`;
const DETAIL = `${ORIGIN}/2/SSWDetalhado`;
const DATE = /\b(\d{2})\/(\d{2})\/(\d{4}|\d{2})\b/;

function* elements(node, tag) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName === tag) yield child;
    yield* elements(child, tag);
  }
}

function plainText(node) {
  if (node.nodeName === '#text') return node.value;
  if (node.tagName === 'br') return ' ';
  return (node.childNodes ?? []).map(plainText).join('');
}

const text = node => plainText(node).replace(/\s+/g, ' ').trim();
const attr = (node, key) => node.attrs?.find(a => a.name === key)?.value;
const cells = row => row.childNodes.filter(node => node.tagName === 'td' || node.tagName === 'th');
const invoiceNumber = value => value.replace(/^0+(?=\d)/, '');
const isoDate = ([, day, month, year]) => `${year.length === 2 ? `20${year}` : year}-${month}-${day}`;

export function sswDetailFields(html, invoice) {
  const matches = [...elements(parse(html), 'tr')].filter(row => {
    const [first, , situation] = cells(row);
    const number = first && /^\d{3}\s+(\d+)(?:\s|$)/.exec(text(first));
    return situation && number && invoiceNumber(number[1]) === invoiceNumber(invoice);
  });
  if (matches.length !== 1) throw new BotError('SSW_INVOICE_MISMATCH');
  const links = [...elements(cells(matches[0])[2], 'a')].filter(link => normalize(text(link)) === 'mais detalhes');
  if (links.length !== 1) throw new BotError('SSW_DETAIL_LINK_INVALID');
  // The public form's opx() passes id, md and w=x to its detail POST. It strips base64 padding.
  const params = /^opx\(['"]\/2\/ssw_SSWDetalhado\?id=([\w+/%-]{1,512})=*&md=([\w+/%-]{1,512})=*['"]\);?$/.exec(attr(links[0], 'onclick')?.trim() ?? '');
  if (!params) throw new BotError('SSW_DETAIL_LINK_INVALID');
  const [, id, md] = params;
  return { id: id.replaceAll('%', '%25'), md: md.replaceAll('%', '%25'), w: 'x' };
}

export function parseSswDetail(html, { cpf, invoice }) {
  const page = parse(html);
  const invoiceLabel = [...elements(page, 'span')].find(span => normalize(text(span)) === 'n fiscal');
  const number = invoiceLabel && /^N Fiscal:\s*\d{3}\s*(\d+)$/i.exec(text(invoiceLabel.parentNode));
  if (!number || invoiceNumber(number[1]) !== invoiceNumber(invoice)) throw new BotError('SSW_INVOICE_MISMATCH');
  const etaLabel = [...elements(page, 'div')].find(div => /^Previsão de entrega:/i.test(div.childNodes[0]?.value?.trim() ?? ''));
  const date = etaLabel && DATE.exec(text(etaLabel));
  const eta = date ? deliveryDate(isoDate(date)) : null;

  const table = [...elements(page, 'table')].find(candidate => [...elements(candidate, 'tr')].some(row =>
    cells(row).map(cell => normalize(text(cell))).join('|') === 'data hora|unidade|situacao'));
  if (!table) throw new BotError('SSW_HISTORY_MISSING');

  const cpfPattern = new RegExp(cpf.split('').join('[.\\s-]*'), 'g');
  const clean = node => text(node).replace(cpfPattern, '[CPF omitido]').slice(0, 300);
  const unique = new Map();
  for (const row of elements(table, 'tr')) {
    const [when, location, situation] = cells(row);
    const timestamp = when && DATE.exec(text(when));
    if (!timestamp) continue;
    const time = /\b\d{2}:\d{2}\b/.exec(text(when));
    const title = situation && [...elements(situation, 'p')].find(p => attr(p, 'class')?.split(/\s+/).includes('titulo'));
    if (!time || !title || !location) throw new BotError('SSW_EVENT_INVALID');
    const occurredAt = canonicalTime(`${isoDate(timestamp)}T${time[0]}:00`);
    const unit = clean(location);
    const statusText = clean(title);
    if (!unit || !statusText) throw new BotError('SSW_EVENT_INVALID');
    const id = hash(`${occurredAt}|${normalize(unit)}|${normalize(statusText)}`);
    unique.set(id, { id, occurredAt, statusText, description: `${statusText}\nUnidade: ${unit}` });
  }
  const events = [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  // SSW lists the newest movement first, including entries with the same date and time.
  const latestAt = events.at(-1)?.occurredAt;
  if (!latestAt) throw new BotError('SSW_HISTORY_MISSING');
  const { statusText } = events.find(event => event.occurredAt === latestAt);
  return { status: 1, statusText, eta, events, latestAt };
}

export class Ssw {
  constructor(shipment, { fetchImpl = fetch } = {}) {
    Object.assign(this, { shipment, fetchImpl });
  }

  async consult(signal) {
    const cookies = new Map();
    const timeout = AbortSignal.timeout(20000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const request = async (url, body, referer) => {
      const headers = { accept: 'text/html' };
      if (cookies.size) headers.cookie = [...cookies.values()].join('; ');
      if (body) Object.assign(headers, { origin: ORIGIN, referer });
      try {
        const response = await this.fetchImpl(url, { method: body ? 'POST' : 'GET', body, headers, redirect: 'manual', signal: requestSignal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BotError(`SSW_HTTP_${response.status}`);
        }
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';', 1)[0];
          cookies.set(pair.split('=', 1)[0], pair);
        }
        const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
        return new TextDecoder(charset).decode(await readBody(response));
      } catch (error) {
        if (error instanceof BotError) throw error;
        throw new BotError(requestSignal.aborted ? 'SSW_REQUEST_ABORTED' : 'SSW_NETWORK_ERROR');
      }
    };

    const { cpf, invoice } = this.shipment;
    await request(SSW_FORM);
    const result = await request(RESULT, new URLSearchParams({ cnpjdest: cpf, NR: invoice, chave: '' }), SSW_FORM);
    const detail = await request(DETAIL, new URLSearchParams(sswDetailFields(result, invoice)), RESULT);
    return parseSswDetail(detail, this.shipment);
  }
}
