const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1546475931411943466';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const PORT = process.env.PORT || 10000;

const app = express();
let discordReady = false;
let lastForwardAt = null;
let lastReplyAt = null;
let lastError = null;

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'ruru-discord-bot',
    discordReady,
    targetChannel: CHANNEL_ID,
    lastForwardAt,
    lastReplyAt,
    lastError,
  });
});

app.listen(PORT, () => {
  console.log(`Health server listening on ${PORT}`);
});

if (!BOT_TOKEN || !MAKE_WEBHOOK_URL) {
  console.error('Missing DISCORD_BOT_TOKEN or MAKE_WEBHOOK_URL');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  discordReady = true;
  lastError = null;
  console.log(`Discord connected as ${client.user.tag}`);
});

client.on('shardDisconnect', () => {
  discordReady = false;
});

client.on('shardReady', () => {
  discordReady = true;
});

client.on('error', (err) => {
  lastError = err?.message || String(err);
  console.error('Discord client error:', lastError);
});

function splitDiscordMessage(text, max = 2000) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== CHANNEL_ID) return;

    const content = (message.content || '').trim();
    if (!content) return;

    const payload = {
      content,
      author_username: message.author.username,
      author_display_name:
        message.member?.displayName ||
        message.author.globalName ||
        message.author.username,
      author_id: message.author.id,
      channel_id: message.channelId,
      guild_id: message.guildId,
      message_id: message.id,
      timestamp: message.createdAt.toISOString(),
    };

    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(`Make webhook ${response.status}: ${responseBody}`);
    }

    lastForwardAt = new Date().toISOString();
    lastError = null;
    console.log(`Forwarded Discord message ${message.id} to Make`);

    const replyText = responseBody.trim();
    if (replyText) {
      for (const chunk of splitDiscordMessage(replyText)) {
        await message.channel.send(chunk);
      }
      lastReplyAt = new Date().toISOString();
      console.log(`Replied to Discord message ${message.id} as ${client.user.tag}`);
    }
  } catch (err) {
    lastError = err?.message || String(err);
    console.error('Forward/reply failed:', lastError);
  }
});

client.login(BOT_TOKEN).catch((err) => {
  lastError = err?.message || String(err);
  console.error('Discord login failed:', lastError);
  process.exit(1);
});
