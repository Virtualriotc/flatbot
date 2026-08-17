# flatbot

flatbot does the boring half of hunting for a flat in Germany. It watches the big German rental
portals, decides which listings are worth your time, writes the German application letter, and — only
once you say so — fills in the portal's own contact form for you. Telegram is the whole interface.

## One listing, end to end

A flat appears on ImmobilienScout24. Within a minute flatbot has it. Hard rules run first, because they
are free: too expensive, too small, wrong room count, a blocklisted district, older than your staleness
cutoff. Those die on the spot and never cost an LLM call. A city mismatch is the exception — that field
is free text nobody validates, so a miss becomes a flagged question rather than a silent rejection.

What survives goes to an LLM judge holding your preferences as plain prose, German or English, written
the way you would tell a friend: "living alone, two rooms between the centre and the office, kitchen
required, balcony is nice to have". It returns a score out of 100, one line of reasoning, and a scam
flag. High scores are applications, middling ones are questions, low ones are silence. Whatever clears
the bar also gets a German Anschreiben — 120 to 180 words, one or two specifics of this flat, signed
with your name, forbidden from claiming anything that is not in your own profile text.

Your phone buzzes. Two lines: the score, `2-Zi, 52m², 950€`, the address, why it fits, the link. You
tap yes, you tap no, or you ignore it. When the judge got it wrong you reply in plain language — "too
far from the office", "Erdgeschoss ist okay" — and the twenty newest notes go verbatim into every
judge prompt from then on. Older ones are compressed weekly into a `learned.md` that is yours to edit.

In shadow mode that is the end of it. In auto mode an apply-tier listing skips the question: after a
random two-to-eight-minute wait, an agent opens the listing in a real browser you logged into once,
fills the contact form, submits it, and screenshots the confirmation. You get a receipt. A send counts
as confirmed only when the portal's own success wording was on screen *and* the screenshot is on disk.
Everything else — a paywall, a crash, no confirmation — hands you the letter and the link to send by
hand. flatbot never retries a send; a duplicate application reads far worse than one manual check.

## Two modes

**Shadow** is the default. A fresh install sends nothing to anyone: it watches, judges, drafts and
asks. **Auto** submits by itself, at most three applications per portal per rolling hour, and never
without a human for a listing the judge suspects is a scam. You turn it on by sending `/auto` in
Telegram. `/shadow` and `/pause` turn it back off, including for a send already waiting out its delay.

## Getting started

```sh
git clone https://github.com/Virtualriotc/flatbot.git && cd flatbot && npm i && npm run build
flatbot init      # bot token, chat id, your limits, your preferences in plain language
flatbot doctor    # every check runs, so one pass shows every problem
flatbot run       # shadow mode: it watches and asks, and sends nothing
```

The scraper flatbot reads its listings from is a separate install that has to be running first. Run
every command from the flatbot checkout. Live in shadow mode for a few days and answer the asks until
the judge agrees with you, then `flatbot login <portal>` once per portal and `/auto` when you actually
mean it. Real steps: [docs/deploy-laptop.md](docs/deploy-laptop.md). Every setting, command and known
failure mode: [docs/configuration.md](docs/configuration.md).

## Requirements

Node 22 or newer, a Telegram bot, and an LLM you already have — the `claude` CLI you are logged into,
or any OpenAI-compatible endpoint, a free key included. Auto mode additionally needs Google Chrome and
a machine you can leave on, on a home connection rather than a cloud VM, which the portals block far
harder. What to install, and in which order, is in [docs/deploy-laptop.md](docs/deploy-laptop.md).

## Security

Three secrets, and they live in `.env` only — never in the config file, never in git: the bot token,
your chat id, and an LLM key if your provider needs one. There is deliberately no `.env.example`. The
bot answers exactly one chat, the id in `TELEGRAM_CHAT_ID`; every other update is dropped without a
reply, so a leaked token alone does not give a stranger a working bot.

Listing text is written by strangers, and it reaches an LLM and then an agent driving a browser that
holds your live portal logins. So the agent that fills the form runs with every built-in tool switched
off and exactly eight browser actions available, in an empty scratch directory, with your own tools and
your secrets kept out of its environment. Verified by running the attack, not by reading the docs:
allowing only those eight is not enough on its own — an agent allowed nothing else still read a file off
disk. Re-run the attack after upgrading the CLI it uses. This holds for the default
sender only — the alternative restricts nothing at all, and that warning sits next to the setting in
[docs/configuration.md](docs/configuration.md).

The browser profile directory holds live portal sessions: anyone who has it is logged in as you. It is
gitignored — do not copy it anywhere, and delete it when you stop.

## Status

flatbot has never sent a real application. Not one. The per-portal form knowledge in `src/platforms.ts`
— which button opens the form, the German wording of the success confirmation — has never been checked
against a live page. Windows is implemented, never run on real Windows. Watch your first sends yourself.

## Disclaimer

Automating portal contact forms may conflict with those portals' Terms of Service. You are responsible
for how you use this. flatbot applies with your accounts, from your machine, in your name. No warranty;
see [LICENSE](LICENSE).

## Built on

- [Fredy](https://github.com/orangecoding/fredy) — scrapes the portals flatbot reads
- [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) — the stealth browser
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) — the browser actions the sender gets
- [Claude Code](https://claude.com/claude-code) — default judge, writer and send agent
- [browser-use](https://github.com/browser-use/browser-use) — the alternative send backend
- [grammY](https://grammy.dev) — the Telegram bot
