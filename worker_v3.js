'use strict';

import baseWorker from './worker_v2.js';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.2.0-worker-news-priority';
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

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(m?.[1] || '').replace(/<[^>]*>/g, '').trim();
}

async function searchNews(query) {
  const u = new URL('https://news.google.com/rss/search');
  u.search = new URLSearchParams({
    q: clean(query, 120),
    hl: 'ja',
    gl: 'JP',
    ceid: 'JP:ja',
  }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`News ${r.status}`);
  const xml = await r.text();
  const records = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((m) => ({
      title: clean(parseTag(m[1], 'title'), 300),
      url: parseTag(m[1], 'link'),
      date: parseTag(m[1], 'pubDate'),
      source: parseTag(m[1], 'source'),
    }))
    .filter((x) => x.title && /^https:\/\//.test(x.url));

  return {
    type: 'news',
    status: records.length ? 'ok' : 'empty',
    checked_at: new Date().toISOString(),
    records,
    note: 'Google News RSSの見出し・配信元・日時・URLです。記事本文は未確認です。',
  };
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

function getMessageOption(i) {
  return i.data?.options?.find((o) => o.name === 'メッセージ')?.value
    || i.data?.options?.find((o) => o.name === 'message')?.value
    || '';
}

function isNewsQuery(q) {
  return /ニュース|報道|記事|ヘッドライン|FRB|FOMC|パウエル|NASDAQ|ナスダック|米国株|利下げ|利上げ|金利.*(発言|報道|ニュース)|今週.*(出来事|材料)/i.test(q);
}

function makeNewsQuery(q) {
  if (/FRB|FOMC|パウエル/i.test(q)) return 'FRB FOMC パウエル 金利';
  if (/NASDAQ|ナスダック/i.test(q)) return 'NASDAQ 米国株 FRB 金利';
  return clean(q.replace(/これが通ったら[\s\S]*$/i, '').trim(), 120);
}

async function editOriginal(i, content) {
  const r = await fetch(`${DISCORD_API}/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!r.ok) throw new Error(`Edit original ${r.status}`);
}

async function processNews(env, i, q) {
  try {
    const member = i.member;
    const displayName = member?.nick || member?.user?.global_name || member?.user?.username || 'ユーザー';
    const base = {
      author_username: member?.user?.username || '',
      author_display_name: displayName,
      author_id: member?.user?.id || '',
      channel_id: i.channel_id,
      guild_id: i.guild_id,
      message_id: 'slash-command',
      timestamp: new Date().toISOString(),
    };
    const result = await searchNews(makeNewsQuery(q));
    const packet = {
      protocol: 'ruru-v2',
      phase: 'answer',
      question: clean(q, 4000),
      now: new Date().toISOString(),
      timezone: 'Asia/Tokyo',
      author: displayName,
      recent_messages: [],
      readable_channels: [],
      can_search_server: true,
      can_search_news_headlines: true,
      can_search_web: true,
      can_search_weather: true,
      tool_result: result,
      forced_search: true,
    };
    const answer = await askMake(env, base, packet);
    await editOriginal(i, `**${clean(displayName, 80)}：** ${clean(q, 1000)}\n\n${clean(answer, 7600)}`.slice(0, 1900));
  } catch (e) {
    console.log(JSON.stringify({ type: 'ruru_news_error', version: VERSION, error: clean(e?.message || String(e), 500) }));
    await editOriginal(i, 'すみません。ニュース取得処理でエラーが発生しました。').catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      return json({ ok: true, service: 'ruru-worker', version: VERSION, make: !!env.MAKE_WEBHOOK_URL, bot: !!env.DISCORD_BOT_TOKEN });
    }

    if (request.method !== 'POST') return baseWorker.fetch(request, env, ctx);

    const clone = request.clone();
    const body = await clone.text();
    let interaction;
    try { interaction = JSON.parse(body); }
    catch { return baseWorker.fetch(request, env, ctx); }

    if (interaction.type !== 2 || interaction.data?.name !== 'るる') {
      return baseWorker.fetch(request, env, ctx);
    }

    const q = clean(getMessageOption(interaction), 4000).trim();
    if (!q || !isNewsQuery(q)) return baseWorker.fetch(request, env, ctx);

    const valid = await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('invalid request signature', { status: 401 });

    ctx.waitUntil(processNews(env, interaction, q));
    return json({ type: 5, data: {} });
  },
};
