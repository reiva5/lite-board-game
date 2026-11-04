import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStateStore,
  createSpreadsheet,
  createGoogleSheetsAdapter,
} from '../src/index.js';

function fixture(initial) {
  let text = initial;
  const writes = [];
  const reads = [];
  const spreadsheet = {
    async read(range) {
      reads.push(range);
      return text === undefined ? [] : [[text]];
    },
    async write(range, values) {
      writes.push({ range, values });
      text = values[0][0];
    },
  };
  return {
    spreadsheet,
    store: createStateStore({ spreadsheet }),
    writes,
    reads,
    replace(value) { text = value; },
    text: () => text,
  };
}

test('initializes empty storage once and survives a new instance', async () => {
  const f = fixture();
  assert.deepEqual(await f.store.getState(), {});
  assert.equal(f.writes.length, 0);
  const initial = { turn: 0, players: ['Alice'], active: false, extra: null };
  assert.deepEqual(await f.store.initialize(initial), initial);
  assert.deepEqual(await f.store.initialize({ turn: 100 }), initial);
  const second = createStateStore({ spreadsheet: f.spreadsheet });
  assert.deepEqual(await second.getState(), initial);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].range, "'State'!A1");
});

test('basic CRUD preserves falsy values and treats missing keys explicitly', async () => {
  const { store, text } = fixture();
  assert.equal(await store.get('missing'), undefined);
  assert.equal(await store.has('toString'), false);
  assert.deepEqual(await store.set('turn', 0), { turn: 0 });
  await store.set('ready', false);
  await store.set('name', '');
  await store.set('optional', null);
  assert.equal(await store.has('optional'), true);
  assert.equal(await store.get('optional'), null);
  assert.equal(await store.get('ready'), false);
  assert.equal(await store.get('name'), '');
  assert.equal(await store.get('turn'), 0);
  assert.equal(await store.delete('turn'), true);
  assert.equal(await store.delete('turn'), false);
  assert.deepEqual(await store.setState({ replacement: true }), { replacement: true });
  assert.deepEqual(await store.clear(), {});
  assert.equal(text(), '{}');
});

test('deleting from absent or empty storage does not initialize or write a cell', async () => {
  for (const initial of [undefined, '']) {
    const f = fixture(initial);
    assert.equal(await f.store.delete('missing'), false);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.reads, ["'State'!A1"]);
    assert.equal(f.text(), initial);
  }
});

test('special object keys are own data, never prototype mutations', async () => {
  const { store } = fixture();
  await store.set('__proto__', { polluted: true });
  await store.set('constructor', 'data');
  assert.deepEqual(await store.get('__proto__'), { polluted: true });
  assert.equal(await store.has('__proto__'), true);
  assert.equal(await store.get('constructor'), 'data');
  assert.equal({}.polluted, undefined);
  await store.delete('__proto__');
  assert.equal(await store.get('__proto__'), undefined);
});

test('updates are serialized including async callbacks and simultaneous calls', async () => {
  const { store } = fixture();
  await Promise.all(Array.from({ length: 30 }, () => store.update('count', async count => {
    await new Promise(resolve => setImmediate(resolve));
    return (count ?? 0) + 1;
  })));
  assert.equal(await store.get('count'), 30);
  const [, value] = await Promise.all([store.set('count', 40), store.get('count')]);
  assert.equal(value, 40);
});

test('re-reads external changes rather than returning stale cached state', async () => {
  const f = fixture('{"count":1}');
  assert.equal(await f.store.get('count'), 1);
  f.replace('{"count":2,"other":true}');
  assert.deepEqual(await f.store.update('count', count => count + 1), { count: 3, other: true });
  f.replace('');
  assert.deepEqual(await f.store.initialize({ fresh: true }), { fresh: true });
});

test('input and output references cannot mutate persisted snapshots', async () => {
  const f = fixture();
  const input = { nested: { cards: [1, 2] } };
  const promise = f.store.setState(input);
  input.nested.cards.push(3);
  const result = await promise;
  result.nested.cards.push(4);
  const read = await f.store.get('nested');
  read.cards.push(5);
  assert.deepEqual(await f.store.getState(), { nested: { cards: [1, 2] } });
  const value = { cards: [7] };
  const write = f.store.set('nested', value);
  value.cards.push(8);
  await write;
  assert.deepEqual(await f.store.get('nested'), { cards: [7] });
  const initial = { cards: [9] };
  const empty = fixture();
  const init = empty.store.initialize(initial);
  initial.cards.push(10);
  await init;
  assert.deepEqual(await empty.store.getState(), { cards: [9] });
});

test('corrupt or wrong-shaped state is surfaced without overwriting', async () => {
  for (const initial of ['bad JSON', 'null', '[]', '1', 'true', '"string"', 12, null, '{"x":1e999}']) {
    const f = fixture(initial);
    await assert.rejects(f.store.getState());
    await assert.rejects(f.store.initialize({ safe: true }));
    await assert.rejects(f.store.set('key', 1));
    assert.equal(f.writes.length, 0);
    assert.equal(f.text(), initial);
  }
});

test('configuration and key validation reject invalid inputs', () => {
  assert.throws(() => createStateStore(), /spreadsheet/);
  const { spreadsheet, store } = fixture();
  for (const cell of ['A0', 'A1:B2', 'Sheet!A1', '$A$1', '', 1]) {
    assert.throws(() => createStateStore({ spreadsheet, cell }), /cell/);
  }
  assert.throws(() => createStateStore({ spreadsheet, sheetName: '' }), /sheetName/);
  for (const key of ['', null, undefined, 1]) {
    for (const method of ['get', 'has', 'set', 'update', 'delete']) {
      assert.throws(() => store[method](key, 1), /key/);
    }
  }
  assert.throws(() => store.update('x', 1), /updater/);
});

test('rejects lossy non-JSON values before changing storage', async () => {
  const f = fixture('{"keep":true}');
  const cyclic = {};
  cyclic.self = cyclic;
  const extra = [];
  extra.label = 'lost';
  const numericExtra = [];
  numericExtra[4294967295] = 'lost';
  const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { return 1; } });
  const hidden = Object.defineProperty({}, 'x', { value: 1 });
  const symbol = { [Symbol('x')]: true };
  const invalid = [
    undefined, () => {}, Symbol('x'), 1n, NaN, Infinity, new Date(),
    new Map(), new Set(), cyclic, [, 1], extra, numericExtra, accessor, hidden, symbol,
    { nested: undefined }, Object.create({ inherited: true }),
  ];
  for (const value of invalid) {
    assert.throws(() => f.store.set('x', value), TypeError);
  }
  for (const root of [null, [], 42, true, 'text']) {
    assert.throws(() => f.store.setState(root), /root/);
  }
  assert.equal(f.writes.length, 0);
  assert.deepEqual(await f.store.getState(), { keep: true });
});

test('cell size limit accepts the exact boundary and rejects overflow', async () => {
  const f = fixture();
  const overhead = JSON.stringify({ x: '' }).length;
  await f.store.setState({ x: 'a'.repeat(50_000 - overhead) });
  assert.equal(f.text().length, 50_000);
  assert.throws(() => f.store.setState({ x: 'a'.repeat(50_001 - overhead) }), RangeError);
  assert.equal(f.writes.length, 1);
});

test('rejected updater does not write and queue recovers', async () => {
  const f = fixture('{"count":1}');
  const error = new Error('cannot update');
  await assert.rejects(f.store.update('count', async () => { throw error; }), e => e === error);
  await assert.rejects(f.store.update('count', () => undefined), TypeError);
  assert.equal(f.writes.length, 0);
  await f.store.update('count', count => count + 1);
  assert.equal(await f.store.get('count'), 2);
});

test('failed reads and writes propagate and do not poison later operations', async () => {
  const f = fixture('{"count":1}');
  const originalWrite = f.spreadsheet.write;
  const offline = new Error('offline');
  f.spreadsheet.write = async () => { throw offline; };
  await assert.rejects(f.store.set('count', 2), e => e === offline);
  assert.equal(f.text(), '{"count":1}');
  f.spreadsheet.write = originalWrite;
  const originalRead = f.spreadsheet.read;
  f.spreadsheet.read = async () => { throw offline; };
  await assert.rejects(f.store.initialize(), e => e === offline);
  f.spreadsheet.read = originalRead;
  assert.deepEqual(await f.store.set('count', 3), { count: 3 });
});

test('state store rejects malformed adapter rows', async () => {
  for (const rows of [null, {}, [null], [['{}'], ['{}']], [['{}', 'extra']]]) {
    const spreadsheet = {
      async read() { return rows; },
      async write() { assert.fail('must not overwrite'); },
    };
    await assert.rejects(createStateStore({ spreadsheet }).initialize(), /single cell/);
  }
});

test('state round-trips through the full Google adapter HTTP boundary', async () => {
  let persisted;
  const requests = [];
  const spreadsheet = createSpreadsheet(createGoogleSheetsAdapter({
    spreadsheetId: 'integration',
    accessToken: 'test-token',
    fetch: async (url, options) => {
      requests.push(new URL(url));
      if (options.method === 'GET') {
        return Response.json(persisted === undefined ? {} : { values: [[persisted]] });
      }
      assert.equal(options.method, 'PUT');
      persisted = JSON.parse(options.body).values[0][0];
      return Response.json({ updatedCells: 1 });
    },
  }));
  const options = { spreadsheet, sheetName: "Player's State", cell: 'B2' };
  const store = createStateStore(options);
  await store.initialize({ round: 1 });
  await store.set('cards', ['001', '=1+2', null]);
  await store.update('round', round => round + 1);
  assert.deepEqual(await createStateStore(options).getState(), {
    round: 2, cards: ['001', '=1+2', null],
  });
  assert.ok(requests.every(url => decodeURIComponent(url.pathname)
    .endsWith("/values/'Player''s State'!B2")));
});
