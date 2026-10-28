const tabs = ['Narrative & Choice Matrix', 'Real-World Benchmarks'];
const safeCodes = new Set(['CREDENTIALS_UNAVAILABLE', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND',
  'INVALID_RANGE', 'RATE_LIMITED', 'SERVER_ERROR', 'HTTP_ERROR', 'NETWORK_FAILURE', 'TIMEOUT', 'CANCELLED',
  'UNEXPECTED_CONTENT_TYPE', 'INVALID_JSON', 'INVALID_RESPONSE', 'INTERNAL_ERROR']);
const failure = (code, tab) => Object.assign(new Error(`Spreadsheet loading failed: ${code}`), { code, tab });

export default class BrowserSource {
  constructor({ transport = globalThis.fetch.bind(globalThis), timeoutMs = 15000 } = {}) {
    if (typeof transport !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw failure('INVALID_CONFIGURATION');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  async readTab(tab) {
    if (!tabs.includes(tab)) throw failure('UNKNOWN_TAB', tab);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure('TIMEOUT', tab)); }, this.timeoutMs);
    });
    const read = async () => {
      let response;
      try {
        response = await this.transport(`/api/spreadsheet?tab=${encodeURIComponent(tab)}`, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
      } catch { throw failure('NETWORK_FAILURE', tab); }
      if (controller.signal.aborted) throw failure('TIMEOUT', tab);
      if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') throw failure('INVALID_RESPONSE', tab);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') ?? '')) throw failure('INVALID_RESPONSE', tab);
      let body;
      try { body = await response.json(); } catch { throw failure('INVALID_RESPONSE', tab); }
      if (!response.ok) throw failure(safeCodes.has(body?.code) ? body.code : 'HTTP_ERROR', tab);
      if (!Array.isArray(body)) throw failure('INVALID_RESPONSE', tab);
      for (const row of body) {
        if (!Array.isArray(row)) throw failure('INVALID_RESPONSE', tab);
        for (const cell of row) {
          if (cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean' && !Number.isFinite(cell)) throw failure('INVALID_RESPONSE', tab);
        }
      }
      return structuredClone(body);
    };
    try { return await Promise.race([timeout, read()]); } finally { clearTimeout(timer); }
  }
}
