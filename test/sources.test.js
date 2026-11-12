import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, privateDecrypt, createDecipheriv, createCipheriv, createHmac, constants, timingSafeEqual } from 'node:crypto';
import { payload, shipment } from './helpers.js';
import { parseTracking } from '../src/normalize.js';
import { Rodonaves } from '../src/rodonaves.js';
import { encryptRequest, decryptResponse } from '../src/jwe.js';
import { requestJson } from '../src/http.js';
import { Telegram } from '../src/telegram.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { enabled: true, keyId: 'test-key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const response = (json, status = 200, extraHeaders = {}) => ({ ok: status === 200, status, headers: new Headers(extraHeaders), json });
function decodeRequest(compact) {
  const p = compact.split('.'), header = JSON.parse(Buffer.from(p[0], 'base64url'));
  assert.equal(header.alg, 'RSA-OAEP-256'); assert.equal(header.enc, 'A256CBC-HS512');
  const cek = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(p[1], 'base64url'));
  const aad = Buffer.from(p[0]), iv = Buffer.from(p[2], 'base64url'), ct = Buffer.from(p[3], 'base64url'), al = Buffer.alloc(8); al.writeBigUInt64BE(BigInt(aad.length * 8));
  const expected = createHmac('sha512', cek.subarray(0, 32)).update(Buffer.concat([aad, iv, ct, al])).digest().subarray(0, 32);
  assert.ok(timingSafeEqual(expected, Buffer.from(p[4], 'base64url')));
  const d = createDecipheriv('aes-256-cbc', cek.subarray(32), iv); return Buffer.concat([d.update(ct), d.final()]);
}
function envelope(data, secret) {
  const h = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secret, iv); c.setAAD(Buffer.from(h));
  const ct = Buffer.concat([c.update(JSON.stringify(data)), c.final()]); return { key: [h, '', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.') };
}
test('26 valida CT-e, protocolo, NF e modal sem confiar apenas no HTTP 200', () => {
  for (const [field, value] of [['protocolNumber', '99'], ['cTeNumber', '99'], ['invoiceNumbers', ['99']], ['serviceType', 2], ['status', 99]]) {
    const p = payload(); p.data[0][field] = value; assert.throws(() => parseTracking(p, shipment));
  }
  for (const invalid of [{}, { data: [] }, { data: null }, { data: [null] }]) assert.throws(() => parseTracking(invalid, shipment));
  assert.throws(() => parseTracking(payload({ steps: [] }), shipment));
});
test('27 datas inválidas e descrição não textual não inventam dados', () => {
  assert.throws(() => parseTracking(payload({ steps: [{ occurredAt: 'banana', description: 'x' }] }), shipment));
  assert.throws(() => parseTracking(payload({ steps: [{ occurredAt: '2026-02-31T12:00:00-03:00', description: 'x' }] }), shipment));
  assert.throws(() => parseTracking(payload({ eta: '2026-02-31' }), shipment));
  const p = payload(); p.data[0].steps[0] = { occurredAt: '2024-07-01T10:00:00-03:00', description: {} }; assert.equal(parseTracking(p, shipment).events[0].description, '');
});
test('28 transporte JWE criptografa pedido e autentica resposta', () => {
  const raw = Buffer.from('{"example":1}'); assert.deepEqual(decodeRequest(encryptRequest(raw, key)), raw);
  const secret = randomBytes(32), e = envelope({ ok: true }, secret); assert.deepEqual(decryptResponse(e, secret), { ok: true });
  const p = e.key.split('.'); p[3] = Buffer.from('alterado').toString('base64url'); assert.throws(() => decryptResponse({ key: p.join('.') }, secret), /TRACKING_ENCRYPTION_INVALID/);
});
test('29 fallback por CT-e é consultado na mesma rodada e valida identidade', async () => {
  const queries = [];
  const source = new Rodonaves(shipment, { request: async (url, options) => {
    if (url.endsWith('jwe-key')) return response({ data: key });
    const query = JSON.parse(decodeRequest(options.body.key)); queries.push(query);
    return response(envelope(query.protocolNumber ? { data: [] } : payload(), decodeRequest(options.headers['X-Jwe-Response-Key'])), 200, { 'X-Jwe-Encrypted': '1' });
  } });
  assert.equal((await source.consult()).source, 'cte'); assert.equal(queries.length, 2); assert.equal(queries[1].cTeNumber, shipment.cte);
});
test('30 CAPTCHA, autenticação ou limite bloqueia novas tentativas na rodada', async () => {
  let count = 0;
  const source = new Rodonaves(shipment, { request: async url => {
    if (url.endsWith('jwe-key')) return response({ data: key }); count++; return response({ title: 'captcha.required' }, 403);
  } });
  await assert.rejects(() => source.consult(), /TRACKING_ACCESS_RESTRICTED/); assert.equal(count, 1);
});
test('31 chave pública expirada é atualizada apenas uma vez por busca', async () => {
  let keyCalls = 0, calls = 0;
  const source = new Rodonaves(shipment, { request: async url => {
    if (url.endsWith('jwe-key')) { keyCalls++; return response({ data: key }); }
    if (++calls === 1) return response({ title: 'jwe.invalid' }, 400); return response(payload());
  } });
  await source.consult(); assert.equal(calls, 2); assert.equal(keyCalls, 2);
});
test('32 HTTP aplica timeout, tamanho máximo, rejeita HTML e não expõe URL em erros', async () => {
  let observed;
  const r = await requestJson('https://example.test', { fetchImpl: async (_url, options) => { observed = options; return new Response('{"ok":true}'); } });
  assert.equal(r.json.ok, true); assert.ok(observed.signal); assert.equal(observed.redirect, 'error');
  await assert.rejects(() => requestJson('https://example.test', { fetchImpl: async () => new Response('<html>vazio</html>') }), /HTTP_INVALID_JSON/);
  await assert.rejects(() => requestJson('https://example.test', { fetchImpl: async () => new Response('x'.repeat(2097153)) }), /HTTP_RESPONSE_TOO_LARGE/);
  await assert.rejects(() => requestJson('https://example.test', { fetchImpl: async () => { throw new Error('URL privada'); } }), error => error.code === 'HTTP_NETWORK_ERROR' && !error.message.includes('privada') && error.ambiguous);
});
test('33 Telegram envia somente ao chat privado configurado e valida confirmação', async () => {
  const calls = [];
  const telegram = new Telegram('fake-token', '123', { request: async (url, options) => { calls.push(options.body); return response({ ok: true, result: { chat: { type: 'private', id: 123 }, message_id: 1 } }); } });
  assert.equal(await telegram.send('Teste'), 1); assert.equal(calls[0].chat_id, '123');
  await assert.rejects(() => new Telegram('fake-token', '-123').send('Teste'), /TELEGRAM_PRIVATE_CHAT_REQUIRED/);
});
test('34 resposta negativa do Telegram permite retentativa segura', async () => {
  const telegram = new Telegram('fake-token', '123', { request: async () => response({ ok: false, parameters: { retry_after: 600 } }, 429) });
  await assert.rejects(() => telegram.send('Teste'), error => !error.ambiguous && error.retryAfter === 600);
});
test('35 chat discovery ignora grupos e não altera webhook existente', async () => {
  const telegram = new Telegram('fake-token', '', { request: async url => response({ ok: true, result: url.endsWith('getWebhookInfo') ? {} : [
    { message: { chat: { type: 'group', id: -123 }, from: { id: 1 }, text: '/start' } },
    { message: { chat: { type: 'private', id: 123 }, from: { id: 123 }, text: '/start rodonaves' } },
  ] }) });
  assert.deepEqual((await telegram.discover()).map(x => x.id), [123]);
  const blocked = new Telegram('fake-token', '', { request: async () => response({ ok: true, result: { url: 'https://example.test' } }) });
  await assert.rejects(() => blocked.discover(), /TELEGRAM_WEBHOOK_PRESENT/);
});
