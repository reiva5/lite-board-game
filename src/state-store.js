function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('key must be a non-empty string');
  }
}

function assertJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('state must contain only JSON values without cycles');
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('state objects must be plain JSON objects');
  }
  ancestors.add(value);
  if (Reflect.ownKeys(value).some(key => {
    if (array && key === 'length') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)
      || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length));
  })) {
    throw new TypeError('state must not contain symbols, accessors, or non-JSON properties');
  }
  if (array) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new TypeError('state arrays must not contain holes');
      assertJson(value[i], ancestors);
    }
  } else {
    for (const item of Object.values(value)) assertJson(item, ancestors);
  }
  ancestors.delete(value);
}

function serialize(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('state root must be a plain JSON object');
  }
  assertJson(state);
  const text = JSON.stringify(state);
  if (text.length > 50_000) {
    throw new RangeError('serialized state exceeds the 50,000-character cell limit');
  }
  return text;
}

/**
 * A single-cell JSON store. Operations are serialized within this instance only;
 * Google Sheets does not provide compare-and-swap or cross-client transactions.
 */
export function createStateStore({ spreadsheet, sheetName = 'State', cell = 'A1' } = {}) {
  if (typeof spreadsheet?.read !== 'function' || typeof spreadsheet?.write !== 'function') {
    throw new TypeError('spreadsheet must expose read and write functions');
  }
  if (typeof sheetName !== 'string' || !sheetName.trim()) {
    throw new TypeError('sheetName must be a non-empty string');
  }
  if (typeof cell !== 'string' || !/^[A-Za-z]+[1-9]\d*$/.test(cell)) {
    throw new TypeError('cell must identify one cell, for example A1');
  }
  const range = `'${sheetName.replaceAll("'", "''")}'!${cell}`;
  let pending = Promise.resolve();

  function enqueue(operation) {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function read() {
    const rows = await spreadsheet.read(range);
    if (!Array.isArray(rows) || rows.length > 1
        || rows.some(row => !Array.isArray(row) || row.length > 1)) {
      throw new TypeError('state range must return a single cell');
    }
    const text = rows[0]?.[0];
    if (text === undefined || text === '') return undefined;
    if (typeof text !== 'string') throw new TypeError('stored state must be JSON text');
    let state;
    try {
      state = JSON.parse(text);
    } catch (cause) {
      throw new SyntaxError('stored state contains invalid JSON', { cause });
    }
    serialize(state);
    return state;
  }

  async function write(state) {
    const text = serialize(state);
    await spreadsheet.write(range, [[text]]);
    return JSON.parse(text);
  }

  return Object.freeze({
    getState() {
      return enqueue(async () => (await read()) ?? {});
    },
    setState(state) {
      // Snapshot before queuing so caller mutations cannot change the write.
      const text = serialize(state);
      return enqueue(() => write(JSON.parse(text)));
    },
    initialize(initialState = {}) {
      const text = serialize(initialState);
      return enqueue(async () => (await read()) ?? write(JSON.parse(text)));
    },
    get(key) {
      assertKey(key);
      return enqueue(async () => {
        const state = (await read()) ?? {};
        return Object.hasOwn(state, key) ? state[key] : undefined;
      });
    },
    has(key) {
      assertKey(key);
      return enqueue(async () => Object.hasOwn((await read()) ?? {}, key));
    },
    set(key, value) {
      assertKey(key);
      const text = serialize({ [key]: value });
      return enqueue(async () => write({ ...((await read()) ?? {}), ...JSON.parse(text) }));
    },
    update(key, updater) {
      assertKey(key);
      if (typeof updater !== 'function') throw new TypeError('updater must be a function');
      return enqueue(async () => {
        const state = (await read()) ?? {};
        const previous = Object.hasOwn(state, key) ? state[key] : undefined;
        const next = await updater(previous);
        return write({ ...state, [key]: next });
      });
    },
    delete(key) {
      assertKey(key);
      return enqueue(async () => {
        const state = (await read()) ?? {};
        if (!Object.hasOwn(state, key)) return false;
        delete state[key];
        await write(state);
        return true;
      });
    },
    clear() {
      return enqueue(() => write({}));
    },
  });
}
