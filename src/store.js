// Tiny JSON-file store; single process, so whole-file rewrite (atomic rename) is enough.
import fs from 'node:fs';
const FILE = process.env.SQUAD_DB ?? 'data/db.json';
let db = { links: {}, members: {}, copies: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
export const get = () => db;
export function save() {
  fs.mkdirSync(FILE.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
