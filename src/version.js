// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';

/** The version from package.json, e.g. "0.8.0". */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
