'use strict';

const DISCORD_API = 'https://discord.com/api/v10';
const VERSION = '3.1.0-worker-lazy-discord';
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

async function discordApi(env, path, options = {}) {
  const r = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!r.ok) throw new Error(`Discord ${r.status} ${path}`);
  if (r.status === 204) return null;
  return r.json();
}

function decodeXml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
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
    title: clean(parseTag(m[1], 'title'), 300), url: parseTag(m[1], 'link'), date: parseTag(m[1], 'pubDate'), source: parseTag(m[1], 'source'),
  })).filter((x) => x.title && /^https:\/\//.test(x.url));
  return { type: 'news', status: 'ok', checked_at: new Date().toISOString(), records, note: 'ニュース見出し・配信元・日時・リンクです。記事本文は未確認です。' };
}

function decodeHtml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function stripHtml(s) { return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function externalSafe(q) { return !/discord\.com\/channels|<@|\b\d{16,20}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(q); }
async function searchWeb(query, question) {
  query = clean(query, 160).trim();
  if (!query || !externalSafe(question)) return { type: 'web', status: 'blocked', records: [], note: '内部情報や個人情報を外部検索へ送らないため検索していません。' };
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; RuruBot/3.1)' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Web ${r.status}`);
  const html = await r.text();
  const records = [];
  for (const m of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = decodeHtml(m[1]);
    try { const u = new URL(href, 'https://duckduckgo.com'); const x = u.searchParams.get('uddg'); if (x) href = decodeURIComponent(x); } catch {}
    if (!/^https?:\/\//i.test(href)) continue;
    records.push({ title: clean(stripHtml(m[2]), 300), url: clean(href, 1000) });
    if (records.length >= 8) break;
  }
  return { type: 'web', status: records.length ? 'ok' : 'empty', query, checked_at: new Date().toISOString(), records, note: '一般Web検索のタイトルとURLです。公式サイトを優先して回答してください。' };
}

const CITY_COORDS = {
  '東京': [35.6762,139.6503], '東京都': [35.6762,139.6503], '札幌': [43.0618,141.3545], '札幌市': [43.0618,141.3545],
  '大阪': [34.6937,135.5023], '大阪市': [34.6937,135.5023], '名古屋': [35.1815,136.9066], '福岡': [33.5902,130.4017],
  '横浜': [35.4437,139.6380], '仙台': [38.2682,140.8694], '京都': [35.0116,135.7681], '那覇': [26.2124,127.6809],
};
function inferPlace(q) {
  for (const k of Object.keys(CITY_COORDS)) if (q.includes(k)) return k;
  const m = q.match(/([一-龥ぁ-んァ-ヶA-Za-z]{2,20})(?:の)?(?:天気|気温|降水|雨|雪)/);
  return m?.[1]?.replace(/^(今日|明日|あした|週末|今週|来週)/, '') || null;
}
async function searchWeather(question) {
  const place = inferPlace(question) || '東京';
  let latitude, longitude, name = place;
  if (CITY_COORDS[place]) [latitude, longitude] = CITY_COORDS[place];
  else {
    for (const candidate of [place, place.replace(/市$/, ''), `${place} Japan`]) {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=ja&format=json`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const g = await r.json();
      if (g.results?.[0]) { latitude = g.results[0].latitude; longitude = g.results[0].longitude; name = g.results[0].name || place; break; }
    }
  }
  if (latitude == null) return { type: 'weather', status: 'empty', place, records: [], note: '場所を特定できませんでした。' };
  const p = new URLSearchParams({ latitude:String(latitude), longitude:String(longitude), timezone:'Asia/Tokyo', forecast_days:'7', daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max' });
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Weather ${r.status}`);
  const w = await r.json();
  const records = (w.daily?.time || []).map((date,i)=>({ date, weather_code:w.daily.weather_code?.[i], temp_max:w.daily.temperature_2m_max?.[i], temp_min:w.daily.temperature_2m_min?.[i], precip_probability_max:w.daily.precipitation_probability_max?.[i], precipitation_sum:w.daily.precipitation_sum?.[i], wind_max:w.daily.wind_speed_10m_max?.[i] }));
  return { type:'weather', status:'ok', checked_at:new Date().toISOString(), location:{name}, records, note:'Open-Meteoの7日間予報です。時刻は日本時間です。' };
}

async function askMake(env, base, packet) {
  const r = await fetch(env.MAKE_WEBHOOK_URL, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({...base, content:JSON.stringify(packet)}), signal:AbortSignal.timeout(30000) });
  const t = (await r.text()).trim();
  if (!r.ok || !t || /^(Accepted|OK)$/i.test(t)) throw new Error(`Make ${r.status}`);
  return t;
}
function parseTool(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  if (!raw.startsWith('{')) return null;
  try { const p=JSON.parse(raw); return ['server_search','news_search','web_search','weather_search'].includes(p.ruru_tool)?p:null; } catch { return null; }
}
function forcedTool(q) {
  if (/天気|気温|降水|降る|雨|雪|台風|猛暑|最低気温|最高気温/.test(q)) return {ruru_tool:'weather_search'};
  if (/最新|現在|今どう|今日の|明日の|あしたの|今週|週末|来週|発売日|価格|値段|営業時間|営業中|在庫|何時|いつ発売|新しいの|アップデート|バージョン/.test(q)) return {ruru_tool:'web_search',query:q};
  return null;
}

async function recentMessages(env, interaction) {
  try {
    const rows = await discordApi(env, `/channels/${interaction.channel_id}/messages?limit=10`);
    return (rows||[]).slice().reverse().filter(m=>!m.author?.bot).map(m=>({id:m.id,channel_id:m.channel_id,author:m.author?.global_name||m.author?.username||'不明',date:m.timestamp,content:clean(m.content,700),url:`https://discord.com/channels/${interaction.guild_id}/${m.channel_id}/${m.id}`})).filter(x=>x.content).slice(-8);
  } catch { return []; }
}
async function serverContext(env, interaction) {
  try {
    const [channels, botUser] = await Promise.all([discordApi(env, `/guilds/${interaction.guild_id}/channels`), discordApi(env, '/users/@me')]);
    const readable = (channels||[]).filter(c=>[0,5,15].includes(Number(c.type)) && !c.nsfw).map(c=>({id:c.id,name:c.name,topic:clean(c.topic,180)}));
    return {ok:true, channels, readable, botUser};
  } catch (e) {
    return {ok:false, error:clean(e?.message||String(e),300), channels:[], readable:[], botUser:null};
  }
}
async function searchServer(env, interaction, ctx, plan) {
  if (!ctx.ok) return {type:'server',status:'error',records:[],errors:[ctx.error],note:'Discord APIへの接続に失敗しました。'};
  const ids = Array.isArray(plan.channel_ids)&&plan.channel_ids.length ? plan.channel_ids.map(String) : ctx.readable.map(c=>c.id).slice(0,90);
  const queries=[...new Set((Array.isArray(plan.queries)?plan.queries:[plan.query||'']).map(q=>clean(q,100).trim()))].slice(0,2); if(!queries.length)queries.push('');
  const found=new Map(), errors=[];
  for(const q of queries){
    const p=new URLSearchParams({limit:'20',sort_by:'timestamp',sort_order:'desc',include_nsfw:'false'}); if(q)p.set('content',q); for(const id of ids)p.append('channel_id',id);
    try { const data=await discordApi(env, `/guilds/${interaction.guild_id}/messages/search?${p}`); for(const m of (data.messages||[]).flat().slice(0,30)){ if(!m?.id||m.author?.id===ctx.botUser?.id)continue; found.set(m.id,{id:m.id,channel_id:m.channel_id,author:m.author?.global_name||m.author?.username||'不明',date:m.timestamp,content:clean(m.content,1200),url:`https://discord.com/channels/${interaction.guild_id}/${m.channel_id}/${m.id}`}); }} catch(e){errors.push(clean(e?.message||String(e),200));}
  }
  return {type:'server',status:errors.length?(found.size?'partial':'error'):'ok',queries,records:[...found.values()].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,14),errors,note:'Discord内検索結果です。'};
}

async function buildAnswer(env, interaction, question) {
  const member=interaction.member; const displayName=member?.nick||member?.user?.global_name||member?.user?.username||'ユーザー';
  const base={author_username:member?.user?.username||'',author_display_name:displayName,author_id:member?.user?.id||'',channel_id:interaction.channel_id,guild_id:interaction.guild_id,message_id:'slash-command',timestamp:new Date().toISOString()};
  const basePacket={protocol:'ruru-v2',phase:'request',question:clean(question,4000),now:new Date().toISOString(),timezone:'Asia/Tokyo',author:displayName,recent_messages:[],readable_channels:[],can_search_server:true,can_search_news_headlines:true,can_search_web:true,can_search_weather:true};
  let tool=forcedTool(question), result=null, answer;
  if(tool){
    if(tool.ruru_tool==='weather_search') result=await searchWeather(question); else result=await searchWeb(tool.query||question,question);
    answer=await askMake(env,base,{...basePacket,phase:'answer',tool_result:result,forced_search:true});
    return {answer:clean(answer,7600),displayName};
  }
  answer=await askMake(env,base,basePacket); tool=parseTool(answer);
  if(tool){
    if(tool.ruru_tool==='news_search') result=await searchNews(tool.query||question);
    else if(tool.ruru_tool==='web_search') result=await searchWeb(tool.query||question,question);
    else if(tool.ruru_tool==='weather_search') result=await searchWeather(question);
    else if(tool.ruru_tool==='server_search') {
      const ctx=await serverContext(env,interaction);
      const history=await recentMessages(env,interaction);
      result=await searchServer(env,interaction,ctx,tool);
      answer=await askMake(env,base,{...basePacket,phase:'answer',recent_messages:history,readable_channels:ctx.readable,tool_result:result});
      return {answer:clean(answer,7600),displayName};
    }
    answer=await askMake(env,base,{...basePacket,phase:'answer',tool_result:result});
  }
  return {answer:clean(answer,7600),displayName};
}

async function editOriginal(i,content){const r=await fetch(`${DISCORD_API}/webhooks/${i.application_id}/${i.token}/messages/@original`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}})});if(!r.ok)throw new Error(`Edit original ${r.status}`);}
function getMessageOption(i){return i.data?.options?.find(o=>o.name==='メッセージ')?.value||i.data?.options?.find(o=>o.name==='message')?.value||'';}
function sensitive(q){return /サーバー|Discord|ディスコード|別のチャンネル|別チャンネル|過去の投稿|誰が.*言|オフ会|募集投稿|この部屋|他の部屋/.test(q);}
async function processInteraction(env,i,q){try{const {answer,displayName}=await buildAnswer(env,i,q);await editOriginal(i,`**${clean(displayName,80)}：** ${clean(q,1000)}\n\n${answer}`.slice(0,1900));}catch(e){console.log(JSON.stringify({type:'ruru_error',version:VERSION,error:clean(e?.message||String(e),500)}));await editOriginal(i,'すみません。今は回答処理を完了できませんでした。少し時間をおいて、もう一度お願いします。').catch(()=>{});}}

export default { async fetch(request,env,ctx){
  if(request.method==='GET') return json({ok:true,service:'ruru-worker',version:VERSION,make:!!env.MAKE_WEBHOOK_URL,bot:!!env.DISCORD_BOT_TOKEN});
  if(request.method!=='POST') return new Response('Method Not Allowed',{status:405});
  const body=await request.text(); if(!(await verifyDiscordRequest(request,body,env.DISCORD_PUBLIC_KEY))) return new Response('invalid request signature',{status:401});
  let i; try{i=JSON.parse(body);}catch{return new Response('bad json',{status:400});}
  if(i.type===1)return json({type:1});
  if(i.type!==2||i.data?.name!=='るる')return json({type:4,data:{content:'この操作には対応していません。',flags:64}});
  const q=clean(getMessageOption(i),4000).trim(); if(!q)return json({type:4,data:{content:'メッセージを入力してください。',flags:64}});
  ctx.waitUntil(processInteraction(env,i,q)); return json({type:5,data:sensitive(q)?{flags:64}:{}});
}};
