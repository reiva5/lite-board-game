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
  try {
    get('endpoint').value = config.endpoint || storage.getItem('game100:endpoint') || '';
    get('spreadsheet').value = storage.getItem('game100:lastSpreadsheet') || '';
  } catch {
    get('status').textContent = 'Penyimpanan browser tidak tersedia; aktifkan untuk menjaga sesi.';
  }
  function client() {
    const endpoint = endpointUrl(get('endpoint').value.trim());
    const spreadsheetUrl = get('spreadsheet').value.trim();
    const spreadsheet = sheetId(spreadsheetUrl);
    if (!locks?.request) throw new ClientError('BROWSER_UNSUPPORTED', 'Browser harus mendukung Web Locks pada HTTPS agar sesi antartab aman.');
    storage.setItem('game100:endpoint', endpoint);
    storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
    return createRegistrationClient({
      endpoint, spreadsheetUrl, storage, send, random,
      exclusive: operation => locks.request(`game100:${endpoint}:${spreadsheet}`, operation),
    });
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    for (const id of buttons) get(id).disabled = true;
    get('endpoint').disabled = true;
    get('spreadsheet').disabled = true;
    get('name').disabled = true;
    get('roster').hidden = true;
    get('status').setAttribute('role', 'status');
    get('status').textContent = 'Menghubungi server...';
    try {
      const api = client();
      const result = action === 'join' ? await api.join(get('name').value) : await api[action]();
      renderRoster(document, result);
      get('status').textContent = action === 'initialize' ? 'Server dikonfirmasi. Anda belum terdaftar.'
        : result.left ? 'Keluar dikonfirmasi server.' : 'Registrasi/sesi dikonfirmasi server. Belum ada permainan pada tahap ini.';
    } catch (error) {
      get('status').setAttribute('role', 'alert');
      get('status').textContent = error instanceof ClientError
        ? `${error.code}: ${error.message}` : 'STORAGE_ERROR: Operasi browser gagal; sesi tidak dihapus. Periksa penyimpanan browser.';
    } finally {
      busy = false;
      for (const id of buttons) get(id).disabled = false;
      for (const id of ['endpoint', 'spreadsheet', 'name']) get(id).disabled = false;
    }
  }
  for (const action of buttons) get(action).addEventListener('click', () => run(action));
  // A refresh restores the selected server, never creates a fresh identity.
  if (get('endpoint').value && get('spreadsheet').value) {
    try { if (client().hasSession()) void run('resume'); } catch (error) {
      get('status').textContent = error instanceof ClientError ? error.message : 'Penyimpanan browser gagal dibaca.';
    }
  }
  return { run };
}
