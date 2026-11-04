export const MAX_PAYLOAD = 48000;
export const MAX_RETRIES = 32;
export const LOBBY_TIMEOUT = 60000;

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
    if (!(keys(player, playerKeys) || keys(player, [...playerKeys, 'readyVersion']))
        || !id(player.id) || !digest(player.secretDigest)
        || typeof player.ready !== 'boolean' || !integer(player.lastSeenAt)
        || (player.readyVersion !== undefined && !integer(player.readyVersion))) corrupt();
    let normalized;
    try { normalized = normalizeName(player.name); } catch { corrupt(); }
    if (normalized.name !== player.name || normalized.nameKey !== player.nameKey
        || names.has(player.nameKey) || ids.has(player.id) || secrets.has(player.secretDigest)) corrupt();
    names.add(player.nameKey); ids.add(player.id); secrets.add(player.secretDigest);
  }
  for (const retry of state.retries) {
    if (!keys(retry, retryKeys) || !id(retry.requestId) || !id(retry.playerId)
        || !['join', 'leave', 'setReady'].includes(retry.action) || !digest(retry.secretDigest)
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
    players: state.players.map(({ id, name, ready, lastSeenAt, readyVersion = 0 }) => ({ id, name, ready, lastSeenAt, readyVersion })),
  };
}

// Called only inside the runtime's script lock. Dependencies are synchronous.
export function applyCommand(previous, command, { hash, uuid, now }) {
  requireValue(command && typeof command === 'object' && !Array.isArray(command), 'INVALID_REQUEST', 'Perintah tidak valid.');
  const { action, requestId } = command;
  requireValue(['initialize', 'join', 'resume', 'leave', 'sync', 'setReady'].includes(action) && id(requestId),
    'INVALID_REQUEST', 'Aksi atau requestId tidak valid.');
  const allowed = ['action', 'requestId', 'spreadsheetUrl', 'secret', 'name', 'serverId', 'playerId', 'ready', 'readyVersion'];
  requireValue(Object.keys(command).every(key => allowed.includes(key)), 'INVALID_REQUEST', 'Field perintah tidak dikenal.');
  requireValue(action === 'setReady'
    ? typeof command.ready === 'boolean' && integer(command.readyVersion) && command.readyVersion > 0
    : command.ready === undefined && command.readyVersion === undefined,
  'INVALID_REQUEST', 'Ready harus boolean dengan versi keputusan positif.');
  let state = previous === null ? null : validateState(JSON.parse(JSON.stringify(previous)));
  if (action === 'initialize' && !state) {
    state = { schemaVersion: 1, serverId: uuid(), revision: 0, phase: 'lobby', players: [], retries: [] };
    validateState(state);
    return { state, changed: true, result: { state: publicState(state) } };
  }
  requireValue(state, 'NOT_INITIALIZED', 'Server belum diinisialisasi.');
  const timestamp = now();
  requireValue(integer(timestamp), 'INVALID_TIME', 'Waktu server tidak valid.');
  let changed = false;
  function finish(result, error) {
    if (changed) {
      requireValue(state.revision < Number.MAX_SAFE_INTEGER, 'REVISION_LIMIT', 'Batas revisi tercapai.');
      state.revision++;
    }
    validateState(state);
    return { state, changed, ...(error ? { error } : { result: { ...result, state: publicState(state) } }) };
  }
  function cleanup() {
    // Future phases must opt in explicitly; lobby expiry never applies to a game.
    if (state.phase !== 'lobby') return;
    const remaining = state.players.filter(player => timestamp - player.lastSeenAt < LOBBY_TIMEOUT);
    if (remaining.length === state.players.length) return;
    state.players = remaining;
    for (const player of remaining) {
      requireValue((player.readyVersion ?? 0) < Number.MAX_SAFE_INTEGER, 'REVISION_LIMIT', 'Batas keputusan ready tercapai.');
      player.ready = false;
      player.readyVersion = (player.readyVersion ?? 0) + 1;
    }
    changed = true;
  }
  if (action === 'initialize') {
    cleanup();
    return finish({});
  }
  requireValue(command.serverId === undefined || command.serverId === state.serverId,
    'SERVER_CHANGED', 'Identitas server berubah.');
  requireValue(digest(command.secret),
    'INVALID_SESSION', 'Kredensial sesi tidak valid.');
  const secretDigest = hash(command.secret);
  const normalized = action === 'join' ? normalizeName(command.name) : null;
  const fingerprint = hash(JSON.stringify([action, normalized?.name ?? null, command.playerId ?? null,
    command.serverId ?? null, ...(action === 'setReady' ? [command.ready, command.readyVersion] : [])]));
  const retry = state.retries.find(item => item.requestId === requestId);
  if (retry) {
    requireValue(retry.secretDigest === secretDigest && retry.fingerprint === fingerprint,
      'REQUEST_CONFLICT', 'requestId sudah dipakai untuk perintah lain.');
  }
  let player = state.players.find(item => item.secretDigest === secretDigest);
  if (action !== 'join' && !(retry && action === 'leave')) {
    requireValue(command.serverId === state.serverId && player && player.id === command.playerId,
      'INVALID_SESSION', 'Sesi tidak ditemukan atau kredensial salah.');
  }
  cleanup();
  try {
    if (retry) {
      requireValue(action === 'leave' || state.players.some(item => item.id === retry.playerId),
        'SESSION_ENDED', 'Sesi berakhir setelah 60 detik tanpa heartbeat. Silakan daftar lagi.');
      return finish({ playerId: retry.playerId, left: action === 'leave' });
    }
    requireValue(!player || state.players.includes(player), 'SESSION_ENDED',
      'Sesi berakhir setelah 60 detik tanpa heartbeat. Silakan daftar lagi.');
    if (action === 'join') {
      if (player) {
        requireValue(player.nameKey === normalized.nameKey, 'SESSION_EXISTS', 'Sesi ini sudah memakai nama lain.');
        return finish({ playerId: player.id, left: false });
      }
      requireValue(!state.players.some(item => item.nameKey === normalized.nameKey), 'NAME_TAKEN', 'Nama sudah dipakai di server ini.');
      requireValue(state.players.length < 4, 'SERVER_FULL', 'Server penuh (maksimal 4 pemain).');
      player = { id: uuid(), ...normalized, secretDigest, ready: false, readyVersion: 0, lastSeenAt: timestamp };
      state.players.push(player);
      changed = true;
    } else {
      if (action === 'leave') {
        state.players = state.players.filter(item => item.id !== player.id);
        changed = true;
      } else {
        if (action === 'setReady') {
          const version = player.readyVersion ?? 0;
          requireValue(command.readyVersion <= version + 1, 'INVALID_REQUEST', 'Versi ready harus berurutan; sinkronkan sesi.');
          if (command.readyVersion > version) {
            player.ready = command.ready;
            player.readyVersion = command.readyVersion;
            changed = true;
          }
        }
        if (timestamp > player.lastSeenAt) { player.lastSeenAt = timestamp; changed = true; }
        if (action !== 'setReady') return finish({ playerId: player.id, left: false });
      }
    }
    state.retries.push({ requestId, action, secretDigest, fingerprint, playerId: player.id });
    state.retries = state.retries.slice(-MAX_RETRIES);
    changed = true;
    return finish({ playerId: player.id, left: action === 'leave' });
  } catch (error) {
    // Cleanup must survive a valid request whose player expired or join was rejected.
    if (!(error instanceof GameError) || !changed) throw error;
    return finish(null, { code: error.code, message: error.message });
  }
}
