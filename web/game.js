const cardPattern = /^(A|[2-9]|10|J|Q|K)[SHDC]$/;
const isCard = value => typeof value === 'string' && cardPattern.test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export function choicesForCard(card) {
  const rank = card.slice(0, -1);
  if (rank === 'A') return [1, 11];
  if (rank === '10') return [10, -10];
  if (['9', 'J', 'Q'].includes(rank)) return [0];
  return [Number(rank === 'K' ? 99 : rank)];
}

export function roundSnapshot(round, participantIds, viewerId) {
  const invalid = () => { throw new Error('Snapshot ronde tidak valid.'); };
  if (!round || round.version !== 1 || !['playing', 'finished'].includes(round.status)
      || !Number.isSafeInteger(round.tableScore) || round.tableScore > 100
      || ![1, -1].includes(round.direction) || !nonnegative(round.turnNumber)
      || !Array.isArray(round.players) || round.players.length !== participantIds.length
      || round.players.some((player, index) => !player || player.playerId !== participantIds[index]
        || !['active', 'lost'].includes(player.status)
        || player.cardCount !== (player.status === 'active' ? 3 : 0))
      || !nonnegative(round.drawCount) || round.drawCount > 52
      || !(round.discardTop === null || isCard(round.discardTop))
      || !Array.isArray(round.hand) || !round.hand.every(isCard)
      || new Set(round.hand).size !== round.hand.length) invalid();
  const active = round.players.filter(player => player.status === 'active');
  const own = round.players.find(player => player.playerId === viewerId);
  if (round.hand.length !== (own ? own.cardCount : 0)
      || round.drawCount + round.players.reduce((sum, player) => sum + player.cardCount, 0) > 52
      || (round.status === 'playing'
        ? active.length < 2 || !active.some(player => player.playerId === round.turnPlayerId)
          || round.winnerId !== null || round.endedAt !== null
        : active.length !== 1 || round.winnerId !== active[0].playerId
          || round.turnPlayerId !== null || !nonnegative(round.endedAt))) invalid();
  const move = round.lastMove;
  if (round.turnNumber === 0 ? move !== null : !move
      || !participantIds.includes(move.playerId) || !isCard(move.card)
      || !choicesForCard(move.card).includes(move.choice)
      || !Number.isSafeInteger(move.scoreBefore) || move.scoreBefore > 100
      || !Number.isSafeInteger(move.scoreAfter) || move.scoreAfter !== round.tableScore
      || !['played', 'bust'].includes(move.outcome)) invalid();
  return {
    version: 1, status: round.status, tableScore: round.tableScore, direction: round.direction,
    turnPlayerId: round.turnPlayerId, turnNumber: round.turnNumber,
    players: round.players.map(({ playerId, status, cardCount }) => ({ playerId, status, cardCount })),
    drawCount: round.drawCount, discardTop: round.discardTop, hand: [...round.hand],
    winnerId: round.winnerId, endedAt: round.endedAt,
    lastMove: move === null ? null : {
      playerId: move.playerId, card: move.card, choice: move.choice,
      scoreBefore: move.scoreBefore, scoreAfter: move.scoreAfter, outcome: move.outcome,
    },
  };
}

export function renderRound(document, result, canPlay, play) {
  const get = id => document.getElementById(id);
  const round = result.state.round;
  get('round').hidden = !round;
  get('legacy-game').hidden = Boolean(round);
  get('hand').replaceChildren();
  if (!round) return;
  const name = id => result.state.players.find(player => player.id === id).name;
  get('table-score').textContent = `Skor meja: ${round.tableScore}`;
  get('direction').textContent = round.direction === 1 ? 'Arah: searah jarum jam' : 'Arah: berlawanan jarum jam';
  get('draw-count').textContent = `Sisa draw: ${round.drawCount}`;
  get('last-card').textContent = round.discardTop === null ? 'Belum ada kartu dimainkan.' : `Discard teratas: ${round.discardTop}`;
  get('turn').textContent = round.status === 'finished'
    ? `Permainan selesai. Pemenang: ${name(round.winnerId)}.`
    : `Giliran: ${name(round.turnPlayerId)}.`;
  get('round-result').textContent = round.players.find(player => player.playerId === result.playerId)?.status === 'lost'
    ? 'Anda kalah dan tetap dapat menyaksikan hasil permainan.' : '';
  get('last-move').textContent = round.lastMove === null ? ''
    : `${name(round.lastMove.playerId)} memainkan ${round.lastMove.card}; skor ${round.lastMove.scoreAfter}${round.lastMove.outcome === 'bust' ? ' (kalah: melewati 100)' : ''}.`;
  for (const card of round.hand) {
    const item = document.createElement('li');
    for (const choice of choicesForCard(card)) {
      const button = document.createElement('button');
      const score = card.startsWith('K') ? 99 : round.tableScore + choice;
      button.textContent = `${card}: ${card.startsWith('K') ? 'set 99' : choice >= 0 ? `+${choice}` : choice} -> ${score}${score > 100 ? ' (kalah)' : ''}`;
      button.disabled = !canPlay || round.status !== 'playing' || round.turnPlayerId !== result.playerId;
      button.addEventListener('click', () => { if (!button.disabled) play(card, choice); });
      item.append(button);
    }
    get('hand').append(item);
  }
}
