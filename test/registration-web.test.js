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
        const outcome = applyCommand(state, command, deps);
        state = outcome.state;
        if (outcome.error) throw new ClientError(outcome.error.code, outcome.error.message);
        return outcome.result;
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
    removeEventListener(event) { delete this[event]; }
  }
  const elements = new Map();
  return {
    addEventListener(event, callback) { this[event] = callback; },
    removeEventListener(event) { delete this[event]; },
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

test('browser entry mounts the real UI and wires submit, initialize, resume, ready, and leave', async t => {
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
  assert.equal(get('players').children[0].textContent, 'Browser player (Anda) - Belum siap');
  await get('resume').click();
  await get('ready').click();
  assert.equal(get('players').children[0].textContent, 'Browser player (Anda) - Siap');
  await get('not-ready').click();
  assert.equal(get('players').children[0].textContent, 'Browser player (Anda) - Belum siap');
  await get('leave').click();
  assert.deepEqual(f.provider.calls.map(request => request.action),
    ['initialize', 'initialize', 'join', 'resume', 'setReady', 'setReady', 'leave']);
  assert.equal(locked.length, 6);
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
  assert.deepEqual(document.getElementById('players').children.map(item => item.textContent), ['A - Belum siap']);
  assert.equal(document.getElementById('roster').hidden, false);
  assert.equal(document.getElementById('server').textContent, `Server ${result.state.serverId} - 1/6 pemain (minimum 2)`);
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
  assert.equal(lookup('status').textContent, 'STORAGE_ERROR: Operasi browser gagal; sesi tidak dihapus. Periksa penyimpanan browser.');
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('leave').hidden, true);
  assert.equal(get('session-recovery').hidden, true);
  release(); await pending;
  assert.equal(get('join').disabled, true);
  assert.equal(get('roster').hidden, false);
  assert.equal(get('players').children[0].textContent, '<img src=x onerror=alert(1)> (Anda) - Belum siap');
  assert.equal(get('leave').hidden, false);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('session-recovery').hidden, true);
  get('endpoint').value = 'https://evil.example';
  await ui.run('initialize');
  assert.equal(get('status').attributes.role, 'alert');
  assert.match(get('status').textContent, /INVALID_ENDPOINT/);
  assert.equal(get('roster').hidden, true);
  ui.unmount();
});

test('UI restores stored session automatically on refresh, but never joins automatically', async () => {
  const f = await fixture();
  const registered = await f.client.join('A');
  f.storage.setItem('game100:endpoint', endpoint);
  f.storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
  const document = fakeDocument();
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  const ui = mountRegistration(document, { storage: f.storage, config: {}, random,
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
  ui.unmount();
});

function fakeTimers() {
  let next = 0;
  const scheduled = new Map();
  return {
    scheduled,
    setTimeout(callback, delay) { const id = ++next; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    fire() {
      const [id, task] = scheduled.entries().next().value;
      scheduled.delete(id); task.callback();
    },
    get delay() { return scheduled.values().next().value?.delay; },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('UI rejects changed-server and older initialization snapshots without replacing the roster', async () => {
  for (const mismatch of ['server', 'revision']) {
    const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
    let responseCount = 0;
    const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
      locks: { request: (_, operation) => operation() },
      send: async request => {
        const result = await f.provider.send(request);
        result.state.revision = 5;
        if (++responseCount === 2) {
          if (mismatch === 'server') result.state.serverId = random();
          else result.state.revision = 4;
        }
        return result;
      },
    });
    document.getElementById('spreadsheet').value = spreadsheetUrl;
    await ui.run('initialize');
    const previous = document.getElementById('server').textContent;
    await ui.run('initialize');
    assert.match(document.getElementById('status').textContent,
      mismatch === 'server' ? /SERVER_CHANGED/ : /STALE_RESPONSE/);
    assert.equal(document.getElementById('server').textContent, previous);
    assert.equal(document.getElementById('roster').hidden, mismatch === 'server');
    assert.equal(document.getElementById('ready').disabled, true);
    assert.equal(timers.scheduled.size, 0);
    ui.unmount();
  }
});

test('UI surfaces storage failure while recovering a failed heartbeat without deleting the session', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  let fail = false;
  const read = f.storage.getItem;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: async request => {
      if (fail) {
        f.storage.getItem = () => { throw Error('storage blocked'); };
        throw new ClientError('NETWORK_ERROR', 'offline');
      }
      return f.provider.send(request);
    },
  });
  document.getElementById('spreadsheet').value = spreadsheetUrl;
  document.getElementById('name').value = 'A';
  await ui.run('join');
  const saved = new Map(f.storage.values);
  fail = true;
  await ui.run('sync');
  assert.equal(document.getElementById('status').attributes.role, 'alert');
  assert.match(document.getElementById('status').textContent, /STORAGE_ERROR/);
  assert.equal(document.getElementById('ready').disabled, true);
  assert.equal(timers.scheduled.size, 0);
  assert.deepEqual(f.storage.values, saved);
  f.storage.getItem = read;
  ui.unmount();
});

test('unmounted UI ignores explicit actions and saved sessions surface non-client transport errors', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  let fail = false;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: request => {
      if (fail) throw Error('unexpected browser transport failure');
      return f.provider.send(request);
    },
  });
  document.getElementById('spreadsheet').value = spreadsheetUrl;
  document.getElementById('name').value = 'A';
  await ui.run('join');
  fail = true;
  await ui.run('sync');
  assert.match(document.getElementById('status').textContent, /STORAGE_ERROR/);
  assert.equal(document.getElementById('session-recovery').hidden, false);
  ui.unmount();
  const calls = f.provider.calls.length;
  await ui.run('sync');
  assert.equal(f.provider.calls.length, calls);
});

test('late transport failures after unmount or server selection do not replace current status', async () => {
  for (const change of ['unmount', 'input', 'value']) {
    const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
    let reject;
    const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
      locks: { request: (_, operation) => operation() },
      send: request => request.action === 'sync'
        ? new Promise((_, fail) => { reject = fail; }) : f.provider.send(request),
    });
    document.getElementById('spreadsheet').value = spreadsheetUrl;
    document.getElementById('name').value = 'A';
    await ui.run('join');
    const pending = ui.run('sync');
    await settle();
    if (change === 'unmount') ui.unmount();
    else {
      document.getElementById('spreadsheet').value = spreadsheetUrl.replace('s'.repeat(30), 't'.repeat(30));
      if (change === 'input') document.getElementById('spreadsheet').input();
    }
    document.getElementById('status').textContent = 'Current selection';
    reject(new ClientError('NETWORK_ERROR', 'old request failed'));
    await pending;
    assert.doesNotMatch(document.getElementById('status').textContent, /old request failed/);
    assert.equal(document.getElementById('ready').disabled, true);
    ui.unmount();
  }
});

test('UI polling combines sync/heartbeat, is sequential, backs off, refreshes on focus and stops on leave/unmount', async () => {
  const f = await fixture(), document = fakeDocument(), events = fakeDocument(), timers = fakeTimers();
  let inFlight = 0, maximum = 0, fail = false, release;
  const send = async request => {
    maximum = Math.max(maximum, ++inFlight);
    try {
      if (request.action === 'sync' && release === undefined) await new Promise(resolve => { release = resolve; });
      if (fail) throw new ClientError('NETWORK_ERROR', 'offline');
      return await f.provider.send(request);
    } finally { inFlight--; }
  };
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, locks: { request: (_, operation) => operation() },
    events, timers, send });
  document.getElementById('spreadsheet').value = spreadsheetUrl;
  document.getElementById('name').value = 'A';
  events.offline();
  assert.doesNotMatch(document.getElementById('status').textContent, /OFFLINE/);
  await ui.run('join');
  assert.equal(timers.delay, 10000);
  document.visibilityState = 'hidden';
  document.visibilitychange();
  assert.equal(inFlight, 0);
  events.offline();
  assert.match(document.getElementById('status').textContent, /OFFLINE/);
  timers.fire(); await settle();
  events.focus(); events.focus();
  assert.equal(inFlight, 1);
  assert.equal(document.getElementById('ready').disabled, true);
  release(); await settle();
  assert.equal(maximum, 1);
  assert.equal(timers.delay, 0);
  timers.fire(); await settle();
  assert.equal(f.provider.calls.at(-1).action, 'sync');
  assert.equal(timers.delay, 10000);
  await ui.run('ready');
  assert.match(document.getElementById('players').children[0].textContent, / - Siap$/);
  assert.equal(document.getElementById('not-ready').disabled, false);
  assert.equal(timers.delay, 10000);
  fail = true;
  timers.fire(); await settle();
  assert.equal(timers.delay, 20000);
  assert.match(document.getElementById('status').textContent, /NETWORK_ERROR.*offline/);
  assert.equal(document.getElementById('roster').hidden, false);
  timers.fire(); await settle(); assert.equal(timers.delay, 40000);
  timers.fire(); await settle(); assert.equal(timers.delay, 60000);
  fail = false; events.focus(); await settle(); assert.equal(timers.delay, 10000);
  document.visibilityState = 'visible';
  document.visibilitychange(); await settle();
  assert.equal(f.provider.calls.at(-1).action, 'sync');
  assert.equal(timers.delay, 10000);
  await ui.run('leave');
  assert.equal(timers.scheduled.size, 0);
  events.focus(); await settle(); assert.equal(timers.scheduled.size, 0);
  ui.unmount();
  assert.equal(events.focus, undefined);
  assert.equal(timers.scheduled.size, 0);
});

test('UI ignores completion after unmount or selection change and expires with clear recovery', async () => {
  for (const change of ['unmount', 'selection', 'expired']) {
    const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
    let response, release;
    const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
      locks: { request: (_, operation) => operation() },
      send: async request => {
        if (request.action === 'sync') return new Promise((resolve, reject) => {
          release = () => change === 'expired' ? reject(new ClientError('SESSION_ENDED', 'Sesi berakhir; daftar lagi.')) : resolve(response);
        });

        response = await f.provider.send(request); return response;
      },
    });
    document.getElementById('spreadsheet').value = spreadsheetUrl;
    document.getElementById('name').value = 'A';
    await ui.run('join');
    const pending = ui.run('sync'); await settle();
    if (change === 'unmount') ui.unmount();
    if (change === 'selection') {
      document.getElementById('spreadsheet').value = spreadsheetUrl.replace('s'.repeat(30), 't'.repeat(30));
      document.getElementById('spreadsheet').change();
    }
    release(); await pending;
    assert.equal(timers.scheduled.size, 0);
    if (change !== 'unmount') assert.equal(document.getElementById('roster').hidden, true);
    if (change === 'expired') {
      assert.match(document.getElementById('status').textContent, /SESSION_ENDED/);
      assert.equal(document.getElementById('join').disabled, false);
      assert.equal(document.getElementById('ready').disabled, true);
    }
    ui.unmount();
  }
});

test('refresh resume failure backs off and retries the stored identity without enabling ready early', async () => {
  const f = await fixture(), timers = fakeTimers(), document = fakeDocument();
  const joined = await f.client.join('A');
  f.storage.setItem('game100:endpoint', endpoint);
  f.storage.setItem('game100:lastSpreadsheet', spreadsheetUrl);
  let fail = true;
  const ui = mountRegistration(document, {
    ...f.options, config: {}, timers, locks: { request: (_, operation) => operation() },
    send: async request => {
      if (fail) throw new ClientError('NETWORK_ERROR', 'offline');
      return f.provider.send(request);
    },
  });
  await settle();
  assert.equal(timers.delay, 20000);
  assert.equal(document.getElementById('ready').disabled, true);
  assert.equal(document.getElementById('roster').hidden, true);
  assert.match(document.getElementById('status').textContent, /NETWORK_ERROR/);
  fail = false; timers.fire(); await settle();
  assert.equal(f.provider.calls.at(-1).action, 'sync');
  assert.equal(f.provider.calls.at(-1).playerId, joined.playerId);
  assert.equal(document.getElementById('ready').disabled, false);
  assert.equal(timers.delay, 10000);
  ui.unmount();
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
  ui.unmount();
});

test('semantic form handles Enter and submit-button activation once, with no join click handler', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  let release, prevented = 0;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: request => new Promise(resolve => { release = () => resolve(f.provider.send(request)); }),
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  get('name').value = 'A';
  assert.equal(get('join').click, undefined);
  const submit = () => get('entry-form').submit({ preventDefault() { prevented++; } });
  submit();
  submit();
  await settle();
  assert.equal(get('join').disabled, true);
  release(); await settle();
  assert.equal(prevented, 2);
  assert.equal(f.provider.calls.filter(request => request.action === 'join').length, 1);
  assert.equal(get('leave').hidden, false);
  assert.equal(get('ready').hidden, false);
  assert.equal(get('not-ready').hidden, false);
  ui.unmount();
  assert.equal(get('entry-form').submit, undefined);
});

test('ambiguous ready and leave hide action controls until exact recovery without losing polling', async () => {
  for (const action of ['ready', 'leave']) {
    const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
    let lost = true;
    const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
      locks: { request: (_, operation) => operation() },
      send: async request => {
        const result = await f.provider.send(request);
        if (request.action === (action === 'ready' ? 'setReady' : 'leave') && lost) {
          lost = false;
          throw new ClientError('NETWORK_ERROR', 'committed but unanswered');
        }
        return result;
      },
    });
    const get = id => document.getElementById(id);
    get('spreadsheet').value = spreadsheetUrl;
    get('name').value = 'A';
    await ui.run('join');
    await ui.run(action);
    const pending = f.provider.calls.at(-1);
    assert.equal(get('registration-fields').hidden, true);
    assert.equal(get('session-recovery').hidden, false);
    assert.equal(get('leave').hidden, true);
    assert.equal(get('ready').hidden, true);
    assert.equal(get('not-ready').hidden, true);
    assert.equal(timers.delay, 20000);
    timers.fire(); await settle();
    assert.deepEqual(f.provider.calls.at(-1), pending);
    assert.equal(get('session-recovery').hidden, true);
    assert.equal(get('leave').hidden, action === 'leave');
    assert.equal(get('registration-fields').hidden, action !== 'leave');
    if (action === 'leave') {
      assert.equal(timers.scheduled.size, 0);
    } else {
      assert.equal(timers.delay, 10000);
      assert.equal(get('ready').hidden, false);
      assert.equal(get('ready').disabled, true);
      assert.equal(get('not-ready').disabled, false);
    }
    ui.unmount();
  }
});

test('server selection restores saved-session controls without network, and expiry returns to entry', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  let expired = false;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: request => expired
      ? Promise.reject(new ClientError('SESSION_ENDED', 'Sesi berakhir; daftar lagi.'))
      : f.provider.send(request),
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl; get('name').value = 'A';
  await ui.run('join');
  const calls = f.provider.calls.length;
  get('spreadsheet').value = spreadsheetUrl.replace('s'.repeat(30), 't'.repeat(30));
  get('spreadsheet').input();
  assert.equal(timers.scheduled.size, 0);
  assert.equal(get('ready').hidden, true);
  get('spreadsheet').value = spreadsheetUrl;
  get('spreadsheet').change();
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('session-recovery').hidden, false);
  assert.equal(get('leave').hidden, true);
  assert.equal(get('roster').hidden, true);
  assert.equal(f.provider.calls.length, calls);
  assert.equal(timers.scheduled.size, 0);
  await ui.run('resume');
  assert.equal(get('leave').hidden, false);
  expired = true;
  timers.fire(); await settle();
  assert.equal(get('registration-fields').hidden, false);
  assert.equal(get('name').required, true);
  assert.equal(get('session-recovery').hidden, true);
  assert.equal(get('leave').hidden, true);
  assert.equal(get('ready').hidden, true);
  assert.equal(get('roster').hidden, true);
  assert.equal(timers.scheduled.size, 0);
  assert.match(get('status').textContent, /SESSION_ENDED/);
  ui.unmount();
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
  assert.equal(document.getElementById('initialize').disabled, true);
  assert.equal(document.getElementById('ready').disabled, false);
  assert.equal(document.getElementById('leave').hidden, false);
  ui.unmount();
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

test('UI switches on focus/poll snapshot, inhibits lobby controls, restores game on refresh, and ignores stale lobby', async () => {
  const f = await fixture(), document = fakeDocument(), events = fakeDocument(), timers = fakeTimers();
  let stale;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, events, timers,
    locks: { request: (_, operation) => operation() },
    send: request => stale && request.action === 'sync' ? stale : f.provider.send(request),
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  get('name').value = '<A>';
  await ui.run('join');
  const b = createRegistrationClient({ ...f.options, storage: memory() });
  await b.join('B'); await ui.run('ready');
  stale = await f.client.sync();
  await b.setReady(true);
  stale = undefined;
  events.focus(); await settle();
  assert.equal(get('game').hidden, false);
  assert.match(get('game-id').textContent, /ID permainan:/);
  assert.deepEqual(get('participants').children.map(item => item.textContent), ['<A>', 'B']);
  assert.equal(get('lobby-help').hidden, true);
  assert.match(get('status').textContent, /Ronde tersinkron/);
  for (const id of ['ready', 'not-ready', 'leave', 'join']) assert.equal(get(id).disabled, true);
  for (const id of ['ready', 'not-ready', 'leave', 'registration-fields', 'session-recovery']) assert.equal(get(id).hidden, true);
  assert.equal(get('name').required, false);
  const calls = f.provider.calls.length, gameId = get('game-id').textContent;
  for (const action of ['ready', 'not-ready', 'leave']) await ui.run(action);
  assert.equal(f.provider.calls.length, calls);
  await ui.run('join');
  assert.equal(f.provider.calls.at(-1).action, 'resume');
  assert.equal(f.provider.calls.length, calls + 1);
  events.offline();
  assert.match(get('status').textContent, /peserta game tetap tersimpan/);
  stale = { ...(await b.sync()), playerId: JSON.parse(f.storage.getItem(f.client.lockKey)).playerId };
  stale.state = { ...stale.state, revision: 0, phase: 'lobby' };
  delete stale.state.gameId; delete stale.state.participantIds; delete stale.state.startedAt;
  delete stale.state.round;
  await ui.run('sync');
  assert.match(get('status').textContent, /STALE_RESPONSE/);
  assert.equal(get('game-id').textContent, gameId);
  assert.equal(get('game').hidden, false);
  ui.unmount();
  const refreshed = fakeDocument();
  const next = mountRegistration(refreshed, { ...f.options, config: {}, timers: fakeTimers(),
    locks: { request: (_, operation) => operation() },
  });
  await settle();
  assert.equal(refreshed.getElementById('game').hidden, false);
  assert.equal(refreshed.getElementById('game-id').textContent, gameId);
  assert.equal(refreshed.getElementById('leave').disabled, true);
  assert.equal(refreshed.getElementById('leave').hidden, true);
  assert.equal(refreshed.getElementById('registration-fields').hidden, true);
  assert.equal(refreshed.getElementById('name').required, false);
  next.unmount();
});

for (const action of ['leave', 'not-ready']) test(`UI recovers GAME_STARTED from racing ${action} without erasing identity`, async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  let race = false;
  const b = createRegistrationClient({ ...f.options, storage: memory() });
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: async request => {
      if (race && ['leave', 'setReady'].includes(request.action)) {
        race = false;
        await b.setReady(true);
      }
      return f.provider.send(request);
    },
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl; get('name').value = 'A';
  await ui.run('join'); await b.join('B'); await ui.run('ready');
  const identity = JSON.parse(f.storage.getItem(f.client.lockKey));
  race = true;
  await ui.run(action);
  assert.match(get('status').textContent, /GAME_STARTED/);
  assert.equal(f.client.hasSession(), true);
  assert.equal(JSON.parse(f.storage.getItem(f.client.lockKey)).pending, undefined);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('session-recovery').hidden, false);
  for (const id of ['leave', 'ready', 'not-ready']) assert.equal(get(id).hidden, true);
  assert.equal(timers.delay, 0);
  timers.fire(); await settle();
  assert.equal(get('game').hidden, false);
  assert.equal(JSON.parse(f.storage.getItem(f.client.lockKey)).playerId, identity.playerId);
  assert.equal(get('leave').disabled, true);
  for (const id of ['leave', 'ready', 'not-ready', 'session-recovery']) assert.equal(get(id).hidden, true);
  ui.unmount();
});

test('semantic game recovery submits once with no required hidden name and no lobby controls', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  await f.client.join('A');
  const b = createRegistrationClient({ ...f.options, storage: memory() });
  await b.join('B'); await f.client.setReady(true); await b.setReady(true);
  let release, prevented = 0;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: request => new Promise(resolve => { release = () => resolve(f.provider.send(request)); }),
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  get('spreadsheet').input();
  const calls = f.provider.calls.length;
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('session-recovery').hidden, false);
  assert.equal(timers.scheduled.size, 0);
  assert.equal(get('join').click, undefined);
  for (let i = 0; i < 2; i++) get('entry-form').submit({ preventDefault() { prevented++; } });
  await settle();
  for (const id of ['ready', 'not-ready', 'leave']) assert.equal(get(id).hidden, true);
  release(); await settle();
  assert.equal(prevented, 2);
  assert.equal(f.provider.calls.length, calls + 1);
  assert.equal(f.provider.calls.at(-1).action, 'resume');
  assert.equal(get('game').hidden, false);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  for (const id of ['ready', 'not-ready', 'leave', 'session-recovery']) assert.equal(get(id).hidden, true);
  ui.unmount();
});

test('game selection invalidates delayed response without networking or exposing stale game controls', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers(), events = fakeDocument();
  let release;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers, events,
    locks: { request: (_, operation) => operation() },
    send: request => request.action === 'sync'
      ? new Promise(resolve => { release = () => resolve(f.provider.send(request)); })
      : f.provider.send(request),
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl; get('name').value = 'A';
  await ui.run('join');
  const b = createRegistrationClient({ ...f.options, storage: memory() });
  await b.join('B'); await b.setReady(true); await ui.run('ready');
  const gameId = get('game-id').textContent;
  const pending = ui.run('sync'); await settle();
  for (const id of ['leave', 'ready', 'not-ready']) assert.equal(get(id).hidden, true);
  const calls = f.provider.calls.length;
  get('spreadsheet').value = spreadsheetUrl.replace('s'.repeat(30), 't'.repeat(30));
  get('spreadsheet').input();
  assert.equal(get('roster').hidden, true);
  release(); await pending;
  assert.equal(get('roster').hidden, true);
  assert.equal(timers.scheduled.size, 0);
  const after = f.provider.calls.length;
  assert.equal(after, calls + 1);
  get('spreadsheet').value = spreadsheetUrl; get('spreadsheet').change();
  events.focus(); await settle();
  assert.equal(f.provider.calls.length, after);
  assert.equal(timers.scheduled.size, 0);
  assert.equal(get('session-recovery').hidden, false);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('roster').hidden, true);
  await ui.run('resume');
  assert.equal(get('game-id').textContent, gameId);
  assert.equal(get('game').hidden, false);
  for (const id of ['leave', 'ready', 'not-ready', 'session-recovery']) assert.equal(get(id).hidden, true);
  ui.unmount();
});

test('lost final-ready response recovers from refresh with entry hidden and same game identity', async () => {
  const f = await fixture(), document = fakeDocument(), timers = fakeTimers();
  let loseReady = false;
  const ui = mountRegistration(document, { ...f.options, config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
    send: async request => {
      const result = await f.provider.send(request);
      if (loseReady && request.action === 'setReady') throw new ClientError('NETWORK_ERROR', 'lost after commit');
      return result;
    },
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl; get('name').value = 'A';
  await ui.run('join');
  const b = createRegistrationClient({ ...f.options, storage: memory() });
  await b.join('B'); await b.setReady(true);
  loseReady = true; await ui.run('ready');
  const pending = f.provider.calls.at(-1);
  const gameId = (await b.sync()).state.gameId;
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('session-recovery').hidden, false);
  for (const id of ['ready', 'not-ready', 'leave']) assert.equal(get(id).hidden, true);
  ui.unmount();
  const refreshed = fakeDocument();
  const next = mountRegistration(refreshed, { ...f.options, config: {}, timers: fakeTimers(),
    locks: { request: (_, operation) => operation() },
  });
  await settle();
  assert.deepEqual(f.provider.calls.at(-1), pending);
  assert.equal(refreshed.getElementById('game-id').textContent, `ID permainan: ${gameId}`);
  assert.equal(refreshed.getElementById('game').hidden, false);
  for (const id of ['ready', 'not-ready', 'leave', 'registration-fields', 'session-recovery']) {
    assert.equal(refreshed.getElementById(id).hidden, true);
  }
  assert.equal(refreshed.getElementById('name').required, false);
  next.unmount();
});

test('initializing a game never exposes new-join form or confirms an anonymous player', async () => {
  const f = await fixture();
  await f.client.join('A');
  const b = createRegistrationClient({ ...f.options, storage: memory() });
  await b.join('B'); await b.setReady(true); await f.client.setReady(true);
  const document = fakeDocument(), timers = fakeTimers();
  const ui = mountRegistration(document, { ...f.options, storage: memory(), config: { endpoint }, timers,
    locks: { request: (_, operation) => operation() },
  });
  const get = id => document.getElementById(id);
  get('spreadsheet').value = spreadsheetUrl;
  await ui.run('initialize');
  assert.match(get('status').textContent, /Anda belum terdaftar/);
  assert.equal(get('game').hidden, false);
  assert.equal(get('registration-fields').hidden, true);
  assert.equal(get('name').required, false);
  assert.equal(get('join').disabled, true);
  for (const id of ['ready', 'not-ready', 'leave', 'session-recovery']) assert.equal(get(id).hidden, true);
  const calls = f.provider.calls.length;
  await ui.run('join');
  assert.match(get('status').textContent, /GAME_STARTED/);
  assert.equal(f.provider.calls.length, calls);
  assert.equal(timers.scheduled.size, 0);
  ui.unmount();
});
