export class BotError extends Error {
  constructor(code, { ambiguous = false, retryAfter = 300 } = {}) {
    super(code);
    this.code = code;
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter;
  }
}
export const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INTERNAL_ERROR';
