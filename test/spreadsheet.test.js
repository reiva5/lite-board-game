import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSpreadsheet,
  createGoogleSheetsAdapter,
  SpreadsheetApiError,
} from '../src/index.js';

function fakeGoogle(responses = [{}]) {
  const calls = [];
  const adapter = createGoogleSheetsAdapter({
    spreadsheetId: 'sheet_123',
    accessToken: 'test-token',
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), ...options });
      return Response.json(responses.shift() ?? {});
    },
  });
  return { adapter, calls, spreadsheet: createSpreadsheet(adapter) };
}

test('Google Sheets adapter encodes ranges, authenticates, and reads row values', async () => {
  const { spreadsheet, calls } = fakeGoogle([{ values: [[1, true, '001']] }, {}]);
  assert.deepEqual(await spreadsheet.read("'Player's board'!A1:C1"), [[1, true, '001']]);
  assert.deepEqual(await spreadsheet.read('State!A1'), []);
  const call = calls[0];
  assert.equal(decodeURIComponent(call.url.pathname),
    "/v4/spreadsheets/sheet_123/values/'Player's board'!A1:C1");
  assert.equal(call.url.searchParams.get('majorDimension'), 'ROWS');
  assert.equal(call.url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
  assert.equal(call.headers.Authorization, 'Bearer test-token');
  assert.equal(call.method, 'GET');
  assert.equal(call.redirect, 'error');
  assert.equal(call.body, undefined);
});

test('write and append use RAW and clear has a scoped POST body', async () => {
  const { spreadsheet, calls } = fakeGoogle([{ updatedCells: 3 }, { updates: {} }, { clearedRange: 'A1' }]);
  const values = [['001', '=1+2', false]];
  assert.deepEqual(await spreadsheet.write('A1:C1', values), { updatedCells: 3 });
  assert.deepEqual(await spreadsheet.append('A:C', values), { updates: {} });
  assert.deepEqual(await spreadsheet.clear('A1:C1'), { clearedRange: 'A1' });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[2].method, 'POST');
  assert.ok(calls[1].url.pathname.endsWith(':append'));
  assert.ok(calls[2].url.pathname.endsWith(':clear'));
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.url.searchParams.get('valueInputOption'), 'RAW');
    assert.deepEqual(JSON.parse(call.body), { majorDimension: 'ROWS', values });
    assert.equal(call.headers['Content-Type'], 'application/json');
  }
  assert.equal(calls[1].url.searchParams.get('insertDataOption'), 'INSERT_ROWS');
  assert.equal(calls[2].body, '{}');
});

test('token callback is resolved for every request', async () => {
  const tokens = [];
  let count = 0;
  const adapter = createGoogleSheetsAdapter({
    spreadsheetId: 'id',
    accessToken: async () => `token-${++count}`,
    fetch: async (_, options) => {
      tokens.push(options.headers.Authorization);
      return Response.json({});
    },
  });
  await adapter.read('A1');
  await adapter.clear('A1');
  assert.deepEqual(tokens, ['Bearer token-1', 'Bearer token-2']);
});

test('HTTP errors preserve status without disclosing response contents or retrying', async () => {
  for (const status of [401, 403, 429, 500]) {
    let count = 0;
    const adapter = createGoogleSheetsAdapter({
      spreadsheetId: 'id',
      accessToken: 'secret-token',
      fetch: async () => {
        count++;
        return Response.json({ error: 'private sheet data' }, { status });
      },
    });
    await assert.rejects(adapter.append('A1', [['x']]), error => {
      assert.ok(error instanceof SpreadsheetApiError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private|secret-token/);
      return true;
    });
    assert.equal(count, 1);
  }
});

test('network, token, and response failures propagate', async () => {
  const failure = new Error('offline');
  const adapter = createGoogleSheetsAdapter({
    spreadsheetId: 'id', accessToken: 'token', fetch: async () => { throw failure; },
  });
  await assert.rejects(adapter.read('A1'), error => error === failure);
  const invalidToken = createGoogleSheetsAdapter({
    spreadsheetId: 'id', accessToken: async () => '',
    fetch: () => assert.fail('must not fetch'),
  });
  await assert.rejects(invalidToken.read('A1'), /provider/);
  const invalid = fakeGoogle([{ values: 'invalid' }, { values: [null] }]);
  await assert.rejects(invalid.spreadsheet.read('A1'), /invalid row/);
  await assert.rejects(invalid.spreadsheet.read('A1'), /invalid row/);
});

test('adapter configuration and ranges are validated', async () => {
  assert.throws(() => createSpreadsheet({}), /adapter.read/);
  assert.throws(() => createGoogleSheetsAdapter(), /spreadsheetId/);
  assert.throws(() => createGoogleSheetsAdapter({ spreadsheetId: '../other' }), /spreadsheetId/);
  assert.throws(() => createGoogleSheetsAdapter({ spreadsheetId: 'id' }), /accessToken/);
  assert.throws(() => createGoogleSheetsAdapter({
    spreadsheetId: 'id', accessToken: 'token', fetch: null,
  }), /fetch/);
  const { spreadsheet, calls } = fakeGoogle();
  for (const range of ['', ' ', null, 42]) {
    await assert.rejects(spreadsheet.read(range), /range/);
    await assert.rejects(spreadsheet.write(range, [['x']]), /range/);
    await assert.rejects(spreadsheet.append(range, [['x']]), /range/);
    await assert.rejects(spreadsheet.clear(range), /range/);
  }
  assert.equal(calls.length, 0);
});

test('reject invalid matrices before writing', async () => {
  const { spreadsheet, calls } = fakeGoogle();
  for (const values of [
    [], [[]], ['abc'], [[1], [1, 2]], [[null]], [[undefined]],
    [[NaN]], [[Infinity]], [[{}]], [[1n]], [[() => {}]], [new Array(2)],
  ]) {
    await assert.rejects(spreadsheet.write('A1', values), TypeError);
    await assert.rejects(spreadsheet.append('A1', values), TypeError);
  }
  assert.equal(calls.length, 0);
});

test('wrapper preserves adapter context and forwards values and errors', async () => {
  const adapter = {
    data: [],
    async read() { return this.data; },
    async write(range, values) { this.data = values; return range; },
    async append(range, values) { this.data.push(...values); return range; },
    async clear() { this.data = []; },
  };
  const spreadsheet = createSpreadsheet(adapter);
  assert.equal(await spreadsheet.write('A1', [[true, '', 0]]), 'A1');
  await spreadsheet.append('A:B', [[false, 'x', 1]]);
  assert.deepEqual(await spreadsheet.read('A:C'), [[true, '', 0], [false, 'x', 1]]);
  await spreadsheet.clear('A:C');
  assert.deepEqual(await spreadsheet.read('A:C'), []);
});
