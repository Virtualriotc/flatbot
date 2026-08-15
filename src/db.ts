import Database from 'better-sqlite3';

export type Listing = { id: string; platform: string; title: string; url: string;
  price: number | null; size: number | null; rooms: number | null; address: string | null;
  description: string | null; imageUrls: string[]; discoveredAt: string };

export type ListingRow = Listing & { status: string; score: number | null; reasons: string | null;
  scam: 0 | 1; letter: string | null; statusNote: string | null; updatedAt: string };

export type Db = {
  upsertListing(l: Listing): void;
  /**
   * Returns the number of rows changed — 0 means the id was not there, or `expect` did not match.
   * The sender leases on it: `expect` makes the lease one atomic statement, so a second flatbot
   * process on the same db loses the race instead of sending the same application again.
   */
  setDecision(id: string, d: { status: string; score?: number; reasons?: string; scam?: boolean; letter?: string },
    expect?: string): number;
  setStatusNote(id: string, note: string): number;
  getListing(id: string): ListingRow | undefined;
  findByUrl(url: string): ListingRow | undefined;
  listByStatus(status: string): ListingRow[];                       // oldest discovered first
  countSentSince(platform: string, sinceIso: string): number;       // for the sender's hourly cap
  addFeedback(listingId: string | null, text: string): void;
  recentFeedback(n: number): string[];
  allFeedback(): string[];                                          // newest first, for distillation
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  stats(sinceIso: string): { found: number; asked: number; approved: number; skipped: number; sent: number };
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  price REAL,
  size REAL,
  rooms REAL,
  address TEXT,
  description TEXT,
  image_urls TEXT NOT NULL DEFAULT '[]',
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  score INTEGER,
  reasons TEXT,
  scam INTEGER NOT NULL DEFAULT 0,
  letter TEXT,
  status_note TEXT,
  updated_at TEXT NOT NULL,
  -- stamped once, on the first transition to sent: the hourly cap needs a clock that
  -- later writes (a status note, a reply) cannot move.
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS listings_url_idx ON listings(url);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Raw = {
  id: string; platform: string; title: string; url: string;
  price: number | null; size: number | null; rooms: number | null;
  address: string | null; description: string | null;
  image_urls: string; discovered_at: string;
  status: string; score: number | null; reasons: string | null;
  scam: number; letter: string | null; status_note: string | null; updated_at: string;
};

function toRow(r: Raw | undefined): ListingRow | undefined {
  if (!r) return undefined;
  return {
    id: r.id, platform: r.platform, title: r.title, url: r.url,
    price: r.price, size: r.size, rooms: r.rooms, address: r.address, description: r.description,
    imageUrls: JSON.parse(r.image_urls) as string[], discoveredAt: r.discovered_at,
    status: r.status, score: r.score, reasons: r.reasons,
    scam: r.scam ? 1 : 0, letter: r.letter, statusNote: r.status_note, updatedAt: r.updated_at,
  };
}

/** Every comparison on discovered_at is lexicographic, so it has to be stored in one shape. */
const iso = (v: string): string => (Number.isNaN(Date.parse(v)) ? v : new Date(v).toISOString());

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Databases created before sent_at existed: add it and seed it from the only clock they had.
  if (!(db.pragma('table_info(listings)') as { name: string }[]).some((c) => c.name === 'sent_at')) {
    db.exec(`ALTER TABLE listings ADD COLUMN sent_at TEXT`);
    db.exec(`UPDATE listings SET sent_at = updated_at WHERE status = 'sent'`);
  }

  const insert = db.prepare(`INSERT INTO listings
    (id, platform, title, url, price, size, rooms, address, description, image_urls, discovered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`);
  const decide = db.prepare(`UPDATE listings SET status = ?, score = COALESCE(?, score),
    reasons = COALESCE(?, reasons), scam = COALESCE(?, scam), letter = COALESCE(?, letter),
    updated_at = ?, sent_at = COALESCE(sent_at, CASE WHEN ? = 'sent' THEN ? END)
    WHERE id = ? AND (? IS NULL OR status = ?)`);
  const note = db.prepare(`UPDATE listings SET status_note = ?, updated_at = ? WHERE id = ?`);
  const byId = db.prepare(`SELECT * FROM listings WHERE id = ?`);
  const byUrl = db.prepare(`SELECT * FROM listings WHERE url = ?`);
  const byStatus = db.prepare(`SELECT * FROM listings WHERE status = ? ORDER BY discovered_at ASC, id ASC`);
  const sentSince = db.prepare(`SELECT COUNT(*) AS n FROM listings
    WHERE status = 'sent' AND platform = ? AND sent_at >= ?`);
  const insertFeedback = db.prepare(`INSERT INTO feedback (listing_id, text, created_at) VALUES (?, ?, ?)`);
  // newest-first; id (autoincrement) breaks ties when two entries share a timestamp
  const lastFeedback = db.prepare(`SELECT text FROM feedback ORDER BY created_at DESC, id DESC LIMIT ?`);
  const allFeedbackRows = db.prepare(`SELECT text FROM feedback ORDER BY created_at DESC, id DESC`);
  const readMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`);
  const writeMeta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const countByStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM listings WHERE discovered_at >= ? GROUP BY status`);

  return {
    upsertListing(l) {
      insert.run(l.id, l.platform, l.title, l.url, l.price, l.size, l.rooms, l.address, l.description,
        JSON.stringify(l.imageUrls ?? []), iso(l.discoveredAt), new Date().toISOString());
    },
    setDecision(id, d, expect) {
      const now = new Date().toISOString();
      return decide.run(d.status, d.score ?? null, d.reasons ?? null,
        d.scam === undefined ? null : d.scam ? 1 : 0, d.letter ?? null,
        now, d.status, now, id, expect ?? null, expect ?? null).changes;
    },
    setStatusNote(id, n) {
      return note.run(n, new Date().toISOString(), id).changes;
    },
    getListing(id) { return toRow(byId.get(id) as Raw | undefined); },
    findByUrl(url) { return toRow(byUrl.get(url) as Raw | undefined); },
    listByStatus(status) { return (byStatus.all(status) as Raw[]).map((r) => toRow(r)!); },
    countSentSince(platform, sinceIso) { return (sentSince.get(platform, sinceIso) as { n: number }).n; },
    addFeedback(listingId, text) {
      insertFeedback.run(listingId, text, new Date().toISOString());
    },
    recentFeedback(n) {
      return (lastFeedback.all(n) as { text: string }[]).map((r) => r.text);
    },
    allFeedback() {
      return (allFeedbackRows.all() as { text: string }[]).map((r) => r.text);
    },
    getMeta(key) { return (readMeta.get(key) as { value: string } | undefined)?.value; },
    setMeta(key, value) { writeMeta.run(key, value); },
    stats(sinceIso) {
      const out = { found: 0, asked: 0, approved: 0, skipped: 0, sent: 0 };
      for (const { status, n } of countByStatus.all(sinceIso) as { status: string; n: number }[]) {
        out.found += n;
        if (status === 'asked') out.asked += n;
        else if (status === 'sent') out.sent += n;
        else if (status === 'approved') out.approved += n;
        else if (status === 'skipped_rules' || status === 'skipped_judge') out.skipped += n;
      }
      return out;
    },
    close() { db.close(); },
  };
}
