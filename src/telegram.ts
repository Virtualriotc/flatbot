import { Bot, InlineKeyboard } from 'grammy';
import type { Config } from './config.js';
import type { Db, ListingRow } from './db.js';

export type Notifier = { ask(r: ListingRow): Promise<void>; receipt(r: ListingRow): Promise<void>;
  /** Free text (sender fallbacks, errors) — no listing formatting, no verdict buttons. */
  text(msg: string): Promise<void> };

/** Past deciding: the sender owns these, or the human already said no. Tapping ✅ again on one
 *  would mean a second application, so the callback only reads the status back. */
const DECIDED = new Set(['queued', 'pending_send', 'sending', 'sent', 'failed', 'fallback_manual', 'rejected']);

/** "2-Zi, 52m², 950€" — skips whatever the portal did not give us, title if it gave us nothing. */
function summary(r: ListingRow): string {
  return [r.rooms && `${r.rooms}-Zi`, r.size && `${r.size}m²`, r.price && `${r.price}€`]
    .filter(Boolean).join(', ') || r.title;
}

export function fmtAsk(r: ListingRow): string {
  return [
    `🤔 ${r.score ?? '?'} — ${[summary(r), r.address].filter(Boolean).join(' — ')}`,
    r.reasons && `fits: ${r.reasons}`,
    r.url,
    `#${r.id}`,
  ].filter(Boolean).join('\n');
}

/** Shadow mode's "would apply" note, or — once the sender really sent it — the send receipt. */
export function fmtReceipt(r: ListingRow): string {
  const head = r.status === 'sent' ? '✅ Sent —' : '✅ (shadow) would apply —';
  return `${head} ${summary(r)}\n${r.url}\n#${r.id}`;
}

export type Stats = { found: number; asked: number; approved: number; skipped: number;
  sent?: number; fallback?: number; failed?: number };

export function fmtStats(s: Stats): string {
  return [`found ${s.found}`, `asked ${s.asked}`, `approved ${s.approved}`, `skipped ${s.skipped}`,
    s.sent !== undefined && `sent ${s.sent}`,
    s.fallback !== undefined && `manual ${s.fallback}`,
    s.failed !== undefined && `failed ${s.failed}`].filter(Boolean).join(' · ');
}

/**
 * `db.stats()` buckets nothing past `approved`, so it can never report the number that matters
 * most in auto mode: how many applications actually went out. Count those from their own rows
 * over the same discovery window.
 * ponytail: three full scans per /stats; move the buckets into db.stats()'s GROUP BY if the
 * listing table ever gets big enough to notice.
 */
export function collectStats(db: Db, sinceIso: string): Stats {
  const n = (status: string) => db.listByStatus(status).filter((r) => r.discoveredAt >= sinceIso).length;
  return { ...db.stats(sinceIso), sent: n('sent'), fallback: n('fallback_manual'), failed: n('failed') };
}

const HELP = `flatbot — I watch the portals and ask you about the flats worth a look.

/stats — found / asked / approved / skipped / sent / manual / failed, last 7 days
/pause — stop polling and stop sending
/resume — undo /pause
/auto — auto mode: approved applications get submitted
/shadow — shadow mode: nothing is sent
/status <id> <note> — attach a note to a listing
/help — this message

Tap ✅ or ❌ under an ask. Reply to any of my messages in plain language and I file it as
feedback against that listing, so the next judgement already knows.`;

/** Every bot message ends with "\n#<id>"; that trailer is the whole reply-mapping mechanism. */
export function listingIdFromReply(repliedText: string | undefined): string | null {
  return repliedText?.match(/#([\w-]+)\s*$/)?.[1] ?? null;
}

export function createBot(cfg: Config, db: Db): { bot: Bot; notifier: Notifier } {
  const bot = new Bot(cfg.telegram.token);
  const chatId = cfg.telegram.chatId;
  const verdictKeyboard = (id: string) => new InlineKeyboard().text('✅', `ok:${id}`).text('❌', `no:${id}`);

  // A throw out of a handler otherwise reaches grammY's default handler, which stops polling and
  // rethrows — the rejection escapes bot.start(), kills the process, and (because the update was
  // never confirmed) Telegram redelivers it into the same crash on restart. A 429, a 502 or a tap
  // on a >48h-old button is enough. Log and swallow instead: the bot stays up and the update is
  // acknowledged, so nothing is redelivered.
  bot.catch((err) => { console.error('telegram handler:', err.error ?? err); });

  // Locked to the owner's chat: anything else (including updates with no chat) is dropped unanswered.
  bot.use(async (ctx, next) => { if (ctx.chat && String(ctx.chat.id) === chatId) await next(); });

  // /start is the first thing anyone sends a bot, and the text handler below drops everything
  // beginning with "/" — without these two the first message gets no reply at all.
  for (const c of ['start', 'help'] as const) bot.command(c, (ctx) => ctx.reply(HELP));

  bot.command('stats', async (ctx) => {
    await ctx.reply(fmtStats(collectStats(db, new Date(Date.now() - 7 * 86_400_000).toISOString())));
  });
  for (const mode of ['auto', 'shadow'] as const)
    bot.command(mode, async (ctx) => {
      db.setMeta('mode', mode);
      // Approvals only count from the flip onwards; clearing on /shadow re-stamps the next /auto,
      // so a shadow interlude cannot leave the first window's approved rows eligible forever.
      // senderTick stamps this itself if it is missing, so this only makes the boundary exact.
      db.setMeta('autoSince', mode === 'auto' ? new Date().toISOString() : '');
      await ctx.reply(`mode: ${mode}`);
    });
  bot.command('pause', async (ctx) => { db.setMeta('paused', '1'); await ctx.reply('paused'); });
  bot.command('resume', async (ctx) => { db.setMeta('paused', '0'); await ctx.reply('resumed'); });
  bot.command('status', async (ctx) => {
    const [id, ...note] = ctx.match.trim().split(/\s+/);
    if (!id || !note.length) { await ctx.reply('usage: /status <id> <note>'); return; }
    // setStatusNote no-ops on an unknown id, so without this the note is swallowed and the
    // reply still says "noted" — the user's typing is gone with no sign of it.
    if (!db.getListing(id)) { await ctx.reply(`no listing #${id}`); return; }
    db.setStatusNote(id, note.join(' '));
    await ctx.reply(`noted #${id}`);
  });

  bot.on('callback_query:data', async (ctx) => {
    const m = ctx.callbackQuery.data.match(/^(ok|no):(.+)$/);
    if (!m) { await ctx.answerCallbackQuery(); return; }
    const status = db.getListing(m[2])?.status;
    if (status && DECIDED.has(status)) { await ctx.answerCallbackQuery(`already ${status}`); return; }
    // In auto mode ✅ hands the listing straight to the sender; in shadow it just records approval.
    const ok = m[1] === 'ok';
    const approved = db.getMeta('mode') === 'auto' ? 'queued' : 'approved';
    db.setDecision(m[2], { status: ok ? approved : 'rejected' });
    await ctx.answerCallbackQuery(ok ? '✅' : '❌');
    // The ask stays in the chat forever. Live buttons on a decided listing only invite taps that
    // Telegram rejects once the message is >48h old. Answer first, then take them away.
    await ctx.editMessageReplyMarkup();
  });

  // Any other text is feedback, tied to the listing whose message it replies to (or global).
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    db.addFeedback(listingIdFromReply(ctx.message.reply_to_message?.text), ctx.message.text);
    await ctx.react('👍');
  });

  // `withVerdict` is the listing id when the message is still decidable — a receipt for a real
  // send is history, and buttons on history only invite a duplicate application.
  const send = async (text: string, withVerdict?: string) => {
    await bot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      ...(withVerdict ? { reply_markup: verdictKeyboard(withVerdict) } : {}),
    });
  };
  const notifier: Notifier = {
    ask: (r) => send(fmtAsk(r), r.id),
    receipt: (r) => send(fmtReceipt(r), r.status === 'sent' ? undefined : r.id),
    text: (msg) => send(msg),
  };

  return { bot, notifier };
}
