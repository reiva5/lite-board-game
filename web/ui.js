import { createRegistrationClient, ClientError, endpointUrl, sheetId } from './client.js';

export function renderRoster(document, result) {
  const list = document.getElementById('players');
  list.replaceChildren();
  for (const player of result.state.players) {
    const item = document.createElement('li');
    item.textContent = `${player.name}${player.id === result.playerId && !result.left ? ' (Anda)' : ''} - ${player.ready ? 'Siap' : 'Belum siap'}`;
    list.append(item);
  }
  document.getElementById('roster').hidden = false;
  document.getElementById('server').textContent = `Server ${result.state.serverId} - ${result.state.players.length}/4 pemain (minimum 2)`;
  const game = result.state.phase === 'game';
  document.getElementById('game').hidden = !game;
  document.getElementById('lobby-help').hidden = game;
  document.getElementById('game-id').textContent = game ? `ID permainan: ${result.state.gameId}` : '';
  const participants = document.getElementById('participants');
  participants.replaceChildren();
  if (game) for (const id of result.state.participantIds) {
    const item = document.createElement('li');
    item.textContent = result.state.players.find(player => player.id === id).name;
    participants.append(item);
  }
}

export function mountRegistration(document, {
  storage, config, locks, send, random, events = document.defaultView,
  timers = globalThis,
}) {
  const get = id => document.getElementById(id);
  const buttons = ['initialize', 'join', 'resume', 'leave', 'ready', 'not-ready'];
  let busy = false, stopped = false, active = false, recovering = false, latest = null;
  let timer, failures = 0, refreshRequested = false, api, apiKey, apiSelection, generation = 0;
  let selectedKey = null, displayedKey = null;
  const selected = () => `${get('endpoint').value.trim()}\n${get('spreadsheet').value.trim()}`;
  const listeners = [];
  function listen(element, event, callback) {
    element?.addEventListener(event, callback);
    listeners.push(() => element?.removeEventListener?.(event, callback));
  }
  function cancelTimer() {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  }
  function showError(error) {
    get('status').setAttribute('role', 'alert');
    get('status').textContent = error instanceof ClientError
      ? `${error.code}: ${error.message}` : 'STORAGE_ERROR: Operasi browser gagal; sesi tidak dihapus. Periksa penyimpanan browser.';
  }
  function controls() {
    let saved = false, key = null, selectionError = false;
    try {
      const current = client();
      key = current.lockKey;
      saved = current.hasSession();
    } catch (error) {
      // Incomplete entry fields are normal; storage failures must stay visible.
      if (!(error instanceof ClientError)
          || !['NOT_CONFIGURED', 'INVALID_ENDPOINT', 'INVALID_URL'].includes(error.code)) {
        selectionError = true;
        showError(error);
      }
    }
    const confirmed = saved && active && !busy && key === displayedKey;
    const game = key === displayedKey && latest?.state.phase === 'game';
    if (key !== selectedKey && !busy && !selectionError) {
      get('status').setAttribute('role', 'status');
      get('status').textContent = saved && !confirmed
        ? 'Sesi tersimpan ditemukan. Pulihkan sesi untuk melanjutkan.'
        : 'Masukkan tautan spreadsheet dan nama untuk bergabung.';
    }
    selectedKey = key;
    get('registration-fields').hidden = saved || game;
    get('name').required = !saved && !game;
    get('session-recovery').hidden = !saved || confirmed;
    get('roster').hidden = key === null || displayedKey !== key;
    for (const id of ['leave', 'ready', 'not-ready']) get(id).hidden = !confirmed || game;
    for (const id of buttons) get(id).disabled = busy
      || (['ready', 'not-ready', 'leave'].includes(id) && (!confirmed || game))
      || (['initialize', 'join'].includes(id) && saved)
      || (id === 'join' && game);
    for (const id of ['endpoint', 'spreadsheet', 'name']) get(id).disabled = busy;
    const own = latest?.state.players.find(player => player.id === latest.playerId);
    if (own) {
      get('ready').disabled ||= own.ready;
      get('not-ready').disabled ||= !own.ready;
    }
  }
  try {
    get('endpoint').value = config.endpoint || storage.getItem('game100:endpoint') || '';
    get('spreadsheet').value = storage.getItem('game100:lastSpreadsheet') || '';
  } catch {
    get('status').textContent = 'Penyimpanan browser tidak tersedia; aktifkan untuk menjaga sesi.';
  }
  function client(remember = false) {
    const configuredEndpoint = get('endpoint').value.trim();
    if (!configuredEndpoint) throw new ClientError('NOT_CONFIGURED', 'Backend belum disiapkan. Hubungi pengelola server; pemain tidak perlu membuat endpoint sendiri.');
    const endpoint = endpointUrl(configuredEndpoint);
    const spreadsheetUrl = get('spreadsheet').value.trim();
    const spreadsheet = sheetId(spreadsheetUrl);
    if (remember) {
      try {
        storage.setItem('game100:endpoint', endpoint);
        storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
      } catch {
        throw new ClientError('STORAGE_ERROR', 'Penyimpanan browser gagal; periksa izin dan quota penyimpanan.');
      }
    }
    const key = `${endpoint}:${spreadsheet}`;
    if (!api || apiKey !== key) {
      apiKey = key;
      api = createRegistrationClient({
        endpoint, spreadsheetUrl, storage, send, random,
        exclusive: operation => {
          if (!locks?.request) throw new ClientError('BROWSER_UNSUPPORTED', 'Browser harus mendukung Web Locks pada HTTPS agar sesi antartab aman.');
          return locks.request(`game100:${endpoint}:${spreadsheet}`, operation);
        },
      });
    }
    return api;
  }
  function schedule(delay) {
    cancelTimer();
    if (stopped || (!active && !recovering)) return;
    timer = timers.setTimeout(() => { timer = undefined; void run('sync'); }, delay);
    timer?.unref?.();
  }
  async function run(action) {
    if (stopped) return;
    if (latest?.state.phase === 'game' && ['ready', 'not-ready', 'leave'].includes(action)) return;
    if (busy) {
      if (action === 'sync') refreshRequested = true;
      return;
    }
    cancelTimer();
    const selection = selected();
    const epoch = generation;
    if (apiKey && selection !== apiSelection) {
      latest = null; displayedKey = null; active = false; recovering = false;
    }
    busy = true;
    active = false;
    controls();
    get('status').setAttribute('role', 'status');
    get('status').textContent = 'Menghubungi server...';
    let current;
    try {
      current = client(true);
      apiSelection = selection;
      if (action === 'join' && current.hasSession()) action = 'resume';
      if (action === 'join' && latest?.state.phase === 'game') {
        throw new ClientError('GAME_STARTED', 'Permainan sudah dimulai. Hanya peserta dengan sesi tersimpan dapat memulihkan permainan.');
      }
      recovering = current.hasSession();
      const result = action === 'join' ? await current.join(get('name').value)
        : action === 'ready' || action === 'not-ready' ? await current.setReady(action === 'ready')
          : await current[action]();
      if (stopped || epoch !== generation || selection !== selected()) return;
      if (latest && result.state.serverId !== latest.state.serverId) {
        throw new ClientError('SERVER_CHANGED', 'Server berubah; pulihkan sesi sebelum melanjutkan.');
      }
      if (latest && result.state.revision < latest.state.revision) {
        throw new ClientError('STALE_RESPONSE', 'Respons lama diabaikan; sinkronisasi akan diulang.');
      }
      latest = result;
      displayedKey = current.lockKey;
      recovering = false;
      active = action !== 'initialize' && current.hasSession() && !result.left;
      failures = 0;
      renderRoster(document, result);
      get('status').textContent = action === 'initialize' ? 'Server dikonfirmasi. Anda belum terdaftar.'
        : result.left ? 'Keluar dikonfirmasi server.'
          : result.state.phase === 'game' ? 'Permainan dimulai oleh server dan sesi dikonfirmasi. Ini placeholder tersinkron; aturan kartu belum tersedia.'
            : 'Lobby tersinkron dan sesi dikonfirmasi. Permainan otomatis dimulai saat 2-4 pemain semuanya siap.';
    } catch (error) {
      if (stopped || epoch !== generation || selection !== selected()) return;
      failures++;
      try { recovering = current?.hasSession() ?? false; } catch (storageError) {
        recovering = false;
        error = storageError;
      }
      if (error.code === 'GAME_STARTED' && recovering) {
        failures = 0;
        refreshRequested = true;
      }
      if (['SESSION_ENDED', 'INVALID_SESSION', 'SERVER_CHANGED', 'NO_SESSION'].includes(error.code)) {
        recovering = false;
        latest = null;
        displayedKey = null;
      }
      showError(error);
      if (recovering) get('status').textContent += ' Data terakhir mungkin lama; pulihkan sesi atau tunggu sinkronisasi ulang.';
      if (['SESSION_ENDED', 'INVALID_SESSION', 'SERVER_CHANGED', 'NO_SESSION'].includes(error.code)) {
        get('status').textContent += ' Sesi tidak aktif. Silakan daftar lagi.';
      }
      if (error instanceof ClientError && error.code === 'NOT_INITIALIZED') {
        get('status').textContent += ' Minta pengelola menginisialisasi server melalui Penyiapan server.';
      }
    } finally {
      busy = false;
      if (!stopped) {
        controls();
        const immediate = refreshRequested && failures === 0;
        refreshRequested = false;
        schedule(immediate ? 0 : Math.min(60000, 10000 * 2 ** Math.min(failures, 3)));
      }
    }
  }
  listen(get('entry-form'), 'submit', event => {
    event.preventDefault();
    void run('join');
  });
  for (const action of buttons.filter(action => action !== 'join')) listen(get(action), 'click', () => run(action));
  function selectionChanged() {
    cancelTimer();
    generation++;
    failures = 0; refreshRequested = false;
    active = false; recovering = false; latest = null; displayedKey = null; api = null; apiKey = null;
    controls();
  }
  for (const id of ['endpoint', 'spreadsheet']) {
    listen(get(id), 'input', selectionChanged);
    listen(get(id), 'change', selectionChanged);
  }
  const refresh = () => { if ((active || recovering) && !stopped) void run('sync'); };
  listen(events, 'focus', refresh);
  listen(events, 'online', refresh);
  listen(events, 'offline', () => {
    if ((!active && !recovering) || stopped) return;
    get('status').setAttribute('role', 'alert');
    get('status').textContent = latest?.state.phase === 'game'
      ? 'OFFLINE: Browser tidak terhubung. Data mungkin lama; identitas dan peserta game tetap tersimpan.'
      : 'OFFLINE: Browser tidak terhubung. Data mungkin lama; sesi lobby dapat berakhir setelah 60 detik tanpa heartbeat.';
  });
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  controls();
  if (get('endpoint').value && get('spreadsheet').value) {
    try { if (client().hasSession()) void run('resume'); } catch (error) { showError(error); }
  }
  return {
    run,
    unmount() {
      stopped = true;
      active = false;
      recovering = false;
      cancelTimer();
      for (const remove of listeners) remove();
    },
  };
}
