import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { harness, snapshot, first, next, shipment } from './helpers.js';
import { InstanceLock, Store } from '../src/store.js';
import { runLoop } from '../src/engine.js';
import { BotError } from '../src/errors.js';

test('01 primeira consulta salva referência sem mensagem antiga', async t => {
  const h = harness(t); await h.monitor.cycle();
  assert.equal(h.sent.length, 0); assert.equal(h.store.events().length, 1); assert.equal(h.store.getState().initialized, true);
});
test('02 consulta sem alterações fica silenciosa', async t => {
  const h = harness(t); await h.monitor.cycle(); await h.monitor.cycle(); assert.equal(h.sent.length, 0);
});
test('mudança na ordem dos eventos não gera nova notificação', async t => {
  const h = harness(t);
  h.source.consult = async () => snapshot({ steps: [first, next] });
  await h.monitor.cycle();
  h.source.consult = async () => snapshot({ steps: [next, first] });
  await h.monitor.cycle();
  assert.equal(h.store.events().length, 2);
  assert.equal(h.sent.length, 0);
});
test('03 nova movimentação gera uma mensagem com dados reais do evento', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => snapshot({ steps: [first, next] });
  await h.monitor.cycle(); assert.equal(h.sent.length, 1); assert.match(h.sent[0], /BETA-SP/); assert.match(h.sent[0], /01:37/); assert.match(h.sent[0], /06\/07\/2024/);
});
test('04 evento já notificado não é repetido nem após reiniciar', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => snapshot({ steps: [first, next] });
  await h.monitor.cycle(); h.reopen(); await h.monitor.cycle(); assert.equal(h.sent.length, 1); assert.equal(h.store.notifications()[0].status, 'sent');
});
for (const failures of [1, 2]) test(`0${failures + 4} ${failures} falha(s) não dispara(m) alerta`, async t => {
  const h = harness(t); h.source.consult = async () => { throw new Error('offline'); };
  for (let n = 0; n < failures; n++) await h.monitor.cycle(); assert.equal(h.sent.length, 0); assert.equal(h.store.getState().failures, failures);
});
test('07 três falhas consecutivas enviam um alerta', async t => {
  const h = harness(t); h.source.consult = async () => { throw new Error('offline'); };
  for (let n = 0; n < 3; n++) await h.monitor.cycle();
  assert.equal(h.sent.length, 1); assert.match(h.sent[0], /FALHA NO RASTREAMENTO/); assert.equal(h.store.getState().failureAlertSent, true);
});
test('08 falhas adicionais e reinício não repetem alerta', async t => {
  const h = harness(t); h.source.consult = async () => { throw new Error('offline'); };
  for (let n = 0; n < 3; n++) await h.monitor.cycle(); h.reopen();
  for (let n = 0; n < 5; n++) await h.monitor.cycle(); assert.equal(h.sent.length, 1);
});
test('09 sucesso zera falhas e permite alerta em nova sequência', async t => {
  const h = harness(t), fail = async () => { throw new Error('offline'); }; h.source.consult = fail;
  for (let n = 0; n < 3; n++) await h.monitor.cycle(); h.source.consult = async () => snapshot(); await h.monitor.cycle();
  assert.equal(h.store.getState().failures, 0); assert.equal(h.store.getState().failureAlertSent, false);
  h.source.consult = fail; for (let n = 0; n < 3; n++) await h.monitor.cycle(); assert.equal(h.sent.length, 2);
});
test('10 fechamento preserva referência, eventos e contador', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => { throw new Error(); }; await h.monitor.cycle();
  const before = h.store.getState(); h.reopen(); assert.deepEqual(h.store.getState(), before); assert.equal(h.store.events().length, 1);
});
test('11 fonte antiga não apaga histórico, previsão nem status', async t => {
  const h = harness(t); h.source.consult = async () => snapshot({ steps: [first, next], status: 2, eta: '2024-07-07' }); await h.monitor.cycle();
  h.source.consult = async () => snapshot(); await h.monitor.cycle();
  const state = h.store.getState(); assert.equal(state.status, 2); assert.equal(state.eta, '2024-07-07'); assert.equal(h.store.events().length, 2); assert.equal(h.sent.length, 0);
});
test('12 erro explícito do Telegram preserva pendência e tenta no ciclo seguinte', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => snapshot({ steps: [first, next] });
  h.telegram.send = async () => { throw new BotError('TELEGRAM_API_ERROR'); }; await h.monitor.cycle();
  assert.equal(h.store.notifications()[0].status, 'pending'); h.reopen(); h.advance(300);
  h.telegram.send = async text => { h.sent.push(text); return 123; }; await h.monitor.cycle();
  assert.equal(h.sent.length, 1); assert.equal(h.store.notifications()[0].status, 'sent');
});
test('13 mudança de previsão gera uma mensagem e não se repete', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => snapshot({ eta: '2024-07-07' });
  await h.monitor.cycle(); await h.monitor.cycle(); assert.equal(h.sent.length, 1); assert.match(h.sent[0], /07\/07\/2024/);
});
test('14 internet temporariamente indisponível não encerra loop; espera 300s e recupera', async t => {
  const h = harness(t), stop = new AbortController(); let count = 0, waits = 0;
  h.source.consult = async () => { if (++count === 1) throw new Error('offline'); return snapshot(); };
  await runLoop(h.monitor, { signal: stop.signal, clock: () => 1000, sleep: async ms => { assert.equal(ms, 300000); if (++waits === 2) stop.abort(); } });
  assert.equal(count, 2); assert.equal(h.store.getState().failures, 0); assert.equal(h.store.getState().initialized, true);
});
test('15 caixa, acentos, pontuação, segundos e espaços não viram novidade', async t => {
  const h = harness(t); h.source.consult = async () => snapshot({ steps: [next] }); await h.monitor.cycle();
  h.source.consult = async () => snapshot({ steps: [{ description: '  Em transito para a unidade de transferencia BETA SP  ', occurredAt: '2024-07-02T04:37:00Z' }] });
  await h.monitor.cycle(); assert.equal(h.sent.length, 0); assert.equal(h.store.events().length, 1);
});
test('16 linha histórica descoberta com data antiga é preservada sem falsa novidade', async t => {
  const h = harness(t); h.source.consult = async () => snapshot({ steps: [next] }); await h.monitor.cycle();
  h.source.consult = async () => snapshot({ steps: [first, next] }); await h.monitor.cycle(); assert.equal(h.sent.length, 0); assert.equal(h.store.events().length, 2);
});
test('17 consultas concorrentes são impedidas', async t => {
  const h = harness(t); let release; h.source.consult = () => new Promise(resolve => { release = resolve; });
  const pending = h.monitor.cycle(); assert.deepEqual(await h.monitor.cycle(), { skipped: true }); release(snapshot()); await pending;
});
test('18 SQLite impede segunda instância e libera ao fechar', t => {
  const h = harness(t), p = path.join(h.directory, 'instance.sqlite'), firstLock = new InstanceLock(p);
  assert.throws(() => new InstanceLock(p), /INSTANCE_ALREADY_RUNNING/); firstLock.close(); const lock = new InstanceLock(p); lock.close();
});
test('19 timeout após envio fica incerto e não provoca duplicação automática', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => snapshot({ steps: [first, next] });
  let attempts = 0; h.telegram.send = async () => { attempts++; throw new BotError('HTTP_NETWORK_ERROR', { ambiguous: true }); };
  await h.monitor.cycle(); assert.equal(h.store.notifications()[0].status, 'uncertain'); h.reopen(); h.advance(600); await h.monitor.cycle(); assert.equal(attempts, 1);
});
test('20 encerramento durante envio é recuperado como incerto', async t => {
  const h = harness(t); await h.monitor.cycle(); h.monitor.recordSuccess(snapshot({ steps: [first, next] }));
  const item = h.store.notifications()[0]; h.store.markSending(item.id); h.reopen(); assert.equal(h.store.notifications()[0].status, 'uncertain'); await h.monitor.flush(); assert.equal(h.sent.length, 0);
});
test('21 sucesso cancela alerta de falhas ainda não enviado', async t => {
  const h = harness(t); h.source.consult = async () => { throw new Error(); }; h.telegram.send = async () => { throw new BotError('TELEGRAM_API_ERROR'); };
  for (let n = 0; n < 3; n++) await h.monitor.cycle(); h.source.consult = async () => snapshot(); h.advance(300); await h.monitor.cycle();
  assert.equal(h.store.notifications()[0].status, 'cancelled'); assert.equal(h.sent.length, 0);
});
test('22 saída para entrega e entrega concluída geram avisos', async t => {
  const h = harness(t); await h.monitor.cycle(); const route = { description: 'Mercadoria em rota de entrega', occurredAt: '2024-07-02T08:00:00-03:00' };
  h.source.consult = async () => snapshot({ steps: [first, next, route] }); await h.monitor.cycle(); assert.match(h.sent.at(-1), /rota de entrega/);
  h.source.consult = async () => snapshot({ steps: [first, next, route, { description: 'Entrega concluída', occurredAt: '2024-07-02T09:00:00-03:00' }], status: 2 });
  await h.monitor.cycle(); assert.equal(h.store.getState().status, 2); assert.ok(h.sent.some(x => /Entrega concluída/.test(x)));
});
test('23 evento datado sem descrição usa aviso genérico', async t => {
  const h = harness(t); await h.monitor.cycle(); h.source.consult = async () => snapshot({ steps: [first, { occurredAt: next.occurredAt }] });
  await h.monitor.cycle(); assert.equal(h.sent.length, 1); assert.match(h.sent[0], /teve uma nova atualização/);
});
test('24 alteração de encomenda não mistura bancos', t => {
  const h = harness(t); assert.throws(() => new Store(h.filename, { ...shipment, cte: '99' }), /DATABASE_SHIPMENT_MISMATCH/);
});
test('25 falha no meio da transação não perde referência', async t => {
  const h = harness(t); await h.monitor.cycle(); const state = h.store.getState();
  assert.throws(() => h.store.transaction(() => { h.store.setState({ broken: true }); throw new Error(); })); assert.deepEqual(h.store.getState(), state);
});
