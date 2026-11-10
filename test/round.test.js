import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RoundError, createRound, validateRound, publicRound, playRound, cardOptions,
} from '../game100/round.js';

const ids = ['a', 'b'];
const deck = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
  .flatMap(rank => ['S', 'H', 'D', 'C'].map(suit => `${rank}${suit}`));
const clone = value => structuredClone(value);
function error(code, action) {
  assert.throws(action, err => err instanceof RoundError && err.code === code
    && typeof err.message === 'string' && err.message.length > 0);
}
function fixture({
  cards = [['KS', '2S', '3S'], ['KH', '2H', '3H']],
  tableScore = 0, direction = 1, eliminated = [], turn = 0, emptyDraw = false,
} = {}) {
  const players = cards.map((_, index) => String.fromCharCode(97 + index));
  const round = createRound(players, () => 0.5);
  round.hands = cards.map((hand, index) => ({ playerId: players[index], cards: [...hand] }));
  round.tableScore = tableScore;
  round.direction = direction;
  round.turnNumber = 1;
  round.turnPlayerId = players[turn];
  round.eliminatedIds = eliminated.map(index => players[index]);
  const used = new Set(cards.flat());
  const remaining = deck.filter(card => !used.has(card) && card !== '9S');
  round.drawPile = emptyDraw ? [] : remaining;
  round.discardPile = emptyDraw ? [...remaining, '9S'] : ['9S'];
  round.lastMove = {
    playerId: players[turn], card: '9S', choice: 0,
    scoreBefore: tableScore, scoreAfter: tableScore, outcome: 'played',
  };
  validateRound(round, players);
  return { round, players };
}
function play(round, players, card, choice, now = 123, random = () => 0.5) {
  return playRound(round, players, {
    playerId: round.turnPlayerId, card, choice, turnNumber: round.turnNumber,
  }, now, random);
}

test('creation: boundaries, deterministic Fisher–Yates, defaults and full conservation', () => {
  for (let count = 2; count <= 6; count += 1) {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, count);
    let calls = 0;
    const round = createRound(players, () => { calls += 1; return 0; });
    assert.equal(calls, 51);
    assert.deepEqual(round.hands[0].cards, ['AS', 'KC', 'KD']);
    assert.equal(round.drawPile.length, 52 - count * 3);
    assert.equal(validateRound(round, players), round);
    assert.deepEqual(round, createRound(players, () => 0));
  }
  validateRound(createRound(ids), ids);
  for (const players of [null, {}, [], ['a'], Array(7).fill('a'),
    ['a', 'a'], ['a', ''], ['a', ' '], ['a', 1], ['a', null], ['a', ,]]) {
    error('INVALID_MOVE', () => createRound(players));
  }
  for (const random of [null, 1, () => -0.1, () => 1, () => NaN, () => Infinity,
    () => '0.5', () => undefined]) {
    error('INVALID_RANDOM', () => createRound(ids, random));
  }
  let calls = 0;
  error('INVALID_RANDOM', () => createRound(ids, () => ++calls === 10 ? 1 : 0));
});

test('card options include bust choices, all suits/ranks, and reject malformed input', () => {
  const expected = {
    A: [1, 11], 2: [2], 3: [3], 4: [4], 5: [5], 6: [6], 7: [7], 8: [8],
    9: [0], 10: [10, -10], J: [0], Q: [0], K: [99],
  };
  for (const card of deck) {
    assert.deepEqual(cardOptions(card, 100), expected[card.slice(0, -1)]);
    assert.deepEqual(cardOptions(card, -1000), expected[card.slice(0, -1)]);
  }
  for (const card of [null, {}, 2, '', '1S', 'ASx', 'as', 'JOKER']) {
    error('INVALID_MOVE', () => cardOptions(card, 0));
  }
  for (const value of [undefined, null, NaN, Infinity, 101, 0.1, '0', -Infinity]) {
    error('INVALID_MOVE', () => cardOptions('AS', value));
  }
  const choices = cardOptions('AS', 0);
  choices.push(100);
  assert.deepEqual(cardOptions('AS', 0), [1, 11]);
});

test('ordinary scoring, exact 100, negative scores, king reset and ace choices', () => {
  for (const [card, choice, before, after] of [
    ['2S', 2, 98, 100], ['8S', 8, 0, 8], ['9H', 0, 100, 100],
    ['JS', 0, 12, 12], ['QS', 0, 12, 12],
    ['10S', -10, 0, -10], ['10S', 10, 90, 100],
    ['AS', 1, 99, 100], ['AS', 11, 89, 100],
    ['KS', 99, -100, 99], ['KS', 99, 100, 99],
  ]) {
    const { round, players } = fixture({
      cards: [[card, 'KD', 'KC'], ['KH', '2H', '3H']], tableScore: before,
    });
    const reference = round;
    assert.equal(play(round, players, card, choice), reference);
    assert.equal(round.tableScore, after);
    assert.equal(round.turnNumber, 2);
    assert.equal(round.hands[0].cards.length, 3);
    assert.equal(round.lastMove.outcome, 'played');
    assert.deepEqual(round.lastMove, {
      playerId: 'a', card, choice, scoreBefore: before, scoreAfter: after, outcome: 'played',
    });
    validateRound(round, players);
  }
});

test('J passes normally for 3–6, Q reverses, both repeat for exactly two active', () => {
  for (let count = 3; count <= 6; count += 1) {
    const cards = [
      ['JS', 'QS', 'KS'], ['AH', '2H', 'KH'], ['AD', '2D', 'KD'],
      ['AC', '2C', 'KC'], ['3S', '4S', '5S'], ['3H', '4H', '5H'],
    ].slice(0, count);
    let state = fixture({ cards });
    play(state.round, state.players, 'JS', 0);
    assert.equal(state.round.turnPlayerId, 'b');
    state = fixture({ cards });
    play(state.round, state.players, 'QS', 0);
    assert.equal(state.round.direction, -1);
    assert.equal(state.round.turnPlayerId, state.players.at(-1));
  }
  for (const card of ['JS', 'QS']) {
    const { round, players } = fixture({
      cards: [[card, '2S', 'KS'], [], ['AD', '2D', 'KD'], []], eliminated: [1, 3],
    });
    play(round, players, card, 0);
    assert.equal(round.turnPlayerId, 'a');
    assert.equal(round.direction, card === 'QS' ? -1 : 1);
  }
  const { round, players } = fixture({
    cards: [['QS', 'JS', 'KS'], ['AH', '2H', 'KH']], direction: -1,
  });
  play(round, players, 'QS', 0);
  assert.equal(round.direction, 1);
  assert.equal(round.turnPlayerId, 'a');
  play(round, players, 'JS', 0);
  assert.equal(round.turnPlayerId, 'a');
});

test('direction skips eliminated seats in either direction and after reverse', () => {
  const cards = [['QS', '2S', 'KS'], [], ['AD', '2D', 'KD'],
    ['AC', '2C', 'KC'], []];
  for (const [direction, card, choice, expected] of [
    [1, '2S', 2, 'c'], [-1, '2S', 2, 'd'], [1, 'QS', 0, 'd'], [-1, 'QS', 0, 'c'],
  ]) {
    const { round, players } = fixture({ cards, eliminated: [1, 4], direction });
    play(round, players, card, choice);
    assert.equal(round.turnPlayerId, expected);
  }
});

test('voluntary bust discards entire hand, keeps table, no refill, finishes once', () => {
  for (const [card, choice] of [['AS', 11], ['10S', 10], ['8S', 8]]) {
    const { round, players } = fixture({
      cards: [[card, 'KS', '2S'], ['KH', '2H', '3H']], tableScore: 99,
    });
    const draw = [...round.drawPile];
    play(round, players, card, choice, 0);
    assert.equal(round.status, 'finished');
    assert.equal(round.winnerId, 'b');
    assert.equal(round.endedAt, 0);
    assert.equal(round.turnPlayerId, null);
    assert.equal(round.tableScore, 99);
    assert.equal(round.lastMove.scoreAfter, 99);
    assert.equal(round.lastMove.outcome, 'bust');
    assert.deepEqual(round.hands[0].cards, []);
    assert.deepEqual(round.drawPile, draw);
    assert.deepEqual(round.eliminatedIds, ['a']);
    const before = clone(round);
    error('GAME_FINISHED', () => play(round, players, 'KH', 99));
    assert.deepEqual(round, before);
  }
  const { round, players } = fixture({
    cards: [['AS', 'KS', '2S'], ['KH', '2H', '3H'], ['KD', '2D', '3D']], tableScore: 99,
  });
  play(round, players, 'AS', 11);
  assert.equal(round.turnPlayerId, 'b');
  assert.equal(round.status, 'playing');
});

test('automatic dead-hand chains preserve actor move and never eliminate final survivor', () => {
  for (const direction of [1, -1]) {
    const { round, players } = fixture({
      cards: [['KS', '2S', '3S'], ['2H', '3H', '4H'], ['2D', '3D', '4D'],
        ['2C', '3C', '4C']], tableScore: 100, direction,
    });
    play(round, players, 'KS', 99);
    assert.equal(round.tableScore, 99);
    assert.deepEqual(round.eliminatedIds, direction === 1 ? ['b', 'c', 'd'] : ['d', 'c', 'b']);
    assert.equal(round.winnerId, 'a');
    assert.equal(round.turnNumber, 2);
    assert.equal(round.lastMove.playerId, 'a');
    assert.equal(round.lastMove.outcome, 'played');
    assert.equal(round.discardPile.at(-1), 'KS');
    assert.equal(publicRound(round, 'a').discardTop, 'KS');
    validateRound(round, players);
  }
  const { round, players } = fixture({
    cards: [['AS', 'KS', '2S'], ['2H', '3H', '4H'], ['2D', '3D', '4D']], tableScore: 99,
  });
  play(round, players, 'AS', 11);
  assert.deepEqual(round.eliminatedIds, ['a', 'b']);
  assert.equal(round.winnerId, 'c');
  assert.equal(round.hands[2].cards.length, 3);
  assert.equal(round.lastMove.outcome, 'bust');
  assert.equal(round.discardPile.at(-1), 'AS');
});

test('dead-hand cards stay below the played top and recycle on the subsequent reshuffle', () => {
  const { round, players } = fixture({
    cards: [['KS', '2S', '3S'], ['2H', '3H', '4H'],
      ['2D', '3D', '4D'], ['KH', '2C', '3C']], tableScore: 100,
  });
  const lastDraw = round.drawPile.pop();
  round.discardPile.unshift(...round.drawPile);
  round.drawPile = [lastDraw];
  validateRound(round, players);

  play(round, players, 'KS', 99);
  assert.deepEqual(round.eliminatedIds, ['b', 'c']);
  assert.equal(round.status, 'playing');
  assert.equal(round.turnPlayerId, 'd');
  assert.equal(round.drawPile.length, 0);
  assert.equal(round.discardPile.at(-1), 'KS');
  assert.equal(publicRound(round, 'd').discardTop, 'KS');
  const eliminatedCards = ['2H', '3H', '4H', '2D', '3D', '4D'];
  assert.ok(eliminatedCards.every(card => round.discardPile.includes(card)));
  const recycled = [...round.discardPile];

  play(round, players, 'KH', 99);
  assert.deepEqual(round.discardPile, ['KH']);
  assert.equal(publicRound(round, 'a').discardTop, 'KH');
  assert.equal(round.lastMove.card, 'KH');
  assert.equal(round.drawPile.length, recycled.length - 1);
  assert.deepEqual(new Set([...round.drawPile, round.hands[3].cards.at(-1)]), new Set(recycled));
  validateRound(round, players);
});

test('repeating actor with dead refill is eliminated, and refill king saves next player', () => {
  const { round, players } = fixture({
    cards: [['JS', '2S', '3S'], ['KH', '2H', '3H']], tableScore: 100,
  });
  const index = round.drawPile.indexOf('4S');
  [round.drawPile[index], round.drawPile[round.drawPile.length - 1]]
    = [round.drawPile.at(-1), round.drawPile[index]];
  play(round, players, 'JS', 0);
  assert.equal(round.winnerId, 'b');
  assert.deepEqual(round.eliminatedIds, ['a']);
  assert.equal(round.lastMove.outcome, 'played');
  const state = fixture({
    cards: [['KS', '2S', '3S'], ['KH', '2H', '3H'], ['2D', '3D', '4D']], tableScore: 100,
  });
  play(state.round, state.players, 'KS', 99);
  assert.equal(state.round.turnPlayerId, 'b');
  assert.deepEqual(state.round.eliminatedIds, []);
});

test('reshuffle preserves new top, all 52 cards, and is transactional on bad random', () => {
  for (const random of [() => 0, undefined]) {
    const { round, players } = fixture({ emptyDraw: true });
    play(round, players, '2S', 2, 1, random);
    assert.deepEqual(round.discardPile, ['2S']);
    assert.equal(round.drawPile.length, 45);
    validateRound(round, players);
  }
  for (const random of [null, () => -1]) {
    const { round, players } = fixture({ emptyDraw: true });
    const before = clone(round);
    error('INVALID_RANDOM', () => play(round, players, '2S', 2, 1, random));
    assert.deepEqual(round, before);
  }
  const { round, players } = fixture({ emptyDraw: true, tableScore: 99 });
  play(round, players, '2S', 2, 1, null);
  assert.equal(round.status, 'finished');
});

test('public view exposes exactly sanitized fields, copies cards and last move', () => {
  const round = createRound(ids, () => 0);
  const initial = publicRound(round, 'a');
  assert.deepEqual(Object.keys(initial).sort(), ['version', 'status', 'tableScore', 'direction',
    'turnPlayerId', 'turnNumber', 'players', 'drawCount', 'discardTop', 'winnerId',
    'endedAt', 'lastMove', 'hand'].sort());
  assert.equal(initial.discardTop, null);
  assert.equal(initial.lastMove, null);
  assert.deepEqual(initial.hand, round.hands[0].cards);
  initial.hand.pop();
  assert.equal(round.hands[0].cards.length, 3);
  for (const viewer of [undefined, null, 'intruder']) {
    assert.deepEqual(publicRound(round, viewer).hand, []);
  }
  const state = fixture({ tableScore: 99 });
  play(state.round, state.players, '2S', 2);
  const view = publicRound(state.round, 'b');
  assert.equal(view.discardTop, '2S');
  assert.deepEqual(view.players, [
    { playerId: 'a', status: 'lost', cardCount: 0 },
    { playerId: 'b', status: 'active', cardCount: 3 },
  ]);
  view.lastMove.choice = 100;
  assert.equal(state.round.lastMove.choice, 2);
  assert.deepEqual(publicRound(state.round, 'a').hand, []);
});

test('commands: malformed, foreign, choice, stale, wrong turn, timestamp and overflow', () => {
  const { round, players } = fixture();
  const good = { playerId: 'a', card: '2S', choice: 2, turnNumber: 1 };
  const bad = [
    null, [], {}, { ...good, extra: true }, { ...good, playerId: 'z' },
    { ...good, card: 'junk' }, { ...good, turnNumber: -1 },
    { ...good, turnNumber: 0.5 }, { ...good, card: '2H' },
    { ...good, choice: '2' }, { ...good, choice: 1 },
  ];
  for (const command of bad) {
    const before = clone(round);
    error('INVALID_MOVE', () => playRound(round, players, command, 0));
    assert.deepEqual(round, before);
  }
  for (const now of [-1, NaN, Infinity, undefined, '0', 0.5]) {
    error('INVALID_MOVE', () => playRound(round, players, good, now));
  }
  error('STALE_TURN', () => playRound(round, players, { ...good, turnNumber: 0 }, 0));
  error('STALE_TURN', () => playRound(round, players, { ...good, turnNumber: 2 }, 0));
  error('NOT_YOUR_TURN', () => playRound(round, players, { ...good, playerId: 'b' }, 0));
  round.turnNumber = Number.MAX_SAFE_INTEGER;
  const before = clone(round);
  error('INVALID_MOVE', () => playRound(round, players,
    { ...good, turnNumber: round.turnNumber }, 0));
  assert.deepEqual(round, before);
  const state = fixture({
    cards: [['10S', 'KS', '2S'], ['KH', '2H', '3H']], tableScore: Number.MIN_SAFE_INTEGER,
  });
  error('INVALID_MOVE', () => play(state.round, state.players, '10S', -10));
  play(state.round, state.players, '2S', 2);
  assert.equal(state.round.tableScore, Number.MIN_SAFE_INTEGER + 2);
});

test('accepted moves reject replay and eliminated seats cannot take the next turn', () => {
  const { round, players } = fixture({
    cards: [['AS', 'KS', '2S'], ['KH', '2H', '3H'], ['KD', '2D', '3D']], tableScore: 99,
  });
  const command = { playerId: 'a', card: 'AS', choice: 11, turnNumber: round.turnNumber };
  playRound(round, players, command, 10);
  const before = clone(round);
  error('STALE_TURN', () => playRound(round, players, command, 11));
  error('NOT_YOUR_TURN', () => playRound(round, players,
    { ...command, turnNumber: round.turnNumber }, 11));
  assert.deepEqual(round, before);
  playRound(round, players, {
    playerId: 'b', card: 'KH', choice: 99, turnNumber: round.turnNumber,
  }, 11);
  assert.equal(round.turnPlayerId, 'c');
  assert.deepEqual(round.eliminatedIds, ['a']);
});

test('strict state validation rejects malformed state without writes', () => {
  const { round, players } = fixture();
  const corruptions = [
    () => null, () => [], () => 1, () => Object.create(null),
    r => { r.extra = true; }, r => { delete r.direction; },
    r => { r.version = 2; }, r => { r.status = 'waiting'; },
    r => { r.tableScore = 101; }, r => { r.direction = 0; },
    r => { r.turnNumber = -1; }, r => { r.hands = null; },
    r => { r.hands.pop(); }, r => { delete r.hands[0]; }, r => { r.drawPile = null; },
    r => { r.discardPile = null; }, r => { r.eliminatedIds = null; },
    r => { r.eliminatedIds = ['x']; }, r => { r.eliminatedIds = ['b', 'b']; },
    r => { r.eliminatedIds = Array(1); },
    r => { r.hands[0] = null; }, r => { r.hands[0].extra = true; },
    r => { r.hands[0].playerId = 'b'; }, r => { r.hands[0].cards = null; },
    r => { r.hands[0].cards.pop(); }, r => { r.eliminatedIds = ['a']; },
    r => { r.drawPile.pop(); }, r => { r.drawPile[0] = 'BAD'; },
    r => { r.drawPile[0] = r.drawPile[1]; },
    r => { r.winnerId = 'a'; }, r => { r.endedAt = 0; },
    r => { r.turnPlayerId = 'z'; }, r => { r.tableScore = 100;
      r.hands[0].cards = ['2S', '3S', '4S'];
      r.drawPile = deck.filter(c => !['2S', '3S', '4S', 'KH', '2H', '3H', '9S'].includes(c)); },
    r => { r.status = 'finished'; },
    r => { r.lastMove = null; }, r => { r.lastMove.extra = true; },
    r => { r.lastMove.playerId = 'z'; }, r => { r.lastMove.card = 'BAD'; },
    r => { r.lastMove.scoreBefore = 101; }, r => { r.lastMove.scoreAfter = 1; },
    r => { r.lastMove.outcome = 'bad'; }, r => { r.lastMove.choice = 1; },
    r => { [r.drawPile[0], r.discardPile[0]] = [r.discardPile[0], r.drawPile[0]]; },
    r => { r.discardPile.push(r.drawPile.pop()); },
    r => { r.lastMove.scoreBefore = 1; },
    r => { r.lastMove.outcome = 'bust'; },
    r => { r.lastMove.card = '2S'; r.lastMove.choice = 2; r.lastMove.scoreBefore = 100; },
  ];
  for (const mutate of corruptions) {
    const copy = clone(round);
    const replacement = mutate(copy);
    const value = replacement === undefined ? copy : replacement;
    error('CORRUPT_STATE', () => validateRound(value, players));
    error('CORRUPT_STATE', () => playRound(value, players, {}, 0));
  }
  for (const participants of [null, ['a'], ['b', 'a'], ['a', 'a']]) {
    error('CORRUPT_STATE', () => validateRound(round, participants));
  }
  for (const key of Object.keys(createRound(ids, () => 0))) {
    const initial = createRound(ids, () => 0);
    if (key === 'lastMove') initial[key] = round.lastMove;
    else if (key === 'tableScore') initial[key] = 1;
    else if (key === 'direction') initial[key] = -1;
    else if (key === 'turnPlayerId') initial[key] = 'b';
    else continue;
    error('CORRUPT_STATE', () => validateRound(initial, ids));
  }
});

test('finished and bust invariants, safe score, and initial-state invariants', () => {
  const state = fixture({ tableScore: 99 });
  play(state.round, state.players, '2S', 2);
  for (const mutate of [
    r => { r.winnerId = 'a'; }, r => { r.turnPlayerId = 'b'; },
    r => { r.endedAt = -1; }, r => { r.lastMove.scoreBefore = 98; },
    r => { r.lastMove.scoreBefore = 100; }, r => { r.lastMove.playerId = 'b'; },
    r => { r.status = 'playing'; },
  ]) {
    const copy = clone(state.round);
    mutate(copy);
    error('CORRUPT_STATE', () => validateRound(copy, state.players));
  }
  const initial = createRound(ids, () => 0);
  initial.status = 'finished';
  error('CORRUPT_STATE', () => validateRound(initial, ids));
  const discardedInitial = createRound(ids, () => 0);
  discardedInitial.discardPile.push(discardedInitial.drawPile.pop());
  error('CORRUPT_STATE', () => validateRound(discardedInitial, ids));
  const valid = fixture({ tableScore: 0 }).round;
  valid.lastMove = { playerId: 'a', card: '10S', choice: -10,
    scoreBefore: Number.MIN_SAFE_INTEGER, scoreAfter: 0, outcome: 'played' };
  const location = valid.drawPile.indexOf('10S');
  [valid.drawPile[location], valid.discardPile[0]] = [valid.discardPile[0], valid.drawPile[location]];
  error('CORRUPT_STATE', () => validateRound(valid, ids));
});

test('default play random and random failures preserve ownership and input identity', () => {
  const { round, players } = fixture({ emptyDraw: true });
  const command = { playerId: 'a', card: '2S', choice: 2, turnNumber: round.turnNumber };
  const commandBefore = clone(command);
  const playersBefore = [...players];
  const originalHand = round.hands[0].cards;
  const handBefore = [...originalHand];
  playRound(round, players, command, 1);
  validateRound(round, players);
  assert.deepEqual(command, commandBefore);
  assert.deepEqual(players, playersBefore);
  assert.deepEqual(originalHand, handBefore);

  const state = fixture({ emptyDraw: true });
  const before = clone(state.round);
  let calls = 0;
  error('INVALID_RANDOM', () => play(state.round, state.players, '2S', 2, 1,
    () => ++calls === 5 ? NaN : 0));
  assert.equal(calls, 5);
  assert.deepEqual(state.round, before);
});

test('full deterministic matches terminate, maintain invariants, reject all post-game writes', () => {
  function match(count, seed) {
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const players = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, count);
    const round = createRound(players, random);
    let moves = 0;
    while (round.status === 'playing') {
      const actor = round.hands.find(hand => hand.playerId === round.turnPlayerId);
      assert.equal(actor.cards.length, 3);
      const choices = actor.cards.flatMap(card => cardOptions(card, round.tableScore)
        .map(choice => ({ card, choice })));
      const selected = choices[Math.floor(random() * choices.length)];
      const oldCounter = round.turnNumber;
      play(round, players, selected.card, selected.choice, moves, random);
      assert.equal(round.turnNumber, oldCounter + 1);
      validateRound(round, players);
      moves += 1;
      assert.ok(moves < 10000);
    }
    assert.equal(round.eliminatedIds.length, count - 1);
    const before = clone(round);
    error('GAME_FINISHED', () => playRound(round, players, null, -1, null));
    assert.deepEqual(round, before);
    return round;
  }
  for (let count = 2; count <= 6; count += 1) {
    assert.deepEqual(match(count, 123), match(count, 123));
  }
});
