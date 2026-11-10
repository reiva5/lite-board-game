const ROUND_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ROUND_DECK = ROUND_RANKS.flatMap(rank => ['S', 'H', 'D', 'C'].map(suit => `${rank}${suit}`));
const ROUND_CARDS = new Set(ROUND_DECK);
const ROUND_KEYS = ['version', 'status', 'tableScore', 'direction', 'turnPlayerId', 'turnNumber',
  'hands', 'drawPile', 'discardPile', 'eliminatedIds', 'winnerId', 'endedAt', 'lastMove'];
const ROUND_MOVE_KEYS = ['playerId', 'card', 'choice', 'scoreBefore', 'scoreAfter', 'outcome'];

export class RoundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundError';
    this.code = code;
  }
}

function roundRequire(condition, code, message) {
  if (!condition) throw new RoundError(code, message);
}

function roundKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function roundParticipants(ids) {
  return Array.isArray(ids) && ids.length >= 2 && ids.length <= 6
    && Array.from(ids).every(id => typeof id === 'string' && id.trim().length > 0)
    && new Set(ids).size === ids.length;
}

function roundScore(value) {
  return Number.isSafeInteger(value) && value <= 100;
}

function roundCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function cardOptions(card, tableScore) {
  roundRequire(ROUND_CARDS.has(card) && roundScore(tableScore), 'INVALID_MOVE', 'Kartu atau skor tidak valid.');
  const rank = card.slice(0, -1);
  if (rank === 'A') return [1, 11];
  if (rank === '10') return [10, -10];
  if (rank === 'K') return [99];
  if (['9', 'J', 'Q'].includes(rank)) return [0];
  return [Number(rank)];
}

function roundResult(card, choice, tableScore) {
  return card.startsWith('K') ? 99 : tableScore + choice;
}

function roundLegal(hand, tableScore) {
  return hand.cards.some(card => cardOptions(card, tableScore)
    .some(choice => roundScore(roundResult(card, choice, tableScore))));
}

export function validateRound(round, participantIds) {
  const check = condition => roundRequire(condition, 'CORRUPT_STATE', 'State ronde rusak.');
  check(roundParticipants(participantIds));
  check(roundKeys(round, ROUND_KEYS));
  check(round.version === 1 && ['playing', 'finished'].includes(round.status));
  check(roundScore(round.tableScore) && [1, -1].includes(round.direction) && roundCounter(round.turnNumber));
  check(Array.isArray(round.hands) && round.hands.length === participantIds.length);
  check(Array.isArray(round.drawPile) && Array.isArray(round.discardPile)
    && Array.isArray(round.eliminatedIds));
  check(new Set(round.eliminatedIds).size === round.eliminatedIds.length
    && Array.from(round.eliminatedIds).every(id => participantIds.includes(id)));
  const allCards = [...round.drawPile, ...round.discardPile];
  Array.from(round.hands).forEach((hand, index) => {
    check(roundKeys(hand, ['playerId', 'cards']));
    check(hand.playerId === participantIds[index] && Array.isArray(hand.cards));
    check(hand.cards.length === (round.eliminatedIds.includes(hand.playerId) ? 0 : 3));
    allCards.push(...hand.cards);
  });
  check(allCards.length === 52 && allCards.every(card => ROUND_CARDS.has(card))
    && new Set(allCards).size === 52);
  const active = round.hands.filter(hand => !round.eliminatedIds.includes(hand.playerId));
  if (round.status === 'playing') {
    check(active.length >= 2 && round.winnerId === null && round.endedAt === null);
    const turn = active.find(hand => hand.playerId === round.turnPlayerId);
    check(turn !== undefined);
    check(roundLegal(turn, round.tableScore));
  } else {
    check(active.length === 1 && round.winnerId === active[0].playerId
      && round.turnPlayerId === null && roundCounter(round.endedAt));
  }
  if (round.turnNumber === 0) {
    check(round.lastMove === null && round.status === 'playing' && round.tableScore === 0
      && round.direction === 1 && round.turnPlayerId === participantIds[0]
      && round.discardPile.length === 0 && round.eliminatedIds.length === 0);
  } else {
    const move = round.lastMove;
    check(roundKeys(move, ROUND_MOVE_KEYS));
    check(participantIds.includes(move.playerId) && ROUND_CARDS.has(move.card)
      && roundScore(move.scoreBefore) && move.scoreAfter === round.tableScore
      && ['played', 'bust'].includes(move.outcome));
    check(cardOptions(move.card, move.scoreBefore).includes(move.choice));
    check(round.discardPile.includes(move.card));
    const computed = roundResult(move.card, move.choice, move.scoreBefore);
    if (move.outcome === 'bust') {
      check(computed > 100 && move.scoreAfter === move.scoreBefore
        && round.eliminatedIds.includes(move.playerId));
    } else {
      check(roundScore(computed) && move.scoreAfter === computed);
    }
  }
  return round;
}

function roundShuffle(cards, random) {
  roundRequire(typeof random === 'function', 'INVALID_RANDOM', 'Sumber acak tidak valid.');
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const value = random();
    roundRequire(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1,
      'INVALID_RANDOM', 'Nilai acak tidak valid.');
    const other = Math.floor(value * (index + 1));
    [cards[index], cards[other]] = [cards[other], cards[index]];
  }
  return cards;
}

export function createRound(participantIds, random = Math.random) {
  roundRequire(roundParticipants(participantIds), 'INVALID_MOVE', 'Peserta tidak valid.');
  const drawPile = roundShuffle([...ROUND_DECK], random);
  const hands = participantIds.map(playerId => ({
    playerId, cards: [drawPile.pop(), drawPile.pop(), drawPile.pop()],
  }));
  return {
    version: 1, status: 'playing', tableScore: 0, direction: 1,
    turnPlayerId: participantIds[0], turnNumber: 0, hands, drawPile, discardPile: [],
    eliminatedIds: [], winnerId: null, endedAt: null, lastMove: null,
  };
}

export function publicRound(round, viewerId) {
  return {
    version: round.version, status: round.status, tableScore: round.tableScore,
    direction: round.direction, turnPlayerId: round.turnPlayerId, turnNumber: round.turnNumber,
    players: round.hands.map(hand => ({
      playerId: hand.playerId,
      status: round.eliminatedIds.includes(hand.playerId) ? 'lost' : 'active',
      cardCount: hand.cards.length,
    })),
    drawCount: round.drawPile.length,
    discardTop: round.discardPile.at(-1) ?? null,
    winnerId: round.winnerId, endedAt: round.endedAt,
    lastMove: round.lastMove === null ? null : { ...round.lastMove },
    hand: [...(round.hands.find(hand => hand.playerId === viewerId)?.cards ?? [])],
  };
}

export function playRound(round, participantIds, command, now, random = Math.random) {
  validateRound(round, participantIds);
  roundRequire(round.status === 'playing', 'GAME_FINISHED', 'Ronde sudah selesai.');
  roundRequire(roundKeys(command, ['playerId', 'card', 'choice', 'turnNumber'])
    && participantIds.includes(command.playerId) && ROUND_CARDS.has(command.card)
    && roundCounter(command.turnNumber) && roundCounter(now), 'INVALID_MOVE', 'Perintah tidak valid.');
  roundRequire(command.turnNumber === round.turnNumber, 'STALE_TURN', 'Giliran sudah berubah.');
  roundRequire(command.playerId === round.turnPlayerId, 'NOT_YOUR_TURN', 'Bukan giliran Anda.');
  roundRequire(round.turnNumber < Number.MAX_SAFE_INTEGER, 'INVALID_MOVE', 'Nomor giliran penuh.');
  const actor = round.hands.find(hand => hand.playerId === command.playerId);
  roundRequire(actor.cards.includes(command.card)
    && cardOptions(command.card, round.tableScore).includes(command.choice),
  'INVALID_MOVE', 'Kartu atau pilihan tidak valid.');
  const nextScore = roundResult(command.card, command.choice, round.tableScore);
  roundRequire(Number.isSafeInteger(nextScore), 'INVALID_MOVE', 'Skor di luar batas aman.');

  // Commit only after every operation, including a possible reshuffle, succeeds.
  const next = {
    ...round,
    hands: round.hands.map(item => ({ playerId: item.playerId, cards: [...item.cards] })),
    drawPile: [...round.drawPile],
    discardPile: [...round.discardPile],
    eliminatedIds: [...round.eliminatedIds],
  };
  const hand = next.hands.find(item => item.playerId === command.playerId);
  const eliminate = target => {
    next.eliminatedIds.push(target.playerId);
    next.discardPile.push(...target.cards);
    target.cards = [];
  };
  hand.cards.splice(hand.cards.indexOf(command.card), 1);
  const bust = nextScore > 100;
  if (bust) eliminate(hand);
  next.discardPile.push(command.card);
  if (!bust) {
    next.tableScore = nextScore;
    if (command.card.startsWith('Q')) next.direction *= -1;
    if (next.drawPile.length === 0) {
      const top = next.discardPile.pop();
      next.drawPile = roundShuffle(next.discardPile, random);
      next.discardPile = [top];
    }
    hand.cards.push(next.drawPile.pop());
  }
  next.turnNumber += 1;
  next.lastMove = {
    playerId: command.playerId, card: command.card, choice: command.choice,
    scoreBefore: round.tableScore, scoreAfter: next.tableScore, outcome: bust ? 'bust' : 'played',
  };
  const activeCount = () => next.hands.length - next.eliminatedIds.length;
  let seat = next.hands.indexOf(hand);
  const repeat = !bust && activeCount() === 2 && ['J', 'Q'].includes(command.card.slice(0, -1));
  if (!repeat) seat = (seat + next.direction + next.hands.length) % next.hands.length;
  while (activeCount() > 1) {
    const candidate = next.hands[seat];
    if (!next.eliminatedIds.includes(candidate.playerId)) {
      if (roundLegal(candidate, next.tableScore)) {
        next.turnPlayerId = candidate.playerId;
        break;
      }
      eliminate(candidate);
    }
    seat = (seat + next.direction + next.hands.length) % next.hands.length;
  }
  if (activeCount() === 1) {
    next.status = 'finished';
    next.turnPlayerId = null;
    next.winnerId = next.hands.find(item => !next.eliminatedIds.includes(item.playerId)).playerId;
    next.endedAt = now;
  }
  validateRound(next, participantIds);
  Object.assign(round, next);
  return round;
}
