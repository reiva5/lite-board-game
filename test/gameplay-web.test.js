import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCommand, publicState } from '../game100/domain.js';
import { createRegistrationClient, ClientError, validateResult } from '../web/client.js';
import { choicesForCard, renderRound, roundSnapshot } from '../web/game.js';
import { mountRegistration, renderRoster } from '../web/ui.js';

const endpoint = 'https://script.google.com/macros/s/test_deployment/exec';
const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
const code = expected => error => error.code === expected;
function memory() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
async function fixture(count = 2) {
  let state = null, sequence = 0;
  const random = () => createHash('sha256').update(String(++sequence)).digest('hex');
  const deps = { hash: text => createHash('sha256').update(text).digest('hex'),
    uuid: random, now: () => 10, random: () => 0.5 };
  const calls = [];
  const send = async command => {
    calls.push(command);
    try {
      const outcome = applyCommand(state, command, deps);
      state = outcome.state;
      if (outcome.error) throw new ClientError(outcome.error.code, outcome.error.message);
      return outcome.result;
    } catch (error) { throw new ClientError(error.code, error.message); }
  };
  const stores = Array.from({ length: count }, memory);
  const clients = stores.map(storage => createRegistrationClient({ endpoint, spreadsheetUrl, storage, send, random }));
  await clients[0].initialize();
  for (let i = 0; i < count; i++) await clients[i].join(`P${i}`);
  const start = async () => {
    for (const client of clients) await client.setReady(true);
    return clients[0].sync();
  };
  return { clients, stores, send, random, calls, start,
    get state() { return state; }, set state(value) { state = value; } };
}
function documentFixture() {
  class Element {
    value = ''; hidden = false; disabled = false; textContent = ''; children = []; listeners = {};
    setAttribute() {}
    replaceChildren() { this.children = []; }
    append(item) { this.children.push(item); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    removeEventListener(event) { delete this.listeners[event]; }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); },
    addEventListener() {}, removeEventListener() {},
  };
  return document;
}

test('public round validator accepts choices and strips private/provider fields', async () => {
  const f = await fixture(6), result = await f.start();
  const checked = validateResult(result, 'sync');
  assert.equal(checked.state.players.length, 6);
  assert.equal(checked.state.round.hand.length, 3);
  assert.deepEqual(choicesForCard('AS'), [1, 11]);
  assert.deepEqual(choicesForCard('10S'), [10, -10]);
  for (const card of ['9S', 'JS', 'QS']) assert.deepEqual(choicesForCard(card), [0]);
  assert.deepEqual(choicesForCard('KS'), [99]);
  assert.deepEqual(choicesForCard('8S'), [8]);
  const dirty = structuredClone(result);
  dirty.state.round.secret = 'must not escape';
  dirty.state.round.players[0].private = true;
  assert.deepEqual(validateResult(dirty, 'sync'), result);
  const anonymous = publicState(f.state);
  assert.equal(validateResult({ state: anonymous }, 'initialize').state.round.hand.length, 0);
});

test('malformed public rounds fail explicitly rather than persisting broken game snapshots', async () => {
  const f = await fixture(), result = await f.start();
  const mutations = [
    () => null,
    r => ({ ...r, version: 2 }), r => ({ ...r, status: 'other' }),
    r => ({ ...r, tableScore: 101 }), r => ({ ...r, tableScore: 0.5 }),
    r => ({ ...r, direction: 0 }), r => ({ ...r, turnNumber: -1 }),
    r => ({ ...r, players: null }), r => ({ ...r, players: [] }),
    r => ({ ...r, players: [null, r.players[1]] }),
    r => ({ ...r, players: r.players.map(p => ({ ...p, playerId: 'other' })) }),
    r => ({ ...r, players: r.players.map(p => ({ ...p, status: 'other' })) }),
    r => ({ ...r, players: r.players.map(p => ({ ...p, cardCount: 2 })) }),
    r => ({ ...r, drawCount: -1 }), r => ({ ...r, drawCount: 53 }),
    r => ({ ...r, drawCount: 52 }), r => ({ ...r, discardTop: 'XS' }),
    r => ({ ...r, hand: null }), r => ({ ...r, hand: ['XS'] }),
    r => ({ ...r, hand: [r.hand[0], r.hand[0], r.hand[0]] }),
    r => ({ ...r, hand: [] }), r => ({ ...r, turnPlayerId: 'other' }),
    r => ({ ...r, winnerId: r.turnPlayerId }), r => ({ ...r, endedAt: 0 }),
    r => ({ ...r, lastMove: {} }),
    r => ({ ...r, status: 'finished' }),
  ];
  for (const mutate of mutations) {
    const data = structuredClone(result); data.state.round = mutate(data.state.round);
    assert.throws(() => validateResult(data, 'sync'), code('INVALID_RESPONSE'));
  }
  const ids = result.state.participantIds;
  const lost = { ...result.state.round, players: result.state.round.players.map(p => ({ ...p, status: 'lost', cardCount: 0 })), hand: [] };
  assert.throws(() => roundSnapshot(lost, ids, result.playerId));
  const finished = { ...lost, players: [{ ...result.state.round.players[0] }, lost.players[1]],
    status: 'finished', turnPlayerId: null, winnerId: ids[0], endedAt: 10, hand: result.state.round.hand };
  assert.equal(roundSnapshot(finished, ids, result.playerId).winnerId, ids[0]);
  for (const patch of [{ winnerId: ids[1] }, { turnPlayerId: ids[0] }, { endedAt: -1 }]) {
    assert.throws(() => roundSnapshot({ ...finished, ...patch }, ids, result.playerId));
  }
  const before = f.state.round.tableScore;
  const card = result.state.round.hand[0];
  const moved = await f.clients[0].playCard(card, choicesForCard(card)[0]);
  assert.equal(moved.state.round.turnNumber, 1);
  const moveBase = moved.state.round.lastMove;
  for (const patch of [null, { ...moveBase, playerId: 'other' }, { ...moveBase, card: 'XS' },
    { ...moveBase, choice: 900 }, { ...moveBase, scoreBefore: 101 }, { ...moveBase, scoreBefore: 1.5 },
    { ...moveBase, scoreAfter: -5 }, { ...moveBase, scoreAfter: 0.5 }, { ...moveBase, outcome: 'other' }]) {
    assert.throws(() => roundSnapshot({ ...moved.state.round, lastMove: patch }, ids, moved.playerId));
  }
  assert.equal(moveBase.scoreBefore, before);
  const dirty = structuredClone(moved); dirty.state.round.lastMove.private = true;
  assert.deepEqual(validateResult(dirty, 'playCard'), moved);
});

test('gameplay writes persist before send, exact retries survive reload, and stale turn clears only pending', async () => {
  const f = await fixture(), result = await f.start();
  let loseResponse = true;
  const options = { endpoint, spreadsheetUrl, storage: f.stores[0], random: f.random,
    send: async command => {
      const pending = JSON.parse(f.stores[0].getItem(f.clients[0].lockKey)).pending;
      assert.deepEqual(pending, command);
      const outcome = await f.send(command);
      if (loseResponse) { loseResponse = false; throw new ClientError('NETWORK_ERROR', 'lost'); }
      return outcome;
    } };
  const client = createRegistrationClient(options), card = result.state.round.hand[0], choice = choicesForCard(card)[0];
  await assert.rejects(client.playCard(card, choice), code('NETWORK_ERROR'));
  const pending = f.calls.at(-1), revision = f.state.revision;
  await assert.rejects(client.playCard(card, choice), code('PENDING_COMMAND'));
  const recovered = await createRegistrationClient(options).resume();
  assert.equal(recovered.state.revision, revision);
  assert.deepEqual(f.calls.at(-1), pending);
  assert.equal(JSON.parse(f.stores[0].getItem(client.lockKey)).pending, undefined);
  for (const rejection of ['STALE_TURN', 'NOT_YOUR_TURN', 'GAME_FINISHED', 'INVALID_MOVE', 'GAME_CHANGED',
    'GAME_UPGRADE_REQUIRED', 'GAME_NOT_STARTED']) {
    const rejected = createRegistrationClient({ ...options, send: async () => { throw new ClientError(rejection, rejection); } });
    await assert.rejects(rejected.playCard(card, choice), code(rejection));
    const saved = JSON.parse(f.stores[0].getItem(client.lockKey));
    for (const expected of [null, { gameId: 'other', turnNumber: 0 },
      { gameId: saved.gameId, turnNumber: saved.turnNumber + 1 }]) {
      await assert.rejects(client.playCard('AS', 1, expected), code('STALE_TURN'));
      assert.equal(JSON.parse(f.stores[0].getItem(client.lockKey)).pending, undefined);
    }
    assert.equal(saved.pending, undefined);
    assert.equal(saved.playerId, result.playerId);
  }
});

test('gameplay client rejects missing sessions, bad input and corrupt pending gameplay', async () => {
  const f = await fixture(), client = f.clients[0];
  await assert.rejects(client.playCard('XS', 0), code('INVALID_MOVE'));
  await assert.rejects(client.playCard(null, 0), code('INVALID_MOVE'));
  await assert.rejects(client.playCard('AS', 1.5), code('INVALID_MOVE'));
  await assert.rejects(client.playCard('AS', 1), code('GAME_NOT_STARTED'));
  const empty = createRegistrationClient({ endpoint, spreadsheetUrl, storage: memory() });
  await assert.rejects(empty.playCard('AS', 1), code('NO_SESSION'));
  await f.start();
  const saved = JSON.parse(f.stores[0].getItem(client.lockKey));
  const pending = { action: 'playCard', card: 'AS', choice: 1, gameId: saved.gameId,
    turnNumber: saved.turnNumber, secret: saved.secret, serverId: saved.serverId, playerId: saved.playerId,
    requestId: f.random(), spreadsheetUrl };
  for (const patch of [{ gameId: '' }, { turnNumber: -1 }, { card: null }, { card: 'XS' }, { choice: 0.5 }]) {
    f.stores[0].setItem(client.lockKey, JSON.stringify({ ...saved, pending: { ...pending, ...patch } }));
    assert.throws(() => client.hasSession(), code('STORAGE_ERROR'));
  }
  for (const patch of [{ gameId: '' }, { turnNumber: -1 }, { turnNumber: 0.5 }]) {
    f.stores[0].setItem(client.lockKey, JSON.stringify({ ...saved, ...patch }));
    assert.throws(() => client.hasSession(), code('STORAGE_ERROR'));
  }
  f.stores[0].setItem(client.lockKey, JSON.stringify(saved));
});

test('round renderer handles own moves, opponent/lost/terminal states and legacy games', async () => {
  const f = await fixture(), result = await f.start(), document = documentFixture();
  const get = id => document.getElementById(id), actions = [];
  const data = structuredClone(result);
  data.state.round.hand = ['AS', '10H', 'KD'];
  renderRound(document, data, true, (...args) => actions.push(args));
  const buttons = get('hand').children.flatMap(item => item.children);
  assert.equal(buttons.length, 5);
  buttons[0].listeners.click();
  assert.deepEqual(actions, [['AS', 1]]);
  buttons[0].disabled = true; buttons[0].listeners.click();
  assert.equal(actions.length, 1);
  data.state.round.tableScore = 100;
  data.state.round.direction = -1;
  data.state.round.discardTop = 'QS';
  data.state.round.lastMove = { playerId: result.playerId, card: 'AS', choice: 11,
    scoreBefore: 100, scoreAfter: 100, outcome: 'bust' };
  renderRound(document, data, false, assert.fail);
  assert.match(get('direction').textContent, /berlawanan/);
  assert.match(get('last-move').textContent, /kalah/);
  assert.match(get('hand').children[0].children[0].textContent, /kalah/);
  assert.ok(get('hand').children.every(item => item.children.every(button => button.disabled)));
  data.state.round.status = 'finished'; data.state.round.winnerId = data.state.participantIds[1];
  data.state.round.players[0].status = 'lost'; data.state.round.players[0].cardCount = 0;
  data.state.round.hand = [];
  renderRound(document, data, true, assert.fail);
  renderRoster(document, data);
  assert.match(get('turn').textContent, /Pemenang: P1/);
  assert.match(get('round-result').textContent, /Anda kalah/);
  assert.match(get('players').children[0].textContent, /Kalah/);
  data.state.round.players[1].status = 'active';
  delete data.state.round;
  renderRound(document, data, true, assert.fail);
  assert.equal(get('round').hidden, true);
  assert.equal(get('legacy-game').hidden, false);
});

test('mounted UI sends card choices and disables moves when not current or already finished', async () => {
  const f = await fixture(), result = await f.start(), document = documentFixture();
  f.stores[0].setItem('game100:lastSpreadsheet', spreadsheetUrl);
  const ui = mountRegistration(document, { storage: f.stores[0], config: { endpoint }, send: f.send,
    random: f.random, locks: { request: (_, operation) => operation() },
    timers: { setTimeout() { return 1; }, clearTimeout() {} } });
  try {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    const get = id => document.getElementById(id);
    assert.equal(get('round').hidden, false);
    const button = get('hand').children[0].children[0];
    assert.equal(button.disabled, false);
    button.listeners.click();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.at(-1).action, 'playCard');
    assert.equal(f.state.round.turnNumber, 1);
    const calls = f.calls.length;
    await ui.run('playCard', { card: 'AS', choice: 1 });
    if (f.state.round.turnPlayerId !== result.playerId) assert.equal(f.calls.length, calls);
  } finally { ui.unmount(); }
});

test('legacy persisted placeholder reconnects read-only without silently dealing or resetting it', async () => {
  const f = await fixture();
  await f.start();
  delete f.state.round;
  const before = structuredClone(f.state);
  f.stores[0].setItem('game100:lastSpreadsheet', spreadsheetUrl);
  const document = documentFixture();
  const ui = mountRegistration(document, { storage: f.stores[0], config: { endpoint }, send: f.send,
    random: f.random, locks: { request: (_, operation) => operation() },
    timers: { setTimeout() { return 1; }, clearTimeout() {} } });
  try {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.match(document.getElementById('status').textContent, /Game lama.*spreadsheet baru/);
    assert.equal(document.getElementById('round').hidden, true);
    assert.equal(document.getElementById('legacy-game').hidden, false);
    const calls = f.calls.length;
    await ui.run('playCard', { card: 'AS', choice: 1 });
    assert.equal(f.calls.length, calls);
    assert.deepEqual(f.state, before);
  } finally { ui.unmount(); }
});
