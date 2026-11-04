import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { applyCommand } from '../game100/domain.js';
import {
  ClientError, createRegistrationClient, postCommand, endpointUrl, randomHex, validateResult,
} from '../web/client.js';
import { mountRegistration, renderRoster } from '../web/ui.js';
import { config } from '../web/config.js';

const endpoint = 'https://script.google.com/macros/s/test_deployment/exec';
const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
let counter = 0;
const random = () => createHash('sha256').update(String(++counter)).digest('hex');
function memory() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function server() {
  const deps = { hash: text => createHash('sha256').update(text).digest('hex'), uuid: random, now: () => 10 };
  let state = null, calls = [];
  return {
    calls,
    send: async command => {
      calls.push(command);
      try {
        const outcome = applyCommand(state, command, deps); state = outcome.state; return outcome.result;
      } catch (error) { throw new ClientError(error.code, error.message); }
    },
  };
}
async function fixture() {
  const provider = server(), storage = memory();
  const options = { endpoint, spreadsheetUrl, storage, send: provider.send, random };
  const client = createRegistrationClient(options);
  await client.initialize();
  return { provider, storage, options, client };
}
const code = expected => error => error.code === expected;

test('transport uses simple text POST, follows redirects, no secrets in URL or headers', async () => {
  const f = await fixture();
  const data = await f.client.join('A');
  const request = f.provider.calls.at(-1);
  const result = await postCommand(endpoint, request, async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.mode, 'cors');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined);
    assert.deepEqual(JSON.parse(options.body), request);
    return new Response(JSON.stringify({ ok: true, data }));
  });
  assert.deepEqual(result, data);
});

test('transport reports network/CORS, HTTP, HTML, invalid envelope and application errors distinctly', async () => {
  const command = { action: 'initialize' };
  const cases = [
    [async () => { throw TypeError('fetch'); }, 'NETWORK_ERROR'],
    [async () => new Response('denied', { status: 403 }), 'HTTP_ERROR'],
    [async () => new Response('<html>login</html>'), 'INVALID_RESPONSE'],
    [async () => ({ ok: false, status: 0, type: 'opaque' }), 'HTTP_ERROR'],
    [async () => new Response('{"ok":true,"data":{}}'), 'INVALID_RESPONSE'],
    [async () => new Response('{"unexpected":true}'), 'INVALID_RESPONSE'],
    [async () => new Response('{"ok":false,"error":{"code":"BUSY","message":"busy"}}'), 'BUSY'],
  ];
  for (const [fetcher, expected] of cases) await assert.rejects(postCommand(endpoint, command, fetcher), code(expected));
  await assert.rejects(postCommand(endpoint, command, (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Error('aborted')));
  }), 1), code('NETWORK_ERROR'));
  for (const value of ['https://evil.example/exec', `${endpoint}?secret=x`, endpoint + '\n', endpoint.replace('/exec', '/dev')]) {
    assert.throws(() => endpointUrl(value), code('INVALID_ENDPOINT'));
  }
});

test('secret and pending request persist BEFORE join; reload retries exact request after lost response', async () => {
  const f = await fixture();
  let first = true;
  const send = async command => {
    const saved = JSON.parse(f.storage.getItem(f.client.lockKey));
    assert.equal(saved.secret, command.secret);
    assert.deepEqual(saved.pending, command);
    const result = await f.provider.send(command);
    if (first) { first = false; throw new ClientError('NETWORK_ERROR', 'lost'); }
    return result;
  };
  const client = createRegistrationClient({ ...f.options, send });
  await assert.rejects(client.join('A'), code('NETWORK_ERROR'));
  const request = f.provider.calls.at(-1);
  await assert.rejects(client.join('B'), code('SESSION_EXISTS'));
  const refreshed = createRegistrationClient({ ...f.options, send });
  const recovered = await refreshed.resume();
  assert.deepEqual(f.provider.calls.at(-1), request);
  assert.equal(recovered.state.players.length, 1);
  assert.equal(JSON.parse(f.storage.getItem(client.lockKey)).pending, undefined);
  const resumed = await createRegistrationClient(f.options).resume();
  assert.equal(resumed.playerId, recovered.playerId);
});

test('explicit rejected join can be corrected; ambiguous failures retain pending command', async () => {
  const f = await fixture();
  await assert.rejects(f.client.join(''), code('INVALID_NAME'));
  assert.equal(f.client.hasSession(), false);
  await f.client.join('A');
  const secondStorage = memory();
  const second = createRegistrationClient({ ...f.options, storage: secondStorage });
  await assert.rejects(second.join('a'), code('NAME_TAKEN'));
  assert.equal(second.hasSession(), false);
  assert.equal((await second.join('B')).state.players.length, 2);
});

test('leave response loss is retried and storage removed only after server confirms', async () => {
  const f = await fixture();
  await f.client.join('A');
  let lost = true;
  const send = async command => {
    const result = await f.provider.send(command);
    if (command.action === 'leave' && lost) { lost = false; throw new ClientError('NETWORK_ERROR', 'lost'); }
    return result;
  };
  const client = createRegistrationClient({ ...f.options, send });
  await assert.rejects(client.leave(), code('NETWORK_ERROR'));
  assert.equal(client.hasSession(), true);
  const result = await createRegistrationClient({ ...f.options, send }).resume();
  assert.equal(result.left, true);
  assert.equal(result.state.players.length, 0);
  assert.equal(client.hasSession(), false);
});

test('sessions isolated by canonical spreadsheet ID and endpoint; malformed storage fails closed', async () => {
  const f = await fixture();
  await f.client.join('A');
  const same = createRegistrationClient({ ...f.options, spreadsheetUrl: spreadsheetUrl + '?usp=sharing#gid=1' });
  assert.equal(same.hasSession(), true);
  const other = createRegistrationClient({ ...f.options, spreadsheetUrl: spreadsheetUrl.replace('s'.repeat(30), 't'.repeat(30)) });
  assert.equal(other.hasSession(), false);
  assert.equal(createRegistrationClient({ ...f.options, endpoint: endpoint.replace('test_deployment', 'other') }).hasSession(), false);
  for (const raw of ['{', '{}', '{"secret":null}']) {
    f.storage.setItem(f.client.lockKey, raw);
    assert.throws(() => f.client.hasSession(), code('STORAGE_ERROR'));
  }
});

test('storage quota prevents orphan writes; failure after join remains recoverable', async () => {
  const f = await fixture();
  const failing = { ...f.storage, setItem() { throw Error('quota'); } };
  await assert.rejects(createRegistrationClient({ ...f.options, storage: failing }).join('A'), code('STORAGE_ERROR'));
  assert.equal(f.provider.calls.length, 1);
  let writes = 0;
  const after = { ...f.storage, setItem(key, value) { if (++writes === 2) throw Error('quota'); f.storage.setItem(key, value); } };
  await assert.rejects(createRegistrationClient({ ...f.options, storage: after }).join('A'), code('STORAGE_ERROR'));
  assert.equal((await f.client.resume()).state.players.length, 1);
});

test('missing sessions and unresolved joins cannot resume or leave as another identity', async () => {
  const f = await fixture();
  await assert.rejects(f.client.resume(), code('NO_SESSION'));
  await assert.rejects(f.client.leave(), code('NO_SESSION'));
  const offline = createRegistrationClient({
    ...f.options, send: async () => { throw new ClientError('NETWORK_ERROR', 'offline'); },
  });
  await assert.rejects(offline.join('A'), code('NETWORK_ERROR'));
  const saved = f.storage.getItem(offline.lockKey);
  await assert.rejects(offline.leave(), code('PENDING_COMMAND'));
  assert.equal(f.storage.getItem(offline.lockKey), saved);
  assert.equal(f.provider.calls.length, 1);
});

test('unreadable storage and cleanup failures are explicit and preserve retry records', async () => {
  const f = await fixture();
  const unreadable = createRegistrationClient({
    ...f.options, storage: { getItem() { throw Error('unavailable'); } },
  });
  assert.throws(() => unreadable.hasSession(), code('STORAGE_ERROR'));
  await assert.rejects(unreadable.join('A'), code('STORAGE_ERROR'));
  assert.equal(f.provider.calls.length, 1);

  const storage = { ...f.storage, removeItem() { throw Error('unavailable'); } };
  const client = createRegistrationClient({ ...f.options, storage });
  await assert.rejects(client.join(''), error => {
    assert.equal(error.code, 'STORAGE_ERROR');
    assert.match(error.message, /ditolak/);
    return true;
  });
  assert.equal(client.hasSession(), true);
  assert.equal(JSON.parse(f.storage.getItem(client.lockKey)).pending.action, 'join');
  f.storage.removeItem(client.lockKey);
  const joined = await client.join('A');
  await assert.rejects(client.leave(), error => {
    assert.equal(error.code, 'STORAGE_ERROR');
    assert.match(error.message, /Keluar dikonfirmasi/);
    return true;
  });
  const pending = JSON.parse(f.storage.getItem(client.lockKey));
  assert.equal(pending.playerId, joined.playerId);
  assert.equal(pending.pending.action, 'leave');
  const recovered = await f.client.resume();
  assert.equal(recovered.left, true);
  assert.equal(recovered.state.players.length, 0);
  assert.equal(f.client.hasSession(), false);
});

test('default client transport uses fetch and crypto without injected replacements', async t => {
  const provider = server(), storage = memory(), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, endpoint);
    const request = JSON.parse(options.body);
    requests.push(request);
    return Response.json({ ok: true, data: await provider.send(request) });
  });
  const client = createRegistrationClient({ endpoint, spreadsheetUrl, storage });
  await client.initialize();
  const result = await client.join('A');
  assert.match(requests[0].requestId, /^[a-f0-9]{64}$/);
  assert.match(requests[1].secret, /^[a-f0-9]{64}$/);
  assert.notEqual(requests[1].requestId, requests[1].secret);
  assert.equal((await client.resume()).playerId, result.playerId);
  assert.equal((await client.leave()).left, true);
  assert.equal(client.hasSession(), false);
});

test('injected cross-tab lock serializes identity creation', async () => {
  const f = await fixture();
  let tail = Promise.resolve();
  const exclusive = operation => {
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  };
  const one = createRegistrationClient({ ...f.options, exclusive });
  const two = createRegistrationClient({ ...f.options, exclusive });
  const results = await Promise.allSettled([one.join('A'), two.join('B')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'SESSION_EXISTS');
});

function fakeDocument() {
  class Element {
    value = ''; textContent = ''; disabled = false; hidden = true; children = []; attributes = {};
    set innerHTML(_) { throw Error('unsafe HTML'); }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren() { this.children = []; }
    append(element) { this.children.push(element); }
    addEventListener(event, callback) { this[event] = callback; }
  }
  const elements = new Map();
  return {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: () => new Element(),
  };
}

function browserGlobals(t, descriptors) {
  for (const [name, descriptor] of Object.entries(descriptors)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
}

test('public configuration is immutable and only accepts a public deployment endpoint', () => {
  assert.deepEqual(Object.keys(config), ['endpoint']);
  assert.equal(typeof config.endpoint, 'string');
  if (config.endpoint) assert.equal(endpointUrl(config.endpoint), config.endpoint);
  assert.ok(Object.isFrozen(config));
  assert.throws(() => { config.endpoint = endpoint; }, TypeError);
});

test('browser entry mounts the real UI and wires submit, initialize, resume, and leave', async t => {
  const f = await fixture(), document = fakeDocument(), locked = [];
  f.storage.setItem('game100:endpoint', endpoint);
  f.storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
  browserGlobals(t, {
    document: { value: document },
    localStorage: { value: f.storage },
    navigator: { value: { locks: { request: (key, operation) => {
      locked.push(key);
      return operation();
    } } } },
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, config.endpoint || endpoint);
    return Response.json({ ok: true, data: await f.provider.send(JSON.parse(options.body)) });
  });
  await import('../web/app.js');
  const get = id => document.getElementById(id);
  assert.equal(get('endpoint').value, config.endpoint || endpoint);
  assert.equal(get('spreadsheet').value, spreadsheetUrl);
  assert.equal(f.provider.calls.length, 1);
  await get('initialize').click();
  assert.match(get('status').textContent, /Anda belum terdaftar/);
  get('name').value = 'Browser player';
  let prevented = false;
  get('entry-form').submit({ preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(get('players').children[0].textContent, 'Browser player (Anda)');
  await get('resume').click();
  await get('leave').click();
  assert.deepEqual(f.provider.calls.map(request => request.action), ['initialize', 'initialize', 'join', 'resume', 'leave']);
  assert.equal(locked.length, 4);
  assert.ok(locked.every(key => key === `game100:${config.endpoint || endpoint}:${'s'.repeat(30)}`));
  assert.equal(get('leave').hidden, true);
  assert.equal(get('registration-fields').hidden, false);
});

test('browser entry reports inaccessible localStorage instead of mounting an unsafe session', () => {
  const source = `
    import assert from 'node:assert/strict';
    const status = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
    globalThis.document = {
      getElementById(id) { assert.equal(id, 'status'); return status; },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      get() { throw Error('storage blocked'); },
    });
    await import(${JSON.stringify(new URL('../web/app.js', import.meta.url).href)});
    assert.equal(status.attributes.role, 'alert');
    assert.match(status.textContent, /Penyimpanan browser tidak tersedia/);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('roster never marks a departed identity as the current player', async () => {
  const f = await fixture(), result = await f.client.join('A');
  const document = fakeDocument();
  renderRoster(document, { ...result, left: true });
  assert.deepEqual(document.getElementById('players').children.map(item => item.textContent), ['A']);
  assert.equal(document.getElementById('roster').hidden, false);
  assert.equal(document.getElementById('server').textContent, `Server ${result.state.serverId} - 1/4 pemain`);
});

test('UI reports unexpected DOM access failures during startup without resuming', async () => {
  const f = await fixture(), document = fakeDocument();
  await f.client.join('A');
  f.storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
  const lookup = document.getElementById.bind(document);
  let endpointReads = 0, endpointValue;
  Object.defineProperty(lookup('endpoint'), 'value', {
    // Fail inside the startup client lookup, after initial controls and field checks.
    get() { if (++endpointReads === 3) throw Error('DOM unavailable'); return endpointValue; },
    set(value) { endpointValue = value; },
  });
  const saved = f.storage.getItem(f.client.lockKey);
  mountRegistration(document, {
    storage: f.storage, config: { endpoint }, random,
    locks: { request: () => assert.fail('must not acquire a lock') },
    send: () => assert.fail('must not send a command'),
  });
  assert.equal(endpointReads, 3);
  assert.equal(lookup('status').textContent, 'Penyimpanan browser gagal dibaca.');
  assert.equal(lookup('leave').hidden, true);
  assert.equal(lookup('session-recovery').hidden, false);
  assert.equal(f.storage.getItem(f.client.lockKey), saved);
});

test('UI renders names as text and success only after confirmation; errors and loading explicit', async () => {
  const f = await fixture(), document = fakeDocument();
  const get = id => document.getElementById(id);
  let release;
  const ui = mountRegistration(document, {
    storage: f.storage, config: { endpoint }, locks: { request: (_, operation) => operation() },
    send: request => new Promise(resolve => { release = () => resolve(f.provider.send(request)); }), random,
  });
  get('spreadsheet').value = spreadsheetUrl;
  get('name').value = '<img src=x onerror=alert(1)>';
  const pending = ui.run('join');
  assert.equal(get('join').disabled, true);
  assert.equal(get('roster').hidden, true);
  assert.equal(get('status').textContent, 'Menghubungi server...');
  assert.equal(get('leave').hidden, true);
  assert.equal(get('session-recovery').hidden, true);
  release(); await pending;
  assert.equal(get('join').disabled, false);
  assert.equal(get('roster').hidden, false);
  assert.equal(get('leave').hidden, false);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('session-recovery').hidden, true);
  assert.equal(get('players').children[0].textContent, '<img src=x onerror=alert(1)> (Anda)');
  get('endpoint').value = 'https://evil.example';
  await ui.run('initialize');
  assert.equal(get('status').attributes.role, 'alert');
  assert.match(get('status').textContent, /INVALID_ENDPOINT/);
  assert.equal(get('roster').hidden, true);
});

test('UI restores stored session automatically on refresh, but never joins automatically', async () => {
  const f = await fixture();
  const registered = await f.client.join('A');
  f.storage.setItem('game100:endpoint', endpoint);
  f.storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
  const document = fakeDocument();
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  mountRegistration(document, { storage: f.storage, config: {}, random,
    locks: { request: (_, operation) => operation() },
    send: async request => { assert.equal(request.action, 'resume'); const result = await f.provider.send(request); done(); return result; },
  });
  await completed;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(document.getElementById('status').textContent, /dikonfirmasi/);
  assert.equal(f.provider.calls.at(-1).playerId, registered.playerId);
  assert.equal(document.getElementById('leave').hidden, false);
  assert.equal(document.getElementById('session-recovery').hidden, true);
  assert.equal(document.getElementById('registration-fields').hidden, true);
});

test('new player sees entry fields, not session controls; setup is collapsed in HTML', async () => {
  const f = await fixture(), document = fakeDocument();
  mountRegistration(document, { storage: f.storage, config: { endpoint }, random,
    locks: { request: (_, operation) => operation() }, send: f.provider.send });
  assert.equal(document.getElementById('registration-fields').hidden, false);
  assert.equal(document.getElementById('session-recovery').hidden, true);
  assert.equal(document.getElementById('leave').hidden, true);
  assert.equal(document.getElementById('roster').hidden, true);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form id="entry-form">([\s\S]*?)<\/form>/)[1];
  assert.deepEqual([...form.matchAll(/<input id="([^"]+)"/g)].map(match => match[1]), ['spreadsheet', 'name']);
  assert.match(form, /id="join" type="submit">Gabung server/);
  assert.match(html, /<details id="setup">[\s\S]*id="endpoint"[\s\S]*id="initialize"/);
  assert.match(html, /<section id="roster"[\s\S]*id="leave"[^>]*hidden/);
});

test('UI shows recovery after ambiguous join failure, hides leave until recovered, then returns to entry after leave', async () => {
  const f = await fixture(), document = fakeDocument();
  let lost = true;
  const ui = mountRegistration(document, { storage: f.storage, config: { endpoint }, random,
    locks: { request: (_, operation) => operation() },
    send: async request => {
      const result = await f.provider.send(request);
      if (request.action === 'join' && lost) { lost = false; throw new ClientError('NETWORK_ERROR', 'lost'); }
      return result;
    },
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  get('name').value = 'A';
  await ui.run('join');
  assert.match(get('status').textContent, /NETWORK_ERROR/);
  assert.equal(get('session-recovery').hidden, false);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('leave').hidden, true);
  const request = f.provider.calls.at(-1);
  await ui.run('resume');
  assert.deepEqual(f.provider.calls.at(-1), request);
  assert.equal(get('session-recovery').hidden, true);
  assert.equal(get('leave').hidden, false);
  await ui.run('leave');
  assert.match(get('status').textContent, /Keluar dikonfirmasi/);
  assert.equal(get('registration-fields').hidden, false);
  assert.equal(get('name').required, true);
  assert.equal(get('leave').hidden, true);
  assert.equal(get('session-recovery').hidden, true);
});

test('initialization and definite join rejection never expose leave or recovery', async () => {
  const f = await fixture(), document = fakeDocument();
  const ui = mountRegistration(document, { storage: f.storage, config: { endpoint }, random,
    locks: { request: (_, operation) => operation() }, send: f.provider.send,
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  await ui.run('initialize');
  assert.match(get('status').textContent, /Anda belum terdaftar/);
  assert.equal(get('leave').hidden, true);
  assert.equal(get('session-recovery').hidden, true);
  assert.equal(get('registration-fields').hidden, false);
  get('name').value = '  ';
  await ui.run('join');
  assert.match(get('status').textContent, /INVALID_NAME/);
  assert.equal(get('leave').hidden, true);
  assert.equal(get('session-recovery').hidden, true);
  assert.equal(get('registration-fields').hidden, false);
});

test('changing selected server hides stale roster and session controls without making requests', async () => {
  const f = await fixture(), document = fakeDocument();
  const ui = mountRegistration(document, { storage: f.storage, config: { endpoint }, random,
    locks: { request: (_, operation) => operation() }, send: f.provider.send,
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  get('name').value = 'A';
  await ui.run('join');
  const calls = f.provider.calls.length;
  get('spreadsheet').value = spreadsheetUrl.replace('s'.repeat(30), 't'.repeat(30));
  get('spreadsheet').input();
  assert.equal(get('roster').hidden, true);
  assert.equal(get('leave').hidden, true);
  assert.equal(get('session-recovery').hidden, true);
  assert.equal(get('registration-fields').hidden, false);
  assert.doesNotMatch(get('status').textContent, /dikonfirmasi/);
  assert.equal(f.provider.calls.length, calls);
});

test('missing backend config and uninitialized server are explicit, not implicit initialization or success', async () => {
  const f = await fixture(), document = fakeDocument();
  const ui = mountRegistration(document, { storage: f.storage, config: {}, random,
    locks: { request: (_, operation) => operation() }, send: f.provider.send,
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  get('name').value = 'A';
  await ui.run('join');
  assert.match(get('status').textContent, /NOT_CONFIGURED/);
  assert.equal(f.provider.calls.length, 1);
  get('endpoint').value = endpoint;
  const empty = server();
  const second = mountRegistration(document, { storage: memory(), config: { endpoint }, random,
    locks: { request: (_, operation) => operation() }, send: empty.send,
  });
  get('spreadsheet').value = spreadsheetUrl;
  await second.run('join');
  assert.match(get('status').textContent, /NOT_INITIALIZED.*pengelola/);
  assert.deepEqual(empty.calls.map(request => request.action), ['join']);
  assert.equal(get('leave').hidden, true);
});

test('submitting with a saved session resumes rather than joining a second player', async () => {
  const f = await fixture(), document = fakeDocument();
  const joined = await f.client.join('A');
  const ui = mountRegistration(document, { storage: f.storage, config: { endpoint }, random,
    locks: { request: (_, operation) => operation() }, send: f.provider.send,
  });
  document.getElementById('spreadsheet').value = spreadsheetUrl;
  document.getElementById('name').value = 'B';
  await ui.run('join');
  assert.equal(f.provider.calls.at(-1).action, 'resume');
  assert.equal(f.provider.calls.at(-1).playerId, joined.playerId);
  assert.equal(document.getElementById('leave').hidden, false);
});

test('UI rejects browsers without Web Locks before sending a registration command', async () => {
  const f = await fixture(), document = fakeDocument();
  const ui = mountRegistration(document, {
    storage: f.storage, config: { endpoint }, send: f.provider.send, random,
  });
  document.getElementById('spreadsheet').value = spreadsheetUrl;
  document.getElementById('name').value = 'A';
  await ui.run('join');
  assert.match(document.getElementById('status').textContent, /BROWSER_UNSUPPORTED/);
  assert.equal(document.getElementById('status').attributes.role, 'alert');
  assert.equal(document.getElementById('join').disabled, false);
  assert.equal(document.getElementById('leave').hidden, true);
  assert.equal(f.provider.calls.length, 1);
  assert.equal(f.client.hasSession(), false);
});

test('UI exposes storage read, corrupt session, and preference write failures without network requests', async () => {
  const f = await fixture();
  for (const failure of ['read', 'corrupt', 'write']) {
    const document = fakeDocument();
    const storage = memory();
    storage.setItem('game100:endpoint', endpoint);
    storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
    if (failure === 'read') storage.getItem = () => { throw Error('blocked'); };
    if (failure === 'corrupt') storage.setItem(f.client.lockKey, '{}');
    if (failure === 'write') storage.setItem = () => { throw Error('quota'); };
    const ui = mountRegistration(document, {
      storage, config: { endpoint }, locks: { request: (_, operation) => operation() },
      send: f.provider.send, random,
    });
    if (failure === 'corrupt') {
      assert.equal(document.getElementById('status').attributes.role, 'alert');
      assert.match(document.getElementById('status').textContent, /sesi browser tidak valid/);
    } else {
      document.getElementById('spreadsheet').value = spreadsheetUrl;
      await ui.run('join');
      assert.equal(document.getElementById('status').attributes.role, 'alert');
      assert.match(document.getElementById('status').textContent, /STORAGE_ERROR/);
    }
    assert.equal(document.getElementById('leave').hidden, true);
    assert.equal(f.provider.calls.length, 1);
  }
});

test('UI ignores a second action while awaiting server confirmation', async () => {
  const f = await fixture(), document = fakeDocument();
  let complete;
  const ui = mountRegistration(document, {
    storage: f.storage, config: { endpoint }, locks: { request: (_, operation) => operation() }, random,
    send: request => new Promise(resolve => { complete = () => resolve(f.provider.send(request)); }),
  });
  document.getElementById('spreadsheet').value = spreadsheetUrl;
  document.getElementById('name').value = 'A';
  const joining = ui.run('join');
  await ui.run('initialize');
  assert.equal(f.provider.calls.length, 1);
  assert.equal(document.getElementById('initialize').disabled, true);
  complete();
  await joining;
  assert.deepEqual(f.provider.calls.map(request => request.action), ['initialize', 'join']);
  assert.equal(document.getElementById('initialize').disabled, false);
});

test('public response strips unexpected secrets, random uses 32 crypto bytes, static assets are relative', async () => {
  const f = await fixture(), result = await f.client.join('A');
  result.state.players[0].secretDigest = 'must not persist';
  assert.equal(validateResult(result, 'join').state.players[0].secretDigest, undefined);
  assert.equal(randomHex({ getRandomValues(bytes) { assert.equal(bytes.length, 32); return bytes.fill(255); } }), 'ff'.repeat(32));
  const document = fakeDocument(); renderRoster(document, result);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /lang="id"/);
  for (const asset of [...html.matchAll(/(?:src|href)="([^"]+)"/g)]) {
    assert.ok(asset[1].startsWith('./'));
    await readFile(new URL(`../web/${asset[1]}`, import.meta.url));
  }
  for (const id of ['endpoint', 'spreadsheet', 'name']) assert.ok(html.includes(`for="${id}"`));
});
