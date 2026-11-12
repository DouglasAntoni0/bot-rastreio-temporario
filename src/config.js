import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BotError } from './errors.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ENV_PATH = path.join(ROOT, '.env');
export function loadConfig({ cloud = false, ...options } = {}) {
  if (!cloud && process.env.NODE_ENV !== 'production' && existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  return parseConfig(process.env, { remote: cloud, ...options });
}

export function parseConfig(env, { needChat = true, needToken = true, needShipment = true, remote = false } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = env.TELEGRAM_CHAT_ID ?? '';
  if (needToken && !/^\d+:[\w-]{25,}$/.test(token)) throw new BotError('CONFIG_TOKEN_INVALID');
  if (needChat && !/^[1-9]\d{0,15}$/.test(chatId)) throw new BotError('CONFIG_PRIVATE_CHAT_REQUIRED');
  const shipment = {
    protocol: env.RODONAVES_PROTOCOLO ?? env.TRACKING_PROTOCOL,
    cte: env.RODONAVES_CTE ?? env.TRACKING_CTE,
    cnpj: env.RODONAVES_CNPJ ?? env.TRACKING_CNPJ,
    invoice: env.RODONAVES_NF ?? env.TRACKING_INVOICE,
  };
  if (needShipment && (Object.values(shipment).some(x => !/^\d{1,20}$/.test(x ?? '')) || shipment.cnpj.length !== 14)) throw new BotError('CONFIG_SHIPMENT_INVALID');
  const intervalMs = Number(env.CHECK_INTERVAL_MS ?? Number(env.POLL_SECONDS ?? 300) * 1000);
  if (!Number.isInteger(intervalMs) || intervalMs < 300000 || intervalMs > 86400000) throw new BotError('CONFIG_INTERVAL_INVALID');
  let state;
  if (remote) {
    const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
    const redisToken = env.UPSTASH_REDIS_REST_TOKEN;
    const namespace = env.STATE_NAMESPACE ?? 'rodonaves';
    if (!/^https:\/\/[a-z\d-]+\.upstash\.io$/i.test(url ?? '') || !/^[\w=-]{16,}$/.test(redisToken ?? '') || !/^[\w-]{1,48}$/.test(namespace)) throw new BotError('CONFIG_STATE_INVALID');
    state = { url, token: redisToken, namespace };
  }
  return { token, chatId, shipment, intervalMs, state, dataDir: path.join(ROOT, 'data'), logDir: path.join(ROOT, 'logs'), link: `https://rodonaves.com.br/rastreamento/${shipment.protocol}?modal=rodoviario` };
}
