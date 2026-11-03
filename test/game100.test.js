import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyCommand, decodeState, normalizeName, spreadsheetId, MAX_PAYLOAD } from '../game100/domain.js';
import { createHandler } from '../apps-script/runtime.js';

const url = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
const hash = text => createHash('sha256').update(text).digest('hex');
let sequence = 0;
const uuid = () => `id_${String(++sequence).padStart(20, '0')}`;
const deps = { hash, uuid, now: () => 123456 };
const command = (action, extra = {}) => ({ action, spreadsheetUrl: url, requestId: uuid(), ...extra });
const secret = index => hash(`secret-${index}`);
function initial() { return applyCommand(null, command('initialize'), deps).state; }
function join(state, name, index = 1) {
  return applyCommand(state, command('join', { name, secret: secret(index) }), deps);
}
const code = expected => error => error.code === expected;

test('canonical Sheets URLs only; no arbitrary hosts or paths', () => {
  assert.equal(spreadsheetId(url), 's'.repeat(30));
  assert.equal(spreadsheetId(`${url}?usp=sharing#gid=0`), 's'.repeat(30));
  for (const value of ['http:' + url.slice(6), url.replace('docs.google.com', 'docs.google.com.evil'),
    url.replace('/edit', '/unexpected'), url.replace('https://', 'https://user@'), null,
    'https://docs.google.com/spreadsheets/d/short/edit', url + '\n']) {
    assert.throws(() => spreadsheetId(value), code('INVALID_URL'));
  }
});

test('names normalize NFC/trim/lowercase and reject control, blank, long', () => {
  assert.deepEqual(normalizeName('  E\u0301KA  '), { name: '\u00c9KA', nameKey: '\u00e9ka' });
  for (const name of ['', '  ', 'a'.repeat(41), 'A\n', 'A\u200b', 'A\tB', 2]) {
    assert.throws(() => normalizeName(name), code('INVALID_NAME'));
  }
  const state = join(initial(), ' \u00c9ka ').state;
  assert.throws(() => join(state, 'E\u0301KA', 2), code('NAME_TAKEN'));
});

test('join preserves caller state, exposes no secrets, and checks server identity', () => {
  const state = initial(), outcome = join(state, '<img src=x>');
  assert.equal(state.players.length, 0);
  assert.equal(outcome.state.players[0].ready, false);
  assert.equal(outcome.state.players[0].lastSeenAt, 123456);
  assert.ok(!JSON.stringify(outcome.result).includes('secret'));
  assert.ok(!JSON.stringify(outcome.result).includes(hash(secret(1))));
  assert.throws(() => applyCommand(state, command('join', {
    name: 'A', secret: secret(1), serverId: uuid(),
  }), deps), code('SERVER_CHANGED'));
});

test('capacity is four, duplicate names checked atomically, phase must be supported', () => {
  let state = initial();
  for (let i = 1; i <= 4; i++) state = join(state, `Player ${i}`, i).state;
  assert.throws(() => join(state, 'Fifth', 5), code('SERVER_FULL'));
  assert.throws(() => join(state, ' player 1 ', 5), code('NAME_TAKEN'));
  assert.throws(() => join({ ...state, phase: 'game' }, 'A'), code('CORRUPT_STATE'));
});

test('lost join response recovers same player even with a new request ID', () => {
  const request = command('join', { name: 'A', secret: secret(1) });
  const first = applyCommand(initial(), request, deps);
  const retry = applyCommand(first.state, request, deps);
  assert.deepEqual(retry.result, first.result);
  assert.equal(retry.changed, false);
  const recovered = join(first.state, 'A');
  assert.equal(recovered.result.playerId, first.result.playerId);
  assert.equal(recovered.state.players.length, 1);
  assert.throws(() => applyCommand(first.state, { ...request, secret: secret(2) }, deps), code('REQUEST_CONFLICT'));
  assert.throws(() => applyCommand(first.state, { ...request, name: 'B' }, deps), code('REQUEST_CONFLICT'));
});

test('resume and leave require both server/player identity and secret; remaining players preserved', () => {
  const a = join(initial(), 'A'), b = join(a.state, 'B', 2);
  const auth = { serverId: b.state.serverId, playerId: a.result.playerId, secret: secret(1) };
  for (const action of ['resume', 'leave']) {
    for (const bad of [{ secret: secret(2) }, { playerId: b.result.playerId }, { serverId: undefined }]) {
      assert.throws(() => applyCommand(b.state, command(action, { ...auth, ...bad }), deps), code('INVALID_SESSION'));
    }
  }
  const resumed = applyCommand(b.state, command('resume', auth), deps);
  assert.equal(resumed.changed, false);
  const leave = command('leave', auth);
  const left = applyCommand(b.state, leave, deps);
  assert.deepEqual(left.state.players, [b.state.players[1]]);
  assert.equal(left.result.left, true);
  assert.deepEqual(applyCommand(left.state, leave, deps).result, left.result);
  assert.throws(() => applyCommand(left.state, command('resume', auth), deps), code('INVALID_SESSION'));
});

test('retry history stays bounded, valid active identity survives eviction', () => {
  let state = initial();
  const a = join(state, 'A'); state = a.state;
  for (let i = 2; i < 40; i++) {
    const b = join(state, 'B', i);
    state = applyCommand(b.state, command('leave', {
      serverId: b.state.serverId, playerId: b.result.playerId, secret: secret(i),
    }), deps).state;
  }
  assert.equal(state.retries.length, 32);
  assert.equal(join(state, 'A').result.playerId, a.result.playerId);
  assert.ok(JSON.stringify(state).length < MAX_PAYLOAD);
});

test('corrupt persisted structures are rejected instead of initialized over', () => {
  assert.equal(decodeState(''), null);
  const state = join(initial(), 'A').state;
  const corruptions = [
    null, {}, { ...state, schemaVersion: 2 }, { ...state, revision: -1 },
    { ...state, players: [...state.players, state.players[0]] },
    { ...state, players: [{ ...state.players[0], secretDigest: secret(1).slice(1) }] },
    { ...state, players: [{ ...state.players[0], nameKey: 'wrong' }] },
    { ...state, retries: [{ ...state.retries[0], action: 'setState' }] },
    { ...state, extra: true }, { ...state, retries: Array(33).fill(state.retries[0]) },
  ];
  for (const value of corruptions) assert.throws(() => decodeState(JSON.stringify(value)), code('CORRUPT_STATE'));
  for (const value of ['{', ' '.repeat(48001), 1]) assert.throws(() => decodeState(value), code('CORRUPT_STATE'));
  assert.deepEqual(applyCommand(state, command('initialize'), deps).state, state);
});

test('persisted players reject invalid names and independently duplicated identities', () => {
  const state = join(join(initial(), 'A').state, 'B', 2).state;
  const original = JSON.stringify(state);
  const [first, second] = state.players;
  for (const invalid of [
    { ...second, name: null },
    { ...second, name: '' },
    { ...second, name: 'B\n' },
    { ...second, name: ' B ' },
    { ...second, name: first.name, nameKey: first.nameKey },
    { ...second, id: first.id },
    { ...second, secretDigest: first.secretDigest },
  ]) {
    const snapshot = JSON.stringify({ ...state, players: [first, invalid] });
    assert.throws(() => decodeState(snapshot), code('CORRUPT_STATE'));
    assert.equal(JSON.stringify(state), original);
  }
});

test('persisted retries cannot contradict an active player or reuse a request ID', () => {
  const state = join(initial(), 'A').state;
  const retry = state.retries[0];
  for (const retries of [
    [{ ...retry, secretDigest: hash(secret(2)) }],
    [{ ...retry, action: 'leave' }],
    [retry, { ...retry }],
  ]) {
    assert.throws(() => decodeState(JSON.stringify({ ...state, retries })), code('CORRUPT_STATE'));
  }
  assert.deepEqual(decodeState(JSON.stringify(state)), state);
});

function fakeRuntime() {
  const cells = new Map([['State!A1', 'unrelated'], ['Other!B2', 'preserve']]);
  const events = [];
  let held = false, fault, onRead;
  const book = {
    getSheetByName(name) {
      events.push(`sheet:${name}`);
      if (!cells.has(`${name}!A1`)) return null;
      return { getRange(address) {
        assert.equal(address, 'A1');
        return {
          getFormula: () => fault === 'formula' ? '=1' : '',
          getValue: () => { onRead?.(); return cells.get(`${name}!A1`); },
          setValue: value => { if (fault === 'write') throw Error('quota secret'); cells.set(`${name}!A1`, value); events.push('write'); },
        };
      } };
    },
    insertSheet(name) { assert.equal(name, 'Game100State'); cells.set(`${name}!A1`, ''); return book.getSheetByName(name); },
  };
  const services = {
    ...deps,
    getLock: () => ({
      tryLock: wait => { assert.equal(wait, 5000); events.push('lock'); if (held || fault === 'lock') return false; held = true; return true; },
      releaseLock: () => { assert.ok(held); held = false; events.push('release'); },
    }),
    open: id => { assert.ok(held); assert.equal(id, 's'.repeat(30)); if (fault === 'permission') throw Error('permission secret'); return book; },
    flush: () => { events.push('flush'); if (fault === 'flush') throw Error('quota secret'); },
    log: message => events.push(message),
  };
  return {
    cells, events, services, handle: createHandler(services),
    set fault(value) { fault = value; }, set onRead(value) { onRead = value; },
  };
}
const invoke = (runtime, request) => runtime.handle(JSON.stringify(request));

test('runtime only writes reserved A1; flush precedes release; init is non-destructive', () => {
  const runtime = fakeRuntime();
  assert.equal(invoke(runtime, command('join', { name: 'A', secret: secret(1) })).error.code, 'NOT_INITIALIZED');
  assert.ok(!runtime.cells.has('Game100State!A1'));
  assert.equal(invoke(runtime, command('initialize')).ok, true);
  assert.equal(runtime.cells.get('State!A1'), 'unrelated');
  assert.equal(runtime.cells.get('Other!B2'), 'preserve');
  assert.deepEqual(runtime.events.slice(-3), ['write', 'flush', 'release']);
  const saved = runtime.cells.get('Game100State!A1');
  assert.equal(invoke(runtime, command('initialize')).ok, true);
  assert.equal(runtime.cells.get('Game100State!A1'), saved);
});

test('contending runtime instances cannot interleave read-modify-write', () => {
  const runtime = fakeRuntime();
  invoke(runtime, command('initialize'));
  const second = createHandler(runtime.services);
  const competing = command('join', { name: ' a ', secret: secret(2) });
  let collision;
  runtime.onRead = () => { collision = second(JSON.stringify(competing)); };
  const first = invoke(runtime, command('join', { name: 'A', secret: secret(1) }));
  assert.equal(collision.error.code, 'BUSY');
  assert.equal(first.data.state.players.length, 1);
  runtime.onRead = undefined;
  assert.equal(second(JSON.stringify(competing)).error.code, 'NAME_TAKEN');
});

test('provider permission/quota and lock failures surface safely and release locks', () => {
  for (const fault of ['permission', 'write', 'flush', 'lock']) {
    const runtime = fakeRuntime(); runtime.fault = fault;
    const response = invoke(runtime, command('initialize'));
    assert.equal(response.error.code, fault === 'lock' ? 'BUSY' : 'PROVIDER_ERROR');
    assert.ok(!JSON.stringify(response).includes('secret'));
    if (fault !== 'lock') {
      assert.ok(runtime.events.includes('release'));
      assert.ok(runtime.events.indexOf('flush') < runtime.events.indexOf('release'));
    }
    runtime.fault = undefined;
    assert.equal(invoke(runtime, command('initialize')).ok, true);
  }
});

test('credential and request IDs reject trailing newline; unrelated initialization cannot overwrite a marker', () => {
  const state = initial();
  assert.throws(() => applyCommand(state, command('join', { name: 'A', secret: secret(1) + '\n' }), deps), code('INVALID_SESSION'));
  assert.throws(() => applyCommand(state, { ...command('initialize'), requestId: uuid() + '\n' }, deps), code('INVALID_REQUEST'));
  const runtime = fakeRuntime();
  runtime.cells.set('Game100State!A1', '{"application":"something-else"}');
  assert.equal(invoke(runtime, command('initialize')).error.code, 'CORRUPT_STATE');
  assert.equal(runtime.cells.get('Game100State!A1'), '{"application":"something-else"}');
});

test('flush failure after join commit recovers same identity from exact retry', () => {
  const runtime = fakeRuntime();
  invoke(runtime, command('initialize'));
  const request = command('join', { name: 'A', secret: secret(1) });
  runtime.fault = 'flush';
  assert.equal(invoke(runtime, request).error.code, 'PROVIDER_ERROR');
  const stored = JSON.parse(runtime.cells.get('Game100State!A1'));
  assert.equal(stored.players.length, 1);
  runtime.fault = undefined;
  const retry = invoke(runtime, request);
  assert.equal(retry.ok, true);
  assert.equal(retry.data.playerId, stored.players[0].id);
  assert.equal(retry.data.state.players.length, 1);
});

test('corrupt reserved data/formula never overwrites cells; malformed and generic commands rejected', () => {
  const runtime = fakeRuntime();
  for (const value of ['{', 'null', '{"schemaVersion":2}', 1]) {
    runtime.cells.set('Game100State!A1', value);
    assert.equal(invoke(runtime, command('initialize')).error.code, 'CORRUPT_STATE');
    assert.equal(runtime.cells.get('Game100State!A1'), value);
  }
  runtime.cells.set('Game100State!A1', '');
  runtime.fault = 'formula';
  assert.equal(invoke(runtime, command('initialize')).error.code, 'CORRUPT_STATE');
  runtime.fault = undefined;
  assert.equal(runtime.handle('{').error.code, 'INVALID_REQUEST');
  assert.equal(runtime.handle('x'.repeat(4097)).error.code, 'INVALID_REQUEST');
  assert.equal(invoke(runtime, command('setState')).error.code, 'INVALID_REQUEST');
  assert.equal(invoke(runtime, command('initialize', { range: 'Other!B2' })).error.code, 'INVALID_REQUEST');
});

test('deployable build executes actual shared domain and runtime in Apps Script-shaped VM', async () => {
  const source = await readFile(new URL('../dist/apps-script/Code.gs', import.meta.url), 'utf8');
  const runtime = fakeRuntime();
  const context = vm.createContext({
    LockService: { getScriptLock: runtime.services.getLock },
    SpreadsheetApp: { openById: runtime.services.open, flush: runtime.services.flush },
    Utilities: { getUuid: uuid, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => [...createHash('sha256').update(text).digest()] },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    console: { error() {} },
  });
  vm.runInContext(source, context);
  const send = request => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(request) } }).text);
  assert.equal(send(command('initialize')).ok, true);
  const request = command('join', { name: 'A', secret: secret(1) });
  const response = send(request);
  assert.equal(response.data.state.players[0].name, 'A');
  assert.deepEqual(send(request), response);
  assert.equal(send(command('join', { name: 'a', secret: secret(2) })).error.code, 'NAME_TAKEN');
  const auth = { serverId: response.data.state.serverId, playerId: response.data.playerId, secret: secret(1) };
  const ready = command('setReady', { ...auth, ready: true, readyVersion: 1 });
  assert.equal(send(ready).data.state.players[0].ready, true);
  assert.equal(send(command('sync', auth)).data.state.players[0].ready, true);
  assert.equal(send(command('setReady', { ...auth, ready: false, readyVersion: 2 })).data.state.players[0].ready, false);
  assert.equal(send(ready).data.state.players[0].ready, false);
  assert.equal(send(command('sync', { ...auth, secret: secret(2) })).error.code, 'INVALID_SESSION');
  const b = send(command('join', { name: 'B', secret: secret(2) })).data;
  send(command('setReady', { ...auth, ready: true, readyVersion: 3 }));
  const final = command('setReady', {
    serverId: b.state.serverId, playerId: b.playerId, secret: secret(2), ready: true, readyVersion: 1,
  });
  const game = send(final);
  assert.equal(game.data.state.phase, 'game');
  assert.deepEqual(send(final), game);
  assert.equal(send(command('resume', auth)).data.state.gameId, game.data.state.gameId);
  assert.equal(send(command('leave', auth)).error.code, 'GAME_STARTED');
  assert.equal(send(command('join', { name: 'C', secret: secret(3) })).error.code, 'GAME_STARTED');
});

test('script lock serializes ready/leave/heartbeat contention and exact retries', () => {
  for (const action of ['setReady', 'leave', 'sync']) {
    const runtime = fakeRuntime();
    invoke(runtime, command('initialize'));
    const joined = invoke(runtime, command('join', { name: 'A', secret: secret(1) })).data;
    const auth = { serverId: joined.state.serverId, playerId: joined.playerId, secret: secret(1) };
    const first = command('setReady', { ...auth, ready: true, readyVersion: 1 });
    const competing = command(action, { ...auth, ...(action === 'setReady' ? { ready: false, readyVersion: 2 } : {}) });
    let collision;
    runtime.onRead = () => { collision = invoke(runtime, competing); };
    assert.equal(invoke(runtime, first).ok, true);
    assert.equal(collision.error.code, 'BUSY');
    runtime.onRead = undefined;
    const resolved = invoke(runtime, competing);
    assert.equal(resolved.ok, true);
    assert.equal(invoke(runtime, competing).ok, true);
    assert.equal(resolved.data.state.players.length, action === 'leave' ? 0 : 1);
    if (action !== 'leave') assert.equal(resolved.data.state.players[0].ready, action === 'sync');
  }
});
