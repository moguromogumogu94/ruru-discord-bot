'use strict';
const express=require('express');
const {Client,GatewayIntentBits,PermissionFlagsBits,ChannelType,ApplicationCommandType,ApplicationCommandOptionType}=require('discord.js');
const BOT_TOKEN=process.env.DISCORD_BOT_TOKEN;
const MAKE_WEBHOOK_URL=process.env.MAKE_WEBHOOK_URL;
const LEGACY_CHANNEL_ID=process.env.DISCORD_CHANNEL_ID||'1546475931411943466';
const PORT=process.env.PORT||10000;
const VERSION='2.5.0-weather-fixed';
if(!BOT_TOKEN||!MAKE_WEBHOOK_URL)process.exit(1);

const app=express();
let discordReady=false,lastError=null,lastReplyAt=null,lastTool=null,commandGuilds=0;
app.get('/',(_req,res)=>res.json({ok:true,service:'ruru-discord-bot',version:VERSION,discordReady,command:'/るる',commandGuilds,lastReplyAt,lastTool,lastError}));
app.listen(PORT,()=>console.log(`HTTP ready on ${PORT}`));

const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],rest:{timeout:12000,retries:1}});
const clean=(v,max=1800)=>String(v||'').replace(/\u0000/g,'').slice(0,max);
const safeErr=e=>clean(e?.message||e?.code||String(e),300);
function canRead(c,m){return !!c?.permissionsFor?.(m)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]);}
function canSend(c,m){return !!c?.permissionsFor?.(m)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]);}
function decodeHtml(s){return String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));}
function stripHtml(s){return decodeHtml(String(s||'').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}

function recordMessage(m,guild,name){
 const embeds=(m.embeds||[]).map(e=>[e.title,e.description,...(e.fields||[]).map(f=>`${f.name}: ${f.value}`)].filter(Boolean).join('\n')).join('\n');
 const channelId=m.channel_id||m.channelId,id=m.id;
 return {id,channel_id:channelId,channel:name||channelId,author:m.author?.globalName||m.author?.global_name||m.author?.username||'不明',author_id:m.author?.id,bot:!!m.author?.bot,date:m.timestamp||m.createdAt?.toISOString(),edited_at:m.edited_timestamp||m.editedAt?.toISOString()||null,content:clean([m.content,embeds].filter(Boolean).join('\n'),1800),url:`https://discord.com/channels/${guild.id}/${channelId}/${id}`};
}
async function readableScope(channel,member){
 const bot=await channel.guild.members.fetchMe(),channels=await channel.guild.channels.fetch(),allowed=new Map();
 for(const c of channels.values()){
  if(!c||c.nsfw)continue;
  if(![ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum].includes(c.type))continue;
  if(canRead(c,member)&&canRead(c,bot))allowed.set(c.id,c);
 }
 return {allowed,bot};
}
async function recentMessages(channel,beforeId){
 try{const msgs=await channel.messages.fetch({limit:10,...(beforeId?{before:beforeId}:{})});return [...msgs.values()].reverse().filter(m=>!m.author.bot).map(m=>recordMessage(m,channel.guild,m.channel.name)).filter(x=>x.content).slice(-8).map(x=>({...x,content:clean(x.content,700)}));}catch{return[];}
}
async function searchServer(plan,channel,member,omitId){
 const {allowed}=await readableScope(channel,member);const requested=Array.isArray(plan.channel_ids)?plan.channel_ids.map(String):[];const ids=requested.length?requested.filter(id=>allowed.has(id)):[...allowed.keys()].slice(0,90);const queries=[...new Set((Array.isArray(plan.queries)?plan.queries:[plan.query||'']).map(q=>clean(q,100).trim()))].slice(0,2);if(!queries.length)queries.push('');const found=new Map(),errors=[];
 for(const q of queries){const params=new URLSearchParams({limit:'20',sort_by:'timestamp',sort_order:'desc',include_nsfw:'false'});if(q)params.set('content',q);for(const id of ids)params.append('channel_id',id);try{const data=await client.rest.get(`/guilds/${channel.guild.id}/messages/search`,{query:params});for(const m of (Array.isArray(data.messages)?data.messages.flat():[]).slice(0,30)){if(!m?.id||m.id===omitId||m.author?.id===client.user.id||!allowed.has(m.channel_id))continue;const item=recordMessage(m,channel.guild,allowed.get(m.channel_id)?.name);if(item.content)found.set(item.id,item);}}catch(e){errors.push(safeErr(e));}}
 return {type:'server',status:errors.length?(found.size?'partial':'error'):'ok',queries,records:[...found.values()].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,14),errors,note:'Discord内の検索結果です。削除済み投稿・添付ファイル本文・検索索引に未反映の投稿は取得できない場合があります。'};
}

function decodeXml(s){return String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}
function parseTag(xml,tag){const m=xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return decodeXml(m?.[1]||'').replace(/<[^>]*>/g,'').trim();}
async function searchNews(query){const u=new URL('https://news.google.com/rss/search');u.search=new URLSearchParams({q:clean(query,120),hl:'ja',gl:'JP',ceid:'JP:ja'}).toString();const r=await fetch(u,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`News ${r.status}`);const xml=await r.text();const records=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0,8).map(m=>({title:clean(parseTag(m[1],'title'),300),url:parseTag(m[1],'link'),date:parseTag(m[1],'pubDate'),source:parseTag(m[1],'source')})).filter(x=>x.title&&/^https:\/\//.test(x.url));return{type:'news',status:'ok',checked_at:new Date().toISOString(),records,note:'ニュース見出し・配信元・日時・リンクです。記事本文は未確認です。'};}
function externalSafe(q){return !/discord\.com\/channels|<@|\b\d{16,20}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|このサーバー|Discord内|ディスコード内|この部屋|別のチャンネル|メンバーの発言|過去の投稿/i.test(q);}
async function searchWeb(query,question){query=clean(query,160).trim();if(!query||!externalSafe(question))return{type:'web',status:'blocked',records:[],note:'内部情報・個人情報を外部検索へ送らないため検索を実行していません。'};const r=await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error(`Web ${r.status}`);const html=await r.text(),records=[];for(const m of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)){let href=decodeHtml(m[1]);try{const u=new URL(href,'https://duckduckgo.com');const uddg=u.searchParams.get('uddg');if(uddg)href=decodeURIComponent(uddg);}catch{}if(!/^https?:\/\//i.test(href))continue;records.push({title:clean(stripHtml(m[2]),300),url:clean(href,1000)});if(records.length>=8)break;}return{type:'web',status:records.length?'ok':'empty',query,checked_at:new Date().toISOString(),records,note:'一般Web検索のタイトルとURLです。公式サイトを優先して回答してください。'};}

const CITY_COORDS={
 '東京':{name:'東京',latitude:35.6895,longitude:139.6917},'東京都':{name:'東京',latitude:35.6895,longitude:139.6917},
 '札幌':{name:'札幌',latitude:43.0618,longitude:141.3545},'札幌市':{name:'札幌',latitude:43.0618,longitude:141.3545},
 '大阪':{name:'大阪',latitude:34.6937,longitude:135.5023},'大阪市':{name:'大阪',latitude:34.6937,longitude:135.5023},
 '名古屋':{name:'名古屋',latitude:35.1815,longitude:136.9066},'京都':{name:'京都',latitude:35.0116,longitude:135.7681},
 '福岡':{name:'福岡',latitude:33.5904,longitude:130.4017},'仙台':{name:'仙台',latitude:38.2682,longitude:140.8694},
 '横浜':{name:'横浜',latitude:35.4437,longitude:139.638},'神戸':{name:'神戸',latitude:34.6901,longitude:135.1955},
 '広島':{name:'広島',latitude:34.3853,longitude:132.4553},'那覇':{name:'那覇',latitude:26.2124,longitude:127.6809}
};
function inferPlace(q){for(const k of Object.keys(CITY_COORDS).sort((a,b)=>b.length-a.length))if(q.includes(k))return k;const m=q.match(/([一-龥ぁ-んァ-ヶA-Za-z]{2,12})(?:の)?(?:天気|気温|降水|雨|雪)/);return m?.[1]||null;}
async function resolvePlace(place){if(CITY_COORDS[place])return CITY_COORDS[place];const aliases={'東京':'Tokyo','札幌':'Sapporo','大阪':'Osaka','京都':'Kyoto','名古屋':'Nagoya','福岡':'Fukuoka','仙台':'Sendai','横浜':'Yokohama','神戸':'Kobe','広島':'Hiroshima','那覇':'Naha'};const name=aliases[place]||place;const gr=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,{signal:AbortSignal.timeout(10000)});if(!gr.ok)throw new Error(`Geo ${gr.status}`);const gj=await gr.json(),loc=gj.results?.[0];return loc?{name:place||loc.name,latitude:loc.latitude,longitude:loc.longitude}:null;}
async function searchWeather(question){const place=inferPlace(question)||'東京',loc=await resolvePlace(place);if(!loc)return{type:'weather',status:'empty',place,records:[],note:'場所を特定できませんでした。'};const params=new URLSearchParams({latitude:String(loc.latitude),longitude:String(loc.longitude),timezone:'Asia/Tokyo',forecast_days:'7',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'});const wr=await fetch(`https://api.open-meteo.com/v1/forecast?${params}`,{signal:AbortSignal.timeout(10000)});if(!wr.ok)throw new Error(`Weather ${wr.status}`);const w=await wr.json();const rows=(w.daily?.time||[]).map((d,i)=>({date:d,weather_code:w.daily.weather_code?.[i],temp_max:w.daily.temperature_2m_max?.[i],temp_min:w.daily.temperature_2m_min?.[i],precip_probability_max:w.daily.precipitation_probability_max?.[i],precipitation_sum:w.daily.precipitation_sum?.[i],wind_max:w.daily.wind_speed_10m_max?.[i]}));return{type:'weather',status:'ok',checked_at:new Date().toISOString(),location:{name:loc.name},records:rows,note:'Open-Meteoの7日間予報です。時刻は日本時間。予報は更新されます。'};}

app.get('/diagnostic/weather',async(req,res)=>{try{res.json(await searchWeather(String(req.query.q||'東京の天気')));}catch(e){res.status(500).json({error:safeErr(e)});}});

function parseTool(text){const raw=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');if(!raw.startsWith('{'))return null;try{const p=JSON.parse(raw);return['server_search','news_search','web_search','weather_search'].includes(p.ruru_tool)?p:null;}catch{return null;}}
async function askMake(base,packet){const r=await fetch(MAKE_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...base,content:JSON.stringify(packet)}),signal:AbortSignal.timeout(30000)});const t=(await r.text()).trim();if(!r.ok||!t||/^(Accepted|OK)$/i.test(t))throw new Error(`Make ${r.status}`);return t;}
function forcedTool(question){if(!externalSafe(question))return null;if(/天気|気温|降水|降る|雨|雪|台風|猛暑|最低気温|最高気温/.test(question))return{ruru_tool:'weather_search'};if(/最新|現在|今どう|今日の|明日の|あしたの|今週|週末|来週|発売日|価格|値段|営業時間|営業中|在庫|何時|いつ発売|新しいの|アップデート|バージョン/.test(question))return{ruru_tool:'web_search',query:question};return null;}
async function answerQuestion(channel,member,question,messageId=null){const [history,scope]=await Promise.all([recentMessages(channel,messageId),readableScope(channel,member)]);const base={author_username:member.user.username,author_display_name:member.displayName||member.user.globalName||member.user.username,author_id:member.id,channel_id:channel.id,guild_id:channel.guild.id,message_id:messageId||'slash-command',timestamp:new Date().toISOString()};const packet={protocol:'ruru-v2',phase:'request',question:clean(question,4000),now:new Date().toISOString(),timezone:'Asia/Tokyo',author:base.author_display_name,recent_messages:history,readable_channels:[...scope.allowed.values()].slice(0,90).map(c=>({id:c.id,name:c.name,topic:clean(c.topic,180)})),can_search_server:true,can_search_news_headlines:true,can_search_web:true,can_search_weather:true};let tool=forcedTool(question),result=null,answer;if(tool){result=tool.ruru_tool==='weather_search'?await searchWeather(question):await searchWeb(tool.query||question,question);answer=await askMake(base,{...packet,phase:'answer',tool_result:result,forced_search:true});}else{answer=await askMake(base,packet);tool=parseTool(answer);if(tool?.ruru_tool==='server_search')result=await searchServer(tool,channel,member,messageId);else if(tool?.ruru_tool==='news_search')result=await searchNews(tool.query||question);else if(tool?.ruru_tool==='web_search')result=await searchWeb(tool.query||question,question);else if(tool?.ruru_tool==='weather_search')result=await searchWeather(question);if(tool){answer=await askMake(base,{...packet,phase:'answer',tool_result:result});if(parseTool(answer))answer='すみません。検索結果をうまく整理できませんでした。もう一度お願いします。';}}lastTool=tool?.ruru_tool||null;lastReplyAt=new Date().toISOString();return clean(answer,7600);}

async function registerSlashCommands(){const def={name:'るる',description:'AI秘書るるに自由に話しかけます',type:ApplicationCommandType.ChatInput,options:[{name:'メッセージ',description:'自由に入力してください',type:ApplicationCommandOptionType.String,required:true}]};let n=0;for(const g of client.guilds.cache.values()){try{await g.commands.set([def]);n++;console.log(`Registered /るる in ${g.name}`);}catch(e){console.error(safeErr(e));}}commandGuilds=n;}
client.once('ready',async()=>{discordReady=true;lastError=null;console.log(`Discord connected as ${client.user.tag} (${VERSION})`);await registerSlashCommands();});
client.on('shardDisconnect',()=>{discordReady=false;});client.on('shardReady',()=>{discordReady=true;});client.on('error',e=>{lastError=safeErr(e);});
client.on('interactionCreate',async i=>{if(!i.isChatInputCommand()||i.commandName!=='るる'||!i.guild)return;try{await i.deferReply();const channel=await i.guild.channels.fetch(i.channelId),member=await i.guild.members.fetch(i.user.id),bot=await i.guild.members.fetchMe();if(!channel||!canRead(channel,member)||!canSend(channel,bot)){await i.editReply('このチャンネルでは、るるが返信する権限がありません。');return;}const msg=i.options.getString('メッセージ',true).trim(),answer=await answerQuestion(channel,member,msg);const name=member.displayName||i.user.globalName||i.user.username;let visible=`**${clean(name,80)}：** ${clean(msg,1000)}\n\n${answer}`;await i.editReply(visible.slice(0,1900));visible=visible.slice(1900).trim();while(visible){await i.followUp({content:visible.slice(0,1900),allowedMentions:{parse:[]}});visible=visible.slice(1900).trim();}}catch(e){lastError=safeErr(e);const m='すみません。今は回答処理を完了できませんでした。少し時間をおいて、もう一度お願いします。';if(i.deferred||i.replied)await i.editReply(m).catch(()=>{});else await i.reply({content:m,flags:64}).catch(()=>{});}});
client.on('messageCreate',async m=>{if(m.author.bot||!m.guild||m.channelId!==LEGACY_CHANNEL_ID||!m.content.trim())return;try{await m.channel.sendTyping().catch(()=>{});const member=m.member||await m.guild.members.fetch(m.author.id),answer=await answerQuestion(m.channel,member,m.content.trim(),m.id);await m.reply({content:answer.slice(0,1900),allowedMentions:{parse:[],repliedUser:false},failIfNotExists:false});}catch(e){lastError=safeErr(e);}});
client.login(BOT_TOKEN).catch(e=>{lastError=safeErr(e);console.error(lastError);process.exit(1);});