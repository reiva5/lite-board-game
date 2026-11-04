import { createRegistrationClient, ClientError, endpointUrl, sheetId } from './client.js';

export function renderRoster(document, result) {
  const list = document.getElementById('players');
  list.replaceChildren();
  for (const player of result.state.players) {
    const item = document.createElement('li');
    item.textContent = `${player.name}${player.id === result.playerId && !result.left ? ' (Anda)' : ''}`;
    list.append(item);
  }
  document.getElementById('roster').hidden = false;
  document.getElementById('server').textContent = `Server ${result.state.serverId} - ${result.state.players.length}/4 pemain`;
}

export function mountRegistration(document, { storage, config, locks, send, random }) {
  const get = id => document.getElementById(id);
  const buttons = ['initialize', 'join', 'resume', 'leave'];
  let busy = false;
  let confirmedKey = null;
  let displayedKey = null;
  let selectedKey = null;
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
      storage.setItem('game100:endpoint', endpoint);
      storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
    }
    return createRegistrationClient({
      endpoint, spreadsheetUrl, storage, send, random,
      exclusive: operation => {
        if (!locks?.request) throw new ClientError('BROWSER_UNSUPPORTED', 'Browser harus mendukung Web Locks pada HTTPS agar sesi antartab aman.');
        return locks.request(`game100:${endpoint}:${spreadsheet}`, operation);
      },
    });
  }
  function showError(error) {
    get('status').setAttribute('role', 'alert');
    get('status').textContent = error instanceof ClientError
      ? `${error.code}: ${error.message}` : 'STORAGE_ERROR: Operasi browser gagal; sesi tidak dihapus. Periksa penyimpanan browser.';
  }
  function syncControls() {
    let saved = false, key = null, selectionError = false;
    try {
      const api = client();
      key = api.lockKey;
      saved = api.hasSession();
    } catch (error) {
      // Incomplete fields are normal while choosing a server; corrupt storage is not.
      if (!(error instanceof ClientError)
          || !['NOT_CONFIGURED', 'INVALID_ENDPOINT', 'INVALID_URL'].includes(error.code)) {
        selectionError = true;
        showError(error);
      }
    }
    const confirmed = saved && key !== null && confirmedKey === key;
    if (key !== selectedKey && !busy && !selectionError) {
      get('status').setAttribute('role', 'status');
      get('status').textContent = saved && !confirmed
        ? 'Sesi tersimpan ditemukan. Pulihkan sesi untuk melanjutkan.'
        : 'Masukkan tautan spreadsheet dan nama untuk bergabung.';
    }
    selectedKey = key;
    get('registration-fields').hidden = saved;
    get('name').required = !saved;
    get('session-recovery').hidden = !saved || confirmed;
    get('leave').hidden = !confirmed;
    get('roster').hidden = key === null || displayedKey !== key;
    for (const id of buttons) get(id).disabled = busy;
    for (const id of ['endpoint', 'spreadsheet', 'name']) get(id).disabled = busy;
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    confirmedKey = null;
    displayedKey = null;
    syncControls();
    get('status').setAttribute('role', 'status');
    get('status').textContent = 'Menghubungi server...';
    try {
      const api = client(true);
      if (action === 'join' && api.hasSession()) action = 'resume';
      const result = action === 'join' ? await api.join(get('name').value) : await api[action]();
      renderRoster(document, result);
      displayedKey = api.lockKey;
      if (result.playerId && !result.left) confirmedKey = api.lockKey;
      get('status').textContent = action === 'initialize' ? 'Server dikonfirmasi. Anda belum terdaftar.'
        : result.left ? 'Keluar dikonfirmasi server.' : 'Registrasi/sesi dikonfirmasi server. Belum ada permainan pada tahap ini.';
    } catch (error) {
      showError(error);
      if (error instanceof ClientError && error.code === 'NOT_INITIALIZED') {
        get('status').textContent += ' Minta pengelola menginisialisasi server melalui Penyiapan server.';
      }
    } finally {
      busy = false;
      syncControls();
    }
  }
  get('entry-form').addEventListener('submit', event => {
    event.preventDefault();
    void run('join');
  });
  for (const action of buttons.filter(action => action !== 'join')) {
    get(action).addEventListener('click', () => run(action));
  }
  for (const id of ['spreadsheet', 'endpoint']) {
    get(id).addEventListener('input', syncControls);
    get(id).addEventListener('change', syncControls);
  }
  syncControls();
  // A refresh restores the selected server, never creates a fresh identity.
  if (get('endpoint').value && get('spreadsheet').value) {
    try { if (client().hasSession()) void run('resume'); } catch (error) {
      get('status').textContent = error instanceof ClientError ? error.message : 'Penyimpanan browser gagal dibaca.';
    }
  }
  return { run };
}
