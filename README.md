# flatbot

flatbot watches German rental portals (ImmobilienScout24, Kleinanzeigen, WG-Gesucht, Immowelt)
through [Fredy](https://github.com/orangecoding/fredy), which does the scraping and writes every
listing into a local SQLite file. flatbot polls that file, throws out anything that violates your
hard limits (price, size, rooms, districts, staleness), and sends what survives to an LLM judge that
scores it against a plain-English description of what you want. Anything good enough gets a German
application letter written for it, and — once you explicitly turn on auto mode — submitted through
the portal's own contact form by a browser agent. Telegram is the entire user interface: it asks you
about borderline flats, you answer in plain language, and that feedback goes back into the judge.

```
Fredy (scrapes portals -> listings.db)  ->  flatbot: hard rules -> LLM judge -> LLM letter writer
                                                      -> Telegram ask  (shadow mode, the default)
                                                      -> browser agent submits the form (auto mode)
```

Nothing is ever sent to a landlord until you turn auto mode on yourself.

## Requirements

- **Node >= 22** (checked by `flatbot doctor`), and **git**.
- **Fredy**, cloned and running separately. flatbot reads its SQLite file read-only and never scrapes
  a portal itself.
- **A Telegram bot token** from [@BotFather](https://t.me/BotFather), plus the chat id of your own
  chat with that bot.
- **An LLM**, one of:
  - `claude-cli` (default) — the `claude` CLI on your PATH, already logged in, used headlessly as
    `claude -p`. Zero marginal cost on a Claude subscription.
  - `openai-compatible` — any endpoint exposing `POST <baseUrl>/chat/completions` with a Bearer key
    (OpenAI, a local llama.cpp/Ollama-compatible server, OpenRouter, ...).
- **For auto mode only**: **Google Chrome installed** — the send browser drives your real Chrome, so
  nothing is downloaded at install time and nothing works without it. Plus a send backend: the
  `claude` CLI and `npx` (`claude-agent`, the supported default), or `uv`/`uvx` (`browser-use`, an
  escape hatch that needs a wrapper script you write yourself and restricts nothing the agent does —
  see [Auto mode](#auto-mode)). An always-on machine on a **residential** connection — portals block
  datacenter IPs far more aggressively than home ones, so a cloud VM works badly.

## Quickstart

Target: a curated Telegram feed of flats with draft letters, in well under 30 minutes. This
quickstart stops at shadow mode, which sends nothing to anyone.

**1. Get Fredy running.**

```sh
git clone https://github.com/orangecoding/fredy
cd fredy && npm i && node index.js
```

Open `http://localhost:9998` (default login `admin` / `admin` — change it immediately), create a job
with a search URL per portal you care about, and let it run once. Details and the one non-obvious
setting are in [docs/deploy-laptop.md](docs/deploy-laptop.md).

**2. Install flatbot.**

```sh
git clone https://github.com/Virtualriotc/flatbot.git flatbot  
cd flatbot && npm i && npm run build
```

Either use `node dist/index.js <command>` everywhere below, or `npm link` once so the `flatbot`
binary is on your PATH. During development `npm run dev -- <command>` runs the TypeScript directly.

**Run every `flatbot` command from this directory.** `config.yaml` is read from the working
directory, so `flatbot status` in your home folder just reports a missing `config.yaml`, even with
the binary on your PATH. The same applies to anything that starts flatbot for you — see
[Keeping it running](#keeping-it-running).

**3. Run the setup wizard.**

```sh
flatbot init
```

It asks for your bot token, then tells you to message your bot once so it can read your chat id
automatically (if that fails it asks you to paste the id — `flatbot chatid` prints it too). Then it
interviews you: max warm rent, minimum m², room range, city, a free-text description of what you
want, and a free-text description of yourself as a tenant. Last it asks for the path to Fredy's
`db/listings.db`. It writes `.env` (secrets) and `config.yaml` (everything else), and parks the
watermark at Fredy's current newest row so your first run judges only *new* listings instead of
paying for LLM calls on the whole backlog.

**4. Check everything is wired.**

```sh
flatbot doctor
```

Ten checks: Node version, `config.yaml`, Fredy's DB, flatbot's own DB directory, Telegram (`getMe`),
one live LLM round-trip — then four that only auto mode needs (Chrome, the CDP endpoint, the send
backend's binaries, the browser profile), reported as `⏭️ skipped` while you are in shadow mode. Every
check runs even if an earlier one failed, so one pass shows you every problem. Exit code is non-zero
if anything failed.

**5. Shadow-run it for a few days.**

```sh
flatbot run
```

It polls Fredy every 60 seconds and starts the Telegram bot. You get one message per interesting
listing; tap ✅ or ❌, and reply in plain language when the bot got it wrong. `flatbot status` prints
the same numbers in the terminal. Read the asks for a few days and adjust `config.yaml` until the
judge agrees with you.

**6. Only then, auto mode.** Send `/auto` in Telegram. Read the [Auto mode](#auto-mode) and
[Security](#security) sections first — from that point flatbot submits contact forms as you.

## CLI

```
flatbot init            interactive setup (token, chat id, preferences, config.yaml)
flatbot run             poll Fredy every 60s, judge, notify Telegram
flatbot status          counts, mode and watermark
flatbot dryrun <url>    re-judge one known listing with live LLM calls, write nothing
flatbot doctor          check node, config, Fredy db, Telegram, the LLM and the send path
flatbot chatid          print the chat id of whoever last messaged the bot
flatbot login [platform]  open a headed browser so you can log into a portal once
```

`dryrun` only works on a listing flatbot has already stored — it is for tuning prompts and thresholds
against a real listing without touching any state.

## Configuration

`config.yaml` is read from the directory you run `flatbot` in — your checkout — and is gitignored;
`config.example.yaml` is the template. All paths in it are resolved relative to the directory holding
`config.yaml`. The five `hard.*` numbers and `fredyDbPath` are **required**: a missing or misspelled
one is a startup error, never a silently disabled filter.

| Key | Default | Meaning |
|---|---|---|
| `hard.maxWarmRent` | — | Reject anything priced above this. Fredy stores one price number per listing; whether that is warm or cold rent depends on the portal. |
| `hard.minSqm` | — | Reject anything smaller. |
| `hard.minRooms` / `hard.maxRooms` | — | Reject anything outside this room range (halves like `1.5` are respected). |
| `hard.city` | — | Geography check against the address **and** the title, because portals often give a district-only address (`12489 Köpenick`) with the city in the title. Matched case-insensitively, whole words, and word by word — `Frankfurt am Main` matches an address that only says `60313 Frankfurt`. A miss is not a silent reject: the listing still goes to the judge and always to you as an ask (with `⚠️ … not in <city>` in the reasons), never straight to the sender. That is deliberate — this is free text nobody validates, and a spelling the portal does not use (`Muenchen` for `München`) would otherwise reject every listing there is without a word. A listing with no address at all is never checked on geography. Leave it empty to turn the check off and rely on Fredy's search URLs. |
| `hard.districtBlocklist` | `[]` | Case-insensitive **whole-word** match against the listing's address; a hit is a hard reject. `Mitte` blocks `Berlin-Mitte` and leaves `Mittenwalder Straße` alone. |
| `hard.stalenessCutoffHours` | — | Reject listings older than this (measured from Fredy's insert time). Stops an offline laptop from applying to week-old ads on restart. |
| `thresholds.apply` | `75` | Judge score at or above this means "apply". |
| `thresholds.ask` | `50` | Score at or above this (but below `apply`) means "ask me". Below it, skip silently. |
| `preferences` | `''` | Free text, any language, verbatim into the judge prompt. Write it the way you would tell a friend. |
| `profile` | `''` | Free text about you as a tenant (job, income, pets, smoker, documents). The letter writer may use nothing beyond this and is told to invent nothing — so include **your name**, which it signs the letter with. |
| `platforms` | `[]` | Which platform ids to accept: `immoscout`, `kleinanzeigen`, `wggesucht`, `immowelt`. An empty list means no filter. |
| `llm.provider` | `claude-cli` | `claude-cli` (shells out to `claude -p`) or `openai-compatible`. |
| `llm.model` | — | Model name. Required for `openai-compatible`. Also used by the `browser-use` send backend (which falls back to `gemini-2.5-flash`). Ignored by `claude-cli`. |
| `llm.baseUrl` | — | `openai-compatible` only, and required there. `/chat/completions` is appended to it. |
| `llm.apiKeyEnv` | `LLM_API_KEY` | Name of the environment variable holding the API key. |
| `fredyDbPath` | — | Path to Fredy's `db/listings.db`. Opened read-only. |
| `dbPath` | `./flatbot.sqlite` | flatbot's own state: listings, decisions, feedback, watermark, mode. `learned.md` is written next to it. |
| `sender.backend` | `claude-agent` | `claude-agent` (supported default) or `browser-use` (escape hatch: needs your own wrapper script, restricts nothing). Read [Auto mode](#auto-mode) before changing it. |
| `sender.hourlyCapPerPlatform` | `3` | Never send more than this many applications per platform per rolling hour. |
| `sender.minDelayMinutes` | `2` | Lower bound of the random wait before each send. |
| `sender.maxDelayMinutes` | `8` | Upper bound. If it is below the minimum, both are pinned to the minimum. |
| `sender.profileDir` | `./browser-profile` | Persistent browser profile holding your portal logins. Gitignored. |
| `sender.screenshotDir` | `./screenshots` | Where confirmation screenshots are written. Gitignored. |

The whole `sender:` block is optional in the file; leaving it out gives you the defaults above.
Sending is gated on auto mode, not on the presence of this block.

## Telegram

The bot only talks to one chat: the id in `TELEGRAM_CHAT_ID`. Updates from anywhere else are dropped
without a reply.

| Command | Effect |
|---|---|
| `/stats` | found / asked / approved / skipped / sent / manual / failed over the last 7 days |
| `/pause` | Stop polling and stop sending. Takes effect mid-send-delay too. |
| `/resume` | Undo `/pause` |
| `/auto` | Switch to auto mode — approved applications get submitted |
| `/shadow` | Switch back to shadow mode — nothing is sent. Also cancels a send that is already waiting out its delay, returning the listing to the queue |
| `/status <id> <note>` | Attach a free-text note to a listing (e.g. `/status 4f2a viewing friday`). An unknown id is refused rather than silently dropped |
| `/start`, `/help` | Print this list |

Every message the bot sends ends with a `#<listing-id>` line. That trailer is the whole reply-mapping
mechanism: reply to a message and your text is filed against that listing.

**Buttons.** Each ask carries ✅ and ❌. In shadow mode ✅ marks the listing approved; in auto mode it
queues the listing for sending. ❌ rejects it. Tapping either on a listing that has already moved on
(queued, mid-send, sent, failed, handed back for manual sending, or rejected) does nothing and answers
with the status it already has. The buttons are removed from the message once a verdict is recorded.

**Free-text feedback.** Any message that is not a command is stored as feedback. Reply to a listing's
message and it is tied to that listing; send it standalone and it is global. The bot reacts with 👍.
The 20 newest memos are pasted verbatim into every judge prompt, so a correction takes effect on the
next listing — "too far from the S-Bahn", "ground floor is fine actually", "never Neukölln".

**Learning / distillation.** Once a week, everything older than those newest 20 memos is compressed
by the LLM into at most 10 short lessons and written to `learned.md` next to your database. That file
is yours: read it to see what flatbot thinks it learned, edit it, or delete it. flatbot only
overwrites it at the next weekly distillation.

## Auto mode

In auto mode a judge verdict of "apply" goes straight to a send queue instead of asking you. One
listing is sent per pass, oldest first, after a random delay between `minDelayMinutes` and
`maxDelayMinutes`, skipping any platform that already hit `hourlyCapPerPlatform` sends this hour.
Suspected scams are never auto-sent — they are always downgraded to an ask. A listing with no letter
is never queued.

**The two backends are not equivalent.** `claude-agent` is the supported default. `browser-use` is an
escape hatch: it needs a wrapper script you write yourself, and nothing constrains what its agent is
allowed to do.

- **`claude-agent`** (default) — runs `claude -p` headlessly with a pinned
  [Playwright MCP](https://github.com/microsoft/playwright-mcp) server (`0.0.79`) attached over CDP to
  the browser `flatbot run` launches from your profile directory. That browser's debugging port is
  `FLATBOT_CDP_PORT` (default `9222`) and its address is handed straight to the backend;
  `FLATBOT_CDP_ENDPOINT` (default `http://127.0.0.1:9222`) is only the fallback for a browser you
  started yourself, and is what `flatbot doctor` probes. The agent's entire tool list is eight
  Playwright-MCP tools — `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
  `browser_select_option`, `browser_press_key`, `browser_wait_for`, `browser_take_screenshot`
  (`ALLOWED_TOOLS` in `src/backends/claudeAgent.ts`) — with every built-in tool switched off, the
  rest of the MCP server denied by name, your own MCP servers kept out, and the child started in an
  empty scratch directory with the bot token and LLM key stripped from its environment. See
  [Security](#security). Costs nothing extra on a Claude subscription.
- **`browser-use`** — shells out to `uvx browser-use` with your persistent profile directory, driven by
  whatever model you configure (`LLM_API_KEY`, model defaults to `gemini-2.5-flash`, and the **free
  Gemini tier is enough**). Two things to know before picking it:
  - **It needs a wrapper you supply.** flatbot invokes the CLI as
    `<bin> --prompt-file <file> --user-data-dir <profile> --model <model>`, and the published
    `browser-use` CLI (package `0.13.7`) is a Python-script driver that accepts none of those flags.
    Point `FLATBOT_BROWSERUSE_BIN` / `FLATBOT_BROWSERUSE_ARGS` at a script of yours that translates
    them; without it every send fails.
  - **Nothing restricts the agent.** There is no tool allowlist on this path at all — the "only fill
    contact forms" rule below is prompt text, not a boundary.

Both backends get the same prompt shape and the same hard guardrail, quoted into every send prompt
verbatim:

> The sender agent may only fill and submit contact/message forms — never change account settings,
> never pay, never upload documents.

Both fence the listing text and your letter behind a per-send random nonce, so that text scraped off a
portal cannot break out and issue instructions to the agent. That sentence and that fence are advice
to a model; only `claude-agent` also enforces the limit, by never handing the agent a tool that could
do anything else. Per-portal knowledge — which button opens the form, which fields to leave alone, the
German wording of the success confirmation, and the paywall wording that must abort the send — is
plain data in `src/platforms.ts`, not something the model improvises.

**Screenshots are the audit trail.** A send only counts as confirmed when the agent saw one of the
portal's own success strings *and* a screenshot of it exists on disk in `sender.screenshotDir`. If the
agent claims success but no screenshot is there, the message goes out as
`✅ sent — … (unconfirmed — no screenshot in <your screenshotDir>; check the portal)` — it names the
directory rather than a file that does not exist. When there *is* a shot but the agent did not see a
success string, the message points at the file instead. A paywall marker, an error, or a crash
all end the same way: the listing is marked `fallback_manual` and Telegram hands you the letter and
the link so you can send it by hand. flatbot
never re-tries a send by itself — a duplicate application reads far worse than one manual check.

## Security

**Three secrets, and they live in `.env` only** — never in `config.yaml`, never in git (`.env` and
`config.yaml` are both gitignored, and there is deliberately no `.env.example` in this repo):

- `TELEGRAM_BOT_TOKEN` — full control of your bot. Anyone with it can read and send your messages.
- `TELEGRAM_CHAT_ID` — the only chat the bot will ever answer. Every other update is dropped
  unanswered, so a leaked bot token alone does not give a stranger a working bot.
- `LLM_API_KEY` — only needed for `llm.provider: openai-compatible` (rename it via `llm.apiKeyEnv`)
  and for the `browser-use` backend. The `claude-cli` provider uses your existing CLI login and never
  touches a key.

**`.env` is exported into the process environment.** `loadConfig` copies every variable it finds in
`.env` into `process.env` (a real environment variable of the same name still wins), because
`LLM_API_KEY` and friends are read off `process.env` downstream. The consequence, stated plainly:
anything you put in `.env` is inherited by every child process flatbot spawns — `claude`,
`npx @playwright/mcp`, Chrome, `uvx browser-use`. Both send backends strip what they can: the
`browser-use` child has `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` deleted from its environment
(`src/backends/browserUse.ts`), and the LLM key is copied into `GEMINI_API_KEY` only when the send
model is a Gemini one; the `claude-agent` child loses `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and
the LLM key outright, since it needs none of them. Everything else in `.env` is still inherited, so
keep `.env` to the three variables above.

**Fredy holds credentials.** Fredy's own SQLite database keeps the admin password hash and an MCP
bearer token in its `users` table, and proxy/SMTP credentials can end up in `settings`. Treat that
file as a secret: do not commit it, do not copy it around, and do not expose Fredy's web UI on
`:9998` to the network. Its default login is `admin` / `admin` — change it before anything else.
(`scripts/inspect-fredy.mjs`, the schema dump tool, deliberately skips those two tables. Do not
remove that filter to "just see everything".)

**Listing text is untrusted input that reaches an LLM.** Titles and descriptions are written by
strangers and go into judge, writer and sender prompts. Prompt fencing makes injection harder but
nothing makes it impossible, so on the `claude-agent` path the real containment boundary is what the
send agent is not given: `--tools ""` (no built-in tools at all — no file reads, no shell),
`--disallowedTools` for the rest of the Playwright surface, `--strict-mcp-config` so your own MCP
servers stay out, and a scratch working directory instead of your flatbot checkout. What is left is
eight Playwright tools (navigate, snapshot, click, type, select_option, press_key, wait_for,
take_screenshot), which is why that agent cannot read your `.env`, cannot upload your documents,
cannot run JS in your logged-in session, and cannot reach cookies, tabs or raw network requests.
`--allowedTools` alone would not do this: it grants, it does not revoke. Keep it that way, and
re-check it after a `claude` upgrade.
**The `browser-use` path has no such boundary** — there the allowlist is only a sentence in the
prompt. On both paths the caps and delays are the second layer.

**The browser profile is a live session store.** `sender.profileDir` holds the cookies that keep you
logged into the portals — anyone with that directory is logged in as you. It is gitignored; do not
back it up to a shared drive, do not copy it between machines, and delete it if you stop using
flatbot.

**What leaves your machine.** Listing text and your letters go to your configured LLM provider, and
messages go to Telegram. Nothing else is sent anywhere. Everything else — the databases, the
screenshots, `learned.md` — stays on disk.

## Keeping it running

`flatbot run` is a foreground process. To survive a reboot:

```
  macOS / Linux (simplest, needs pm2):
    npm i -g pm2 && pm2 start "$(which node)" --name flatbot -- $(pwd)/dist/index.js run && pm2 save && pm2 startup

  macOS (no pm2): write a launchd job at ~/Library/LaunchAgents/com.flatbot.plist
    with ProgramArguments [<node>, <this dir>/dist/index.js, run],
    WorkingDirectory <this dir>, RunAtLoad and KeepAlive true, then:
    launchctl load ~/Library/LaunchAgents/com.flatbot.plist

  Linux (no pm2): write a systemd unit at ~/.config/systemd/user/flatbot.service
    with ExecStart=<node> <this dir>/dist/index.js run,
    WorkingDirectory=<this dir>, Restart=always, then:
    systemctl --user enable --now flatbot

  Windows: schtasks /create /tn flatbot /sc onstart /tr "cmd /c cd /d <this dir> && node dist\index.js run"

  <this dir> is your flatbot checkout, and it is not optional: flatbot reads
  config.yaml from the working directory. launchd starts agents at /, systemd
  user units at $HOME and schtasks at %SystemRoot%\system32, so a service
  without it dies immediately with ENOENT. (pm2 records the directory you
  started it from, which is why its line does not need one.)
```

`flatbot init` prints the same text at the end of setup. Fredy needs the same treatment — it is a
separate process with its own lifetime.

Windows is **implemented, not yet verified on real Windows; reports welcome.** The support is
deliberate rather than accidental — prompts reach every child process on stdin, and the win32 command
line is built and quoted by flatbot instead of being handed to a naive `shell: true` — but no part of
it has been run on an actual Windows machine. One known gap even in theory: the process-group kill
that cleans up a hung send is POSIX-only, so on Windows a timed-out send may leave a browser behind.

Any always-on machine works: an old laptop, a Raspberry Pi, a home server. Prefer a home connection
over a cloud VM; portals block datacenter IP ranges much more readily.

## Troubleshooting

**No listings appear.** Check the layers in order. Does Fredy itself have new rows (its web UI on
`:9998` lists them)? Does `flatbot doctor` report a non-zero row count for the Fredy DB? Is `flatbot
status` showing a watermark that moves? Remember `init` parks the watermark at Fredy's newest row, so
nothing that existed before setup is ever judged. After that, the usual causes are: `platforms` not
containing the platform id Fredy actually writes (`immoscout`, `kleinanzeigen`, `wggesucht`,
`immowelt`), hard limits so tight that everything is rejected before the judge (price, size and rooms
are hard rejects; `hard.city` is not — a city miss reaches you as an ask flagged `⚠️ … not in <city>`,
so a wall of those means the city in `config.yaml` is not the spelling the portal uses), a
`stalenessCutoffHours` shorter than your polling gap, or the bot being `/pause`d.

**Telegram is silent.** `flatbot doctor` should print your bot's `@username`. If it does and you still
get nothing, the chat id is wrong: the bot ignores every chat but the one in `.env`. Message the bot
and run `flatbot chatid` to see the id it actually sees, then fix `TELEGRAM_CHAT_ID` and restart. If
`doctor` fails at the Telegram check, the token is wrong or the machine cannot reach
`api.telegram.org`.

**LLM errors.** `doctor` sends one prompt and demands the word "pong" back. `claude-cli` failures are
almost always the `claude` binary missing from PATH or its login having expired — run `claude -p hi`
by hand. For `openai-compatible`, an HTTP error is printed with its status: 401 means the key in
`llm.apiKeyEnv` is missing or wrong, 404 usually means `baseUrl` already contained `/chat/completions`
(flatbot appends it). Listings that fail judging are stored with status `error` and the message, so
they are not lost.

**`fallback_manual` sends.** This is the designed outcome whenever a send did not clearly succeed:
paywall hit, unknown platform, no letter, agent error. The Telegram message contains the reason, the
link and the full letter — send it by hand. If it happens on every attempt for one portal, log in
again (`flatbot login <platform>`), and check the screenshot to see what the agent actually saw.
Switching to `browser-use` is not a quick escape: it needs the wrapper script described in
[Auto mode](#auto-mode) and drops the tool restriction entirely.

## Disclaimer

Automating portal contact forms may conflict with those portals' Terms of Service. You are
responsible for how you use this. flatbot applies with **your** accounts, from **your** machine, in
**your** name — the rate limits are deliberately conservative for that reason, and they are a floor,
not a target. The project sends nothing to anyone until you explicitly turn auto mode on, and it is
useful without ever doing so. No warranty; see [LICENSE](LICENSE).
