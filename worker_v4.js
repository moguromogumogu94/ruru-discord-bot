'use strict';

import baseWorker from './worker_v3.js';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.3.0-worker-web-bing-fallback';
const encoder = new TextEncoder();
const clean = (v, max = 1800) => String(v || '').replace(/\u0000/g, '').slice(0, max);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

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
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(m?.[1] || '').replace(/<[^>]*>/g, '').trim();
}
function getMessageOption(i) {
  return i.data?.options?.find((o) => o.name === 'メッセージ')?.value
    || i.data?.options?.find((o) => o.name === 'message')?.value || '';
}
function isCurrentWebQuery(q) {
  if (/ニュース|報道|記事|ヘッドライン|FRB|FOMC|パウエル|NASDAQ|ナスダック|米国株|利下げ|利上げ/.test(q)) return false;
  return /最新|現在|今日|明日|今週|週末|来週|発売|価格|値段|営業時間|営業中|在庫|何時|アップデート|バージョン|モデル|スペック/i.test(q);
}
function makeWebQuery(q) {
  if (/iPhone/i.test(q) && /価格|値段|モデル|最新/.test(q)) return 'site:apple.com/jp iPhone 最新モデル 価格 日本';
  return clean(q, 140);
}
async function searchBingRss(query) {
  const u = new URL('https://www.bing.com/search');
  u.search = new URLSearchParams({ q: query, format: 'rss', setlang: 'ja-jp', cc: 'JP' }).toString();
  const r = await fetch(u, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RuruBot/3.3)', 'accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`BingWeb ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map((m) => ({
    title: clean(parseTag(m[1], 'title'), 300),
    url: clean(parseTag(m[1], 'link'), 1000),
    snippet: clean(parseTag(m[1], 'description'), 700),
  })).filter((x) => x.title && /^https?:\/\//i.test(x.url));
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
async function processWeb(env, i, q) {
  try {
    const member = i.member;
    const displayName = member?.nick || member?.user?.global_name || member?.user?.username || 'ユーザー';
    const base = {
      author_username: member?.user?.username || '', author_display_name: displayName,
      author_id: member?.user?.id || '', channel_id: i.channel_id, guild_id: i.guild_id,
      message_id: 'slash-command', timestamp: new Date().toISOString(),
    };
    const query = makeWebQuery(q);
    let records = [], errors = [];
    try { records = await searchBingRss(query); } catch (e) { errors.push(clean(e?.message || String(e), 200)); }
    const result = {
      type: 'web', status: records.length ? 'ok' : 'empty', query, checked_at: new Date().toISOString(),
      records, errors,
      note: records.length ? 'Bing RSSのWeb検索結果です。タイトル・説明・URLを根拠に回答してください。公式サイトを優先してください。' : 'Web検索結果を取得できませんでした。',
    };
    const packet = {
      protocol: 'ruru-v2', phase: 'answer', question: clean(q, 4000), now: new Date().toISOString(), timezone: 'Asia/Tokyo',
      author: displayName, recent_messages: [], readable_channels: [], can_search_server: true,
      can_search_news_headlines: true, can_search_web: true, can_search_weather: true,
      tool_result: result, forced_search: true,
    };
    const answer = await askMake(env, base, packet);
    await editOriginal(i, `**${clean(displayName, 80)}：** ${clean(q, 1000)}\n\n${clean(answer, 7600)}`.slice(0, 1900));
  } catch (e) {
    console.log(JSON.stringify({ type: 'ruru_web_error', version: VERSION, error: clean(e?.message || String(e), 500) }));
    await editOriginal(i, 'すみません。Web検索処理でエラーが発生しました。').catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return json({ ok: true, service: 'ruru-worker', version: VERSION });
    if (request.method !== 'POST') return baseWorker.fetch(request, env, ctx);
    const clone = request.clone();
    const body = await clone.text();
    let i; try { i = JSON.parse(body); } catch { return baseWorker.fetch(request, env, ctx); }
    if (i.type !== 2 || i.data?.name !== 'るる') return baseWorker.fetch(request, env, ctx);
    const q = clean(getMessageOption(i), 4000).trim();
    if (!q || !isCurrentWebQuery(q)) return baseWorker.fetch(request, env, ctx);
    if (!(await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('invalid request signature', { status: 401 });
    ctx.waitUntil(processWeb(env, i, q));
    return json({ type: 5, data: {} });
  },
};
