import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCommand, decodeState, publicState, LOBBY_TIMEOUT } from '../game100/domain.js';
import { createHandler } from '../apps-script/runtime.js';
const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
function fixture() {
  let time = 0, sequence = 0, state = null;
  const hash = text => createHash('sha256').update(text).digest('hex');
  const uuid = () => hash(String(++sequence));
  const deps = { hash, uuid, now: () => time };
  const command = (action, extra = {}) => ({ action, requestId: uuid(), spreadsheetUrl, ...extra });
  const apply = request => {
    const outcome = applyCommand(state, request, deps);
    state = outcome.state;
    return outcome;
  };
  apply(command('initialize'));
  const join = name => {
    const secret = uuid();
    const result = apply(command('join', { name, secret })).result;
    return { secret, serverId: state.serverId, playerId: result.playerId };
  };
  const ready = (auth, value, version = 1) => apply(command('setReady', { ...auth, ready: value, readyVersion: version }));
  return {
    deps, uuid, command, apply, join, ready,
    get state() { return state; }, set time(value) { time = value; },
  };
}
const code = expected => error => error.code === expected;

test('phase guard skips lobby cleanup if an injected clock corrupts the validated phase', () => {
  const f = fixture();
  f.join('A');
  const before = structuredClone(f.state);
  const parse = JSON.parse;
  let working;
  // Capture the real clone to inject a dependency fault after initial validation.
  JSON.parse = (...args) => { working = parse(...args); return working; };
  try {
    assert.throws(() => applyCommand(before, f.command('initialize'), {
      ...f.deps,
      now: () => { working.phase = 'unsupported'; return LOBBY_TIMEOUT; },
    }), code('CORRUPT_STATE'));
    assert.deepEqual(working.players, before.players);
    assert.equal(working.revision, before.revision);
    assert.deepEqual(f.state, before);
  } finally {
    JSON.parse = parse;
  }
});

test('ready is explicit boolean, private state validates, and all-ready stays lobby', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.ready(a, true); f.ready(b, true);
  assert.equal(f.state.phase, 'lobby');
  assert.ok(f.state.players.every(player => player.ready));
  assert.deepEqual(decodeState(JSON.stringify(f.state)), f.state);
  assert.ok(!JSON.stringify(publicState(f.state)).includes('secret'));
  assert.ok(!JSON.stringify(publicState(f.state)).includes('retries'));
  for (const ready of [null, 1, 'true', undefined]) {
    assert.throws(() => f.ready(a, ready, 2), code('INVALID_REQUEST'));
  }
  f.ready(a, false, 2);
  assert.equal(f.state.players[0].ready, false);
  assert.equal(f.state.players[1].ready, true);
});

test('layer-one player records remain valid and timestamps cannot be supplied by clients', () => {
  const f = fixture(), a = f.join('A');
  const legacy = structuredClone(f.state);
  delete legacy.players[0].readyVersion;
  assert.equal(publicState(decodeState(JSON.stringify(legacy))).players[0].readyVersion, 0);
  const outcome = applyCommand(legacy, f.command('setReady', { ...a, ready: true, readyVersion: 1 }), f.deps);
  assert.equal(outcome.state.players[0].readyVersion, 1);
  assert.throws(() => f.apply(f.command('sync', { ...a, lastSeenAt: 99999 })), code('INVALID_REQUEST'));
  assert.throws(() => f.ready(a, true, Number.MAX_SAFE_INTEGER), code('INVALID_REQUEST'));
});

test('ordinary join/leave preserve everyone else ready; new player starts not ready', () => {
  const f = fixture(), a = f.join('A');
  f.ready(a, true);
  const b = f.join('B');
  assert.deepEqual(f.state.players.map(player => player.ready), [true, false]);
  f.apply(f.command('leave', b));
  assert.equal(f.state.players[0].ready, true);
});

test('timeout boundary expires before heartbeat; survivor reset persists with session-ended error', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.ready(a, true); f.ready(b, true);
  f.time = LOBBY_TIMEOUT - 1;
  f.apply(f.command('sync', b));
  assert.equal(f.state.players.length, 2);
  assert.equal(f.state.players[1].ready, true);
  f.time = LOBBY_TIMEOUT;
  const outcome = f.apply(f.command('sync', a));
  assert.equal(outcome.error.code, 'SESSION_ENDED');
  assert.equal(outcome.changed, true);
  assert.equal(f.state.players.length, 1);
  assert.equal(f.state.players[0].id, b.playerId);
  assert.equal(f.state.players[0].ready, false);
  assert.equal(f.state.players[0].lastSeenAt, LOBBY_TIMEOUT - 1);
  assert.throws(() => f.apply(f.command('sync', a)), code('INVALID_SESSION'));
  assert.equal(f.join(' a ').playerId !== a.playerId, true);
});

test('cleanup frees capacity and normalized names before join checks; initialize also cleans', () => {
  const f = fixture();
  for (const name of ['\u00c9ka', 'B', 'C', 'D']) f.join(name);
  f.time = LOBBY_TIMEOUT;
  f.join(' E\u0301KA ');
  assert.equal(f.state.players.length, 1);
  assert.equal(f.state.players[0].name, '\u00c9KA');
  f.time = 2 * LOBBY_TIMEOUT;
  const outcome = f.apply(f.command('initialize'));
  assert.equal(outcome.result.state.players.length, 0);
  assert.equal(outcome.changed, true);
});

test('cleanup survives rejected join after removing only stale players', () => {
  const f = fixture(), a = f.join('A');
  f.join('B');
  f.time = 50000; f.apply(f.command('sync', a));
  f.time = 60000;
  const result = f.apply(f.command('join', { name: ' a ', secret: f.uuid() }));
  assert.equal(result.error.code, 'NAME_TAKEN');
  assert.equal(result.changed, true);
  assert.equal(f.state.players.length, 1);
});

test('invalid credentials cannot ready, heartbeat, leave, or trigger cleanup', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.ready(a, true);
  f.time = LOBBY_TIMEOUT;
  const before = structuredClone(f.state);
  for (const action of ['setReady', 'sync', 'resume', 'leave']) {
    for (const bad of [{ ...a, secret: b.secret }, { ...a, playerId: b.playerId }]) {
      const request = f.command(action, { ...bad, ...(action === 'setReady' ? { ready: false, readyVersion: 2 } : {}) });
      assert.throws(() => f.apply(request), code('INVALID_SESSION'));
      assert.deepEqual(f.state, before);
    }
  }
});

test('persisted dedupe returns latest snapshot and old ready decisions cannot roll back after eviction', () => {
  const f = fixture(), a = f.join('A');
  const first = f.command('setReady', { ...a, ready: true, readyVersion: 1 });
  f.apply(first); f.ready(a, false, 2);
  assert.equal(f.apply(first).result.state.players[0].ready, false);
  assert.throws(() => f.apply({ ...first, ready: false }), code('REQUEST_CONFLICT'));
  for (let i = 3; i < 40; i++) f.ready(a, false, i);
  assert.equal(f.state.retries.length, 32);
  assert.equal(f.apply(first).result.state.players[0].ready, false);
  assert.equal(f.state.players[0].readyVersion, 39);
});

test('timeout reset invalidates older ready decision even when dedupe record was evicted', () => {
  const f = fixture(), a = f.join('A');
  f.join('B');
  f.ready(a, true);
  f.time = 50000; f.apply(f.command('sync', a));
  f.time = 60000;
  f.apply(f.command('sync', a));
  assert.equal(f.state.players[0].ready, false);
  f.ready(a, true, 1);
  assert.equal(f.state.players[0].ready, false);
  f.ready(a, true, 3);
  assert.equal(f.state.players[0].ready, true);
});

test('runtime writes timeout cleanup before returning error, under lock with reserved isolation', () => {
  const f = fixture(), a = f.join('A');
  const cells = new Map([['Game100State!A1', JSON.stringify(f.state)], ['State!A1', 'sentinel']]);
  const events = [];
  f.time = 60000;
  const handle = createHandler({
    ...f.deps,
    getLock: () => ({ tryLock: () => { events.push('lock'); return true; }, releaseLock: () => events.push('release') }),
    open: () => ({ getSheetByName: name => ({ getRange: cell => ({
      getFormula: () => '', getValue: () => cells.get(`${name}!${cell}`),
      setValue: value => { events.push('write'); cells.set(`${name}!${cell}`, value); },
    }) }) }),
    flush: () => events.push('flush'), log: () => assert.fail('unexpected provider error'),
  });
  const response = handle(JSON.stringify(f.command('sync', a)));
  assert.equal(response.error.code, 'SESSION_ENDED');
  assert.equal(JSON.parse(cells.get('Game100State!A1')).players.length, 0);
  assert.equal(cells.get('State!A1'), 'sentinel');
  assert.deepEqual(events, ['lock', 'write', 'flush', 'release']);
});
