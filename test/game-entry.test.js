import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCommand, decodeState, publicState } from '../game100/domain.js';
import { createHandler } from '../apps-script/runtime.js';
import { validateResult } from '../web/client.js';

const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
const code = expected => error => error.code === expected;
function fixture() {
  let state = null, time = 10, sequence = 0, uuids = 0;
  const hash = text => createHash('sha256').update(text).digest('hex');
  const random = () => hash(String(++sequence));
  const deps = { hash, uuid: () => { uuids++; return random(); }, now: () => time };
  const command = (action, extra = {}) => ({ action, requestId: random(), spreadsheetUrl, ...extra });
  const apply = request => {
    const outcome = applyCommand(state, request, deps);
    state = outcome.state;
    return outcome;
  };
  apply(command('initialize'));
  const join = name => {
    const secret = random(), request = command('join', { name, secret });
    const result = apply(request).result;
    return { auth: { secret, serverId: state.serverId, playerId: result.playerId }, request };
  };
  const ready = (player, version = 1) => command('setReady', { ...player.auth, ready: true, readyVersion: version });
  return { deps, random, command, apply, join, ready,
    get state() { return state; }, get uuids() { return uuids; }, set time(value) { time = value; } };
}

for (const count of [2, 3, 4]) test(`${count} all-ready players start exactly once, with sanitized frozen metadata`, () => {
  const f = fixture(), players = Array.from({ length: count }, (_, i) => f.join(`P${i}`));
  for (const player of players.slice(0, -1)) f.apply(f.ready(player));
  assert.equal(f.state.phase, 'lobby');
  const final = f.ready(players.at(-1)), before = f.uuids;
  const outcome = f.apply(final), game = structuredClone(f.state);
  assert.equal(f.uuids, before + 1);
  assert.equal(game.phase, 'game');
  assert.equal(game.startedAt, 10);
  assert.deepEqual(game.participantIds, players.map(player => player.auth.playerId));
  assert.deepEqual(decodeState(JSON.stringify(game)), game);
  assert.deepEqual(validateResult(outcome.result, 'setReady').state, publicState(game));
  assert.ok(!JSON.stringify(outcome.result).includes('secret'));
  assert.ok(!JSON.stringify(outcome.result).includes('retries'));
  f.time = 600010;
  for (const request of [final, players[0].request,
    f.command('join', { name: 'P0', secret: players[0].auth.secret }),
    f.command('resume', players[0].auth), f.command('sync', players[0].auth), f.command('initialize')]) {
    assert.equal(f.apply(request).result.state.gameId, game.gameId);
    assert.deepEqual(f.state, game);
  }
  assert.equal(f.uuids, before + 1);
  for (const action of ['leave', 'setReady']) {
    assert.throws(() => f.apply(f.command(action, { ...players[0].auth,
      ...(action === 'setReady' ? { ready: false, readyVersion: 2 } : {}) })), code('GAME_STARTED'));
  }
  assert.throws(() => f.join('Late'), code('GAME_STARTED'));
  assert.throws(() => f.apply(f.command('sync', { ...players[0].auth, secret: f.random() })), code('INVALID_SESSION'));
  assert.deepEqual(f.state, game);
});

test('empty/one-player lobbies cannot start; explicit leave can start remaining ready players', () => {
  const f = fixture();
  assert.equal(f.apply(f.command('initialize')).state.phase, 'lobby');
  const a = f.join('A');
  f.apply(f.ready(a));
  assert.equal(f.state.phase, 'lobby');
  const b = f.join('B'), c = f.join('C');
  f.apply(f.ready(b));
  const leave = f.command('leave', c.auth);
  const outcome = f.apply(leave);
  assert.equal(outcome.result.left, true);
  assert.equal(f.state.phase, 'game');
  assert.deepEqual(f.state.participantIds, [a.auth.playerId, b.auth.playerId]);
  const game = structuredClone(f.state);
  assert.equal(f.apply(leave).result.left, true);
  assert.deepEqual(f.state, game);
});

test('both lock orders of final-ready versus leave/join have no lost membership or duplicate game', () => {
  for (const readyFirst of [true, false]) for (const action of ['join', 'leave']) {
    const f = fixture(), a = f.join('A'), b = f.join('B');
    f.apply(f.ready(a));
    const ready = f.ready(b);
    const membership = action === 'join'
      ? f.command('join', { name: 'C', secret: f.random() }) : f.command('leave', a.auth);
    const requests = readyFirst ? [ready, membership] : [membership, ready];
    f.apply(requests[0]);
    if (readyFirst) {
      const saved = structuredClone(f.state);
      assert.throws(() => f.apply(requests[1]), code('GAME_STARTED'));
      assert.deepEqual(f.state, saved);
    } else {
      f.apply(requests[1]);
      assert.equal(f.state.phase, 'lobby');
      assert.equal(f.state.players.length, action === 'join' ? 3 : 1);
    }
    for (const readyFirst of [true, false]) {
      const f = fixture(), a = f.join('A'), b = f.join('B'), c = f.join('C');
      f.apply(f.ready(a));
      const ready = f.ready(b), leave = f.command('leave', c.auth), before = f.uuids;
      for (const request of readyFirst ? [ready, leave] : [leave, ready]) f.apply(request);
      assert.equal(f.state.phase, 'game');
      assert.deepEqual(f.state.participantIds, [a.auth.playerId, b.auth.playerId]);
      assert.equal(f.uuids, before + 1);
      const game = structuredClone(f.state);
      f.apply(ready); f.apply(leave);
      assert.deepEqual(f.state, game);
    }
  }
});

test('timeout resets readiness before final ready/leave/initialize and cannot accidentally start', () => {
  for (const action of ['setReady', 'leave', 'initialize']) {
    const f = fixture(), a = f.join('A'), b = f.join('B'), c = f.join('C');
    f.apply(f.ready(a)); f.apply(f.ready(b));
    f.time = 50000;
    f.apply(f.command('sync', a.auth)); f.apply(f.command('sync', b.auth));
    f.time = 60010;
    const request = f.command(action, action === 'initialize' ? {} : {
      ...c.auth, ...(action === 'setReady' ? { ready: true, readyVersion: 1 } : {}),
    });
    const outcome = f.apply(request);
    if (action !== 'initialize') assert.equal(outcome.error.code, 'SESSION_ENDED');
    assert.equal(f.state.phase, 'lobby');
    assert.deepEqual(f.state.players.map(player => [player.ready, player.readyVersion]), [[false, 2], [false, 2]]);
    f.apply(f.ready(a, 1));
    assert.equal(f.state.players[0].ready, false);
  }
});

test('evicted ready and join retries cannot mutate or recreate a committed game', () => {
  const f = fixture(), a = f.join('A');
  const departed = f.join('Departed');
  f.apply(f.command('leave', departed.auth));
  const old = f.ready(a);
  f.apply(old);
  for (let version = 2; version <= 40; version++) {
    f.apply(f.command('setReady', { ...a.auth, ready: false, readyVersion: version }));
  }
  const b = f.join('B');
  f.apply(f.ready(a, 41)); f.apply(f.ready(b));
  const game = structuredClone(f.state);
  assert.ok(!game.retries.some(retry => retry.requestId === old.requestId));
  assert.throws(() => f.apply(old), code('GAME_STARTED'));
  assert.equal(f.apply(a.request).result.playerId, a.auth.playerId);
  assert.throws(() => f.apply(departed.request), code('GAME_STARTED'));
  assert.deepEqual(f.state, game);
});

test('game join recovery rejects renaming an existing secret without changing the frozen game', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.apply(f.ready(a)); f.apply(f.ready(b));
  const game = structuredClone(f.state), before = f.uuids;
  f.time = 600010;
  assert.throws(() => f.apply(f.command('join', {
    name: 'Renamed', secret: a.auth.secret, serverId: a.auth.serverId,
  })), code('SESSION_EXISTS'));
  const recovered = f.apply(f.command('join', { name: ' a ', secret: a.auth.secret }));
  assert.equal(recovered.result.playerId, a.auth.playerId);
  assert.equal(recovered.changed, false);
  assert.deepEqual(f.state, game);
  assert.equal(f.uuids, before);
});

test('phase metadata corruption is rejected by backend/browser without reserved-cell overwrite', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.apply(f.ready(a)); f.apply(f.ready(b));
  const game = structuredClone(f.state);
  for (const bad of [
    { ...game, phase: 'lobby' }, { ...game, phase: 'unknown' },
    { ...game, gameId: undefined }, { ...game, startedAt: -1 },
    { ...game, startedAt: 1.5 }, { ...game, participantIds: null },
    { ...game, participantIds: [a.auth.playerId] },
    { ...game, participantIds: [a.auth.playerId, a.auth.playerId] },
    { ...game, participantIds: [...game.participantIds].reverse() },
    { ...game, players: [game.players[0]] },
    { ...game, players: game.players.map(player => ({ ...player, ready: false })) },
    { ...game, extra: true },
  ]) {
    const text = JSON.stringify(bad);
    assert.throws(() => decodeState(text), code('CORRUPT_STATE'));
    if (!Object.hasOwn(bad, 'extra')) {
      assert.throws(() => validateResult({ state: bad }, 'initialize'), code('INVALID_RESPONSE'));
    }
    let writes = 0, releases = 0;
    const handle = createHandler({ ...f.deps,
      getLock: () => ({ tryLock: () => true, releaseLock: () => releases++ }),
      open: () => ({ getSheetByName: () => ({ getRange: () => ({
        getFormula: () => '', getValue: () => text, setValue: () => writes++,
      }) }) }), flush() {}, log() { assert.fail('unexpected provider failure'); },
    });
    assert.equal(handle(JSON.stringify(f.command('initialize'))).error.code, 'CORRUPT_STATE');
    assert.equal(writes, 0); assert.equal(releases, 1);
  }
});

test('runtime lock and flush protect all-ready commit against concurrent leave and lost response', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.apply(f.ready(a));
  let text = JSON.stringify(f.state), held = false, onRead;
  const events = [];
  const services = { ...f.deps,
    getLock: () => ({
      tryLock: wait => { assert.equal(wait, 5000); if (held) return false; held = true; return true; },
      releaseLock: () => { held = false; events.push('release'); },
    }),
    open: () => ({ getSheetByName: name => {
      assert.equal(name, 'Game100State');
      return { getRange: cell => {
        assert.equal(cell, 'A1');
        return { getFormula: () => '', getValue: () => { onRead?.(); return text; },
          setValue: value => { assert.ok(held); text = value; events.push('write'); } };
      } };
    } }),
    flush: () => { assert.ok(held); events.push('flush'); }, log() { assert.fail('unexpected failure'); },
  };
  const handle = createHandler(services), other = createHandler(services);
  const send = request => handle(JSON.stringify(request));
  const leave = f.command('leave', a.auth);
  let collision;
  onRead = () => { collision = other(JSON.stringify(leave)); };
  const final = f.ready(b), result = send(final);
  assert.equal(collision.error.code, 'BUSY');
  assert.deepEqual(events, ['write', 'flush', 'release']);
  const committed = text;
  onRead = undefined;
  assert.equal(send(leave).error.code, 'GAME_STARTED');
  assert.deepEqual(send(final), result);
  assert.equal(text, committed);
});

test('provider flush failure after start commit cannot generate a second game on retry', () => {
  const f = fixture(), a = f.join('A'), b = f.join('B');
  f.apply(f.ready(a));
  let text = JSON.stringify(f.state), fail = true, held = false;
  const handle = createHandler({ ...f.deps,
    getLock: () => ({ tryLock: () => { held = true; return true; }, releaseLock: () => { held = false; } }),
    open: () => ({ getSheetByName: () => ({ getRange: () => ({
      getFormula: () => '', getValue: () => text, setValue: value => { text = value; },
    }) }) }),
    flush: () => { assert.ok(held); if (fail) throw Error('provider failure'); },
    log: message => assert.equal(message, 'Game100 provider operation failed'),
  });
  const final = JSON.stringify(f.ready(b)), before = f.uuids;
  assert.equal(handle(final).error.code, 'PROVIDER_ERROR');
  assert.equal(held, false);
  const saved = text, game = JSON.parse(saved);
  assert.equal(game.phase, 'game');
  fail = false;
  assert.equal(handle(final).data.state.gameId, game.gameId);
  assert.equal(text, saved);
  assert.equal(f.uuids, before + 1);
});
