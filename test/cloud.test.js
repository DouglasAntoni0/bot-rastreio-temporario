import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { CloudState, cloudMonitor } from '../src/cloud-state.js';
import { Store } from '../src/store.js';
import { BotError } from '../src/errors.js';
import { shipment, first, next, snapshot } from './helpers.js';

const testToken = ['123', 'a'.repeat(32)].join(':');
const validEnv = {
  TELEGRAM_BOT_TOKEN: testToken, TELEGRAM_CHAT_ID: '123',
  RODONAVES_PROTOCOLO: shipment.protocol, RODONAVES_CTE: shipment.cte,
  RODONAVES_CNPJ: shipment.cnpj, RODONAVES_NF: shipment.invoice,
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'fictitious_test_value',
};

function fakeCloud() {
  let stored;
  let busy = false;
  const remote = {
    beforeSave: () => {},
    async withLease(run) {
      if (busy) throw new BotError('STATE_BUSY');
      busy = true;
      try {
        return await run({ snapshot: structuredClone(stored), save: async value => {
          remote.beforeSave(value);
          stored = structuredClone(value);
        } });
      } finally { busy = false; }
    },
    read: () => structuredClone(stored),
  };
  const store = new Store(':memory:', shipment);
  stored = store.exportSnapshot();
  store.close();
  const sent = [];
  let now = Date.now();
  const options = {
    remote, shipment, link: 'https://example.test',
    source: { consult: async () => snapshot() },
    telegram: { send: async message => sent.push(message) },
    clock: () => now,
  };
  return { remote, options, sent, restart: () => cloudMonitor(options), advance: () => { now += 300000; } };
}

test('configuração valida variáveis obrigatórias, mantém aliases locais e recusa URL externa', () => {
  const config = parseConfig(validEnv, { remote: true });
  assert.deepEqual(config.shipment, shipment);
  assert.equal(config.intervalMs, 300000);
  assert.throws(() => parseConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: '' }), /CONFIG_TOKEN_INVALID/);
  assert.throws(() => parseConfig({ ...validEnv, TELEGRAM_CHAT_ID: '-123' }), /CONFIG_PRIVATE_CHAT_REQUIRED/);
  assert.throws(() => parseConfig({ ...validEnv, RODONAVES_CTE: undefined }), /CONFIG_SHIPMENT_INVALID/);
  assert.throws(() => parseConfig({ ...validEnv, CHECK_INTERVAL_MS: '1000' }), /CONFIG_INTERVAL_INVALID/);
  assert.throws(() => parseConfig({ ...validEnv, UPSTASH_REDIS_REST_URL: 'https://example.test' }, { remote: true }), /CONFIG_STATE_INVALID/);
  const legacy = { TELEGRAM_BOT_TOKEN: testToken, TELEGRAM_CHAT_ID: '123', TRACKING_PROTOCOL: shipment.protocol,
    TRACKING_CTE: shipment.cte, TRACKING_CNPJ: shipment.cnpj, TRACKING_INVOICE: shipment.invoice, POLL_SECONDS: '300' };
  assert.deepEqual(parseConfig(legacy).shipment, shipment);
});

test('CLI em nuvem ignora .env e não mostra valores ao validar configuração', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TELEGRAM_|RODONAVES_|TRACKING_|UPSTASH_|NODE_OPTIONS$|STATE_NAMESPACE$|POLL_SECONDS$|CHECK_INTERVAL_MS$)/i.test(key)));
  const missing = spawnSync(process.execPath, [cli, 'check-config', '--cloud'], { env: clean, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CONFIG_TOKEN_INVALID/);
  const good = spawnSync(process.execPath, [cli, 'check-config', '--cloud'], { env: { ...clean, ...validEnv }, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).armazenamento, 'upstash');
  for (const value of [testToken, shipment.protocol, shipment.cte, shipment.cnpj, shipment.invoice, validEnv.UPSTASH_REDIS_REST_TOKEN]) {
    assert.ok(!(good.stdout + good.stderr).includes(value));
  }
});

test('backup preserva todos os campos e recusa outro rastreio ou estado incompleto', async () => {
  const h = fakeCloud();
  await h.restart().cycle();
  h.options.source.consult = async () => snapshot({ steps: [first, next] });
  await h.restart().cycle();
  const original = h.remote.read();
  const store = new Store(':memory:', shipment);
  try {
    store.restoreSnapshot(original);
    assert.deepEqual(store.exportSnapshot(), original);
    assert.throws(() => store.restoreSnapshot({ ...original, shipment: 'outra' }), /DATABASE_SHIPMENT_MISMATCH/);
    assert.throws(() => store.restoreSnapshot({ ...original, events: [] }), /STATE_INVALID/);
    assert.deepEqual(store.exportSnapshot(), original);
  } finally { store.close(); }
});

test('novo processo recupera histórico e notificação pendente sem duplicar eventos', async () => {
  const h = fakeCloud();
  await h.restart().cycle();
  h.options.source.consult = async () => snapshot({ steps: [first, next] });
  const send = h.options.telegram.send;
  h.options.telegram.send = async () => { throw new BotError('TELEGRAM_API_ERROR'); };
  await h.restart().cycle();
  assert.equal(h.remote.read().outbox[0].status, 'pending');
  h.options.telegram.send = send;
  h.advance();
  h.options.source.consult = async () => snapshot({ steps: [next, first] });
  await h.restart().cycle();
  await h.restart().cycle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.remote.read().outbox[0].status, 'sent');
});

test('sem gravação durável, o bot adia o envio e recupera no ciclo seguinte', async () => {
  const h = fakeCloud();
  await h.restart().cycle();
  h.options.source.consult = async () => snapshot({ steps: [first, next] });
  h.remote.beforeSave = value => {
    if (value.outbox[0]?.status === 'sending') throw new BotError('STATE_NETWORK_ERROR');
  };
  assert.deepEqual(await h.restart().cycle(), { skipped: true });
  assert.equal(h.sent.length, 0);
  assert.equal(h.remote.read().outbox[0].status, 'pending');
  h.remote.beforeSave = () => {};
  await h.restart().cycle();
  assert.equal(h.sent.length, 1);
});

test('falha ao persistir a confirmação preserva envio incerto após reinício', async () => {
  const h = fakeCloud();
  await h.restart().cycle();
  h.options.source.consult = async () => snapshot({ steps: [first, next] });
  h.remote.beforeSave = value => {
    if (value.outbox[0]?.status === 'sent') throw new BotError('STATE_NETWORK_ERROR');
  };
  assert.deepEqual(await h.restart().cycle(), { skipped: true });
  assert.equal(h.sent.length, 1);
  assert.equal(h.remote.read().outbox[0].status, 'sending');
  h.remote.beforeSave = () => {};
  await h.restart().cycle();
  assert.equal(h.sent.length, 1);
  assert.equal(h.remote.read().outbox[0].status, 'uncertain');
});

test('exclusão entre processos protege a consulta e o estado ausente não vira baseline', async () => {
  const h = fakeCloud();
  let finish;
  h.options.source.consult = () => new Promise(resolve => { finish = resolve; });
  const running = h.restart().cycle();
  assert.deepEqual(await h.restart().cycle(), { skipped: true });
  finish(snapshot());
  await running;
  h.options.remote = { withLease: run => run({ snapshot: null }) };
  await assert.rejects(() => h.restart().cycle(), /STATE_MISSING/);
});

test('erros do Redis expõem somente códigos seguros', async () => {
  const state = new CloudState(parseConfig(validEnv, { remote: true }).state, shipment, {
    request: async () => ({ ok: false, status: 401, json: { error: testToken } }),
  });
  await assert.rejects(() => state.read(), error => error.message === 'STATE_AUTH_FAILED');
});
