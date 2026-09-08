'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { Client, GatewayIntentBits, PermissionFlagsBits: P, ChannelType } = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1546475931411943466';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const PORT = process.env.PORT || 10000;
const VERSION = '2.0.0-make-search';
const app = express();
app.use(express.json({ limit: '8kb' }));
const state = { discordReady: false, lastForwardAt: null, lastReplyAt: null, lastError: null,
  lastSearch: null, requests: 0, makeCalls: 0 };
const busy = new Set();
const recentIds = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = (v, max = 1200) => String(v || '').replace(/\u0000/g, '').slice(0, max);
const safeError = e => `${clean(e?.name || 'Error', 50)}:${clean(e?.code || e?.status || 'request_failed', 50)}`;

app.get('/', (_req, res) => res.json({ ok: true, service: 'ruru-discord-bot', version: VERSION, ...state }));

if (!BOT_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Missing required Bot/Make environment variables');
  process.exit(1);
}
const diagnosticKey = crypto.createHmac('sha256', MAKE_WEBHOOK_URL).update('ruru-readonly-diagnostics-v2').digest('hex');
function diagnosticAuth(req, res, next) {
  const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, ''));
  const expected = Buffer.from(diagnosticKey);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { timeout: 12000, retries: 1 },
});
client.once('ready', () => { state.discordReady = true; state.lastError = null; console.log(`RURU_READY ${VERSION}`); });
client.on('shardDisconnect', () => { state.discordReady = false; });
client.on('shardReady', () => { state.discordReady = true; });
client.on('error', err => { state.lastError = safeError(err); console.error('RURU_CLIENT_ERROR', state.lastError); });

function splitDiscordMessage(text, max = 1900) {
  const chunks = [];
  let rest = clean(text, 7600).trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    chunks.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
function canRead(channel, member) {
  return !!channel?.permissionsFor?.(member)?.has([P.ViewChannel, P.ReadMessageHistory]);
}
function visibilitySignature(channel) {
  return [...channel.permissionOverwrites.cache.values()].map(o => {
    const mask = P.ViewChannel | P.ReadMessageHistory;
    const allow = o.allow.bitfield & mask; const deny = o.deny.bitfield & mask;
    return allow || deny ? `${o.id}:${o.type}:${allow}:${deny}` : null;
  }).filter(Boolean).sort().join('|');
}
// A public reply must not reveal rooms that only the asker (or the Bot) can read.
function safeForReply(channel, replyChannel, member, bot) {
  if (!channel || channel.nsfw || !canRead(channel, member) || !canRead(channel, bot)) return false;
  if (channel.id === replyChannel.id) return true;
  if (channel.isThread?.()) return false;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(channel.type)) return false;
  if (channel.guild.id === replyChannel.guild.id && visibilitySignature(channel) === visibilitySignature(replyChannel)) return true;
  if (!canRead(channel, channel.guild.roles.everyone)) return false;
  return !channel.permissionOverwrites.cache.some(o => o.deny.has(P.ViewChannel) || o.deny.has(P.ReadMessageHistory));
}
async function getContext(channel, member, omitId) {
  const guild = channel.guild;
  const [channels, bot] = await Promise.all([guild.channels.fetch(), guild.members.fetchMe()]);
  const scope = new Map();
  for (const c of channels.values()) if (safeForReply(c, channel, member, bot)) scope.set(c.id, c);
  if (canRead(channel, member) && canRead(channel, bot)) scope.set(channel.id, channel);
  let history = []; let historyStatus = 'ok';
  try {
    const items = await channel.messages.fetch({ limit: 10, ...(omitId ? { before: omitId } : {}) });
    history = [...items.values()].reverse().map(m => record(m, guild, m.channel.name)).filter(m => m.content).slice(-8).map(m => ({ ...m, content: clean(m.content, 700) }));
  } catch (err) { historyStatus = safeError(err); }
  return { scope, bot, history, historyStatus, channelIndex: [...scope.values()].slice(0, 90)
    .map(c => ({ id: c.id, name: c.name, topic: clean(c.topic, 180) })) };
}
function record(m, guild, channelName) {
  const embeds = (m.embeds || []).map(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).join('\n');
  const text = [m.content, embeds].filter(Boolean).join('\n');
  const id = m.id; const channelId = m.channel_id || m.channelId;
  return { id, channel_id: channelId, channel: channelName || channelId,
    author: m.author?.globalName || m.author?.global_name || m.author?.username || '不明',
    author_id: m.author?.id, bot: !!m.author?.bot, date: m.timestamp || m.createdAt?.toISOString(),
    edited_at: m.edited_timestamp || m.editedAt?.toISOString() || null,
    content: clean(text, 1800), url: `https://discord.com/channels/${guild.id}/${channelId}/${id}` };
}
async function allowedResultChannel(id, ctx, channel, member) {
  if (ctx.scope.has(id)) return ctx.scope.get(id);
  const c = await channel.guild.channels.fetch(id).catch(() => null);
  if (!c || ![ChannelType.PublicThread, ChannelType.AnnouncementThread].includes(c.type)) return null;
  if (!ctx.scope.has(c.parentId) || c.nsfw || c.parent?.nsfw || !canRead(c, member) || !canRead(c, ctx.bot)) return null;
  return c;
}
async function searchServer(plan, ctx, channel, member, omitId) {
  const requested = Array.isArray(plan.channel_ids) ? plan.channel_ids.map(String) : [];
  const ids = requested.length ? requested.filter(id => ctx.scope.has(id)) : [...ctx.scope.keys()];
  if (!ids.length) return { type: 'server', status: 'permission_denied', records: [] };
  const queries = [...new Set((Array.isArray(plan.queries) ? plan.queries : [plan.query || ''])
    .filter(q => typeof q === 'string').map(q => clean(q, 100).trim()))].slice(0, 2);
  if (!queries.length) queries.push('');
  const found = new Map(); const errors = []; let total = 0; let calls = 0;
  for (const q of queries) {
    const params = new URLSearchParams({ limit: '20', sort_by: 'timestamp', sort_order: 'desc', include_nsfw: 'false' });
    if (q) params.set('content', q);
    for (const id of ids.slice(0, 90)) params.append('channel_id', id);
    try {
      let data;
      for (let attempt = 0; attempt < 2; attempt++) {
        calls++;
        data = await client.rest.get(`/guilds/${channel.guild.id}/messages/search`, { query: params });
        if (data.code !== 110000) break;
        const wait = Number(data.retry_after || 2);
        if (wait > 4) throw Object.assign(new Error('Indexing'), { code: 'indexing' });
        await delay(Math.max(1000, wait * 1000));
      }
      if (!Array.isArray(data.messages)) throw Object.assign(new Error('No search results'), { code: data.code || 'search_unavailable' });
      total += Number(data.total_results || 0);
      for (const m of data.messages.flat().slice(0, 20)) {
        if (m.id === omitId || m.author?.id === client.user.id) continue;
        const c = await allowedResultChannel(m.channel_id, ctx, channel, member);
        if (!c) continue;
        const item = record(m, channel.guild, c.name);
        if (item.content) found.set(item.id, item);
      }
    } catch (err) { errors.push(safeError(err)); }
  }
  const records = [...found.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 14);
  state.lastSearch = { at: new Date().toISOString(), scopeCount: ids.length, resultCount: records.length,
    nativeSearchCalls: calls, oldestDate: records.length ? records[records.length - 1].date : null, errors };
  return { type: 'server', status: errors.length ? (records.length ? 'partial' : 'error') : 'ok',
    scope: '質問した部屋と、返信先の閲覧者にも開示できる部屋。非公開の別室・個人DMは対象外。',
    queries, total_matches: total, records, errors,
    note: 'Discord検索で過去の投稿を探した結果です。全投稿の保存・全文確認ではありません。編集・削除や検索索引の遅れがある場合があります。添付ファイルの中身は読み取っていません。' };
}
function decodeXml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const c = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseNews(xml) {
  const tag = (s, t) => decodeXml((s.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'i')) || [])[1] || '').replace(/<[^>]*>/g, '').trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map(m => ({
    title: clean(tag(m[1], 'title'), 300), url: tag(m[1], 'link'), date: tag(m[1], 'pubDate'), source: tag(m[1], 'source')
  })).filter(x => x.title && /^https:\/\//.test(x.url));
}
function webQueryPermitted(question, query) {
  if (typeof query !== 'string' || query.length < 2 || query.length > 120) return false;
  // Do not transmit community/private records to an external search service.
  if (/サーバー|サーバ|ディスコード|Discord|もぐろ|オフ会|メンバー|この部屋|あの部屋|過去の投稿|運営|配信予定|配信告知/i.test(question)) return false;
  return !/discord\.com\/channels|<@|\b\d{16,20}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\//i.test(query);
}
async function searchNews(query, question) {
  if (!webQueryPermitted(question, query)) return { type: 'news', status: 'blocked', records: [], note: '内部情報・個人情報を外部検索へ送れないため検索を実行していません。' };
  const url = new URL('https://news.google.com/rss/search');
  url.search = new URLSearchParams({ q: query, hl: 'ja', gl: 'JP', ceid: 'JP:ja' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error('News unavailable'), { code: `news_${response.status}` });
  const xml = await response.text();
  if (xml.length > 1500000) throw Object.assign(new Error('Feed too large'), { code: 'feed_too_large' });
  return { type: 'news', status: 'ok', query, checked_at: new Date().toISOString(), records: parseNews(xml),
    note: '取得したのはニュース見出し・配信元・配信日時・リンクだけです。記事本文は未確認です。現在の株価や為替の正確な数値、原因の断定には使えません。古い記事を今日の出来事と扱わないでください。' };
}
function parseTool(text) {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw.startsWith('{')) return null;
  try { const p = JSON.parse(raw); return ['server_search', 'news_search'].includes(p.ruru_tool) ? p : null; }
  catch { return null; }
}
async function askMake(base, packet) {
  state.makeCalls++;
  state.lastForwardAt = new Date().toISOString();
  const r = await fetch(MAKE_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(25000), body: JSON.stringify({ ...base, content: JSON.stringify(packet) }) });
  const text = (await r.text()).trim();
  if (!r.ok || !text || /^(Accepted|OK)$/i.test(text)) throw Object.assign(new Error('Make returned no answer'), { code: `make_${r.status}_no_answer` });
  return text;
}
async function answerQuestion(channel, member, question, messageId) {
  const ctx = await getContext(channel, member, messageId);
  const base = { content: question, author_username: member.user.username,
    author_display_name: member.displayName || member.user.username, author_id: member.id,
    channel_id: channel.id, guild_id: channel.guild.id, message_id: messageId || 'diagnostic', timestamp: new Date().toISOString() };
  const packet = { protocol: 'ruru-v2', phase: 'request', question: clean(question, 4000),
    now: new Date().toISOString(), timezone: 'Asia/Tokyo', author: base.author_display_name,
    recent_messages: ctx.history, history_status: ctx.historyStatus, readable_channels: ctx.channelIndex,
    can_search_server: true, can_search_news_headlines: true };
  let text = await askMake(base, packet);
  const tool = parseTool(text); let result = null;
  if (tool) {
    try { result = tool.ruru_tool === 'server_search' ? await searchServer(tool, ctx, channel, member, messageId) : await searchNews(clean(tool.query, 121), question); }
    catch (err) { result = { type: tool.ruru_tool, status: 'error', records: [], error: safeError(err) }; }
    text = await askMake(base, { ...packet, phase: 'answer', tool_result: result });
    if (parseTool(text)) text = 'すみません。今回の確認では回答に必要な情報を十分に整理できませんでした。調べたい部屋名やキーワードをもう少し具体的に教えてください。';
  }
  return { reply: text, tool: tool?.ruru_tool || null, historyCount: ctx.history.length,
    scopeCount: ctx.scope.size, result, linkedSource: !!result?.records?.some(r => text.includes(r.url)) };
}

// Authenticated, read-only diagnostics. Never posts a test message to Discord.
app.post('/internal/test', diagnosticAuth, async (req, res) => {
  if (!state.discordReady) return res.status(503).json({ error: 'not_ready' });
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const member = await channel.guild.members.fetch(req.body.user_id || channel.guild.ownerId);
    if (!canRead(channel, member)) return res.status(403).json({ error: 'forbidden' });
    if (req.body.action === 'inspect') {
      const ctx = await getContext(channel, member);
      const result = await searchServer({ queries: [clean(req.body.query || '配信', 100)] }, ctx, channel, member);
      return res.json({ historyCount: ctx.history.length, historySample: ctx.history.slice(-1),
        scopeCount: ctx.scope.size, channels: ctx.channelIndex, search: result });
    }
    const out = await answerQuestion(channel, member, clean(req.body.question || 'こんにちは。名前を教えてください。', 2000));
    res.json(out);
  } catch (err) { res.status(502).json({ error: safeError(err) }); }
});

client.on('messageCreate', async message => {
  if (message.author.bot || message.channelId !== CHANNEL_ID || !message.guild || !message.content.trim()) return;
  if (recentIds.has(message.id)) return;
  recentIds.set(message.id, Date.now());
  for (const [id, time] of recentIds) if (Date.now() - time > 600000) recentIds.delete(id);
  while (recentIds.size > 2000) recentIds.delete(recentIds.keys().next().value);
  const key = `${message.channelId}:${message.author.id}`;
  if (busy.has(key)) return;
  busy.add(key); state.requests++;
  try {
    await message.channel.sendTyping().catch(() => {});
    const member = message.member || await message.guild.members.fetch(message.author.id);
    const out = await answerQuestion(message.channel, member, message.content, message.id);
    const chunks = splitDiscordMessage(out.reply);
    for (let i = 0; i < chunks.length; i++) {
      const body = { content: chunks[i], allowedMentions: { parse: [], repliedUser: false } };
      if (i === 0) await message.reply({ ...body, failIfNotExists: false });
      else await message.channel.send(body);
    }
    state.lastReplyAt = new Date().toISOString(); state.lastError = null;
    console.log('RURU_REPLY', JSON.stringify({ tool: out.tool, history: out.historyCount, sources: out.result?.records?.length || 0 }));
  } catch (err) {
    state.lastError = safeError(err); console.error('RURU_REPLY_ERROR', state.lastError);
    await message.reply({ content: 'すみません。今は回答処理を完了できませんでした。接続エラーや利用枠の上限の可能性があります。', allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false }).catch(() => {});
  } finally { busy.delete(key); }
});

app.listen(PORT, () => console.log(`RURU_HTTP_READY ${VERSION}`));
client.login(BOT_TOKEN).catch(err => { console.error('RURU_LOGIN_ERROR', safeError(err)); process.exit(1); });
