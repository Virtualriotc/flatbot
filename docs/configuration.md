# flatbot configuration reference

Everything the [README](../README.md) leaves out: every `config.yaml` key, the Telegram and CLI
surface, the two send backends, and what to check when something is quiet. The operator's runbook —
install order, Fredy's settings, the first-live-send checklist — is [deploy-laptop.md](deploy-laptop.md).

`config.yaml` is read from the directory you run `flatbot` in, which is your checkout. It is
gitignored; `config.example.yaml` is the template. Every relative path in it resolves against the
directory holding it, not against your shell's cwd.

**A missing key is never a disabled filter.** `flatbot` refuses to start when any of
`hard.maxWarmRent`, `hard.minSqm`, `hard.minRooms`, `hard.maxRooms`, `hard.stalenessCutoffHours` or
`fredyDbPath` is missing or non-numeric, and when `llm.provider` or `sender.backend` is a name it does
not know. `openai-compatible` additionally requires `llm.baseUrl` and `llm.model`. The error names
every offending key at once.

## hard — the deterministic filter

Runs before any LLM call. A field the portal did not provide (`null`, or text that will not parse) is
treated as uncertainty, never as a violation — the judge deals with the doubt. The first failing check
wins and ends the listing as `skipped_rules`, with the reason stored.

| Key | Default | Meaning |
|---|---|---|
| `hard.maxWarmRent` | required | Reject above this price. Fredy stores one price number per listing; whether that is warm or cold rent depends on the portal. |
| `hard.minSqm` | required | Reject anything smaller. |
| `hard.minRooms` / `hard.maxRooms` | required | Reject outside this range. Halves (`1.5`) work. |
| `hard.stalenessCutoffHours` | required | Reject listings older than this, measured from Fredy's insert time. Stops a laptop that was asleep from applying to week-old ads on restart. Re-checked again just before a send, because a listing can sit in the queue for days. |
| `hard.city` | no default, but do set it | Geography check, and the only rule whose miss is *soft*. See below. |
| `hard.districtBlocklist` | `[]` | Hard reject on a whole-word match against the address. `Mitte` blocks `Berlin-Mitte` and leaves `Mittenwalder Straße` alone. |

`hard.city` is matched against the address **and** the title, because portals routinely give a
district-only address (`12489 Köpenick`) and put the city in the title. It is matched word by word,
case-insensitively, so `Frankfurt am Main` still matches an address that only says `60313 Frankfurt`.
A miss does not reject: the listing goes to the judge and always reaches you as an ask, its reasons
prefixed `⚠️ … not in <city>`, and never goes to the sender. That is deliberate — the field is free
text nobody validates, and a spelling the portal does not use (`Muenchen` for `München`) would
otherwise reject every listing in existence, silently. A listing with no address at all is not checked
on geography at all. An empty string turns the check off; omitting the key entirely is not the same
thing — every listing that carries an address then fails with a runtime error and is stored as
`error`. Set it, or set it empty.

Word matching (city and blocklist) uses Unicode-aware boundaries rather than `\b`, so terms ending in
`ß` or starting with an umlaut behave.

## thresholds

| Key | Default | Meaning |
|---|---|---|
| `thresholds.apply` | `75` | Score at or above this means "apply" — a receipt in shadow mode, a queued send in auto mode. |
| `thresholds.ask` | `50` | At or above this, below `apply`: ask you. Below it: silence, stored as `skipped_judge`. |

The defaults apply to the **whole block**. A `thresholds:` block containing only one of the two keys
leaves the other undefined, and every comparison against it is false — with only `apply` set,
everything below it is skipped in silence rather than asked about. Set both keys or neither.

A suspected scam is downgraded from "apply" to "ask" before anything else happens, so no listing the
judge distrusts can be sent without a human seeing it.

## preferences, profile, platforms

| Key | Default | Meaning |
|---|---|---|
| `preferences` | `''` | Free text, any language, pasted verbatim into the judge prompt. Write it the way you would tell a friend. |
| `profile` | `''` | Free text about you as a tenant — job, income situation, pets, smoker, documents. The letter writer may use nothing beyond this and is told to invent nothing, so include **your name**: it signs the letter with it. |
| `platforms` | `[]` | Which platform ids to accept: `immoscout`, `kleinanzeigen`, `wggesucht`, `immowelt`. An empty list means no filter. Fredy's own provider ids are camelCase (`wgGesucht`); flatbot lowercases them before comparing. |

## llm

| Key | Default | Meaning |
|---|---|---|
| `llm.provider` | `claude-cli` | `claude-cli` shells out to `claude -p` and uses your existing CLI login — no API key, nothing extra on a subscription. `openai-compatible` posts to `<baseUrl>/chat/completions` with a Bearer key. |
| `llm.model` | — | Required for `openai-compatible`. Ignored by `claude-cli`. Also used as the send model by the `browser-use` backend, which falls back to `gemini-2.5-flash`. |
| `llm.baseUrl` | — | `openai-compatible` only, and required there. `/chat/completions` is appended, so do not include it. |
| `llm.apiKeyEnv` | `LLM_API_KEY` | Name of the environment variable holding the API key. |

## Paths

| Key | Default | Meaning |
|---|---|---|
| `fredyDbPath` | required | Fredy's `db/listings.db`. Opened read-only; flatbot never writes to it and never scrapes a portal itself. New listings are found by `rowid`, not by timestamp — Fredy writes a whole provider batch inside the same millisecond. |
| `dbPath` | `./flatbot.sqlite` | flatbot's own state: listings, statuses, scores, letters, feedback, watermark, mode. `learned.md` is written next to it. |

## sender

Only consulted in auto mode. The whole block is optional in the file; leaving it out gives you the
defaults below. Sending is gated on the mode, not on the block being present.

| Key | Default | Meaning |
|---|---|---|
| `sender.backend` | `claude-agent` | `claude-agent` (supported) or `browser-use`. **Changing this gives up the only enforced limit on what the send agent can do** — read [Send backends](#send-backends) first. |
| `sender.hourlyCapPerPlatform` | `3` | Never more than this many applications per platform per rolling hour. A capped platform is skipped, not queued behind. |
| `sender.minDelayMinutes` | `2` | Lower bound of the random wait before each send. |
| `sender.maxDelayMinutes` | `8` | Upper bound. A value below the minimum is pinned to the minimum rather than meaning "no wait". |
| `sender.profileDir` | `./browser-profile` | Persistent browser profile holding your portal logins. Gitignored. Anyone with this directory is logged in as you. |
| `sender.screenshotDir` | `./screenshots` | Confirmation screenshots, one per send attempt. Gitignored. Also the Playwright MCP server's output directory — it refuses to write anywhere else. |

Environment variables (`.env`, plus the `FLATBOT_*` overrides you normally never set) are documented in
[deploy-laptop.md § flatbot](deploy-laptop.md#2-flatbot).

## CLI

```
flatbot init              interactive setup (token, chat id, preferences, config.yaml)
flatbot login [platform]  open a portal (or every enabled one) to log in once, headed
flatbot run               poll Fredy every 60s, judge, notify Telegram
flatbot status            counts, mode and watermark
flatbot dryrun <url>      re-judge one known listing with live LLM calls, write nothing
flatbot doctor            check node, config, Fredy db, Telegram, the LLM and the send path
flatbot chatid            print the chat id of whoever last messaged the bot
```

Every one of them reads `config.yaml` from the working directory, so run them from your checkout.

`init` refuses to overwrite an existing `config.yaml` — a re-run would wipe your tuned preferences and
re-park the watermark, silently skipping everything collected since. It also parks the watermark at
Fredy's newest row on a fresh setup, so the first `run` judges only new listings instead of paying for
the backlog.

`dryrun` only works on a listing flatbot already stored. It is the way to test a `config.yaml` edit
against a real listing without waiting for a new one, and it writes nothing.

`doctor` runs ten checks and keeps going after a failure, so one pass shows every problem: Node
version, `config.yaml`, Fredy's DB (with its row count — `0 rows` is a *pass*, it only proves the file
opens), flatbot's DB directory, Telegram `getMe`, one live LLM round-trip, then four that only auto
mode needs (Chrome, the CDP endpoint, the backend's binaries, the browser profile). Those four print
`⏭️ skipped` in shadow mode, which is neither pass nor failure. Non-zero exit if anything failed.

## Telegram

The bot only talks to one chat: the id in `TELEGRAM_CHAT_ID`. Updates from anywhere else are dropped
without a reply.

| Command | Effect |
|---|---|
| `/stats` | found / asked / approved / skipped / sent / manual / failed over the last 7 days |
| `/pause` | Stop polling and stop sending. Re-checked after a send's delay, so it also cancels a send already waiting. |
| `/resume` | Undo `/pause`. |
| `/auto` | Auto mode: approved and apply-tier listings get submitted. |
| `/shadow` | Back to shadow mode; nothing is sent. Also releases a send that is waiting out its delay, returning the listing to the queue. |
| `/status <id> <note>` | Attach a free-text note to a listing (`/status 4f2a viewing friday`). An unknown id is refused rather than silently swallowed. |
| `/start`, `/help` | Print the command list. |

`/auto` and `/shadow` both stamp the moment of the flip. Only approvals made after the flip are
sendable, so one `/auto` cannot drain a whole shadow-run backlog of tapped listings.

**The `#<listing-id>` trailer** on every bot message is the entire reply-mapping mechanism: reply to a
message and your text is filed against that listing.

**Buttons.** Each ask carries ✅ and ❌. In shadow mode ✅ records approval; in auto mode it queues the
listing for sending. Tapping either on a listing that has already moved on — queued, mid-send, sent,
failed, handed back for manual sending, or rejected — changes nothing and answers with the status it
already has. The buttons are removed from the message once a verdict is recorded.

**Free-text feedback.** Any message that is not a command is stored as feedback and acknowledged with
👍. Replying to a listing's message ties it to that listing; a standalone message is global. The 20
newest memos go verbatim into every judge prompt, so a correction takes effect on the next listing.

**Learning.** At most once a week, everything older than those newest 20 memos is compressed by the
LLM into at most 10 short lessons and written to `learned.md` next to your database. That file is
yours: read it, edit it, delete it. flatbot only overwrites it at the next weekly distillation, and a
blank or failed LLM reply leaves the existing file alone.

## Send backends

> **The two are not equivalent, and the difference is a security boundary, not a preference.**
> `claude-agent` is the supported default: the agent is held to eight browser actions by flags, so a
> prompt injection in a listing cannot make it do anything else. `browser-use` has **no tool
> restriction at all** — there the "only fill contact forms" rule is a sentence in a prompt, and
> nothing stops the agent doing something else with your logged-in portal session while it reads text
> written by strangers. It is also unfinished: it needs a wrapper script you write yourself. Choose it
> only if you understand that you are giving up the containment, and never leave it unattended.

| | `claude-agent` | `browser-use` |
|---|---|---|
| Runs | `claude -p` with a pinned [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`0.0.79`) attached over CDP to the Chrome `flatbot run` launched from your profile | `uvx browser-use` with your profile directory |
| Needs | the `claude` CLI logged in, `npx`, Google Chrome | `uv`, **plus a wrapper script you write** (see below) |
| Cost | nothing extra on a Claude subscription | any LLM key; the free Gemini tier is enough |
| Tool restriction | eight browser tools, enforced by flags | **none — prompt text only** |
| Timeout | 900 s (`FLATBOT_SEND_TIMEOUT_MS`) | 600 s |

The wrapper: flatbot invokes the CLI as
`<bin> --prompt-file <file> --user-data-dir <profile> --model <model>`, and the published `browser-use`
CLI (package `0.13.7`) is a Python-script driver that accepts none of those flags. Point
`FLATBOT_BROWSERUSE_BIN` / `FLATBOT_BROWSERUSE_ARGS` at a script of yours that translates them;
without it every send fails, and `flatbot doctor` fails the sender-tooling check on purpose rather
than letting you find out at send time.

Both backends get the same prompt shape, the same per-portal instructions from `src/platforms.ts`, and
the same guardrail sentence quoted verbatim:

> The sender agent may only fill and submit contact/message forms — never change account settings,
> never pay, never upload documents.

Both also fence the listing text and your letter behind a per-send random nonce, so text scraped off a
portal cannot close the block and issue instructions to the agent. That sentence and that fence are
advice to a model. Only `claude-agent` also *enforces* the limit, by never handing the agent a tool
that could do anything else — `--tools ""`, the rest of the MCP surface in `--disallowedTools`,
`--strict-mcp-config`, and an empty scratch directory as its cwd. The full flag-by-flag account, the
attack that proved `--allowedTools` alone is not a boundary, and what to re-check after a `claude`
upgrade are in [deploy-laptop.md § the claude-agent tool grant](deploy-laptop.md#known-caveat-the-claude-agent-tool-grant).

Screenshots are the audit trail. A send counts as confirmed only when the agent saw one of the
portal's own success strings **and** a screenshot exists on disk. Agent-claimed but no screenshot is
still booked as sent, flagged `unconfirmed — no screenshot in <dir>; check the portal` (it names the
directory rather than a file that is not there); a screenshot with no success string points at the
file instead. A paywall marker, an error or a crash all end as `fallback_manual`: Telegram hands you
the letter and the link. flatbot never re-tries a send by itself.

## Troubleshooting

**No listings appear.** Check the layers in order. Does Fredy have new rows (its UI on `:9998`)? Does
`flatbot doctor` report a non-zero row count for the Fredy DB? Does the watermark in `flatbot status`
move? Remember that `init` parked the watermark at Fredy's newest row, so nothing that existed before
setup is ever judged. After that the usual causes are: `platforms` missing the id Fredy actually
writes, hard limits so tight that everything is rejected before the judge, a `stalenessCutoffHours`
shorter than your polling gap, or the bot being `/pause`d. A wall of `⚠️ … not in <city>` asks means
`hard.city` is not the spelling the portal uses.

**Telegram is silent.** `flatbot doctor` should print your bot's `@username`. If it does and you still
get nothing, the chat id is wrong — the bot ignores every chat but the one in `.env`. Message the bot,
run `flatbot chatid`, fix `TELEGRAM_CHAT_ID`, restart. If `doctor` fails at the Telegram check, the
token is wrong or the machine cannot reach `api.telegram.org`.

**LLM errors.** `doctor` sends one prompt and demands the word "pong" back. `claude-cli` failures are
almost always the binary missing from PATH or an expired login — run `claude -p hi` by hand. For
`openai-compatible` the HTTP status is printed: 401 is a missing or wrong key in the variable named by
`llm.apiKeyEnv`, 404 usually means `baseUrl` already contained `/chat/completions`. A listing that
fails judging is stored as `error` with the message, so it is not lost — but nothing retries it.

**Nothing is sent although auto mode is on.** Every candidate platform may be at its hourly cap. Or
there is no browser: `claude-agent` drives a Chrome that `flatbot run` launches, and if Chrome is
missing you get one Telegram warning per process and the listings stay queued rather than being
burned. Chrome also refuses to hand over a debugging port that something else already holds — flatbot
will not drive a browser it did not start, so close the other one or set `FLATBOT_CDP_PORT`.

**`fallback_manual`.** The designed outcome whenever a send did not clearly succeed: paywall, unknown
platform, no letter written, a listing that went stale in the queue, or a crashed agent. The Telegram
message carries the reason, the link and the full letter — send it by hand. If it happens on every
attempt for one portal, log in again (`flatbot login <platform>`) and open the screenshot to see what
the agent actually saw. Switching to `browser-use` is not an escape: it needs the wrapper script above
and drops the tool restriction entirely.

**A send was interrupted.** At startup, rows still waiting out their delay are quietly requeued —
nothing was submitted. Rows the backend had already been handed become `fallback_manual` with a
warning that the application may already have gone through: check the portal before re-sending. Both
leases are conditional updates, so a second `flatbot run` on the same database loses the race instead
of sending a duplicate.

## Keeping it running

`flatbot run` is a foreground process, and Fredy is a second one with its own lifetime. The pm2,
launchd, systemd and `schtasks` recipes — and the reason every one of them must set the working
directory explicitly — are in [deploy-laptop.md § keep it running](deploy-laptop.md#6-keep-it-running).
`flatbot init` prints the same text at the end of setup.
