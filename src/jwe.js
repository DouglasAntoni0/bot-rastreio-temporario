// Public transport used by rodonaves.com.br/main.js. RFC 7516 / RFC 7518.
// No credentials, security gates, or CAPTCHA tokens are manufactured.
import { randomBytes, publicEncrypt, createCipheriv, createDecipheriv, createHmac, constants } from 'node:crypto';
import { BotError } from './errors.js';
const b64 = value => Buffer.from(value).toString('base64url');
export function encryptRequest(data, key) {
  const protectedHeader = b64(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256CBC-HS512', kid: key.keyId }));
  const cek = randomBytes(64), iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', cek.subarray(32), iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const aad = Buffer.from(protectedHeader), length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(aad.length * 8));
  const tag = createHmac('sha512', cek.subarray(0, 32)).update(Buffer.concat([aad, iv, ciphertext, length])).digest().subarray(0, 32);
  const encryptedKey = publicEncrypt({ key: key.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek);
  return [protectedHeader, b64(encryptedKey), b64(iv), b64(ciphertext), b64(tag)].join('.');
}
export function decryptResponse(envelope, key) {
  try {
    const p = envelope.key.split('.');
    if (p.length !== 5 || p[1] !== '') throw new Error();
    const header = JSON.parse(Buffer.from(p[0], 'base64url'));
    if (header.alg !== 'dir' || header.enc !== 'A256GCM' || header.zip || header.crit) throw new Error();
    const iv = Buffer.from(p[2], 'base64url'), tag = Buffer.from(p[4], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || key.length !== 32) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(p[0]));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(p[3], 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw new BotError('TRACKING_ENCRYPTION_INVALID'); }
}
