import { mountRegistration } from './ui.js';
import { config } from './config.js';

try {
  mountRegistration(document, {
    storage: localStorage, config, locks: navigator.locks,
  });
} catch {
  const status = document.getElementById('status');
  status.setAttribute('role', 'alert');
  status.textContent = 'Penyimpanan browser tidak tersedia; aktifkan agar sesi dapat disimpan dengan aman.';
}
