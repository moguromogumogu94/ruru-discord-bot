'use strict';

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  ApplicationCommandType,
  ApplicationCommandOptionType,
} = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const LEGACY_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1546475931411943466';
const PORT = process.env.PORT || 10000;
const VERSION = '2.3.0-web-search';

if (!BOT_TOKEN || !MAKE_WEBHOOK_URL) process.exit(1);

const app = express();
let discordReady = false;
let lastError = null;
let lastReplyAt = null;
let lastTool = null;
let commandGuilds = 0;

app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'ruru-discord-bot',
  version: VERSION,
  discordReady,
  command: '/るる',
  commandGuilds,
  legacyChannel: LEGACY_CHANNEL_ID,
  lastReplyAt,
  lastTool,
  lastError,
}));
app.listen(PORT, () => console.log(`HTTP ready on ${PORT}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { timeout: 12000, retries: 1 },
});

const clean = (v, max = 1800) => String(v || '').replace(/\u0000/g, '').slice(0, max);
const safeErr = (e) => clean(e?.message || e?.code || String(e), 300);

function canRead(channel, member) {
  return !!channel?.permissionsFor?.(member)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
}
function canSend(channel, member) {
  return !!channel?.permissionsFor?.(member)?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ]);
}
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripHtml(s) {
  return decodeHtml(String(s || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function recordMessage(message, guild, channelName) {
  const embedText = (message.embeds || []).map((e) => [
    e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`),
  ].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  const content = clean([message.content, embedText].filter(Boolean).join('\n'), 1800);
  const channelId = message.channel_id || message.channelId;
  const messageId = message.id;
  return {
    id: messageId,
    channel_id: channelId,
    channel: channelName || channelId,
    author: message.author?.globalName || message.author?.global_name || message.author?.username || '不明',
    author_id: message.author?.id,
    bot: !!message.author?.bot,
    date: message.timestamp || message.createdAt?.toISOString(),
    edited_at: message.edited_timestamp || message.editedAt?.toISOString() || null,
    content,
    url: `https://discord.com/channels/${guild.id}/${channelId}/${messageId}`,
  };
}

async function readableScope(replyChannel, member) {
  const guild = replyChannel.guild;
  const botMember = await guild.members.fetchMe();
  const channels = await guild.channels.fetch();
  const allowed = new Map();
  for (const channel of channels.values()) {
    if (!channel || channel.nsfw) continue;
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(channel.type)) continue;
    if (!canRead(channel, member) || !canRead(channel, botMember)) continue;
    allowed.set(channel.id, channel);
  }
  if (canRead(replyChannel, member) && canRead(replyChannel, botMember)) allowed.set(replyChannel.id, replyChannel);
  return { allowed, botMember };
}

async function recentMessages(channel, beforeId) {
  try {
    const messages = await channel.messages.fetch({ limit: 10, ...(beforeId ? { before: beforeId } : {}) });
    return [...messages.values()].reverse()
      .filter((m) => !m.author.bot)
      .map((m) => recordMessage(m, channel.guild, m.channel.name))
      .filter((m) => m.content).slice(-8)
      .map((m) => ({ ...m, content: clean(m.content, 700) }));
  } catch { return []; }
}

async function searchServer(plan, channel, member, omitMessageId) {
  const { allowed } = await readableScope(channel, member);
  const requested = Array.isArray(plan.channel_ids) ? plan.channel_ids.map(String) : [];
  const channelIds = requested.length ? requested.filter((id) => allowed.has(id)) : [...allowed.keys()].slice(0, 90);
  const queries = [...new Set((Array.isArray(plan.queries) ? plan.queries : [plan.query || ''])
    .map((q) => clean(q, 100).trim()))].slice(0, 2);
  if (!queries.length) queries.push('');
  const found = new Map();
  const errors = [];
  for (const query of queries) {
    const params = new URLSearchParams({ limit: '20', sort_by: 'timestamp', sort_order: 'desc', include_nsfw: 'false' });
    if (query) params.set('content', query);
    for (const id of channelIds) params.append('channel_id', id);
    try {
      const data = await client.rest.get(`/guilds/${channel.guild.id}/messages/search`, { query: params });
      const rows = Array.isArray(data.messages) ? data.messages.flat() : [];
      for (const message of rows.slice(0, 30)) {
        if (!message?.id || message.id === omitMessageId || message.author?.id === client.user.id) continue;
        if (!allowed.has(message.channel_id)) continue;
        const item = recordMessage(message, channel.guild, allowed.get(message.channel_id)?.name);
        if (item.content) found.set(item.id, item);
      }
    } catch (err) { errors.push(safeErr(err)); }
  }
  return {
    type: 'server',
    status: errors.length ? (found.size ? 'partial' : 'error') : 'ok',
    queries,
    records: [...found.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 14),
    errors,
    note: 'Discord内の検索結果です。削除済み投稿・添付ファイル本文・検索索引に未反映の投稿は取得できない場合があります。',
  };
}

function decodeXml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(m?.[1] || '').replace(/<[^>]*>/g, '').trim();
}
async function searchNews(query) {
  const url = new URL('https://news.google.com/rss/search');
  url.search = new URLSearchParams({ q: clean(query, 120), hl: 'ja', gl: 'JP', ceid: 'JP:ja' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`News ${response.status}`);
  const xml = await response.text();
  const records = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map((m) => ({
    title: clean(parseTag(m[1], 'title'), 300),
    url: parseTag(m[1], 'link'),
    date: parseTag(m[1], 'pubDate'),
    source: parseTag(m[1], 'source'),
  })).filter((x) => x.title && /^https:\/\//.test(x.url));
  return { type: 'news', status: 'ok', checked_at: new Date().toISOString(), records,
    note: 'ニュース見出し・配信元・日時・リンクを取得した結果です。記事本文は未確認です。' };
}

function webQueryPermitted(question, query) {
  if (!query || query.length > 160) return false;
  const combined = `${question}\n${query}`;
  if (/discord\.com\/channels|<@|\b\d{16,20}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(combined)) return false;
  if (/このサーバー|Discord内|ディスコード内|この部屋|別のチャンネル|メンバーの発言|過去の投稿/i.test(question)) return false;
  return true;
}

async function searchWeb(query, question) {
  query = clean(query, 160).trim();
  if (!webQueryPermitted(question, query)) return {
    type: 'web', status: 'blocked', records: [],
    note: 'Discord内部情報や個人情報を外部検索に送らないため、検索を実行しませんでした。',
  };
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RuruBot/1.0)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Web search ${response.status}`);
  const html = await response.text();
  const blocks = [...html.matchAll(/<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)].slice(0, 10);
  const records = [];
  for (const block of blocks) {
    const body = block[1];
    const link = body.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let href = decodeHtml(link[1]);
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch {}
    if (!/^https?:\/\//i.test(href)) continue;
    const snippet = body.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    records.push({
      title: clean(stripHtml(link[2]), 300),
      url: clean(href, 1000),
      snippet: clean(stripHtml(snippet?.[1] || snippet?.[2] || ''), 700),
    });
    if (records.length >= 8) break;
  }
  if (!records.length) return { type: 'web', status: 'empty', query, checked_at: new Date().toISOString(), records: [], note: '検索結果を取得できませんでした。' };
  return { type: 'web', status: 'ok', query, checked_at: new Date().toISOString(), records,
    note: '一般Web検索のタイトル・URL・概要文です。必要に応じて公式サイトを優先して回答してください。' };
}

function parseTool(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return ['server_search', 'news_search', 'web_search'].includes(parsed.ruru_tool) ? parsed : null;
  } catch { return null; }
}

async function askMake(base, packet) {
  const response = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, content: JSON.stringify(packet) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = (await response.text()).trim();
  if (!response.ok || !text || /^(Accepted|OK)$/i.test(text)) throw new Error(`Make response ${response.status}`);
  return text;
}

async function answerQuestion(channel, member, question, messageId = null) {
  const [history, scope] = await Promise.all([recentMessages(channel, messageId), readableScope(channel, member)]);
  const base = {
    author_username: member.user.username,
    author_display_name: member.displayName || member.user.globalName || member.user.username,
    author_id: member.id, channel_id: channel.id, guild_id: channel.guild.id,
    message_id: messageId || 'slash-command', timestamp: new Date().toISOString(),
  };
  const packet = {
    protocol: 'ruru-v2', phase: 'request', question: clean(question, 4000),
    now: new Date().toISOString(), timezone: 'Asia/Tokyo', author: base.author_display_name,
    recent_messages: history,
    readable_channels: [...scope.allowed.values()].slice(0, 90).map((c) => ({ id: c.id, name: c.name, topic: clean(c.topic, 180) })),
    can_search_server: true, can_search_news_headlines: true, can_search_web: true,
  };
  let answer = await askMake(base, packet);
  const tool = parseTool(answer);
  let result = null;
  if (tool?.ruru_tool === 'server_search') result = await searchServer(tool, channel, member, messageId);
  else if (tool?.ruru_tool === 'news_search') result = await searchNews(tool.query || question);
  else if (tool?.ruru_tool === 'web_search') result = await searchWeb(tool.query || question, question);
  if (tool) {
    answer = await askMake(base, { ...packet, phase: 'answer', tool_result: result });
    if (parseTool(answer)) answer = 'すみません。検索結果をうまく整理できませんでした。もう一度お願いします。';
  }
  lastTool = tool?.ruru_tool || null;
  lastReplyAt = new Date().toISOString();
  return clean(answer, 7600);
}

async function registerSlashCommands() {
  const definition = {
    name: 'るる', description: 'AI秘書るるに自由に話しかけます', type: ApplicationCommandType.ChatInput,
    options: [{ name: 'メッセージ', description: '質問・相談・雑談・要約など、自由に入力してください', type: ApplicationCommandOptionType.String, required: true }],
  };
  let count = 0;
  for (const guild of client.guilds.cache.values()) {
    try { await guild.commands.set([definition]); count++; console.log(`Registered /るる in ${guild.name}`); }
    catch (err) { console.error(`Command registration failed for ${guild.id}`, safeErr(err)); }
  }
  commandGuilds = count;
}

client.once('ready', async () => {
  discordReady = true; lastError = null;
  console.log(`Discord connected as ${client.user.tag} (${VERSION})`);
  await registerSlashCommands();
});
client.on('shardDisconnect', () => { discordReady = false; });
client.on('shardReady', () => { discordReady = true; });
client.on('error', (err) => { lastError = safeErr(err); });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'るる' || !interaction.guild) return;
  try {
    await interaction.deferReply();
    const channel = await interaction.guild.channels.fetch(interaction.channelId);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!channel || !canRead(channel, member) || !canSend(channel, await interaction.guild.members.fetchMe())) {
      await interaction.editReply('このチャンネルでは、るるが返信する権限がありません。'); return;
    }
    const userMessage = interaction.options.getString('メッセージ', true).trim();
    const answer = await answerQuestion(channel, member, userMessage, null);
    const displayName = member.displayName || interaction.user.globalName || interaction.user.username;
    const visible = `**${clean(displayName, 80)}：** ${clean(userMessage, 1000)}\n\n${answer}`;
    await interaction.editReply(visible.slice(0, 1900));
    let rest = visible.slice(1900).trim();
    while (rest) { await interaction.followUp({ content: rest.slice(0, 1900), allowedMentions: { parse: [] } }); rest = rest.slice(1900).trim(); }
  } catch (err) {
    lastError = safeErr(err);
    const msg = 'すみません。今は回答処理を完了できませんでした。少し時間をおいて、もう一度お願いします。';
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

// 移行期間中のみ専用チャンネルへの通常投稿にも返信。
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || message.channelId !== LEGACY_CHANNEL_ID) return;
  const question = message.content.trim(); if (!question) return;
  try {
    await message.channel.sendTyping().catch(() => {});
    const member = message.member || await message.guild.members.fetch(message.author.id);
    const answer = await answerQuestion(message.channel, member, question, message.id);
    await message.reply({ content: answer.slice(0, 1900), allowedMentions: { parse: [], repliedUser: false }, failIfNotExists: false });
  } catch (err) { lastError = safeErr(err); }
});

client.login(BOT_TOKEN).catch((err) => { lastError = safeErr(err); console.error('Discord login failed', lastError); process.exit(1); });
