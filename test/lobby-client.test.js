import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCommand } from '../game100/domain.js';
import { ClientError, createRegistrationClient } from '../web/client.js';

const endpoint = 'https://script.google.com/macros/s/test/exec';
const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${'s'.repeat(30)}/edit`;
const code = expected => error => error.code === expected;
function fixture() {
  let time = 0, sequence = 0, state = null;
  const hash = text => createHash('sha256').update(text).digest('hex');
  const uuid = () => hash(String(++sequence));
  const deps = { hash, uuid, now: () => time };
  state = applyCommand(null, { action: 'initialize', requestId: uuid() }, deps).state;
  return {
    uuid,
    get state() { return state; }, set time(value) { time = value; },
    send: async request => {
      try {
        const outcome = applyCommand(state, request, deps);
        state = outcome.state;
        if (outcome.error) throw new ClientError(outcome.error.code, outcome.error.message);
        return outcome.result;
      } catch (error) { throw new ClientError(error.code, error.message); }
    },
  };
}
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
}
function client(f, store = storage(), send = f.send, exclusive) {
  return createRegistrationClient({ endpoint, spreadsheetUrl, storage: store, send, random: f.uuid, exclusive });
}

test('ready and heartbeat reject missing sessions, invalid decisions, and unresolved writes', async () => {
  const f = fixture(), store = storage(), api = client(f, store);
  await assert.rejects(api.sync(), code('NO_SESSION'));
  await assert.rejects(api.setReady(true), code('NO_SESSION'));
  await assert.rejects(api.setReady('true'), code('INVALID_REQUEST'));
  await api.join('A');
  const saved = JSON.parse(store.getItem(api.lockKey));
  delete saved.readyVersion;
  store.setItem(api.lockKey, JSON.stringify(saved));
  assert.equal((await api.setReady(true)).state.players[0].readyVersion, 1);
  const failed = client(f, store, async () => { throw new ClientError('NETWORK_ERROR', 'lost'); });
  await assert.rejects(failed.setReady(false), code('NETWORK_ERROR'));
  const pending = store.getItem(api.lockKey);
  await assert.rejects(api.setReady(true), code('PENDING_COMMAND'));
  assert.equal(store.getItem(api.lockKey), pending);
  assert.equal((await api.sync()).state.players[0].ready, false);
});

test('lost ready response persists exact request across reload, then later decision wins', async () => {
  const f = fixture(), store = storage(), first = client(f, store);
  await first.join('A');
  let lost = true, pending;
  const send = async request => {
    const result = await f.send(request);
    if (request.action === 'setReady' && lost) {
      pending = request; lost = false; throw new ClientError('NETWORK_ERROR', 'lost');
    }
    if (request.action === 'setReady') assert.deepEqual(request, pending);
    return result;
  };
  await assert.rejects(client(f, store, send).setReady(true), code('NETWORK_ERROR'));
  assert.equal((await client(f, store, send).sync()).state.players[0].ready, true);
  assert.equal((await first.setReady(false)).state.players[0].ready, false);
});

test('same-instance and cross-tab ready/heartbeat/leave are sequential and secrets resume on refresh', async () => {
  const f = fixture(), store = storage();
  let tail = Promise.resolve(), inFlight = 0, max = 0;
  const exclusive = operation => {
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  };
  const send = async command => {
    max = Math.max(max, ++inFlight);
    await new Promise(resolve => setImmediate(resolve));
    try { return await f.send(command); } finally { inFlight--; }
  };
  const a = client(f, store, send, exclusive), b = client(f, store, send, exclusive);
  const joined = await a.join('A');
  assert.equal((await b.resume()).playerId, joined.playerId);
  await Promise.all([a.setReady(true), b.sync(), a.setReady(false), b.leave()]);
  assert.equal(max, 1);
  assert.equal(f.state.players.length, 0);
  assert.equal(a.hasSession(), false);
});

test('expired session clears local identity; ambiguous transport failure keeps it', async () => {
  const f = fixture(), store = storage(), api = client(f, store);
  await api.join('A');
  await assert.rejects(client(f, store, async () => { throw new ClientError('NETWORK_ERROR', 'offline'); }).sync(), code('NETWORK_ERROR'));
  assert.equal(api.hasSession(), true);
  f.time = 60000;
  await assert.rejects(api.sync(), code('SESSION_ENDED'));
  assert.equal(api.hasSession(), false);
  assert.equal((await api.join('A')).state.players.length, 1);
});

test('old server, player, revision or displaced session responses never overwrite storage', async () => {
  const f = fixture(), store = storage(), api = client(f, store);
  const joined = await api.join('A');
  await api.setReady(true);
  const before = store.getItem(api.lockKey);
  for (const result of [
    { ...joined, state: { ...joined.state, serverId: f.uuid() } },
    { ...joined, playerId: f.uuid() },
    joined,
  ]) {
    await assert.rejects(client(f, store, async () => result).sync());
    assert.equal(store.getItem(api.lockKey), before);
  }
  await assert.rejects(client(f, store, async request => {
    const result = await f.send(request);
    store.removeItem(api.lockKey);
    return result;
  }).sync(), code('STALE_RESPONSE'));
  assert.equal(api.hasSession(), false);
});

test('a late response cannot overwrite a newer record using the same secret', async () => {
  const f = fixture(), store = storage(), api = client(f, store);
  await api.join('A');
  let displaced;
  await assert.rejects(client(f, store, async request => {
    const result = await f.send(request);
    const current = JSON.parse(store.getItem(api.lockKey));
    current.serverId = f.uuid();
    displaced = JSON.stringify(current);
    store.setItem(api.lockKey, displaced);
    return result;
  }).sync(), code('STALE_RESPONSE'));
  assert.equal(store.getItem(api.lockKey), displaced);
});
