function doPost(event) {
  const handle = createHandler({
    getLock: () => LockService.getScriptLock(),
    open: id => SpreadsheetApp.openById(id),
    flush: () => SpreadsheetApp.flush(),
    hash: text => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
      .map(byte => (byte & 255).toString(16).padStart(2, '0')).join(''),
    uuid: () => Utilities.getUuid(),
    now: () => Date.now(),
    log: message => console.error(message),
  });
  return ContentService.createTextOutput(JSON.stringify(handle(event?.postData?.contents)))
    .setMimeType(ContentService.MimeType.JSON);
}
