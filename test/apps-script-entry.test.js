import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const entryUrl = new URL('../apps-script/entry.js', import.meta.url);
const source = await readFile(entryUrl, 'utf8');

function fixture(result) {
  const calls = [], lock = {}, book = {};
  const output = {
    setMimeType(type) {
      calls.push(['mime', type]);
      return this;
    },
  };
  let services;
  const context = vm.createContext({
    createHandler(dependencies) {
      services = dependencies;
      return contents => {
        calls.push(['handle', contents]);
        return result;
      };
    },
    LockService: { getScriptLock: () => { calls.push(['lock']); return lock; } },
    SpreadsheetApp: {
      openById: id => { calls.push(['open', id]); return book; },
      flush: () => calls.push(['flush']),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (...args) => {
        calls.push(['digest', ...args]);
        return [-128, -1, 0, 1, 127, ...Array(27).fill(0)];
      },
      getUuid: () => 'generated-player-id',
    },
    Date: { now: () => 123456 },
    console: { error: message => calls.push(['log', message]) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        calls.push(['output', text]);
        return output;
      },
    },
  });
  vm.runInContext(source, context, { filename: fileURLToPath(entryUrl) });
  return { context, calls, output, lock, book, services: () => services };
}

test('Apps Script entry forwards POST contents and returns the handler envelope as JSON', () => {
  for (const result of [
    { ok: true, data: { state: { serverId: 'server' } } },
    { ok: false, error: { code: 'BUSY', message: 'Try again' } },
  ]) {
    const f = fixture(result);
    assert.equal(f.context.doPost({ postData: { contents: '{"action":"initialize"}' } }), f.output);
    assert.deepEqual(f.calls, [
      ['handle', '{"action":"initialize"}'],
      ['output', JSON.stringify(result)],
      ['mime', 'application/json'],
    ]);
  }
});

test('Apps Script entry binds every Google service and encodes signed digest bytes as hex', () => {
  const f = fixture({ ok: true });
  f.context.doPost({ postData: { contents: '{}' } });
  const services = f.services();
  assert.equal(services.getLock(), f.lock);
  assert.equal(services.open('spreadsheet-id'), f.book);
  services.flush();
  assert.equal(services.hash('session-secret'), '80ff00017f' + '00'.repeat(27));
  assert.equal(services.uuid(), 'generated-player-id');
  assert.equal(services.now(), 123456);
  services.log('PROVIDER_ERROR');
  assert.deepEqual(f.calls.slice(3), [
    ['lock'], ['open', 'spreadsheet-id'], ['flush'],
    ['digest', 'sha256', 'session-secret', 'utf8'], ['log', 'PROVIDER_ERROR'],
  ]);
});

test('Apps Script entry delegates absent and empty POST bodies to request validation', () => {
  const result = { ok: false, error: { code: 'INVALID_REQUEST', message: 'Missing request' } };
  for (const event of [undefined, null, {}, { postData: null }, { postData: {} }]) {
    const f = fixture(result);
    f.context.doPost(event);
    assert.deepEqual(f.calls[0], ['handle', undefined]);
    assert.deepEqual(JSON.parse(f.calls[1][1]), result);
  }
  const f = fixture(result);
  f.context.doPost({ postData: { contents: '' } });
  assert.deepEqual(f.calls[0], ['handle', '']);
});
