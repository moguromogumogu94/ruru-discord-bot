'use strict';

import baseWorker from './worker_v6.js';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.7.0-worker-token-health';
const encoder = new TextEncoder();
const clean = (v, max = 1800) => String(v || '').replace(/\u0000/g, '').slice(0, max);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;
const TEXT_TYPES = new Set([0, 5, 15]);

function normalizeToken(raw) {
  let t = String(raw || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  t = t.replace(/^Bot\s+/i, '').trim();
  return t;
}
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
  const token = normalizeToken(env.DISCORD_BOT_TOKEN);
  if (!token) throw new Error('Discord token missing');
  const r = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Discord ${r.status} ${path}`);
  return r.status === 204 ? null : r.json();
}
async function discordHealth(env) {
  const token = normalizeToken(env.DISCORD_BOT_TOKEN);
  if (!token) return { ok: false, status: 0, reason: 'missing' };
  try {
    const r = await fetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000) });
    return { ok: r.ok, status: r.status };
  } catch { return { ok: false, status: 0, reason: 'network' }; }
}
function getMessageOption(i) {
  return i.data?.options?.find((o) => o.name === 'メッセージ')?.value || i.data?.options?.find((o) => o.name === 'message')?.value || '';
}
function isServerQuery(q) {
  return /サーバー|Discord|ディスコード|別のチャンネル|別チャンネル|過去の投稿|募集投稿|オフ会|この部屋|他の部屋|誰が.*言|前に.*話|投稿を探|投稿.*検索/i.test(q);
}
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFKC').replace(/[\s　_\-・|｜/\\()[\]{}「」『』【】<>!?！？。、,.:;：；"'`~〜～★☆🌟📗📺🔥👑📰🤖🍵🔬⚡]+/g, '');
}
function termsFromQuestion(q) {
  const joined = normalize(q);
  const terms = [];
  for (const t of ['東京','大阪','札幌','オフ会','募集','場所','時間','日程','イベント']) if (joined.includes(normalize(t))) terms.push(normalize(t));
  return [...new Set(terms)];
}
function roleBasePermissions(guildId, roles, memberRoleIds) {
  const memberRoles = new Set(memberRoleIds || []); let p = 0n;
  for (const role of roles || []) if (role.id === guildId || memberRoles.has(role.id)) p |= BigInt(role.permissions || '0');
  return p;
}
function applyOverwrites(base, channel, guildId, roleIds, memberId) {
  if ((base & ADMINISTRATOR) === ADMINISTRATOR) return (1n << 63n) - 1n;
  let p = base; const ovs = channel.permission_overwrites || [];
  const everyone = ovs.find((o) => o.id === guildId && Number(o.type) === 0);
  if (everyone) { p &= ~BigInt(everyone.deny || '0'); p |= BigInt(everyone.allow || '0'); }
  let deny = 0n, allow = 0n; const rs = new Set(roleIds || []);
  for (const o of ovs) if (Number(o.type) === 0 && rs.has(o.id)) { deny |= BigInt(o.deny || '0'); allow |= BigInt(o.allow || '0'); }
  p &= ~deny; p |= allow;
  const mem = ovs.find((o) => Number(o.type) === 1 && o.id === memberId);
  if (mem) { p &= ~BigInt(mem.deny || '0'); p |= BigInt(mem.allow || '0'); }
  return p;
}
function hasPerm(p, bit) { return (p & ADMINISTRATOR) === ADMINISTRATOR || (p & bit) === bit; }
function recordMessage(m, guildId, channelName) {
  const embedText = (m.embeds || []).map((e) => [e.title,e.description,...(e.fields || []).map((f)=>`${f.name}: ${f.value}`)].filter(Boolean).join('\n')).filter(Boolean).join('\n');
  return { id:m.id, channel_id:m.channel_id, channel:channelName || m.channel_id, author:m.author?.global_name || m.author?.username || '不明', date:m.timestamp, content:clean([m.content,embedText].filter(Boolean).join('\n'),1200), url:`https://discord.com/channels/${guildId}/${m.channel_id}/${m.id}` };
}
async function buildScope(env, i) {
  const guildId = i.guild_id;
  const [channels, roles, botUser] = await Promise.all([
    discordApi(env, `/guilds/${guildId}/channels`),
    discordApi(env, `/guilds/${guildId}/roles`),
    discordApi(env, '/users/@me'),
  ]);
  const botMember = await discordApi(env, `/guilds/${guildId}/members/${botUser.id}`);
  const caller = i.member;
  const callerBase = roleBasePermissions(guildId, roles, caller?.roles || []);
  const botBase = roleBasePermissions(guildId, roles, botMember?.roles || []);
  const readable = [];
  for (const c of channels || []) {
    if (!TEXT_TYPES.has(Number(c.type)) || c.nsfw) continue;
    const up = applyOverwrites(callerBase, c, guildId, caller?.roles || [], caller?.user?.id || '');
    const bp = applyOverwrites(botBase, c, guildId, botMember?.roles || [], botUser.id);
    if (hasPerm(up, VIEW_CHANNEL) && hasPerm(up, READ_MESSAGE_HISTORY) && hasPerm(bp, VIEW_CHANNEL) && hasPerm(bp, READ_MESSAGE_HISTORY)) readable.push({ id:c.id, name:c.name, topic:clean(c.topic,180) });
  }
  return { readable, botUser };
}
async function searchServer(env, i, q) {
  const scope = await buildScope(env, i);
  const terms = termsFromQuestion(q);
  const ranked = scope.readable.map((c)=>{
    const hay = normalize(`${c.name} ${c.topic || ''}`); let score = 0;
    for (const t of terms) if (hay.includes(t)) score += t.length >= 4 ? 4 : 2;
    if (/オフ会/.test(q) && hay.includes(normalize('オフ会'))) score += 8;
    return {...c,score};
  }).filter((c)=>c.score>0).sort((a,b)=>b.score-a.score).slice(0,2);
  const found = new Map(); const errors=[];
  for (const c of ranked) {
    try {
      const rows = await discordApi(env, `/channels/${c.id}/messages?limit=50`);
      for (const m of rows || []) { if (!m?.id || m.author?.id === scope.botUser.id) continue; const item=recordMessage(m,i.guild_id,c.name); if(item.content) found.set(item.id,item); }
    } catch(e) { errors.push(clean(e.message,200)); }
  }
  if (!found.size) {
    const readableMap = new Map(scope.readable.map((c)=>[c.id,c]));
    for (const term of terms.slice(0,2)) {
      try {
        const p = new URLSearchParams({limit:'25',sort_by:'timestamp',sort_order:'desc',include_nsfw:'false',content:term});
        const data = await discordApi(env, `/guilds/${i.guild_id}/messages/search?${p}`);
        for (const m of (data.messages || []).flat().slice(0,30)) { if (!m?.id || m.author?.id===scope.botUser.id || !readableMap.has(m.channel_id)) continue; const item=recordMessage(m,i.guild_id,readableMap.get(m.channel_id)?.name); if(item.content) found.set(item.id,item); }
      } catch(e) { errors.push(clean(e.message,200)); }
    }
  }
  const records=[...found.values()].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,14);
  return { type:'server', status:records.length?(errors.length?'partial':'ok'):(errors.length?'error':'empty'), query:q, matched_channels:ranked.map(({id,name,topic,score})=>({id,name,topic,score})), records, errors, note:'Discord内検索結果です。質問者とるるの双方が閲覧できるチャンネルだけを対象にしています。' };
}
async function askMake(env, base, packet) {
  const r = await fetch(env.MAKE_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...base,content:JSON.stringify(packet)}),signal:AbortSignal.timeout(30000)});
  const t=(await r.text()).trim(); if(!r.ok||!t||/^(Accepted|OK)$/i.test(t)) throw new Error(`Make ${r.status}`); return t;
}
async function editOriginal(i, content) {
  const r=await fetch(`${DISCORD_API}/webhooks/${i.application_id}/${i.token}/messages/@original`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw new Error(`Edit original ${r.status}`);
}
async function processServer(env,i,q) {
  const member=i.member; const displayName=member?.nick||member?.user?.global_name||member?.user?.username||'ユーザー';
  const base={author_username:member?.user?.username||'',author_display_name:displayName,author_id:member?.user?.id||'',channel_id:i.channel_id,guild_id:i.guild_id,message_id:'slash-command',timestamp:new Date().toISOString()};
  try {
    const result=await searchServer(env,i,q);
    const packet={protocol:'ruru-v2',phase:'answer',question:clean(q,4000),now:new Date().toISOString(),timezone:'Asia/Tokyo',author:displayName,recent_messages:[],readable_channels:result.matched_channels||[],can_search_server:true,can_search_news_headlines:true,can_search_web:true,can_search_weather:true,tool_result:result,forced_search:true};
    const answer=await askMake(env,base,packet);
    await editOriginal(i,`**${clean(displayName,80)}：** ${clean(q,1000)}\n\n${clean(answer,7600)}`.slice(0,1900));
  } catch(e) {
    await editOriginal(i,`すみません。サーバー内検索処理でエラーが発生しました。\n(${clean(e?.message||'unknown',160)})`).catch(()=>{});
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.get('check') === 'discord') {
      const health = await discordHealth(env);
      return json({ service:'ruru-worker', version:VERSION, discord_auth:health });
    }
    if (request.method === 'GET') return json({ok:true,service:'ruru-worker',version:VERSION});
    if (request.method !== 'POST') return baseWorker.fetch(request, env, ctx);
    const clone=request.clone(); const body=await clone.text();
    let i; try{i=JSON.parse(body);}catch{return baseWorker.fetch(request,env,ctx);}
    if(i.type!==2||i.data?.name!=='るる') return baseWorker.fetch(request,env,ctx);
    const q=clean(getMessageOption(i),4000).trim();
    if(!q||!isServerQuery(q)) return baseWorker.fetch(request,env,ctx);
    if(!(await verifyDiscordRequest(request,body,env.DISCORD_PUBLIC_KEY))) return new Response('invalid request signature',{status:401});
    ctx.waitUntil(processServer(env,i,q));
    return json({type:5,data:{flags:64}});
  }
};
