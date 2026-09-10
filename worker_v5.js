'use strict';

import baseWorker from './worker_v4.js';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.4.0-worker-web-page-fetch';
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
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(m?.[1] || '').replace(/<[^>]*>/g, '').trim();
}
function decodeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function htmlToText(html) {
  return clean(decodeHtml(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim()), 6500);
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
  if (/iPhone/i.test(q) && /価格|値段|モデル|最新/.test(q)) return 'site:apple.com/jp/iphone iPhone 最新モデル 価格 日本';
  return clean(q, 140);
}
async function searchBingRss(query) {
  const u = new URL('https://www.bing.com/search');
  u.search = new URLSearchParams({ q: query, format: 'rss', setlang: 'ja-jp', cc: 'JP' }).toString();
  const r = await fetch(u, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RuruBot/3.4)', 'accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
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
function safePublicUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return null;
    return u;
  } catch { return null; }
}
function officialScore(url, q) {
  const h = safePublicUrl(url)?.hostname.toLowerCase() || '';
  if (/iphone|apple/i.test(q) && (h === 'apple.com' || h.endsWith('.apple.com'))) return 100;
  if (/microsoft/i.test(q) && h.endsWith('microsoft.com')) return 90;
  if (/google/i.test(q) && h.endsWith('google.com')) return 90;
  return 0;
}
async function fetchPage(record) {
  const u = safePublicUrl(record.url);
  if (!u) return { ...record, page_status: 'blocked' };
  try {
    const r = await fetch(u.toString(), {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RuruBot/3.4; +https://ruru-discord-bot.moguro94.workers.dev)',
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ja,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(12000),
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('text/html')) return { ...record, page_status: `http_${r.status}` };
    const html = await r.text();
    const text = htmlToText(html);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const finalUrl = r.url || record.url;
    return {
      ...record,
      url: clean(finalUrl, 1000),
      page_status: text ? 'ok' : 'empty',
      page_title: clean(decodeHtml(titleMatch?.[1] || ''), 300),
      page_text: text,
    };
  } catch (e) {
    return { ...record, page_status: 'error', page_error: clean(e?.message || String(e), 180) };
  }
}
async function enrichRecords(records, q) {
  const ranked = records.map((r, idx) => ({ r, idx, score: officialScore(r.url, q) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, 3);
  const enriched = await Promise.all(ranked.map((x) => fetchPage(x.r)));
  const byUrl = new Map(enriched.map((x) => [x.url, x]));
  const out = [];
  for (const row of ranked) {
    const hit = enriched.find((x) => x.url === row.r.url || x.title === row.r.title) || row.r;
    out.push(hit);
  }
  for (const r of records) if (!out.some((x) => x.title === r.title && x.url === r.url)) out.push(r);
  return out.slice(0, 8);
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
    try {
      records = await searchBingRss(query);
      if (records.length) records = await enrichRecords(records, q);
    } catch (e) { errors.push(clean(e?.message || String(e), 200)); }
    const result = {
      type: 'web', status: records.length ? 'ok' : 'empty', query, checked_at: new Date().toISOString(),
      records, errors,
      note: records.length
        ? '検索結果に加え、上位の公式・関連ページ本文を直接取得した結果です。page_status=ok の page_text を最優先の根拠として使い、検索スニペットだけでモデル名・価格・発売日を補完しないでください。'
        : 'Web検索結果を取得できませんでした。',
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
