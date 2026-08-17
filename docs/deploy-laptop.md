# Deploying flatbot on an always-on laptop

Everything here runs on one machine: Fredy in one process, flatbot in another. Use a machine on a
**residential** connection that you can leave on — portals block datacenter IP ranges much harder than
home ones. An old laptop with the lid-close sleep disabled, a Pi, or a home server all work.

Read [../README.md](../README.md) first. This document is the operator's runbook: the exact order,
plus the parts that only matter once you send for real. Every `config.yaml` key, the full Telegram and
CLI surface, the backend comparison and the troubleshooting list live in
[configuration.md](configuration.md).

---

## 1. Fredy

flatbot never scrapes. Fredy does, into a SQLite file that flatbot reads read-only.

```sh
git clone https://github.com/orangecoding/fredy
cd fredy
npm i
NODE_ENV=production node index.js
```

On Windows that first token is not shell syntax; use `set NODE_ENV=production && node index.js` in
`cmd`, or `$env:NODE_ENV='production'; node index.js` in PowerShell.

Follow Fredy's own README for its requirements and its supported start scripts; the command above is
the one this project was captured against. Fredy's web UI comes up on **http://localhost:9998**, and
its database lands at `db/listings.db` inside that checkout — that path is what flatbot's
`fredyDbPath` points at.

1. **Change the default login.** It ships as `admin` / `admin` and nags about it on every boot.
   Change it now, before the DB has anything in it worth protecting.
2. **Do not expose `:9998`.** Fredy's own database keeps the admin password hash and an MCP bearer
   token in its `users` table, and can keep proxy/SMTP credentials in `settings`. Keep the port bound
   to localhost, keep the DB file off shared drives, and never commit it.
3. **Create a job** with one search URL per portal you want. Working shapes for Berlin:

   | provider | search URL |
   |---|---|
   | `immoscout` | `https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten` |
   | `kleinanzeigen` | `https://www.kleinanzeigen.de/s-wohnung-mieten/berlin/preis:0:1000/wohnungen/k0c203l3331` |
   | `wgGesucht` | `https://www.wg-gesucht.de/wohnungen-in-Berlin.8.2.1.0.html` |
   | `immowelt` | `https://www.immowelt.de/suche/mieten/wohnung/berlin/berlin-10115/ad08de8634` |

   Put the *city* filter in these URLs anyway. flatbot's `hard.city` only sees listings that carry
   an address, portals are inconsistent about writing the city into it, and a miss there is
   deliberately soft (the listing reaches you as an ask flagged `⚠️ … not in <city>`, never a
   silent skip) — so the URL filter is the reliable layer. Price/size/room filtering is better left
   to flatbot, which sees the reasons.
4. **Enable provider-details enrichment.** This is the one setting that is easy to miss and expensive
   to miss. In Fredy's own settings (a per-user setting, stored as `provider_details` and empty out
   of the box), turn detail-page fetching on for **immoscout**. Without it every single ImmoScout row
   arrives with `description: null` — measured, 50 of 50 rows — and both the judge and the letter
   writer are working from a title and a price. Kleinanzeigen, WG-Gesucht and Immowelt fill
   `description` from the results page and need nothing.
   Trade-off Fredy itself flags: detail fetching makes ImmoScout scraping more detectable. It is
   still the right call — an ImmoScout listing with no description is nearly useless downstream.
5. **Let one run finish.** Trigger the job manually rather than waiting for the cron, then confirm
   rows exist in the UI.

Schema details, sample rows and the measured null counts are in [fredy-schema.md](fredy-schema.md).

---

## 2. flatbot

```sh
git clone https://github.com/Virtualriotc/flatbot.git flatbot  
cd flatbot
npm i
npm run build
npm link          # optional: puts `flatbot` on your PATH
```

Without `npm link`, every command below is `node dist/index.js <command>`.

**Every command below runs from the flatbot checkout**, `npm link` or not. `config.yaml` is read
from the working directory, so `flatbot doctor` anywhere else only tells you `config.yaml` is
missing. Whatever you use to keep it running after a reboot needs the same directory set explicitly
— see [section 6](#6-keep-it-running).

### Setup wizard

```sh
flatbot init
```

It writes two files, both gitignored:

- **`.env`** — `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- **`config.yaml`** — everything else, from your answers.

For the chat-id step: open Telegram, message your new bot anything, then press enter in the wizard.
If it cannot see the message, it asks you to type the id. You can always get it later with:

```sh
flatbot chatid
```

`init` also parks the watermark at Fredy's current newest row. Everything Fredy collected before this
moment is ignored forever — that is deliberate, it stops setup from spending LLM calls on a backlog.

### Environment variables

There is deliberately no `.env.example` in this repo, so here are the names in full. `.env` is a
plain `KEY=value` file; a real environment variable of the same name always wins over the file.

| Variable | Required | What it is |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather. Full control of the bot — treat it as a password. |
| `TELEGRAM_CHAT_ID` | yes | The only chat the bot will ever answer. |
| `LLM_API_KEY` | only for `openai-compatible` and the `browser-use` backend | API key. Rename the variable via `llm.apiKeyEnv` if you prefer. The `claude-cli` provider needs no key. |

Everything in `.env` is copied into `process.env` at startup, so it is also inherited by every child
process flatbot spawns (`claude`, `npx @playwright/mcp`, Chrome, `uvx browser-use`). Keep the file to
these three. The `browser-use` child is the one exception: the two Telegram variables are deleted from
its environment before it starts.

Optional overrides, none of which you normally set:

| Variable | What it does |
|---|---|
| `FLATBOT_CDP_PORT` | Debugging port of the browser `flatbot run` launches (default `9222`). That address is what the `claude-agent` backend is given. If anything is already answering there, flatbot refuses to launch rather than drive a browser it did not start — close it, or set this to a free port. |
| `FLATBOT_CDP_ENDPOINT` | What `flatbot doctor` probes, and the backend's fallback when nothing hands it an endpoint (default `http://127.0.0.1:9222`). It does **not** redirect the browser the run loop launched — use `FLATBOT_CDP_PORT` for that. |
| `FLATBOT_BROWSERUSE_BIN` / `_ARGS` | Not optional if you actually run the `browser-use` backend — see [section 5](#5-turning-on-auto-mode). |
| `FLATBOT_CLAUDE_BIN` / `_ARGS` | Point the `claude` CLI at a wrapper or a stub binary. |
| `FLATBOT_SEND_TIMEOUT_MS` | Per-send timeout; default 900000 (`claude-agent`) / 600000 (`browser-use`). On expiry the whole process group is killed. |
| `GEMINI_API_KEY` | flatbot never reads it, but the `browser-use` child inherits it from your environment. flatbot copies `LLM_API_KEY` into `GEMINI_API_KEY` for that child only when the send model name contains "gemini". |

### Verify

```sh
flatbot doctor
```

All ten checks run even if an earlier one fails, so one pass shows every problem at once:
Node >= 22, `config.yaml` parses, Fredy's DB opens and its row count is printed, flatbot's DB
directory is writable, Telegram answers `getMe`, and the LLM answers a live prompt — then four that
only auto mode needs (Google Chrome is installed, the CDP endpoint, the configured backend's tooling
— which for `browser-use` means `FLATBOT_BROWSERUSE_BIN` pointing at your wrapper, not just `uvx`
being installed — and the browser profile holds portal sessions). Those four print `⏭️ skipped` while you are in
shadow mode, which is neither a pass nor a failure. Non-zero exit if anything failed. Fix until it is
clean before going further.

`doctor` counts as a **pass at `0 rows`** — it only proves the file opens and the schema is there.
Read the number yourself: `0 rows` means Fredy has not scraped anything yet (or you are pointed at
the wrong file), and flatbot will sit silent until that changes.

---

## 3. Shadow run

```sh
flatbot run
```

Poll every 60 seconds, judge, ask on Telegram. Nothing is sent to anyone in this mode.

Run it like this for **several days** and actually read the asks. This is where the configuration
gets earned:

- Every ask you disagree with is a fix. Reply to the bot's message in plain language ("too far from a
  U-Bahn", "ground floor is fine", "this is a scam, the price is impossible"). The 20 newest memos go
  verbatim into every judge prompt, so the next listing already knows.
- Watch the score distribution. If almost everything lands between `thresholds.ask` and
  `thresholds.apply`, you are being asked about everything — raise `ask`. If obviously wrong flats
  score high, the problem is usually `preferences` being vague rather than the thresholds.
- `flatbot status` prints mode, watermark and the 7-day counts. `/stats` prints those counts in chat,
  plus how many applications actually went out (`sent`), landed back on you (`manual`) or errored
  (`failed`) — the numbers that matter once auto mode is on.
- `flatbot dryrun <url>` re-judges one listing flatbot already stored, with live LLM calls, and writes
  nothing. Use it after every `config.yaml` edit instead of waiting for a new listing.
- After a week or so, look at `learned.md` next to your `flatbot.sqlite`. It is the distilled version
  of your older feedback and it is yours to edit or delete.

Only move on when the asks look like decisions you would have made yourself.

---

## 4. Portal logins

This step and every `claude-agent` send afterwards drive **your installed Google Chrome** — `npm i`
downloads no browser, so install Chrome first if the machine does not have it. (A `browser-use`
wrapper launches its own browser from the same profile directory; what that is, is up to your
wrapper.)

Before the first real send, log into every portal once, in flatbot's own browser profile:

```sh
flatbot login immoscout
flatbot login kleinanzeigen
flatbot login wggesucht
flatbot login immowelt
```

Bare `flatbot login` walks the platforms enabled in `config.yaml`. Each one opens a visible browser at
the portal's login page, waits for you to press enter, and closes.

**The browser profile directory is what keeps you logged in** (`sender.profileDir`, default
`./browser-profile`). It holds live session cookies, which means anyone holding that directory is
logged in as you. It is gitignored. Do not back it up to a shared drive, do not copy it to another
machine, and delete it if you stop using flatbot. If sends start failing with login walls, the
session expired — run `flatbot login <platform>` again.

---

## 5. Turning on auto mode

Send `/auto` in Telegram. The bot replies `mode: auto`. `/shadow` puts it back, and `/pause` stops
everything. Both take effect on a send that is already inside its delay window: the send is dropped
and the listing goes back to the status it had before the lease.

Pick your backend in `config.yaml` first (`sender.backend`). **The two are not equivalent** — one is
the supported path, the other is an escape hatch you have to finish building yourself:

- `claude-agent` (default, supported) — needs the `claude` CLI logged in and `npx` available. The
  agent is held to eight browser tools and can do nothing else; see the caveat below.
- `browser-use` (escape hatch) — needs `uv` installed so `uvx browser-use` works, **and a wrapper
  script of your own**. flatbot invokes the CLI as
  `<bin> --prompt-file <file> --user-data-dir <profile> --model <model>`, and the published
  `browser-use` CLI (package `0.13.7`) is a Python-script driver that accepts none of those flags, so
  a stock install fails every send. Point `FLATBOT_BROWSERUSE_BIN` / `FLATBOT_BROWSERUSE_ARGS` at a
  script that translates them. This path also has **no tool restriction at all**: the "only fill
  contact forms" rule is prompt text, and nothing stops the agent doing something else while it reads
  listing text written by strangers in your logged-in session. It does run on a free Gemini key.

### First live send checklist

Do not walk away from the first three sends.

- [ ] Caps are what you think they are. Default is 3 per platform per rolling hour, with a 2–8 minute
      random delay before each send. Confirm the numbers in `config.yaml`.
- [ ] Keep `/pause` within reach. It is the only live control over a send that is already scheduled:
      the pause flag is re-checked *after* the 2–8 minute delay, so a pause inside that window stops
      the send. The ✅/❌ buttons cannot call back a queued listing — they answer "already queued".
- [ ] **Read the letters.** In auto mode an apply-tier listing is queued without asking you, so you
      see its letter in the receipt *after* the send, not before. Read the first few carefully: the
      writer is instructed to invent nothing beyond your `profile`, and this is where you verify that
      on real output. Telegram asks do not include the draft — read letters with
      `flatbot dryrun <url>` on a stored listing before you ever flip to auto.
- [ ] **Open the screenshot for each of the first three sends** (`sender.screenshotDir`). A send only
      counts as confirmed if the portal's own success text was on screen and the screenshot exists.
      `✅ sent — … (unconfirmed — no screenshot in <dir>; check the portal)` means exactly that: no
      file was saved, so the message names the directory. With a file, it points at the file.
- [ ] Watch for `fallback_manual`. Paywall, unknown platform, missing letter or a crashed agent all
      land there, with the letter and the link in the Telegram message so you can send it by hand.
      flatbot deliberately never retries a send: a duplicate application looks worse than one check.
- [ ] Check `/stats` after the first hour and confirm `sent` matches the number of applications you
      actually saw go out, and that `manual` / `failed` match the fallbacks you were told about.

### Status vocabulary

Useful when reading the database or a Telegram trailer: `new`, `skipped_rules`, `skipped_judge`,
`asked`, `approved`, `queued`, `pending_send`, `sending`, `sent`, `fallback_manual`, `failed`,
`rejected`, `error`.

The send lease has two halves, and the difference is what you are told after a crash:

- `pending_send` — claimed, waiting out the 2-8 minute delay. Nothing has been submitted, and no
  other tick or process can take the row. At `flatbot run` startup these are simply requeued, in
  silence: a laptop that slept through the delay is not an incident.
- `sending` — the backend has been handed the job, so the form may be in flight. At startup a stale
  `sending` row becomes `fallback_manual` and you get a Telegram warning that it may already have
  gone through. It is never re-queued: a second copy of the same application in a landlord's inbox
  is the worse outcome.

Both leases are conditional updates (`UPDATE … WHERE id = ? AND status = ?`), so a second
`flatbot run` on the same database loses the race instead of sending a duplicate.

### Known caveat: the claude-agent tool grant

The agent reads listing text written by strangers while holding your logged-in portal session, so
what it *cannot* call is the only real limit on what a prompt injection can make it do. Four flags,
not one, and `--allowedTools` is the least important of them (it only adds permissions — on its own
the agent still had Claude Code's file and shell tools, and would read your `.env`):

    --tools ""             no built-in tools at all — no Read, no Bash, and nothing added in a
                           later CLI version either, because nothing is enumerated
    --disallowedTools ...  the 16 Playwright MCP tools a contact form does not need: file upload,
                           browser_evaluate / browser_run_code_unsafe, dialogs, tabs, raw network
                           requests, console, close. A denied tool is not shown to the model at all
    --allowedTools ...     the eight it does need, comma-separated in one token so the variadic
                           option cannot swallow later arguments (`ALLOWED_TOOLS`):
                           browser_navigate, browser_snapshot, browser_click, browser_type,
                           browser_select_option, browser_press_key, browser_wait_for,
                           browser_take_screenshot — each prefixed `mcp__playwright__`
    --strict-mcp-config    your own MCP servers are not loaded into that session

The child is also spawned in an empty scratch directory rather than your flatbot checkout (so there
is no `.env`, `config.yaml` or `flatbot.sqlite` within reach even for a tool that could read one),
and `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and your LLM key are removed from its environment.
Because the Playwright MCP server refuses file writes outside its output directory and its own cwd,
it is started with `--output-dir <your screenshotDir>` — that is what lets the confirmation
screenshot be written at all.

Verified on CLI 2.1.233 and `@playwright/mcp@0.0.79`: with those flags the session's entire tool
list is the eight names above, a direct instruction to read a `.env` gets "I have no filesystem
tools in this session", and the one route left — `browser_navigate` to a `file://` URL — comes back
`Access to "file:" protocol is blocked` from the MCP server itself. (That block is why flatbot must
never pass `--allow-unrestricted-file-access`.) Re-check it after a CLI upgrade — flag semantics are not a stable API, and
the CLI accepts invalid tool rules silently: a wrong rule does not error, it just leaves the agent
unable to act, which looks like a mysteriously failing send. **The grant has never been exercised
against a live portal.**

So: watch the very first `claude-agent` send with your own eyes. If the agent reports failure without
ever appearing to interact with the page, suspect the tool grant before suspecting the portal.
Switching `sender.backend` to `browser-use` is not a quick way out — it needs the wrapper script from
above, and it drops this restriction entirely.

---

## 6. Keep it running

Both processes need to survive a reboot. flatbot prints this at the end of `flatbot init`:

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

The plist key is `<key>WorkingDirectory</key><string>/path/to/flatbot</string>`; the systemd key is
`WorkingDirectory=/path/to/flatbot` in the `[Service]` section. If your path contains spaces, quote
it there and in the `schtasks` line.

**Windows is implemented, not yet verified on real Windows; reports welcome.** The support is
deliberate — prompts reach every child process on stdin, and the win32 command line is built and
quoted by flatbot rather than handed to a naive `shell: true` — but nothing here has been run on an
actual Windows machine. One gap is known even without a test: the process-group kill that cleans up a
hung send is POSIX-only, so a timed-out send on Windows may leave a browser process behind.

Do the same for Fredy (`node index.js` in the Fredy checkout) — it is a separate process with its own
lifetime, and flatbot silently sees no new listings when it is down.

Also worth doing on a laptop: stop it sleeping on lid close, and make sure the user session the job
runs under actually logs in at boot (a launchd *agent* and a systemd *user* unit both need a logged-in
session; use a system-level unit if that is a problem).

### Logs

- flatbot writes to stdout/stderr. Where that lands depends on how you started it: `pm2 logs flatbot`,
  `journalctl --user -u flatbot -f`, or the `StandardOutPath` / `StandardErrorPath` you set in the
  plist. `*.log` is gitignored, so pointing logs into the repo directory is safe.
- Errors that matter reach Telegram anyway: failed sends, manual fallbacks and unconfirmed sends are
  all messages, not just log lines.
- flatbot's own SQLite (`dbPath`) is the real history — every listing, its status, score, reasons and
  letter. Screenshots in `sender.screenshotDir` are the audit trail for sends.
- Fredy logs separately, in its own checkout.

### Updating

```sh
cd flatbot
git pull
npm i
npm run build
# then restart: pm2 restart flatbot | systemctl --user restart flatbot | relaunch the task
```

`config.yaml`, `.env`, the databases, `learned.md`, screenshots and the browser profile are all
gitignored, so a pull never touches them. Check `config.example.yaml` after a pull for new keys, and
re-run `flatbot doctor` after every update.
