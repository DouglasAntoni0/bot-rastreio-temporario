import { requestJson } from './http.js';
import { BotError } from './errors.js';

export class Telegram {
  constructor(token, chatId, { request = requestJson } = {}) {
    this.base = `https://api.telegram.org/bot${token}/`;
    this.chatId = String(chatId);
    this.request = request;
  }
  async call(method, body = {}, signal, timeoutMs = 20000) {
    const r = await this.request(this.base + method, { body, signal, timeoutMs });
    if (!r.json?.ok) {
      throw new BotError('TELEGRAM_API_ERROR', { ambiguous: r.json?.ok !== false, retryAfter: Math.max(300, Number(r.json?.parameters?.retry_after) || 0) });
    }
    if (!r.ok) throw new BotError('TELEGRAM_HTTP_ERROR', { ambiguous: true });
    return r.json.result;
  }
  async validatePrivate(signal) {
    if (!/^[1-9]\d{0,15}$/.test(this.chatId)) throw new BotError('TELEGRAM_PRIVATE_CHAT_REQUIRED');
    const chat = await this.call('getChat', { chat_id: this.chatId }, signal);
    if (chat.type !== 'private' || String(chat.id) !== this.chatId) throw new BotError('TELEGRAM_PRIVATE_CHAT_REQUIRED');
    return chat;
  }
  async send(text, signal) {
    if (!/^[1-9]\d{0,15}$/.test(this.chatId)) throw new BotError('TELEGRAM_PRIVATE_CHAT_REQUIRED');
    const result = await this.call('sendMessage', { chat_id: this.chatId, text, link_preview_options: { is_disabled: true } }, signal);
    if (result?.chat?.type !== 'private' || String(result?.chat?.id) !== this.chatId || !Number.isInteger(result?.message_id)) throw new BotError('TELEGRAM_ACK_INVALID', { ambiguous: true });
    return result.message_id;
  }
  async discover(signal, timeout = 0) {
    const info = await this.call('getWebhookInfo', {}, signal);
    if (info.url) throw new BotError('TELEGRAM_WEBHOOK_PRESENT');
    const updates = await this.call('getUpdates', { timeout, allowed_updates: ['message'] }, signal, (timeout + 8) * 1000);
    const chats = new Map();
    for (const update of updates) {
      const m = update.message;
      if (m?.chat?.type === 'private' && m.from?.id === m.chat.id && /^\/start(?:@\w+)?(?:\s|$)/.test(m.text ?? '')) chats.set(String(m.chat.id), m.chat);
    }
    return [...chats.values()];
  }
}
