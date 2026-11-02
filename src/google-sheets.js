import { assertRange, assertValues } from './spreadsheet.js';

export class SpreadsheetApiError extends Error {
  constructor(status, statusText) {
    super(`Google Sheets request failed (${status}${statusText ? ` ${statusText}` : ''})`);
    this.name = 'SpreadsheetApiError';
    this.status = status;
  }
}

/**
 * Authentication is owned by the caller. A token callback is invoked for every
 * request so an OAuth client can refresh expiring access tokens.
 */
export function createGoogleSheetsAdapter({ spreadsheetId, accessToken, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (typeof spreadsheetId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) {
    throw new TypeError('spreadsheetId must be a Google spreadsheet ID');
  }
  if (typeof accessToken !== 'function'
      && (typeof accessToken !== 'string' || !accessToken.trim())) {
    throw new TypeError('accessToken must be a non-empty string or a token provider function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch must be a function');
  }
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/`;

  async function request(range, { method = 'GET', suffix = '', query = {}, body } = {}) {
    assertRange(range);
    const token = typeof accessToken === 'function' ? await accessToken() : accessToken;
    if (typeof token !== 'string' || !token.trim()) {
      throw new TypeError('accessToken provider must return a non-empty string');
    }
    const url = new URL(`${baseUrl}${encodeURIComponent(range)}${suffix}`);
    url.search = new URLSearchParams(query).toString();
    const response = await fetchImpl(url.toString(), {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      // Do not expose response bodies, which may contain spreadsheet data.
      throw new SpreadsheetApiError(response.status, response.statusText);
    }
    return response.json();
  }

  return Object.freeze({
    async read(range) {
      const data = await request(range, {
        query: { majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE' },
      });
      if (data.values === undefined) return [];
      if (!Array.isArray(data.values) || data.values.some(row => !Array.isArray(row))) {
        throw new TypeError('Google Sheets returned invalid row data');
      }
      return data.values;
    },
    async write(range, values) {
      assertValues(values);
      return request(range, {
        method: 'PUT',
        query: { valueInputOption: 'RAW' },
        body: { majorDimension: 'ROWS', values },
      });
    },
    async append(range, values) {
      assertValues(values);
      return request(range, {
        method: 'POST',
        suffix: ':append',
        query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
        body: { majorDimension: 'ROWS', values },
      });
    },
    async clear(range) {
      return request(range, { method: 'POST', suffix: ':clear', body: {} });
    },
  });
}
