import { applyCommand, decodeState, spreadsheetId, GameError } from '../game100/domain.js';

export function createHandler(services) {
  return function handle(text) {
    try {
      if (typeof text !== 'string' || text.length > 4096) throw new GameError('INVALID_REQUEST', 'Payload terlalu besar.');
      let command;
      try { command = JSON.parse(text); } catch { throw new GameError('INVALID_REQUEST', 'JSON permintaan tidak valid.'); }
      const sheetId = spreadsheetId(command?.spreadsheetUrl);
      const lock = services.getLock();
      if (!lock.tryLock(5000)) throw new GameError('BUSY', 'Server sibuk; ulangi perintah yang sama.');
      try {
        const book = services.open(sheetId);
        let sheet = book.getSheetByName('Game100State');
        const range = sheet?.getRange('A1');
        if (range?.getFormula()) throw new GameError('CORRUPT_STATE', 'Game100State A1 berisi formula; tidak ditimpa.');
        const previous = decodeState(range ? range.getValue() : '');
        const outcome = applyCommand(previous, command, services);
        if (outcome.changed) {
          if (!sheet) sheet = book.insertSheet('Game100State');
          sheet.getRange('A1').setValue(JSON.stringify(outcome.state));
        }
        return { ok: true, data: outcome.result };
      } finally {
        // Flush even on a failed write: the provider may have buffered a mutation.
        try { services.flush(); } finally { lock.releaseLock(); }
      }
    } catch (error) {
      if (error instanceof GameError) return { ok: false, error: { code: error.code, message: error.message } };
      // Provider exceptions may contain spreadsheet content or account identifiers.
      services.log('Game100 provider operation failed');
      return { ok: false, error: { code: 'PROVIDER_ERROR', message: 'Akses, quota, atau operasi Google gagal. Periksa izin akun game lalu ulangi perintah yang sama.' } };
    }
  };
}
