import { BotError } from './errors.js';

export async function readBody(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new BotError('HTTP_RESPONSE_TOO_LARGE', { ambiguous: true });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function requestJson(url, { body, headers = {}, timeoutMs = 20000, signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const bytes = await readBody(response);
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); }
    catch { throw new BotError('HTTP_INVALID_JSON', { ambiguous: true }); }
    return { status: response.status, ok: response.ok, headers: response.headers, json };
  } catch (error) {
    if (error instanceof BotError) throw error;
    const code = error?.cause?.code;
    // These failures occur before establishing the connection: safe to retry a send.
    const beforeConnection = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code);
    throw new BotError(signal?.aborted ? 'HTTP_STOPPED' : 'HTTP_NETWORK_ERROR', { ambiguous: !beforeConnection });
  }
}
