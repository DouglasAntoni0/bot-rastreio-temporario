import test from 'node:test';
import assert from 'node:assert/strict';
import { Ssw, SSW_FORM, parseSswDetail, sswDetailFields } from '../src/ssw.js';
import { parseConfig } from '../src/config.js';
import { CloudState, cloudMonitor } from '../src/cloud-state.js';
import { combinedMonitor } from '../src/engine.js';
import { Store } from '../src/store.js';
import { BotError } from '../src/errors.js';
import { shipment, first, next, snapshot } from './helpers.js';

const ssw = { cpf: '00000000000', invoice: '8294' };
const resultRow = (invoice, id) => `<tr><td><span>001 ${invoice}</span></td><td>Unidade</td><td>
  <a href="#" onclick="opx('/2/ssw_SSWDetalhado?id=${id}=&amp;md=abc+%2F==')">Mais detalhes</a></td></tr>`;
const result = `<table>${resultRow('008295', 'outra')}${resultRow('008294', 'correta')}</table>`;
const movement = (day, title, unit = 'CIDADE DE TESTE / MG') => `<tr><td>${day}/01/25<br>12:34</td>
  <td>${unit}<br>TVA&nbsp;XXX</td><td><p class="titulo"><b>${title}</b></p><p>Descrição fictícia.</p></td></tr>`;
const detail = ({ eta = '28/01/25', invoice = '008294', history = movement('02', 'EM TRÂNSITO') } = {}) => `
  <h2>Rastreamento detalhado</h2>
  <div>Previsão de entrega:<span>${eta}</span></div>
  <div><span>N Fiscal:</span><span>001 ${invoice}</span></div>
  <table><tr><td>Data/Hora</td><td>Unidade</td><td>Situação</td></tr>${history}</table>`;

test('SSW é opcional, mantém o CPF como texto e usa chave própria no mesmo Redis', () => {
  const env = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'fictitious_test_value' };
  const options = { remote: true, needToken: false, needChat: false, needShipment: false };
  assert.equal(parseConfig(env, options).ssw, null);
  assert.equal(parseConfig({ ...env, SSW_NF: ssw.invoice }, options).sswInvalid, true);
  const config = parseConfig({ ...env, SSW_CPF: ssw.cpf, SSW_NF: `00${ssw.invoice}` }, options);
  assert.deepEqual(config.ssw, ssw);
  const rodonavesState = new CloudState(config.state, shipment);
  const sswState = new CloudState({ ...config.state, namespace: `${config.state.namespace}:ssw` }, ssw);
  assert.equal(sswState.url, rodonavesState.url);
  assert.match(sswState.key, /^rodonaves:ssw:v1:/);
  assert.match(rodonavesState.key, /^rodonaves:v1:/);
  assert.notEqual(sswState.leaseKey, rodonavesState.leaseKey);
});

test('cliente SSW envia a consulta normal e abre o detalhamento da nota exata', async () => {
  const requests = [];
  const source = new Ssw(ssw, { fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return new Response(['<form></form>', result, detail()][requests.length - 1], { headers: { 'set-cookie': 'session=ficticia; Secure' } });
  } });
  const data = await source.consult();
  assert.deepEqual(requests.map(r => [new URL(r.url).pathname, r.method]), [
    ['/2/rastreamento_dest', 'GET'], ['/2/resultSSW_dest_nro', 'POST'], ['/2/SSWDetalhado', 'POST'],
  ]);
  assert.equal(requests[1].headers.cookie, 'session=ficticia');
  assert.deepEqual(Object.fromEntries(requests[1].body), { cnpjdest: ssw.cpf, NR: ssw.invoice, chave: '' });
  assert.deepEqual(Object.fromEntries(requests[2].body), { id: 'correta', md: 'abc+%252F', w: 'x' });
  assert.equal(data.eta, '2025-01-28');
  assert.equal(data.statusText, 'EM TRÂNSITO');
  assert.equal(data.latestAt, '2025-01-02T12:34:00-03:00');
  assert.match(data.events[0].description, /CIDADE DE TESTE \/ MG TVA XXX/);
  assert.throws(() => sswDetailFields(result, '829'), /SSW_INVOICE_MISMATCH/);
  assert.throws(() => sswDetailFields(`<table>${resultRow('008294', 'a')}${resultRow('008294', 'b')}</table>`, ssw.invoice), /SSW_INVOICE_MISMATCH/);
  assert.throws(() => parseSswDetail(detail({ invoice: '008295' }), ssw), /SSW_INVOICE_MISMATCH/);
  assert.equal(parseSswDetail(detail({ eta: '' }), ssw).eta, null);
});

function fakeRemote(initial = null) {
  let saved = initial;
  return {
    async withLease(run) {
      return run({ snapshot: structuredClone(saved), save: async (value, { initialize }) => {
        assert.equal(initialize, !saved);
        saved = structuredClone(value);
      } });
    },
    read: () => structuredClone(saved),
  };
}

test('SSW grava a primeira consulta silenciosamente e retoma sem avisos repetidos', async () => {
  const remote = fakeRemote();
  let html = detail();
  const sent = [];
  const restart = () => cloudMonitor({ remote, shipment: ssw, source: { consult: async () => parseSswDetail(html, ssw) },
    telegram: { send: async text => sent.push(text) }, link: SSW_FORM, carrier: 'Trans Vales (SSW)',
    initializeOnSuccess: true, failureAlerts: false });
  await restart().cycle();
  assert.equal(remote.read().events.length, 1);
  assert.equal(remote.read().outbox.length, 0);
  assert.equal(sent.length, 0);

  const correction = movement('02', 'SAIU PARA ENTREGA', 'CIDADE DE TESTE 000.000.000-00');
  html = detail({ history: correction });
  await restart().cycle();
  await restart().cycle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Trans Vales \(SSW\)/);
  assert.match(sent[0], /SAIU PARA ENTREGA/);
  assert.doesNotMatch(sent[0], /000\.000\.000-00|00000000000/);
  assert.equal(remote.read().state.statusText, 'SAIU PARA ENTREGA');

  html = detail({ eta: '29/01/2025', history: correction });
  await restart().cycle();
  await restart().cycle();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Nova previsão de entrega: 29\/01\/2025/);
  assert.doesNotMatch(sent[1], /Nova movimentação/);
  assert.equal(remote.read().outbox.filter(x => x.status === 'sent').length, 2);
});

test('SSW recusada ou com falha no Redis deixa a Rodonaves consultar e enviar normalmente', async () => {
  const store = new Store(':memory:', shipment);
  const rodonavesState = fakeRemote(store.exportSnapshot());
  store.close();
  const sswState = fakeRemote();
  const sent = [];
  const logs = [];
  const telegram = { send: async text => sent.push(text) };
  const log = (event, metadata) => logs.push([event, metadata]);
  let current = snapshot({ steps: [first] });
  const rodonaves = cloudMonitor({ remote: rodonavesState, shipment, source: { consult: async () => current }, telegram });
  const sswMonitor = cloudMonitor({ remote: sswState, shipment: ssw, telegram, initializeOnSuccess: true, failureAlerts: false, log,
    source: new Ssw(ssw, { fetchImpl: async () => new Response(null, { status: 403 }) }) });
  const monitor = combinedMonitor([['rodonaves', rodonaves], ['ssw', sswMonitor]], log);
  await monitor.cycle();
  current = snapshot({ steps: [first, next] });
  await monitor.cycle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Rodonaves/);
  assert.equal(rodonavesState.read().events.length, 2);
  assert.equal(sswState.read(), null);
  assert.ok(logs.some(([event, data]) => event === 'tracking_failed' && data.code === 'SSW_HTTP_403'));

  sswState.withLease = async () => { throw new BotError('STATE_INVALID'); };
  const [rod, trans] = await monitor.cycle();
  assert.equal(rod.success, true);
  assert.equal(trans.success, false);
  assert.ok(logs.some(([event, data]) => event === 'source_cycle_failed' && data.source === 'ssw'));
});
