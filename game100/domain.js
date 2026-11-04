export const MAX_PAYLOAD = 48000;
export const MAX_RETRIES = 32;

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new GameError(code, message);
}

export function spreadsheetId(url) {
  requireValue(typeof url === 'string' && url.length <= 2048 && !/\s/.test(url), 'INVALID_URL', 'Tautan spreadsheet tidak valid.');
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,128})(?:\/(?:edit|view|preview|copy))?\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/.exec(url);
  requireValue(match, 'INVALID_URL', 'Gunakan tautan https://docs.google.com/spreadsheets/d/ID/edit.');
  return match[1];
}

export function normalizeName(value) {
  requireValue(typeof value === 'string', 'INVALID_NAME', 'Nama wajib diisi.');
  const name = value.normalize('NFC').trim();
  requireValue(name.length > 0 && name.length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(value),
    'INVALID_NAME', 'Nama harus 1-40 karakter tanpa karakter kontrol.');
  return { name, nameKey: name.toLowerCase() };
}

function keys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

const id = value => typeof value === 'string' && !/\s/.test(value) && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const stateKeys = ['schemaVersion', 'serverId', 'revision', 'phase', 'players', 'retries'];
const playerKeys = ['id', 'name', 'nameKey', 'secretDigest', 'ready', 'lastSeenAt'];
const retryKeys = ['requestId', 'action', 'secretDigest', 'fingerprint', 'playerId'];

export function validateState(state) {
  const corrupt = () => { throw new GameError('CORRUPT_STATE', 'Game100State rusak atau versi tidak didukung; tidak ditimpa.'); };
  if (!keys(state, stateKeys) || state.schemaVersion !== 1 || !id(state.serverId)
      || !integer(state.revision) || state.phase !== 'lobby'
      || !Array.isArray(state.players) || state.players.length > 4
      || !Array.isArray(state.retries) || state.retries.length > MAX_RETRIES) corrupt();
  const names = new Set(), ids = new Set(), secrets = new Set(), requests = new Set();
  for (const player of state.players) {
    if (!keys(player, playerKeys) || !id(player.id) || !digest(player.secretDigest)
        || player.ready !== false || !integer(player.lastSeenAt)) corrupt();
    let normalized;
    try { normalized = normalizeName(player.name); } catch { corrupt(); }
    if (normalized.name !== player.name || normalized.nameKey !== player.nameKey
        || names.has(player.nameKey) || ids.has(player.id) || secrets.has(player.secretDigest)) corrupt();
    names.add(player.nameKey); ids.add(player.id); secrets.add(player.secretDigest);
  }
  for (const retry of state.retries) {
    if (!keys(retry, retryKeys) || !id(retry.requestId) || !id(retry.playerId)
        || !['join', 'leave'].includes(retry.action) || !digest(retry.secretDigest)
        || !digest(retry.fingerprint) || requests.has(retry.requestId)) corrupt();
    requests.add(retry.requestId);
    const active = state.players.find(player => player.id === retry.playerId);
    if (active && (active.secretDigest !== retry.secretDigest || retry.action === 'leave')) corrupt();
  }
  requireValue(JSON.stringify(state).length <= MAX_PAYLOAD, 'PAYLOAD_LIMIT', 'State melebihi batas sel.');
  return state;
}

export function decodeState(text) {
  if (text === '') return null;
  requireValue(typeof text === 'string' && text.length <= MAX_PAYLOAD, 'CORRUPT_STATE', 'Game100State bukan JSON yang didukung.');
  let state;
  try { state = JSON.parse(text); } catch { throw new GameError('CORRUPT_STATE', 'Game100State berisi JSON rusak.'); }
  return validateState(state);
}

export function publicState(state) {
  return {
    schemaVersion: state.schemaVersion, serverId: state.serverId,
    revision: state.revision, phase: state.phase,
    players: state.players.map(({ id, name, ready, lastSeenAt }) => ({ id, name, ready, lastSeenAt })),
  };
}

// Called only inside the runtime's script lock. Dependencies are synchronous.
export function applyCommand(previous, command, { hash, uuid, now }) {
  requireValue(command && typeof command === 'object' && !Array.isArray(command), 'INVALID_REQUEST', 'Perintah tidak valid.');
  const { action, requestId } = command;
  requireValue(['initialize', 'join', 'resume', 'leave'].includes(action) && id(requestId),
    'INVALID_REQUEST', 'Aksi atau requestId tidak valid.');
  const allowed = ['action', 'requestId', 'spreadsheetUrl', 'secret', 'name', 'serverId', 'playerId'];
  requireValue(Object.keys(command).every(key => allowed.includes(key)), 'INVALID_REQUEST', 'Field perintah tidak dikenal.');
  let state = previous === null ? null : validateState(JSON.parse(JSON.stringify(previous)));
  if (action === 'initialize') {
    if (state) return { state, changed: false, result: { state: publicState(state) } };
    state = { schemaVersion: 1, serverId: uuid(), revision: 0, phase: 'lobby', players: [], retries: [] };
    validateState(state);
    return { state, changed: true, result: { state: publicState(state) } };
  }
  requireValue(state, 'NOT_INITIALIZED', 'Server belum diinisialisasi.');
  requireValue(command.serverId === undefined || command.serverId === state.serverId,
    'SERVER_CHANGED', 'Identitas server berubah.');
  requireValue(digest(command.secret),
    'INVALID_SESSION', 'Kredensial sesi tidak valid.');
  const secretDigest = hash(command.secret);
  const normalized = action === 'join' ? normalizeName(command.name) : null;
  const fingerprint = hash(JSON.stringify([action, normalized?.name ?? null, command.playerId ?? null, command.serverId ?? null]));
  const retry = state.retries.find(item => item.requestId === requestId);
  if (retry) {
    requireValue(retry.secretDigest === secretDigest && retry.fingerprint === fingerprint,
      'REQUEST_CONFLICT', 'requestId sudah dipakai untuk perintah lain.');
    requireValue(action === 'leave' || state.players.some(player => player.id === retry.playerId),
      'SESSION_ENDED', 'Sesi telah berakhir.');
    return { state, changed: false, result: { state: publicState(state), playerId: retry.playerId, left: action === 'leave' } };
  }
  let player = state.players.find(item => item.secretDigest === secretDigest);
  if (action === 'join') {
    if (player) {
      requireValue(player.nameKey === normalized.nameKey, 'SESSION_EXISTS', 'Sesi ini sudah memakai nama lain.');
      return { state, changed: false, result: { state: publicState(state), playerId: player.id, left: false } };
    }
    requireValue(!state.players.some(item => item.nameKey === normalized.nameKey), 'NAME_TAKEN', 'Nama sudah dipakai di server ini.');
    requireValue(state.players.length < 4, 'SERVER_FULL', 'Server penuh (maksimal 4 pemain).');
    player = { id: uuid(), ...normalized, secretDigest, ready: false, lastSeenAt: now() };
    state.players.push(player);
  } else {
    requireValue(command.serverId === state.serverId && player && player.id === command.playerId,
      'INVALID_SESSION', 'Sesi tidak ditemukan atau kredensial salah.');
    if (action === 'resume') return { state, changed: false, result: { state: publicState(state), playerId: player.id, left: false } };
    state.players = state.players.filter(item => item.id !== player.id);
  }
  requireValue(state.revision < Number.MAX_SAFE_INTEGER, 'REVISION_LIMIT', 'Batas revisi tercapai.');
  state.revision++;
  state.retries.push({ requestId, action, secretDigest, fingerprint, playerId: player.id });
  state.retries = state.retries.slice(-MAX_RETRIES);
  validateState(state);
  return { state, changed: true, result: { state: publicState(state), playerId: player.id, left: action === 'leave' } };
}
