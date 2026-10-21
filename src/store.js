// Tiny JSON-file store; single process, so whole-file rewrite (atomic rename) is enough.
import fs from 'node:fs';
const FILE = process.env.SQUAD_DB ?? 'data/db.json';
// Maps keyed by user-influenced ids (link tokens, Telegram ids, callback data) have no prototype, so a key like
// "__proto__" is just a missing entry rather than Object.prototype.
const nullMap = (o = {}) => Object.assign(Object.create(null), o);
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; } // a corrupt store must stop the bot, not boot it empty over live positions
for (const k of ['links', 'members', 'trades', 'copies']) db[k] = nullMap(db[k]);
export const get = () => db;
export function save() {
  fs.mkdirSync(FILE.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 }); // holds members' API-wallet keys
  fs.renameSync(FILE + '.tmp', FILE);
}
