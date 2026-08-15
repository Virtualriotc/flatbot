import Database from 'better-sqlite3';

// users holds password hashes + MCP bearer tokens, settings can hold proxy/SMTP credentials —
// skip both so this script can't dump secrets to a terminal or log.
const SKIP_TABLES = new Set(['users', 'settings']);

const db = new Database(process.argv[2], { readonly: true });
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  if (SKIP_TABLES.has(name)) continue;
  console.log(`\n== ${name} ==`);
  console.log(db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(name).sql);
  console.log(JSON.stringify(db.prepare(`SELECT * FROM ${name} LIMIT 2`).all(), null, 2));
}
