export class ClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function endpointUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value) || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)) {
    throw new ClientError('INVALID_ENDPOINT', 'Isi endpoint publik Apps Script /exec yang valid.');
  }
  return value;
}

export function sheetId(value) {
  const match = typeof value === 'string' && value.length <= 2048 && !/\s/.test(value)
    && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,128})(?:\/(?:edit|view|preview|copy))?\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/.exec(value);
  if (!match) throw new ClientError('INVALID_URL', 'Gunakan tautan Google Sheets kanonis /spreadsheets/d/ID/edit.');
  return match[1];
}

const validId = value => typeof value === 'string' && !/\s/.test(value) && /^[A-Za-z0-9_-]{16,128}$/.test(value);

export function validateResult(data, action) {
  const state = data?.state;
  if (!state || state.schemaVersion !== 1 || !validId(state.serverId)
      || !Number.isSafeInteger(state.revision) || state.revision < 0 || !['lobby', 'game'].includes(state.phase)
      || !Array.isArray(state.players) || state.players.length > 6
      || state.players.some(player => !player || typeof player !== 'object'
        || !validId(player.id) || typeof player.name !== 'string'
        || !player.name.trim() || player.name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(player.name)
        || typeof player.ready !== 'boolean' || !Number.isSafeInteger(player.lastSeenAt) || player.lastSeenAt < 0
        || (player.readyVersion !== undefined && (!Number.isSafeInteger(player.readyVersion) || player.readyVersion < 0)))
      || new Set(state.players.map(player => player.id)).size !== state.players.length
      || (state.phase === 'game' ? (!validId(state.gameId)
        || !Number.isSafeInteger(state.startedAt) || state.startedAt < 0
        || state.players.length < 2 || !state.players.every(player => player.ready)
        || !Array.isArray(state.participantIds) || state.participantIds.length !== state.players.length
        || state.participantIds.some((value, index) => value !== state.players[index].id))
        : ['gameId', 'participantIds', 'startedAt', 'round'].some(key => Object.hasOwn(state, key)))
      || (action !== 'initialize' && (!validId(data.playerId) || data.left !== (action === 'leave')
        || (action !== 'leave' && !state.players.some(player => player.id === data.playerId))))) {
    throw new ClientError('INVALID_RESPONSE', 'Bentuk respons server tidak valid.');
  }
  let round;
  if (state.round !== undefined) {
    try { round = roundSnapshot(state.round, state.participantIds, action === 'initialize' ? undefined : data.playerId); }
    catch { throw new ClientError('INVALID_RESPONSE', 'Snapshot ronde server tidak valid.'); }
  }
  // Return only the public contract, never persist unexpected provider fields.
  return {
    state: {
      schemaVersion: 1, serverId: state.serverId, revision: state.revision, phase: state.phase,
      players: state.players.map(({ id, name, ready, lastSeenAt, readyVersion = 0 }) => ({ id, name, ready, lastSeenAt, readyVersion })),
      ...(state.phase === 'game' ? {
        gameId: state.gameId, participantIds: [...state.participantIds], startedAt: state.startedAt,
        ...(round === undefined ? {} : { round }),
      } : {}),
    },
    ...(action === 'initialize' ? {} : { playerId: data.playerId, left: data.left }),
  };
}

export async function postCommand(endpoint, command, fetcher = globalThis.fetch, timeout = 20000) {
  endpointUrl(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST', body: JSON.stringify(command), mode: 'cors',
        credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: controller.signal,
      });
    } catch {
      throw new ClientError('NETWORK_ERROR', 'Jaringan, CORS, atau batas waktu gagal. Hasil perintah belum pasti; pulihkan/ulangi sesi.');
    }
    if (!response.ok || response.type === 'opaque') {
      throw new ClientError('HTTP_ERROR', `Google merespons HTTP ${response.status}; periksa deployment dan izin akses anonim.`);
    }
    let envelope;
    try { envelope = JSON.parse(await response.text()); } catch {
      throw new ClientError('INVALID_RESPONSE', 'Respons bukan JSON; periksa endpoint /exec dan halaman login Google.');
    }
    if (envelope?.ok === false && typeof envelope.error?.code === 'string' && typeof envelope.error?.message === 'string') {
      throw new ClientError(envelope.error.code, envelope.error.message);
    }
    if (envelope?.ok !== true) throw new ClientError('INVALID_RESPONSE', 'Envelope respons tidak valid.');
    return validateResult(envelope.data, command.action);
  } finally {
    clearTimeout(timer);
  }
}

export function randomHex(crypto = globalThis.crypto) {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createRegistrationClient({
  endpoint, spreadsheetUrl, storage, send = command => postCommand(endpoint, command),
  random = randomHex, exclusive = operation => operation(),
}) {
  endpointUrl(endpoint);
  const spreadsheet = sheetId(spreadsheetUrl);
  const key = `game100:v1:${endpoint}:${spreadsheet}`;
  const canonicalUrl = `https://docs.google.com/spreadsheets/d/${spreadsheet}/edit`;
  let tail = Promise.resolve();
  const serial = operation => {
    const result = tail.then(() => exclusive(operation));
    tail = result.catch(() => {});
    return result;
  };
  function load() {
    let raw;
    try { raw = storage.getItem(key); } catch { throw new ClientError('STORAGE_ERROR', 'Penyimpanan browser tidak tersedia; sesi tidak dapat diamankan.'); }
    if (raw === null) return null;
    let session;
    try { session = JSON.parse(raw); } catch { throw new ClientError('STORAGE_ERROR', 'Data sesi browser rusak; jangan hapus sebelum memastikan sesi server.'); }
    if (!session || typeof session.secret !== 'string' || session.secret.length !== 64 || !/^[a-f0-9]{64}$/.test(session.secret)
        || (session.serverId !== undefined && !validId(session.serverId))
        || (session.playerId !== undefined && !validId(session.playerId))
        || (!session.pending && (!session.serverId || !session.playerId))
        || (session.readyVersion !== undefined && (!Number.isSafeInteger(session.readyVersion) || session.readyVersion < 0))
        || (session.revision !== undefined && (!Number.isSafeInteger(session.revision) || session.revision < 0))
        || (session.turnNumber !== undefined && (!Number.isSafeInteger(session.turnNumber) || session.turnNumber < 0))
        || (session.gameId !== undefined && !validId(session.gameId))
        || (session.pending && (!['join', 'leave', 'setReady', 'playCard'].includes(session.pending.action)
          || !validId(session.pending.requestId)
          || session.pending.secret !== session.secret || session.pending.spreadsheetUrl !== canonicalUrl
          || (session.pending.action === 'join' && typeof session.pending.name !== 'string')
          || (session.pending.action !== 'join' && (session.pending.serverId !== session.serverId
            || session.pending.playerId !== session.playerId || !session.playerId))
          || (session.pending.action === 'setReady' && (typeof session.pending.ready !== 'boolean'
            || !Number.isSafeInteger(session.pending.readyVersion) || session.pending.readyVersion < 1))
          || (session.pending.action === 'playCard' && (!validId(session.pending.gameId)
            || !Number.isSafeInteger(session.pending.turnNumber) || session.pending.turnNumber < 0
            || typeof session.pending.card !== 'string' || !/^(A|[2-9]|10|J|Q|K)[SHDC]$/.test(session.pending.card)
            || !Number.isSafeInteger(session.pending.choice)))))) {
      throw new ClientError('STORAGE_ERROR', 'Struktur sesi browser tidak valid.');
    }
    return session;
  }
  function save(session) {
    try { storage.setItem(key, JSON.stringify(session)); } catch {
      throw new ClientError('STORAGE_ERROR', 'Gagal menyimpan sesi browser. Pulihkan sesi sebelum mencoba perintah baru.');
    }
  }
  function unchanged(session) {
    const current = load();
    return current?.secret === session.secret && current.serverId === session.serverId
      && current.playerId === session.playerId && current.revision === session.revision
      && current.pending?.requestId === session.pending?.requestId;
  }
  async function execute(session, command) {
    let result;
    try {
      result = validateResult(await send(command), command.action);
      if ((command.serverId && result.state.serverId !== command.serverId)
          || (session.playerId && result.playerId !== session.playerId)) {
        throw new ClientError('INVALID_RESPONSE', 'Identitas respons tidak cocok dengan sesi; perintah tetap tertunda.');
      }
      if (session.revision !== undefined && result.state.revision < session.revision) {
        throw new ClientError('STALE_RESPONSE', 'Respons revisi lama diabaikan; ulangi sinkronisasi.');
      }
    } catch (error) {
      if (error instanceof ClientError && (error.code === 'GAME_STARTED'
          || (command.action === 'playCard' && ['GAME_CHANGED', 'GAME_UPGRADE_REQUIRED', 'GAME_NOT_STARTED',
            'NOT_YOUR_TURN', 'STALE_TURN', 'GAME_FINISHED', 'INVALID_MOVE'].includes(error.code)))
          && unchanged(session)) {
        if (session.playerId) {
          // A terminal lobby command rejection is not an invalidated game identity.
          const { pending, ...identity } = session;
          save(identity);
        } else if (command.action === 'join') {
          try { storage.removeItem(key); } catch {
            throw new ClientError('STORAGE_ERROR', 'Pendaftaran ditolak, tetapi perintah tertunda gagal dibersihkan.');
          }
        }
      }
      // Only definitive rejections invalidate identity; ambiguous writes stay pending.
      if (error instanceof ClientError && ((command.action === 'join'
          && ['INVALID_NAME', 'NAME_TAKEN', 'SERVER_FULL', 'NOT_INITIALIZED'].includes(error.code))
          || ['SESSION_ENDED', 'INVALID_SESSION', 'SERVER_CHANGED'].includes(error.code))
          && unchanged(session)) {
        try { storage.removeItem(key); } catch {
          throw new ClientError('STORAGE_ERROR', 'Sesi ditolak, tetapi data browser gagal dibersihkan. Pulihkan sesi sebelum mendaftar lagi.');
        }
      }
      throw error;
    }
    if (!unchanged(session)) {
      throw new ClientError('STALE_RESPONSE', 'Sesi browser berubah; respons lama diabaikan.');
    }
    if (command.action === 'leave') {
      try { storage.removeItem(key); } catch { throw new ClientError('STORAGE_ERROR', 'Keluar dikonfirmasi server, tetapi penyimpanan browser gagal dibersihkan. Ulangi pemulihan.'); }
    } else {
      save({ secret: session.secret, serverId: result.state.serverId, playerId: result.playerId,
        revision: result.state.revision,
        ...(result.state.round === undefined ? {} : {
          gameId: result.state.gameId, turnNumber: result.state.round.turnNumber,
        }),
        readyVersion: result.state.players.find(player => player.id === result.playerId).readyVersion });
    }
    return result;
  }
  return {
    initialize: () => serial(async () => validateResult(await send({
      action: 'initialize', requestId: random(), spreadsheetUrl: canonicalUrl,
    }), 'initialize')),
    join: name => serial(async () => {
      const current = load();
      if (current) throw new ClientError('SESSION_EXISTS', 'Pulihkan atau keluar dari sesi tersimpan sebelum bergabung lagi.');
      const session = { secret: random() };
      session.pending = { action: 'join', name, secret: session.secret, requestId: random(), spreadsheetUrl: canonicalUrl };
      save(session);
      return execute(session, session.pending);
    }),
    resume: () => serial(async () => {
      const session = load();
      if (!session) throw new ClientError('NO_SESSION', 'Tidak ada sesi tersimpan untuk spreadsheet dan endpoint ini.');
      return execute(session, session.pending ?? {
        action: 'resume', requestId: random(), spreadsheetUrl: canonicalUrl,
        secret: session.secret, serverId: session.serverId, playerId: session.playerId,
      });
    }),
    sync: () => serial(async () => {
      const session = load();
      if (!session) throw new ClientError('NO_SESSION', 'Sesi telah berakhir. Silakan daftar lagi.');
      return execute(session, session.pending ?? {
        action: 'sync', requestId: random(), spreadsheetUrl: canonicalUrl,
        secret: session.secret, serverId: session.serverId, playerId: session.playerId,
      });
    }),
    setReady: ready => serial(async () => {
      if (typeof ready !== 'boolean') throw new ClientError('INVALID_REQUEST', 'Ready harus boolean.');
      const session = load();
      if (!session) throw new ClientError('NO_SESSION', 'Tidak ada sesi tersimpan.');
      if (session.pending) throw new ClientError('PENDING_COMMAND', 'Pulihkan perintah tertunda sebelum mengubah ready.');
      session.pending = {
        action: 'setReady', ready, readyVersion: (session.readyVersion ?? 0) + 1,
        requestId: random(), spreadsheetUrl: canonicalUrl,
        secret: session.secret, serverId: session.serverId, playerId: session.playerId,
      };
      save(session);
      return execute(session, session.pending);
    }),
    leave: () => serial(async () => {
      const session = load();
      if (!session) throw new ClientError('NO_SESSION', 'Tidak ada sesi tersimpan.');
      if (session.pending) throw new ClientError('PENDING_COMMAND', 'Pulihkan perintah tertunda sebelum keluar.');
      session.pending = {
        action: 'leave', requestId: random(), spreadsheetUrl: canonicalUrl,
        secret: session.secret, serverId: session.serverId, playerId: session.playerId,
      };
      save(session);
      return execute(session, session.pending);
    }),
    playCard: (card, choice, expected) => serial(async () => {
      if (typeof card !== 'string' || !/^(A|[2-9]|10|J|Q|K)[SHDC]$/.test(card)
          || !Number.isSafeInteger(choice)) throw new ClientError('INVALID_MOVE', 'Kartu atau pilihan nilai tidak valid.');
      const session = load();
      if (!session) throw new ClientError('NO_SESSION', 'Tidak ada sesi tersimpan.');
      if (session.pending) throw new ClientError('PENDING_COMMAND', 'Pulihkan perintah tertunda sebelum memainkan kartu.');
      if (session.gameId === undefined || session.turnNumber === undefined) {
        throw new ClientError('GAME_NOT_STARTED', 'Sinkronkan ronde sebelum memainkan kartu.');
      }
      if (expected !== undefined && (!expected || expected.gameId !== session.gameId
          || expected.turnNumber !== session.turnNumber)) {
        throw new ClientError('STALE_TURN', 'Tampilan giliran sudah lama; sinkronkan sebelum memainkan kartu.');
      }
      session.pending = {
        action: 'playCard', card, choice, gameId: session.gameId, turnNumber: session.turnNumber,
        requestId: random(), spreadsheetUrl: canonicalUrl,
        secret: session.secret, serverId: session.serverId, playerId: session.playerId,
      };
      save(session);
      return execute(session, session.pending);
    }),
    hasSession: () => load() !== null,
    lockKey: key,
  };
}
import { roundSnapshot } from './game.js';
