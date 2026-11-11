import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCommand, publicState, validateState } from '../game100/domain.js';
import { createHandler } from '../apps-script/runtime.js';
import { cardOptions } from '../game100/round.js';

const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
const hash = text => createHash('sha256').update(text).digest('hex');
const code = expected => error => error.code === expected;

function game(count = 2) {
  let state = null, sequence = 0;
  const deps = { hash, uuid: () => hash(String(++sequence)), now: () => 100, random: () => 0.5 };
  const command = (action, extra = {}) => ({ action, requestId: deps.uuid(), spreadsheetUrl, ...extra });
  const apply = request => {
    const outcome = applyCommand(state, request, deps);
    state = outcome.state;
    return outcome;
  };
  apply(command('initialize'));
  const auth = Array.from({ length: count }, (_, index) => {
    const secret = hash(`player-${index}`);
    const result = apply(command('join', { name: `Player ${index}`, secret })).result;
    return { secret, playerId: result.playerId, serverId: state.serverId };
  });
  const ready = index => apply(command('setReady', { ...auth[index], ready: true, readyVersion: 1 }));
  const play = (extra = {}) => {
    const actor = auth.find(item => item.playerId === state.round.turnPlayerId);
    const card = state.round.hands.find(hand => hand.playerId === actor.playerId).cards[0];
    return command('playCard', { ...actor, gameId: state.gameId, turnNumber: state.round.turnNumber,
      card, choice: cardOptions(card, state.round.tableScore)[0], ...extra });
  };
  return { deps, command, apply, auth, ready, play,
    get state() { return state; }, set state(value) { state = value; } };
}

test('2-6 players get a conserved private deck and only their own public hand', () => {
  for (let count = 2; count <= 6; count++) {
    const f = game(count);
    for (let i = 0; i < count; i++) f.ready(i);
    assert.equal(f.state.round.drawPile.length, 52 - count * 3);
    const serialized = JSON.stringify(f.state);
    assert.ok(serialized.length < 48000);
    for (const auth of f.auth) {
      const { result } = f.apply(f.command('sync', auth));
      assert.deepEqual(result.state.round.hand, f.state.round.hands.find(hand => hand.playerId === auth.playerId).cards);
      assert.equal(result.state.round.players.length, count);
      assert.equal(result.state.round.drawPile, undefined);
      assert.equal(result.state.round.hands, undefined);
      assert.equal(result.state.players.some(player => Object.hasOwn(player, 'secretDigest')), false);
    }
    assert.deepEqual(f.apply(f.command('initialize')).result.state.round.hand, []);
  }
});

test('play command is authenticated, turn-bound and exactly replayable without duplicate effects', () => {
  const f = game();
  f.ready(0); f.ready(1);
  const request = f.play(), before = structuredClone(f.state);
  const result = f.apply(request);
  assert.equal(result.state.revision, before.revision + 1);
  assert.equal(result.state.round.turnNumber, 1);
  assert.deepEqual(f.apply(request).result, result.result);
  assert.equal(f.apply(request).changed, false);
  assert.throws(() => f.apply({ ...request, choice: request.choice + 1 }), code('REQUEST_CONFLICT'));
  assert.throws(() => f.apply(f.play({ secret: hash('impostor') })), code('INVALID_SESSION'));
  assert.throws(() => f.apply(f.play({ gameId: hash('other-game') })), code('GAME_CHANGED'));
  assert.throws(() => f.apply(f.play({ turnNumber: 0 })), code('STALE_TURN'));
  const current = f.play();
  assert.throws(() => f.apply({ ...current, ...f.auth[0] }), code('NOT_YOUR_TURN'));
  assert.throws(() => f.apply({ ...current, card: 'XS' }), code('INVALID_REQUEST'));
  assert.throws(() => f.apply({ ...current, choice: 1.5 }), code('INVALID_REQUEST'));
  assert.throws(() => f.apply({ ...current, gameId: '' }), code('INVALID_REQUEST'));
  assert.throws(() => f.apply({ ...current, turnNumber: -1 }), code('INVALID_REQUEST'));
  assert.throws(() => f.apply({ ...current, card: undefined }), code('INVALID_REQUEST'));
  assert.throws(() => f.apply(f.command('sync', { ...f.auth[0], choice: 1 })), code('INVALID_REQUEST'));
  f.state = { ...f.state, retries: [] };
  assert.throws(() => f.apply({ ...request, requestId: f.deps.uuid() }), error =>
    ['STALE_TURN', 'NOT_YOUR_TURN'].includes(error.code));
});

test('legacy placeholder is read-only and malformed persisted round is never overwritten', () => {
  const f = game();
  f.ready(0); f.ready(1);
  const request = f.play();
  delete f.state.round;
  const legacy = structuredClone(f.state);
  assert.equal(f.apply(f.command('resume', f.auth[0])).changed, false);
  assert.deepEqual(f.state, legacy);
  assert.throws(() => f.apply(request), code('GAME_UPGRADE_REQUIRED'));
  f.state.round = null;
  assert.throws(() => validateState(f.state), code('CORRUPT_STATE'));
  let writes = 0, releases = 0;
  const handler = createHandler({ ...f.deps,
    getLock: () => ({ tryLock: () => true, releaseLock: () => releases++ }),
    open: () => ({ getSheetByName: () => ({ getRange: () => ({
      getFormula: () => '', getValue: () => JSON.stringify(f.state), setValue: () => writes++,
    }) }) }), flush() {}, log() { assert.fail('Unexpected provider error'); },
  });
  assert.equal(handler(JSON.stringify(f.command('initialize'))).error.code, 'CORRUPT_STATE');
  assert.equal(writes, 0); assert.equal(releases, 1);
});

test('lobby rejects gameplay without changing readiness; invalid shuffle never commits start', () => {
  const f = game();
  const request = f.command('playCard', { ...f.auth[0], gameId: hash('game'), turnNumber: 0, card: 'AS', choice: 1 });
  assert.throws(() => f.apply(request), code('GAME_NOT_STARTED'));
  f.ready(0);
  const before = structuredClone(f.state);
  assert.throws(() => applyCommand(f.state, f.command('setReady', {
    ...f.auth[1], ready: true, readyVersion: 1,
  }), { ...f.deps, random: () => 1 }), code('INVALID_RANDOM'));
  assert.deepEqual(f.state, before);
});

test('whole matches terminate, eliminated identities reconnect, and terminal state is immutable', () => {
  for (const count of [2, 6]) {
    const f = game(count);
    for (let i = 0; i < count; i++) f.ready(i);
    let turns = 0;
    while (f.state.round.status === 'playing' && turns++ < 2000) {
      const request = f.play();
      const cards = f.state.round.hands.find(hand => hand.playerId === request.playerId).cards;
      const options = cards.flatMap(card => cardOptions(card, f.state.round.tableScore)
        .map(choice => ({ card, choice, score: card.startsWith('K') ? 99 : f.state.round.tableScore + choice })));
      const selected = options.sort((a, b) => b.score - a.score)[0];
      f.apply({ ...request, card: selected.card, choice: selected.choice });
    }
    assert.ok(turns < 2000);
    assert.equal(f.state.round.status, 'finished');
    assert.equal(f.state.round.players, undefined);
    assert.equal(f.state.round.eliminatedIds.length, count - 1);
    const terminal = structuredClone(f.state);
    for (const auth of f.auth) {
      const result = f.apply(f.command('resume', auth));
      assert.equal(result.changed, false);
      assert.equal(result.result.state.round.winnerId, terminal.round.winnerId);
      assert.equal(result.result.state.round.hand.length, auth.playerId === terminal.round.winnerId ? 3 : 0);
    }
    const auth = f.auth.find(item => item.playerId === terminal.round.winnerId);
    assert.throws(() => f.apply(f.command('playCard', { ...auth, gameId: f.state.gameId,
      turnNumber: f.state.round.turnNumber, card: f.state.round.hands.find(hand => hand.playerId === auth.playerId).cards[0],
      choice: 0 })), code('GAME_FINISHED'));
    assert.deepEqual(f.state, terminal);
    assert.equal(publicState(terminal).round.hand.length, 0);
  }
});
