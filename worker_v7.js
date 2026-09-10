'use strict';

import baseWorker from './worker_v6.js';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.5.0-worker-server-smart-search';
const encoder = new TextEncoder();
const clean = (v, max = 1800) => String(v || '').replace(/\u0000/g, '').slice(0, max);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;
const TEXT_TYPES = new Set([0, 5, 15]);

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
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexToBytes(signature), encoder.encode(timestamp + body));
  } catch { return false; }
}
async function discordApi(env, path) {
  const r = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
  });
  if (!r.ok) throw new Error(`Discord ${r.status} ${path}`);
  return r.status === 204 ? null : r.json();
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
function hasPermission(p, bit) {
  return (p & ADMINISTRATOR) === ADMINISTRATOR || (p & bit) === bit;
}
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFKC').replace(/[\s　_\-・|｜/\\()[\]{}「」『』【】<>!?！？。、,.:;：；"'`~〜～★☆🌟📗📺🔥👑📰🤖🍵🔬⚡]+/g, '');
}
function getMessageOption(i) {
  return i.data?.options?.find((o) => o.name === 'メッセージ')?.value
    || i.data?.options?.find((o) => o.name === 'message')?.value || '';
}
function isServerQuery(q) {
  return /サーバー|Discord|ディスコード|別のチャンネル|別チャンネル|過去の投稿|募集投稿|オフ会|この部屋|他の部屋|誰が.*言|前に.*話|投稿を探|投稿.*検索/i.test(q);
}
function termsFromQuestion(q) {
  const base = String(q || '').replace(/募集投稿|投稿|探して|検索して|見つけて|教えて|ありますか|ある？|について/gi, ' ');
  const terms = base.split(/[\s　,、。・/]+/).map(normalize).filter((x) => x.length >= 2);
  const joined = normalize(q);
  for (const t of ['東京','大阪','札幌','オフ会','募集','場所','時間','日程','イベント']) {
    if (joined.includes(normalize(t))) terms.push(normalize(t));
  }
  return [...new Set(terms)].slice(0, 8);
}
function recordMessage(m, guildId, channelName) {
  const embedText = (m.embeds || []).map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  return {
    id: m.id,
    channel_id: m.channel_id,
    channel: channelName || m.channel_id,
    author: m.author?.global_name || m.author?.username || '不明',
    date: m.timestamp,
    content: clean([m.content, embedText].filter(Boolean).join('\n'), 1500),
    url: `https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}`,
  };
}
async function buildScope(env, i) {
  const guildId = i.guild_id;
  const caller = i.member;
  const [channels, roles, botUser] = await Promise.all([
    discordApi(env, `/guilds/${guildId}/channels`),
    discordApi(env, `/guilds/${guildId}/roles`),
    discordApi(env, '/users/@me'),
  ]);
  const botMember = await discordApi(env, `/guilds/${guildId}/members/${botUser.id}`);
  const callerBase = roleBasePermissions(guildId, roles, caller?.roles || []);
  const botBase = roleBasePermissions(guildId, roles, botMember?.roles || []);
  const readable = [];
  for (const c of channels || []) {
    if (!TEXT_TYPES.has(Number(c.type)) || c.nsfw) continue;
    const userPerms = applyChannelOverwrites(callerBase, c, guildId, caller?.roles || [], caller?.user?.id);
    const botPerms = applyChannelOverwrites(botBase, c, guildId, botMember?.roles || [], botUser.id);
    if (!hasPermission(userPerms, VIEW_CHANNEL) || !hasPermission(userPerms, READ_MESSAGE_HISTORY)) continue;
    if (!hasPermission(botPerms, VIEW_CHANNEL) || !hasPermission(botPerms, READ_MESSAGE_HISTORY)) continue;
    readable.push({ id: c.id, name: c.name, topic: clean(c.topic, 180) });
  }
  return { readable, botUser };
}
async function searchServer(env, i, q) {
  const scope = await buildScope(env, i);
  const readableMap = new Map(scope.readable.map((c) => [c.id, c]));
  const terms = termsFromQuestion(q);
  const rankedChannels = scope.readable.map((c) => {
    const hay = normalize(`${c.name} ${c.topic || ''}`);
    let score = 0;
    for (const t of terms) if (t && hay.includes(t)) score += t.length >= 4 ? 3 : 1;
    if (/オフ会/.test(q) && hay.includes('オフ会')) score += 5;
    return { ...c, score };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);

  const found = new Map();
  const errors = [];

  // Strong signal: matching channel names. Read their recent messages directly.
  for (const c of rankedChannels) {
    try {
      const rows = await discordApi(env, `/channels/${c.id}/messages?limit=50`);
      for (const m of rows || []) {
        if (!m?.id || m.author?.id === scope.botUser.id) continue;
        const item = recordMessage(m, i.guild_id, c.name);
        if (item.content) found.set(item.id, item);
      }
    } catch (e) { errors.push(clean(e?.message || String(e), 200)); }
  }

  // Broad fallback: Discord server search using short terms instead of one long phrase.
  const ids = scope.readable.map((c) => c.id).slice(0, 90);
  const searchTerms = terms.filter((t) => t.length >= 2).slice(0, 5);
  for (const term of searchTerms) {
    const p = new URLSearchParams({ limit: '20', sort_by: 'timestamp', sort_order: 'desc', include_nsfw: 'false', content: term });
    for (const id of ids) p.append('channel_id', id);
    try {
      const data = await discordApi(env, `/guilds/${i.guild_id}/messages/search?${p}`);
      for (const m of (data.messages || []).flat().slice(0, 30)) {
        if (!m?.id || m.author?.id === scope.botUser.id || !readableMap.has(m.channel_id)) continue;
        const item = recordMessage(m, i.guild_id, readableMap.get(m.channel_id)?.name);
        if (item.content) found.set(item.id, item);
      }
    } catch (e) { errors.push(clean(e?.message || String(e), 200)); }
  }

  const matchedIds = new Set(rankedChannels.map((c) => c.id));
  const records = [...found.values()].map((r) => {
    const hay = normalize(`${r.channel} ${r.content}`);
    let score = matchedIds.has(r.channel_id) ? 5 : 0;
    for (const t of terms) if (t && hay.includes(t)) score += t.length >= 4 ? 3 : 1;
    return { ...r, _score: score };
  }).sort((a, b) => b._score - a._score || String(b.date).localeCompare(String(a.date)))
    .slice(0, 20).map(({ _score, ...r }) => r);

  return {
    type: 'server',
    status: errors.length ? (records.length ? 'partial' : 'error') : 'ok',
    query: q,
    matched_channels: rankedChannels.map(({ id, name, topic, score }) => ({ id, name, topic, score })),
    records,
    errors,
    note: 'Discord内検索結果です。質問者とるるの双方が閲覧できるチャンネルだけを対象にし、チャンネル名が質問に合う場合はそのチャンネルの最近の投稿も直接確認しています。',
  };
}
async function askMake(env, base, packet) {
  const r = await fetch(env.MAKE_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, content: JSON.stringify(packet) }), signal: AbortSignal.timeout(30000),
  });
  const t = (await r.text()).trim();
  if (!r.ok || !t || /^(Accepted|OK)$/i.test(t)) throw new Error(`Make ${r.status}`);
  return t;
}
async function editOriginal(i, content) {
  const r = await fetch(`${DISCORD_API}/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) throw new Error(`Edit original ${r.status}`);
}
async function processServer(env, i, q) {
  try {
    const member = i.member;
    const displayName = member?.nick || member?.user?.global_name || member?.user?.username || 'ユーザー';
    const base = {
      author_username: member?.user?.username || '', author_display_name: displayName,
      author_id: member?.user?.id || '', channel_id: i.channel_id, guild_id: i.guild_id,
      message_id: 'slash-command', timestamp: new Date().toISOString(),
    };
    const result = await searchServer(env, i, q);
    const packet = {
      protocol: 'ruru-v2', phase: 'answer', question: clean(q, 4000), now: new Date().toISOString(), timezone: 'Asia/Tokyo',
      author: displayName, recent_messages: [], readable_channels: [], can_search_server: true,
      can_search_news_headlines: true, can_search_web: true, can_search_weather: true,
      tool_result: result, forced_search: true,
    };
    const answer = await askMake(env, base, packet);
    await editOriginal(i, `**${clean(displayName, 80)}：** ${clean(q, 1000)}\n\n${clean(answer, 7600)}`.slice(0, 1900));
  } catch (e) {
    console.log(JSON.stringify({ type: 'ruru_server_error', version: VERSION, error: clean(e?.message || String(e), 500) }));
    await editOriginal(i, 'すみません。サーバー内検索処理でエラーが発生しました。').catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return json({ ok: true, service: 'ruru-worker', version: VERSION });
    if (request.method !== 'POST') return baseWorker.fetch(request, env, ctx);

    const clone = request.clone();
    const body = await clone.text();
    let i;
    try { i = JSON.parse(body); } catch { return baseWorker.fetch(request, env, ctx); }
    if (i.type !== 2 || i.data?.name !== 'るる') return baseWorker.fetch(request, env, ctx);

    const q = clean(getMessageOption(i), 4000).trim();
    if (!q || !isServerQuery(q)) return baseWorker.fetch(request, env, ctx);
    if (!(await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('invalid request signature', { status: 401 });

    ctx.waitUntil(processServer(env, i, q));
    return json({ type: 5, data: { flags: 64 } });
  },
};
