'use strict';

import baseWorker from './worker_v5.js';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.5.0-worker-iphone-official-direct';
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
    .replace(/\s+/g, ' ').trim()), 12000);
}
function getMessageOption(i) {
  return i.data?.options?.find((o) => o.name === 'メッセージ')?.value
    || i.data?.options?.find((o) => o.name === 'message')?.value || '';
}
function isIphoneCurrentQuery(q) {
  return /iphone/i.test(q) && /最新|モデル|価格|値段|発売|予約|スペック/i.test(q);
}
async function fetchOfficial(url) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RuruBot/3.5; +https://ruru-discord-bot.moguro94.workers.dev)',
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ja,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { url, page_status: `http_${r.status}`, page_text: '' };
    const html = await r.text();
    const text = htmlToText(html);
    const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    return { url: r.url || url, page_status: text ? 'ok' : 'empty', page_title: clean(title, 300), page_text: text };
  } catch (e) {
    return { url, page_status: 'error', page_error: clean(e?.message || String(e), 180), page_text: '' };
  }
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
async function processIphone(env, i, q) {
  try {
    const member = i.member;
    const displayName = member?.nick || member?.user?.global_name || member?.user?.username || 'ユーザー';
    const base = {
      author_username: member?.user?.username || '', author_display_name: displayName,
      author_id: member?.user?.id || '', channel_id: i.channel_id, guild_id: i.guild_id,
      message_id: 'slash-command', timestamp: new Date().toISOString(),
    };
    const urls = [
      'https://www.apple.com/jp/shop/buy-iphone',
      'https://www.apple.com/jp/iphone/',
      'https://www.apple.com/jp/newsroom/',
    ];
    const records = await Promise.all(urls.map(fetchOfficial));
    const result = {
      type: 'web', status: records.some((r) => r.page_status === 'ok') ? 'ok' : 'empty',
      query: 'Apple Japan official iPhone latest models prices', checked_at: new Date().toISOString(),
      records,
      note: 'Apple日本公式ページを直接取得した結果です。page_textに明示されているモデル名・価格・予約/発売情報だけを使って回答してください。検索エンジンのスニペットは使用禁止。価格が本文にある場合は必ず具体的な金額を示してください。本文にない内容は推測しないでください。',
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
    console.log(JSON.stringify({ type: 'ruru_iphone_error', version: VERSION, error: clean(e?.message || String(e), 500) }));
    await editOriginal(i, 'すみません。Apple公式情報の取得処理でエラーが発生しました。').catch(() => {});
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
    if (!q || !isIphoneCurrentQuery(q)) return baseWorker.fetch(request, env, ctx);
    if (!(await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('invalid request signature', { status: 401 });
    ctx.waitUntil(processIphone(env, i, q));
    return json({ type: 5, data: {} });
  },
};
