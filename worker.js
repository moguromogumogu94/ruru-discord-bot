'use strict';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.0.0-worker-http';
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const SEND_MESSAGES = 1n << 11n;
const ADMINISTRATOR = 1n << 3n;
const TEXT_TYPES = new Set([0, 5, 15]);
const encoder = new TextEncoder();

const clean = (v, max = 1800) => String(v || '').replace(/\u0000/g, '').slice(0, max);
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

function hexToBytes(hex) {
  if (!hex || hex.length % 2) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyDiscordRequest(request, body, publicKeyHex) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

async function discordApi(env, path, options = {}) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Discord ${response.status} ${path}`);
  if (response.status === 204) return null;
  return response.json();
}

function roleBasePermissions(guildId, roles, memberRoleIds) {
  const memberRoles = new Set(memberRoleIds || []);
  let permissions = 0n;
  for (const role of roles || []) {
    if (role.id === guildId || memberRoles.has(role.id)) permissions |= BigInt(role.permissions || '0');
  }
  return permissions;
}

function applyChannelOverwrites(base, channel, guildId, roleIds, memberId) {
  if ((base & ADMINISTRATOR) === ADMINISTRATOR) return (1n << 63n) - 1n;
  let permissions = base;
  const overwrites = channel.permission_overwrites || [];

  const everyone = overwrites.find((o) => o.id === guildId && Number(o.type) === 0);
  if (everyone) {
    permissions &= ~BigInt(everyone.deny || '0');
    permissions |= BigInt(everyone.allow || '0');
  }

  let roleDeny = 0n;
  let roleAllow = 0n;
  const roleSet = new Set(roleIds || []);
  for (const o of overwrites) {
    if (Number(o.type) === 0 && roleSet.has(o.id)) {
      roleDeny |= BigInt(o.deny || '0');
      roleAllow |= BigInt(o.allow || '0');
    }
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const member = overwrites.find((o) => Number(o.type) === 1 && o.id === memberId);
  if (member) {
    permissions &= ~BigInt(member.deny || '0');
    permissions |= BigInt(member.allow || '0');
  }
  return permissions;
}

function hasPermission(permissions, bit) {
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR || (permissions & bit) === bit;
}

async function buildScope(env, interaction) {
  const guildId = interaction.guild_id;
  const caller = interaction.member;
  const [channels, roles, botUser] = await Promise.all([
    discordApi(env, `/guilds/${guildId}/channels`),
    discordApi(env, `/guilds/${guildId}/roles`),
    discordApi(env, '/users/@me'),
  ]);
  const botMember = await discordApi(env, `/guilds/${guildId}/members/${botUser.id}`);

  const callerBase = roleBasePermissions(guildId, roles, caller?.roles || []);
  const botBase = roleBasePermissions(guildId, roles, botMember?.roles || []);
  const allowed = new Map();

  for (const channel of channels || []) {
    if (!TEXT_TYPES.has(Number(channel.type)) || channel.nsfw) continue;
    const userPerms = applyChannelOverwrites(callerBase, channel, guildId, caller?.roles || [], interaction.member.user.id);
    const botPerms = applyChannelOverwrites(botBase, channel, guildId, botMember?.roles || [], botUser.id);
    if (!hasPermission(userPerms, VIEW_CHANNEL) || !hasPermission(userPerms, READ_MESSAGE_HISTORY)) continue;
    if (!hasPermission(botPerms, VIEW_CHANNEL) || !hasPermission(botPerms, READ_MESSAGE_HISTORY)) continue;
    allowed.set(channel.id, channel);
  }
  return { allowed, botUser, botMember, roles };
}

function recordMessage(message, guildId, channelName) {
  const embedText = (message.embeds || [])
    .map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)]
      .filter(Boolean).join('\n'))
    .filter(Boolean).join('\n');
  const content = clean([message.content, embedText].filter(Boolean).join('\n'), 1800);
  return {
    id: message.id,
    channel_id: message.channel_id,
    channel: channelName || message.channel_id,
    author: message.author?.global_name || message.author?.username || '不明',
    author_id: message.author?.id,
    bot: !!message.author?.bot,
    date: message.timestamp,
    edited_at: message.edited_timestamp || null,
    content,
    url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
  };
}

async function recentMessages(env, interaction) {
  try {
    const messages = await discordApi(env, `/channels/${interaction.channel_id}/messages?limit=10`);
    return (messages || [])
      .slice().reverse()
      .filter((m) => !m.author?.bot)
      .map((m) => recordMessage(m, interaction.guild_id, interaction.channel?.name))
      .filter((m) => m.content)
      .slice(-8)
      .map((m) => ({ ...m, content: clean(m.content, 700) }));
  } catch {
    return [];
  }
}

async function searchServer(env, interaction, scope, plan) {
  const requested = Array.isArray(plan.channel_ids) ? plan.channel_ids.map(String) : [];
  const ids = requested.length
    ? requested.filter((id) => scope.allowed.has(id))
    : [...scope.allowed.keys()].slice(0, 90);
  const queries = [...new Set((Array.isArray(plan.queries) ? plan.queries : [plan.query || ''])
    .map((q) => clean(q, 100).trim()))].slice(0, 2);
  if (!queries.length) queries.push('');

  const found = new Map();
  const errors = [];
  for (const q of queries) {
    const params = new URLSearchParams({ limit: '20', sort_by: 'timestamp', sort_order: 'desc', include_nsfw: 'false' });
    if (q) params.set('content', q);
    for (const id of ids) params.append('channel_id', id);
    try {
      const data = await discordApi(env, `/guilds/${interaction.guild_id}/messages/search?${params}`);
      const rows = Array.isArray(data.messages) ? data.messages.flat() : [];
      for (const m of rows.slice(0, 30)) {
        if (!m?.id || m.author?.id === scope.botUser.id || !scope.allowed.has(m.channel_id)) continue;
        const item = recordMessage(m, interaction.guild_id, scope.allowed.get(m.channel_id)?.name);
        if (item.content) found.set(item.id, item);
      }
    } catch (e) {
      errors.push(clean(e?.message || String(e), 200));
    }
  }
  return {
    type: 'server',
    status: errors.length ? (found.size ? 'partial' : 'error') : 'ok',
    queries,
    records: [...found.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 14),
    errors,
    note: 'Discord内の検索結果です。質問者とるるの双方が閲覧できるチャンネルだけを対象にしています。',
  };
}

function decodeXml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(m?.[1] || '').replace(/<[^>]*>/g, '').trim();
}
async function searchNews(query) {
  const u = new URL('https://news.google.com/rss/search');
  u.search = new URLSearchParams({ q: clean(query, 120), hl: 'ja', gl: 'JP', ceid: 'JP:ja' }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`News ${r.status}`);
  const xml = await r.text();
  const records = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map((m) => ({
    title: clean(parseTag(m[1], 'title'), 300),
    url: parseTag(m[1], 'link'),
    date: parseTag(m[1], 'pubDate'),
    source: parseTag(m[1], 'source'),
  })).filter((x) => x.title && /^https:\/\//.test(x.url));
  return { type: 'news', status: 'ok', checked_at: new Date().toISOString(), records,
    note: 'ニュース見出し・配信元・日時・リンクを取得した結果です。記事本文は未確認です。' };
}

function decodeHtml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripHtml(s) {
  return decodeHtml(String(s || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function externalSafe(question) {
  return !/discord\.com\/channels|<@|\b\d{16,20}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|このサーバー|Discord内|ディスコード内|この部屋|別のチャンネル|メンバーの発言|過去の投稿/i.test(question);
}
async function searchWeb(query, question) {
  query = clean(query, 160).trim();
  if (!query || !externalSafe(question)) return { type: 'web', status: 'blocked', records: [], note: '内部情報・個人情報を外部検索へ送らないため検索していません。' };
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RuruBot/3.0)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`Web ${r.status}`);
  const html = await r.text();
  const records = [];
  for (const m of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = decodeHtml(m[1]);
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch {}
    if (!/^https?:\/\//i.test(href)) continue;
    records.push({ title: clean(stripHtml(m[2]), 300), url: clean(href, 1000) });
    if (records.length >= 8) break;
  }
  return { type: 'web', status: records.length ? 'ok' : 'empty', query,
    checked_at: new Date().toISOString(), records,
    note: '一般Web検索のタイトルとURLです。公式サイトを優先して回答してください。' };
}

const CITY_COORDS = {
  '東京': { name: '東京', latitude: 35.6762, longitude: 139.6503 },
  '東京都': { name: '東京', latitude: 35.6762, longitude: 139.6503 },
  '札幌': { name: '札幌', latitude: 43.0618, longitude: 141.3545 },
  '札幌市': { name: '札幌', latitude: 43.0618, longitude: 141.3545 },
  '大阪': { name: '大阪', latitude: 34.6937, longitude: 135.5023 },
  '大阪市': { name: '大阪', latitude: 34.6937, longitude: 135.5023 },
  '名古屋': { name: '名古屋', latitude: 35.1815, longitude: 136.9066 },
  '福岡': { name: '福岡', latitude: 33.5902, longitude: 130.4017 },
  '横浜': { name: '横浜', latitude: 35.4437, longitude: 139.6380 },
  '仙台': { name: '仙台', latitude: 38.2682, longitude: 140.8694 },
  '京都': { name: '京都', latitude: 35.0116, longitude: 135.7681 },
  '那覇': { name: '那覇', latitude: 26.2124, longitude: 127.6809 },
};
function inferPlace(q) {
  for (const key of Object.keys(CITY_COORDS)) if (q.includes(key)) return key;
  const m = q.match(/([一-龥ぁ-んァ-ヶA-Za-z]{2,20})(?:の)?(?:天気|気温|降水|雨|雪)/);
  return m?.[1]?.replace(/^(今日|明日|あした|週末|今週|来週)/, '') || null;
}
async function searchWeather(question) {
  const place = inferPlace(question) || '東京';
  let loc = CITY_COORDS[place];
  if (!loc) {
    const names = [place, place.replace(/市$/, ''), `${place} Japan`];
    for (const name of names) {
      const gr = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ja&format=json`, { signal: AbortSignal.timeout(10000) });
      if (!gr.ok) continue;
      const gj = await gr.json();
      if (gj.results?.[0]) { loc = gj.results[0]; break; }
    }
  }
  if (!loc) return { type: 'weather', status: 'empty', place, records: [], note: '場所を特定できませんでした。' };
  const params = new URLSearchParams({
    latitude: String(loc.latitude), longitude: String(loc.longitude), timezone: 'Asia/Tokyo', forecast_days: '7',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
  });
  const wr = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!wr.ok) throw new Error(`Weather ${wr.status}`);
  const w = await wr.json();
  const rows = (w.daily?.time || []).map((date, i) => ({
    date,
    weather_code: w.daily.weather_code?.[i],
    temp_max: w.daily.temperature_2m_max?.[i],
    temp_min: w.daily.temperature_2m_min?.[i],
    precip_probability_max: w.daily.precipitation_probability_max?.[i],
    precipitation_sum: w.daily.precipitation_sum?.[i],
    wind_max: w.daily.wind_speed_10m_max?.[i],
  }));
  return { type: 'weather', status: 'ok', checked_at: new Date().toISOString(),
    location: { name: loc.name || place, admin1: loc.admin1 || '', country: loc.country || 'Japan' }, records: rows,
    note: 'Open-Meteoの7日間予報です。時刻は日本時間。予報は更新されます。' };
}

function parseTool(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw.startsWith('{')) return null;
  try {
    const p = JSON.parse(raw);
    return ['server_search', 'news_search', 'web_search', 'weather_search'].includes(p.ruru_tool) ? p : null;
  } catch {
    return null;
  }
}
function forcedTool(question) {
  if (!externalSafe(question)) return null;
  if (/天気|気温|降水|降る|雨|雪|台風|猛暑|最低気温|最高気温/.test(question)) return { ruru_tool: 'weather_search' };
  if (/最新|現在|今どう|今日の|明日の|あしたの|今週|週末|来週|発売日|価格|値段|営業時間|営業中|在庫|何時|いつ発売|新しいの|アップデート|バージョン/.test(question)) {
    return { ruru_tool: 'web_search', query: question };
  }
  return null;
}

async function askMake(env, base, packet) {
  const r = await fetch(env.MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, content: JSON.stringify(packet) }),
    signal: AbortSignal.timeout(30000),
  });
  const t = (await r.text()).trim();
  if (!r.ok || !t || /^(Accepted|OK)$/i.test(t)) throw new Error(`Make ${r.status}`);
  return t;
}

async function buildAnswer(env, interaction, question) {
  const [scope, history] = await Promise.all([
    buildScope(env, interaction),
    recentMessages(env, interaction),
  ]);
  const member = interaction.member;
  const displayName = member?.nick || member?.user?.global_name || member?.user?.username || 'ユーザー';
  const base = {
    author_username: member?.user?.username || '',
    author_display_name: displayName,
    author_id: member?.user?.id || '',
    channel_id: interaction.channel_id,
    guild_id: interaction.guild_id,
    message_id: 'slash-command',
    timestamp: new Date().toISOString(),
  };
  const packet = {
    protocol: 'ruru-v2', phase: 'request', question: clean(question, 4000), now: new Date().toISOString(), timezone: 'Asia/Tokyo',
    author: displayName, recent_messages: history,
    readable_channels: [...scope.allowed.values()].slice(0, 90).map((c) => ({ id: c.id, name: c.name, topic: clean(c.topic, 180) })),
    can_search_server: true, can_search_news_headlines: true, can_search_web: true, can_search_weather: true,
  };

  let tool = forcedTool(question);
  let result = null;
  let answer;
  if (tool) {
    if (tool.ruru_tool === 'weather_search') result = await searchWeather(question);
    else result = await searchWeb(tool.query || question, question);
    answer = await askMake(env, base, { ...packet, phase: 'answer', tool_result: result, forced_search: true });
  } else {
    answer = await askMake(env, base, packet);
    tool = parseTool(answer);
    if (tool?.ruru_tool === 'server_search') result = await searchServer(env, interaction, scope, tool);
    else if (tool?.ruru_tool === 'news_search') result = await searchNews(tool.query || question);
    else if (tool?.ruru_tool === 'web_search') result = await searchWeb(tool.query || question, question);
    else if (tool?.ruru_tool === 'weather_search') result = await searchWeather(question);
    if (tool) {
      answer = await askMake(env, base, { ...packet, phase: 'answer', tool_result: result });
      if (parseTool(answer)) answer = 'すみません。検索結果をうまく整理できませんでした。もう一度お願いします。';
    }
  }
  return { answer: clean(answer, 7600), displayName, tool: tool?.ruru_tool || null };
}

async function editOriginal(interaction, content) {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) throw new Error(`Edit original ${r.status}`);
}
async function followUp(interaction, content, ephemeral = false) {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, ...(ephemeral ? { flags: 64 } : {}) }),
  });
  if (!r.ok) throw new Error(`Followup ${r.status}`);
}

function getMessageOption(interaction) {
  return interaction.data?.options?.find((o) => o.name === 'メッセージ')?.value
    || interaction.data?.options?.find((o) => o.name === 'message')?.value
    || '';
}
function looksServerSensitive(question) {
  return /サーバー|Discord|ディスコード|別のチャンネル|別チャンネル|過去の投稿|前に.*話|誰が.*言|オフ会|募集投稿|この部屋|他の部屋/.test(question);
}

async function processInteraction(env, interaction, question, isEphemeral) {
  try {
    const { answer, displayName } = await buildAnswer(env, interaction, question);
    let visible = `**${clean(displayName, 80)}：** ${clean(question, 1000)}\n\n${answer}`;
    await editOriginal(interaction, visible.slice(0, 1900));
    visible = visible.slice(1900).trim();
    while (visible) {
      await followUp(interaction, visible.slice(0, 1900), isEphemeral);
      visible = visible.slice(1900).trim();
    }
  } catch (e) {
    await editOriginal(interaction, 'すみません。今は回答処理を完了できませんでした。少し時間をおいて、もう一度お願いします。').catch(() => {});
    console.log(JSON.stringify({ type: 'ruru_error', version: VERSION, error: clean(e?.message || String(e), 500) }));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      return json({ ok: true, service: 'ruru-worker', version: VERSION });
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    const valid = await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('invalid request signature', { status: 401 });

    let interaction;
    try { interaction = JSON.parse(body); }
    catch { return new Response('bad json', { status: 400 }); }

    if (interaction.type === 1) return json({ type: 1 });
    if (interaction.type !== 2 || interaction.data?.name !== 'るる') {
      return json({ type: 4, data: { content: 'この操作には対応していません。', flags: 64 } });
    }

    const question = clean(getMessageOption(interaction), 4000).trim();
    if (!question) return json({ type: 4, data: { content: 'メッセージを入力してください。', flags: 64 } });

    const ephemeral = looksServerSensitive(question);
    ctx.waitUntil(processInteraction(env, interaction, question, ephemeral));
    return json({ type: 5, data: ephemeral ? { flags: 64 } : {} });
  },
};
