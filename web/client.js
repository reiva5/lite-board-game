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
      || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.phase !== 'lobby'
      || !Array.isArray(state.players) || state.players.length > 4
      || state.players.some(player => !validId(player.id) || typeof player.name !== 'string'
        || !player.name.trim() || player.name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(player.name)
        || player.ready !== false || !Number.isSafeInteger(player.lastSeenAt) || player.lastSeenAt < 0)
      || (action !== 'initialize' && (!validId(data.playerId) || data.left !== (action === 'leave')
        || (action !== 'leave' && !state.players.some(player => player.id === data.playerId))))) {
    throw new ClientError('INVALID_RESPONSE', 'Bentuk respons server tidak valid.');
  }
  // Return only the public contract, never persist unexpected provider fields.
  return {
    state: {
      schemaVersion: 1, serverId: state.serverId, revision: state.revision, phase: state.phase,
      players: state.players.map(({ id, name, ready, lastSeenAt }) => ({ id, name, ready, lastSeenAt })),
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
        || (session.pending && (!['join', 'leave'].includes(session.pending.action)
          || !validId(session.pending.requestId)
          || session.pending.secret !== session.secret || session.pending.spreadsheetUrl !== canonicalUrl
          || (session.pending.action === 'join' && typeof session.pending.name !== 'string')
          || (session.pending.action === 'leave' && (session.pending.serverId !== session.serverId
            || session.pending.playerId !== session.playerId || !session.playerId))))) {
      throw new ClientError('STORAGE_ERROR', 'Struktur sesi browser tidak valid.');
    }
    return session;
  }
  function save(session) {
    try { storage.setItem(key, JSON.stringify(session)); } catch {
      throw new ClientError('STORAGE_ERROR', 'Gagal menyimpan sesi browser. Pulihkan sesi sebelum mencoba perintah baru.');
    }
  }
  async function execute(session, command) {
    let result;
    try {
      result = validateResult(await send(command), command.action);
    } catch (error) {
      // These domain rejections guarantee that a join did not create a player.
      if (command.action === 'join' && error instanceof ClientError
          && ['INVALID_NAME', 'NAME_TAKEN', 'SERVER_FULL', 'NOT_INITIALIZED'].includes(error.code)) {
        try { storage.removeItem(key); } catch {
          throw new ClientError('STORAGE_ERROR', 'Pendaftaran ditolak, tetapi data percobaan gagal dibersihkan.');
        }
      }
      throw error;
    }
    if (command.action === 'leave') {
      try { storage.removeItem(key); } catch { throw new ClientError('STORAGE_ERROR', 'Keluar dikonfirmasi server, tetapi penyimpanan browser gagal dibersihkan. Ulangi pemulihan.'); }
    } else {
      save({ secret: session.secret, serverId: result.state.serverId, playerId: result.playerId });
    }
    return result;
  }
  return {
    initialize: () => exclusive(async () => validateResult(await send({
      action: 'initialize', requestId: random(), spreadsheetUrl: canonicalUrl,
    }), 'initialize')),
    join: name => exclusive(async () => {
      const current = load();
      if (current) throw new ClientError('SESSION_EXISTS', 'Pulihkan atau keluar dari sesi tersimpan sebelum bergabung lagi.');
      const session = { secret: random() };
      session.pending = { action: 'join', name, secret: session.secret, requestId: random(), spreadsheetUrl: canonicalUrl };
      save(session);
      return execute(session, session.pending);
    }),
    resume: () => exclusive(async () => {
      const session = load();
      if (!session) throw new ClientError('NO_SESSION', 'Tidak ada sesi tersimpan untuk spreadsheet dan endpoint ini.');
      return execute(session, session.pending ?? {
        action: 'resume', requestId: random(), spreadsheetUrl: canonicalUrl,
        secret: session.secret, serverId: session.serverId, playerId: session.playerId,
      });
    }),
    leave: () => exclusive(async () => {
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
    hasSession: () => load() !== null,
    lockKey: key,
  };
}
