export function assertRange(range) {
  if (typeof range !== 'string' || range.trim() === '') {
    throw new TypeError('range must be a non-empty A1 notation string');
  }
}

export function assertValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('values must be a non-empty rectangular array');
  }
  const width = values[0]?.length;
  if (!Number.isInteger(width) || width === 0) {
    throw new TypeError('values must contain non-empty rows');
  }
  for (const row of values) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new TypeError('values must be a rectangular array');
    }
    for (const cell of row) {
      if (!['string', 'number', 'boolean'].includes(typeof cell)
          || (typeof cell === 'number' && !Number.isFinite(cell))) {
        throw new TypeError('cells must be strings, finite numbers, or booleans; use "" to empty a cell');
      }
    }
  }
}

/**
 * Adapters expose asynchronous read(range), write(range, values),
 * append(range, values), and clear(range) methods.
 */
export function createSpreadsheet(adapter) {
  for (const method of ['read', 'write', 'append', 'clear']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`adapter.${method} must be a function`);
    }
  }
  return Object.freeze({
    async read(range) {
      assertRange(range);
      return adapter.read(range);
    },
    async write(range, values) {
      assertRange(range);
      assertValues(values);
      return adapter.write(range, values);
    },
    async append(range, values) {
      assertRange(range);
      assertValues(values);
      return adapter.append(range, values);
    },
    async clear(range) {
      assertRange(range);
      return adapter.clear(range);
    },
  });
}
