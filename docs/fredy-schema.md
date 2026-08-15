# Fredy schema (captured empirically)

Captured 2026-08-15 by standing up a real Fredy instance, running a live Berlin job across
4 providers, and inspecting the resulting SQLite DB with `scripts/inspect-fredy.mjs`.

- **Fredy repo:** https://github.com/orangecoding/fredy
- **Pinned SHA:** `6a1fbc7a5215e2588b4b1184e06d6562acee41fe`
- **DB file, real relative path:** `db/listings.db`, relative to the Fredy checkout's project
  root (i.e. the directory you run `node index.js` from). Confirmed by reading
  `lib/services/storage/SqliteConnection.js`: it resolves `conf/config.json`'s `sqlitepath`
  (default `/db`, i.e. `<checkout>/db`) and always appends `listings.db`. Only the `db/listings.db`
  *suffix* is verified this way — `config.example.yaml`'s `fredyDbPath: ../fredy/db/listings.db`
  additionally assumes Fredy lives in a sibling directory next to flatbot, which is an operator
  layout choice, not something Task 2 confirmed. Comment there was updated accordingly.
- Default port `9998`, default login `admin` / `admin` (Fredy nags to change it on every boot).

## How the job was run

One job ("Berlin Task2 spike"), 4 providers, broad Berlin apartment-rental search URLs (no price
filter baked in for immoscout/immowelt/wgGesucht — Fredy's own hard filters weren't configured
for this spike, flatbot's own `hard:` config block in `config.example.yaml` is what will do the
real filtering downstream):

| provider id (raw, as stored in `listings.provider`) | search URL used |
|---|---|
| `immoscout` | `https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten` |
| `kleinanzeigen` | `https://www.kleinanzeigen.de/s-wohnung-mieten/berlin/preis:0:1000/wohnungen/k0c203l3331` |
| `wgGesucht` | `https://www.wg-gesucht.de/wohnungen-in-Berlin.8.2.1.0.html` |
| `immowelt` | `https://www.immowelt.de/suche/mieten/wohnung/berlin/berlin-10115/ad08de8634` |

Triggered via `POST /api/jobs/:jobId/run` (immediate manual run, no need to wait on the interval
cron). All 4 providers returned listings: `immoscout` 50, `immowelt` 30, `kleinanzeigen` 27,
`wgGesucht` 28 — 135 rows total in one run.

**Note:** the raw provider id for WG-Gesucht is `wgGesucht` (camelCase G), not `wggesucht`.
`config.example.yaml`'s `platforms: [immoscout, kleinanzeigen, wggesucht, immowelt]` uses a
different casing — Task 4 (the Fredy poller/mapper) needs to map between the two rather than
assume they're interchangeable strings. The normalized `Listing.platform` field is lowercase
(`wggesucht`, matching `config.example.yaml`); the lowercasing happens in the mapper, Fredy's raw
`provider` column stays camelCase (`wgGesucht`) untouched.

## `listings` table DDL (live, post-migration 34)

```sql
CREATE TABLE listings
    (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER,
      hash        TEXT,
      provider    TEXT,
      job_id      TEXT,
      price       INTEGER,
      size        INTEGER,
      title       TEXT,
      image_url   TEXT,
      description TEXT,
      address     TEXT,
      link        TEXT, is_active INTEGER DEFAULT 1, latitude REAL, longitude REAL, manually_deleted INTEGER NOT NULL DEFAULT 0, rooms INTEGER, status JSON, notes TEXT, distances JSONB DEFAULT NULL, last_checked_at INTEGER, inactive_since INTEGER, active_check_failures INTEGER DEFAULT 0, previous_price INTEGER, price_changed_at INTEGER, last_price_check_at INTEGER, address_is_manual INTEGER NOT NULL DEFAULT 0, travel_times_at INTEGER, travel_times_failures INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    )
```

The base table (migration 1) only had `id, created_at, hash, provider, job_id, price, size,
title, image_url, description, address, link`. Everything after `link` in the DDL above was
added by later migrations (rooms in `16`, geocoordinates in `7`, soft-delete/active flags in `2`
and `10`, price history in `28`, etc.) — the columns flatbot cares about (`price`, `size`,
`rooms`, `title`, `address`, `description`, `image_url`, `link`, `created_at`, `provider`) have
been stable since early on.

## 2 real sample rows (unredacted — public listing data)

```json
{
  "id": "mojrLdoPAMzPWlt_0w-np",
  "created_at": 1786787328142,
  "hash": "ab85a264d5f7203fcfa10a8b23e2f8257137e23e039d13f018efdf6a14cfab2d",
  "provider": "immoscout",
  "job_id": "ChCGd1d0l4GTabLrt1UJj",
  "price": 1450,
  "size": 55,
  "title": "2-Zimmer-Wohnung in Steglitz",
  "image_url": null,
  "description": null,
  "address": "Birkbuschstraße 35, 12167 Berlin, Steglitz",
  "link": "https://www.immobilienscout24.de/expose/170037125",
  "is_active": 1,
  "latitude": null,
  "longitude": null,
  "rooms": 2
}
```

```json
{
  "id": "aRc_YFILzD4dklCIT7ahy",
  "created_at": 1786787362568,
  "hash": "12c3027a0c7edf7e9f1ca13de59873b49af2a4b1b39bca1d8c7c6e4cb6ee2c72",
  "provider": "kleinanzeigen",
  "job_id": "ChCGd1d0l4GTabLrt1UJj",
  "price": 798,
  "size": 17,
  "title": "Neon Wood Student Housing in Berlin Adlershof - Classic Apartment",
  "image_url": "https://img.kleinanzeigen.de/api/v1/prod-ads/images/2e/2e9169bf-ee7a-445f-b9c6-37279c5bf709?rule=$_59.AUTO",
  "description": "Neon Wood Student Housing in Berlin Adlershof - Classic Apartment Für Deutsch bitte...",
  "address": "12489 Köpenick",
  "link": "https://www.kleinanzeigen.de/s-anzeige/neon-wood-student-housing-in-berlin-adlershof-classic-apartment/3483895855-203-3367",
  "is_active": 1,
  "latitude": null,
  "longitude": null,
  "rooms": 1
}
```

(Full raw dump of every other table is what `scripts/inspect-fredy.mjs` prints — run it yourself
against a live `db/listings.db` to see the rest, e.g. `jobs`. **It deliberately skips `users` and
`settings`**: `users` holds the admin's password hash and MCP bearer token, `settings` can hold
proxy/SMTP credentials — printing those to your terminal/logs is a real leak, not a hypothetical
one, so don't remove that filter to "just see everything.")

## Which `Listing` fields actually exist

| flatbot field | Fredy column | present? |
|---|---|---|
| id | `id` | always (nanoid, TEXT PK) |
| platform | `provider` | always — raw values seen: `immoscout`, `kleinanzeigen`, `wgGesucht`, `immowelt` |
| title | `title` | always, in every row across all 4 providers |
| url | `link` | always |
| price | `price` | always an already-parsed INTEGER (euros, no "€" suffix, no decimals) — providers do the string→number parsing themselves before storage |
| size | `size` | always an already-parsed INTEGER/REAL (m², no "m²" suffix) |
| rooms | `rooms` | already-parsed, but **not always an INTEGER** — 12/148 rows in our live DB are `REAL` (half-rooms, e.g. `1.5`, `2.5`, `4.5` — spread across all 4 providers: immoscout 6, immowelt 2, kleinanzeigen 2, wgGesucht 2). Treat `rooms` as a number, not an int. |
| address | `address` | always populated for all 4 providers we captured live data from; format varies a lot by provider (full street address for immoscout/immowelt, postal-code-only for some kleinanzeigen ads) |
| description | `description` | **NULL for all 50/50 immoscout rows** (with enrichment off, Fredy's default) — immoscout only gets a description if the "fetch provider details" enrichment step runs (`settings.provider_details`, empty array `[]` out of the box). kleinanzeigen, wgGesucht, and immowelt all populate it directly from the search-results page. |
| images | `image_url` | **singular column, not a gallery** — Fredy only keeps one image URL per listing, not an array. 48/50 immoscout rows had one; 2/50 had `null`. kleinanzeigen, wgGesucht, and immowelt always had one in our sample. |

Measured null counts per provider (current DB, `SUM(col IS NULL)` grouped by `provider`):

| provider | rows | price null | size null | rooms null | address null | description null | image_url null |
|---|---|---|---|---|---|---|---|
| immoscout | 54 | 0 | 0 | 0 | 0 | 50 | 2 |
| immowelt | 30 | 0 | 0 | 0 | 0 | 0 | 0 |
| kleinanzeigen | 29 | 0 | 0 | 0 | 0 | 0 | 0 |
| wgGesucht | 35 | 0 | 0 | 0 | 0 | 0 | 0 |

immowelt has zero nulls across every relevant column in our sample — full data every time.

**Schema surprise for Task 4:** the target `Listing.imageUrls` is a `string[]`, but Fredy only
ever gives you 0 or 1 image. The natural mapping is `image_url ? [image_url] : []`.

**Schema surprise for Task 4 (2):** `description` is systematically null for one entire provider
(immoscout) unless you turn on detail-page enrichment in Fredy's settings, which the brief didn't
ask us to do (it also makes immoscout more bot-detectable, per Fredy's own migration 14 comment).
Don't treat a null description as evidence of a scraping bug — it's expected for immoscout.

## Watermark column

**Use `rowid`, not `created_at`.** An earlier version of this doc recommended `created_at` on the
theory that `Date.now()` is called per row inside `storeListings()`'s insert loop
(`lib/services/storage/listingsStorage.js:709`) — true, but `Date.now()` only has 1ms resolution,
and a single provider's whole batch of new listings gets inserted in a tight loop that regularly
finishes inside one millisecond. Measured on the live DB (148 rows): **146 of 148 rows share their
`created_at` with at least one other row.** A poller filtering `WHERE created_at > :lastSeen` would
silently skip every row from the same millisecond as `:lastSeen` on the next poll. Duplicate groups
observed:

| created_at (ms) | provider | rows sharing it |
|---|---|---|
| 1786787328142 | immoscout | 32 |
| 1786787459887 | immowelt | 30 |
| 1786787405733 | wgGesucht | 28 |
| 1786787362568 | kleinanzeigen | 27 |
| 1786787328143 | immoscout | 17 |
| 1786788106180 | wgGesucht | 6 |
| 1786788079253 | immoscout | 4 |
| 1786788087136 | kleinanzeigen | 2 |

`rowid` (SQLite's implicit row id — present because `id` is a non-INTEGER primary key, so this
isn't a `WITHOUT ROWID` table) has none of that problem: it's assigned once per insert, strictly
increasing, and unique by construction. Checked against insertion order on the live DB — zero
inversions. Use `WHERE rowid > :lastSeen ORDER BY rowid ASC`.

`created_at` is still the right source for the normalized `Listing.discoveredAt` field (it's the
actual wall-clock insert time) — just don't use it as the pagination/watermark key.

`id` is a nanoid — safe as a dedup key but not monotonic, don't use it for the watermark either.

## Fredy left running

Backend was started with `NODE_ENV=production node index.js` (via `yarn run start:backend`) as a
detached background process inside `fredy/`, logging to `fredy-backend.log` at the repo root.
Left running per controller instruction so later tasks can accumulate more listings.
