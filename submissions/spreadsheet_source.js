const tabs = ['Narrative & Choice Matrix', 'Real-World Benchmarks'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export default class SpreadsheetSource {
  #options;

  constructor({ spreadsheetId, getAccessToken, transport = globalThis.fetch, timeoutMs,
    clock = { setTimeout, clearTimeout } }) {
    const valid = {
      spreadsheetId: typeof spreadsheetId === 'string' && /^[A-Za-z0-9_-]+$/.test(spreadsheetId),
      getAccessToken: typeof getAccessToken === 'function',
      transport: typeof transport === 'function',
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647,
      clock: typeof clock?.setTimeout === 'function' && typeof clock?.clearTimeout === 'function',
    };
    for (const [field, accepted] of Object.entries(valid)) {
      if (!accepted) throw Object.assign(new Error(`Invalid configuration: ${field}`), { code: 'INVALID_CONFIGURATION', field });
    }
    this.#options = { spreadsheetId, getAccessToken, transport, timeoutMs, clock };
  }

  async readTab(tab, { signal } = {}) {
    const { spreadsheetId, getAccessToken, transport, timeoutMs, clock } = this.#options;
    // Only adapter-authored errors escape; never attach provider/HTTP bodies or causes.
    const error = (code, status) => Object.assign(new Error(`Spreadsheet read failed: ${code}`),
      { code, tab, spreadsheetId }, status === undefined ? {} : { status });
    if (!tabs.includes(tab)) throw error('UNKNOWN_TAB');
    if (signal?.aborted) throw error('CANCELLED');
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let done = false;
      const finish = (failure, values) => {
        if (done) return;
        done = true;
        clock.clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (failure) reject(failure);
        else resolve(values);
      };
      const interrupt = code => {
        controller.abort();
        finish(error(code));
      };
      const cancel = () => interrupt('CANCELLED');
      const timer = clock.setTimeout(() => interrupt('TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      const read = async () => {
        let token;
        try { token = await getAccessToken({ signal: controller.signal }); }
        catch { throw error('CREDENTIALS_UNAVAILABLE'); }
        if (done) return;
        if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw error('CREDENTIALS_UNAVAILABLE');
        const range = encodeURIComponent(`'${tab}'`).replace(/'/g, '%27');
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`
          + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
        let response;
        try {
          response = await transport(url, {
            method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          });
        } catch { throw error('NETWORK_FAILURE'); }
        if (done) return;
        if (!object(response) || !Number.isInteger(response.status) || typeof response.ok !== 'boolean'
          || typeof response.headers?.get !== 'function' || typeof response.json !== 'function') throw error('INVALID_RESPONSE');
        const status = response.status;
        if (status < 200 || status >= 300) {
          const codes = { 400: 'INVALID_RANGE', 401: 'AUTHENTICATION_FAILED', 403: 'PERMISSION_DENIED',
            404: 'NOT_FOUND', 429: 'RATE_LIMITED' };
          throw error(codes[status] ?? (status >= 500 && status < 600 ? 'SERVER_ERROR' : 'HTTP_ERROR'), status);
        }
        const contentType = response.headers.get('content-type');
        if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw error('UNEXPECTED_CONTENT_TYPE');
        }
        let body;
        try { body = await response.json(); } catch { throw error('INVALID_JSON'); }
        if (done) return;
        if (!object(body) || body.majorDimension !== 'ROWS' || typeof body.range !== 'string') throw error('INVALID_RESPONSE');
        const separator = body.range.lastIndexOf('!');
        const sheet = body.range.slice(0, separator);
        if ((sheet !== `'${tab}'` && sheet !== tab) || !/^A1(?::[A-Z]+[1-9]\d*)?$/.test(body.range.slice(separator + 1))) {
          throw error('INVALID_RESPONSE');
        }
        const values = Object.hasOwn(body, 'values') ? body.values : [];
        if (!Array.isArray(values)) throw error('INVALID_RESPONSE');
        for (const row of values) {
          if (!Array.isArray(row)) throw error('INVALID_RESPONSE');
          for (const cell of row) {
            if (cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean' && !Number.isFinite(cell)) {
              throw error('INVALID_RESPONSE');
            }
          }
        }
        return structuredClone(values);
      };
      read().then(values => finish(null, values), failure => finish(failure));
    });
  }
}
