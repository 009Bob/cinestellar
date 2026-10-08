// SPDX-License-Identifier: GPL-3.0-or-later
// Tiny JSON config file (Plex URL, token, chosen libraries) kept in the data volume.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ConfigStore {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = { plexUrl: '', plexToken: '', libraries: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.data = { ...this.data, ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this.data;
  }

  /** Saves are applied one at a time, each through its own temp file, so they cannot clobber each other. */
  save(patch) {
    const run = async () => {
      this.data = { ...this.data, ...patch };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  get configured() {
    return Boolean(this.data.plexUrl && this.data.plexToken);
  }
}
