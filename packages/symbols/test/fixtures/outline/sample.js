'use strict';

const fs = require('fs');
import path from 'node:path';
export { join } from 'node:path';

/**
 * Reads a file.
 */
export function read(file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

function* ids() {
  let i = 0;
  while (true) yield i++;
}

export class Cache extends Map {
  static instances = 0;
  #hits = 0;
  limit;

  constructor(limit) {
    super();
    this.limit = limit;
  }

  get(key) {
    this.#hits++;
    return super.get(key);
  }

  static {
    Cache.instances = 1;
  }
}

export const a = 1, b = (x) => x * 2;
let [first, second] = [1, 2];
module.exports = { read, ids };

export default {
  name: 'sample',
};
