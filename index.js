'use strict';

const express = require('express');
const mineflayer = require('@wp2508/mineflayer');
const TelegramBot = require('node-telegram-bot-api');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ---------- ENVIRONMENT ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || '').trim();
const PORT = Number(process.env.PORT || 3000);

// Render Web Service health endpoint
const app = express();
app.get('/', (_req, res) => res.status(200).send('SEM-AFK-BOT is running.'));
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'SEM-AFK-BOT',
    serversConfigured: serverConfigs.size,
    connectedBots: [...sessions.values()].filter(s => s.bot && s.bot.entity).length
  });
});
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP health server listening on port ${PORT}`);
});

// ---------- STATE ----------
const serverConfigs = new Map();
const sessions = new Map();
let telegram = null;
let shuttingDown = false;

// ---------- SERVER CONFIG ----------
function loadServers() {
  const raw = process.env.MC_SERVERS;
  if (!raw) throw new Error('Missing MC_SERVERS in Render Environment.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MC_SERVERS must be valid JSON.');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('MC_SERVERS must be a non-empty JSON array.');
  }

  serverConfigs.clear();
  for (const item of parsed) {
    if (!item || !item.id || !item.host || !item.username) {
      throw new Error('Each MC_SERVERS item needs id, host, and username.');
    }
    const id = String(item.id).trim();
    const port = Number(item.port || 25565);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port for server "${id}".`);
    }
    serverConfigs.set(id, {
      id,
      host: String(item.host).trim(),
      port,
      username: String(item.username).trim(),
      version: item.version ? String(item.version).trim() : undefined
    });
  }
}

function getSession(id) {
  return sessions.get(String(id));
}

function isConnected(session) {
  return Boolean(session && session.bot && session.bot.entity);
}

function send(chatId, message) {
  if (!telegram) return;
  telegram.sendMessage(chatId, message, { disable_web_page_preview: true })
    .catch(err => console.error('Telegram send error:', err.message));
}

function leaveServer(id) {
  const session = getSession(id);
  if (!session) return false;

  sessions.delete(String(id));
  try {
    if (session.bot) {
      session.bot.removeAllListeners();
      session.bot.quit('Disconnected by admin');
    }
  } catch (err) {
    console.error(`Error disconnecting ${id}:`, err.message);
  }
  return true;
}

// ---------- MINECRAFT CONNECTION ----------
function joinServer(id, chatId) {
  const config = serverConfigs.get(String(id));
  if (!config) {
    send(chatId, `❌ Unknown server ID: ${id}\nUse /servers to see configured servers.`);
    return;
  }

  if (sessions.has(config.id)) {
    const old = sessions.get(config.id);
    if (old.connecting || isConnected(old)) {
      send(chatId, `ℹ️ Bot is already connecting to or connected with "${config.id}".`);
      return;
    }
    leaveServer(config.id);
  }

  const session = { bot: null, connecting: true, startedAt: Date.now(), config };
  sessions.set(config.id, session);
  send(chatId, `🔄 Connecting to ${config.id} (${config.host}:${config.port}) as ${config.username}...`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: 'offline',
      ...(config.version ? { version: config.version } : {})
    });
  } catch (err) {
    sessions.delete(config.id);
    send(chatId, `❌ Could not start connection: ${err.message}`);
    return;
  }

  session.bot = bot;
  bot.loadPlugin(pathfinder);

  bot.once('login', () => {
    session.connecting = false;
    console.log(`[${config.id}] Logged in as ${config.username}`);
  });

  bot.once('spawn', () => {
    session.connecting = false;
    try {
      const mcData = require('minecraft-data')(bot.version);
      bot.pathfinder.setMovements(new Movements(bot, mcData));
    } catch (err) {
      console.error(`[${config.id}] Pathfinder setup:`, err.message);
    }
    send(chatId, `✅ Minecraft bot joined "${config.id}" successfully.`);
  });

  bot.on('kicked', reason => {
    console.log(`[${config.id}] Kicked:`, reason);
    send(chatId, `⚠️ Minecraft bot "${config.id}" was kicked: ${String(reason).slice(0, 500)}`);
  });

  bot.on('error', err => {
    console.error(`[${config.id}] Minecraft error:`, err.message);
    send(chatId, `❌ Minecraft error on "${config.id}": ${err.message}`);
  });

  bot.on('end', reason => {
    console.log(`[${config.id}] Connection ended: ${reason || 'unknown reason'}`);
    if (sessions.get(config.id) === session) sessions.delete(config.id);
    send(chatId, `🔌 Minecraft bot "${config.id}" disconnected.`);
  });
}

// ---------- TELEGRAM COMMANDS ----------
function registerCommands() {
  telegram.onText(/^\/start(?:@\w+)?$/, msg => {
    if (String(msg.chat.id) !== ADMIN_ID) {
      return send(msg.chat.id, '⛔ This bot is private. Ask the owner for access.');
    }
    send(msg.chat.id,
      '👋 SEM-AFK-BOT ready!\n\n' +
      '/servers — configured servers\n' +
      '/status — bot connection status\n' +
      '/join <id> — join a server\n' +
      '/leave <id> — disconnect from a server\n' +
      '/jump <id> — jump\n' +
      '/sneak <id> — toggle sneak\n' +
      '/walk <id> — walk forward briefly\n' +
      '/stop <id> — stop movement\n' +
      '/tp <id> <x> <y> <z> — walk to coordinates\n' +
      '/kill <id> — disconnect bot from server'
    );
  });

  telegram.on('message', msg => {
    if (!msg.text || !msg.text.startsWith('/')) return;
    if (String(msg.chat.id) !== ADMIN_ID) {
      send(msg.chat.id, '⛔ Only the configured admin can use commands.');
    }
  });

  telegram.onText(/^\/servers(?:@\w+)?$/, msg => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const lines = [...serverConfigs.values()].map(s =>
      `• ${s.id}: ${s.host}:${s.port} (username: ${s.username})`);
    send(msg.chat.id, lines.length ? `🗂 Configured servers:\n${lines.join('\n')}` : 'No servers configured.');
  });

  telegram.onText(/^\/status(?:@\w+)?$/, msg => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const lines = [...serverConfigs.keys()].map(id => {
      const s = getSession(id);
      const status = !s ? '🔴 Disconnected' : isConnected(s) ? '🟢 Connected' : '🟡 Connecting';
      return `• ${id}: ${status}`;
    });
    send(msg.chat.id, `📊 SEM-AFK-BOT status\n${lines.join('\n') || 'No servers configured.'}`);
  });

  telegram.onText(/^\/join(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    joinServer(match[1], msg.chat.id);
  });

  telegram.onText(/^\/leave(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const id = match[1];
    if (!leaveServer(id)) return send(msg.chat.id, `ℹ️ No active session for "${id}".`);
    send(msg.chat.id, `🔌 Disconnected "${id}".`);
  });

  telegram.onText(/^\/kill(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const id = match[1];
    if (!leaveServer(id)) return send(msg.chat.id, `ℹ️ No active session for "${id}".`);
    send(msg.chat.id, `🛑 Bot "${id}" disconnected.`);
  });

  telegram.onText(/^\/jump(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const s = getSession(match[1]);
    if (!isConnected(s)) return send(msg.chat.id, '❌ Bot is not connected. Use /join <id>.');
    s.bot.setControlState('jump', true);
    setTimeout(() => {
      try { if (isConnected(s)) s.bot.setControlState('jump', false); } catch {}
    }, 500);
    send(msg.chat.id, `🦘 Jump command sent to "${match[1]}".`);
  });

  telegram.onText(/^\/sneak(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const s = getSession(match[1]);
    if (!isConnected(s)) return send(msg.chat.id, '❌ Bot is not connected. Use /join <id>.');
    const next = !s.bot.getControlState('sneak');
    s.bot.setControlState('sneak', next);
    send(msg.chat.id, `🕵️ Sneak ${next ? 'enabled' : 'disabled'} for "${match[1]}".`);
  });

  telegram.onText(/^\/walk(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const s = getSession(match[1]);
    if (!isConnected(s)) return send(msg.chat.id, '❌ Bot is not connected. Use /join <id>.');
    s.bot.setControlState('forward', true);
    setTimeout(() => {
      try { if (isConnected(s)) s.bot.setControlState('forward', false); } catch {}
    }, 3000);
    send(msg.chat.id, `🚶 Walking forward for 3 seconds on "${match[1]}".`);
  });

  telegram.onText(/^\/stop(?:@\w+)?\s+(\S+)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const s = getSession(match[1]);
    if (!isConnected(s)) return send(msg.chat.id, '❌ Bot is not connected.');
    s.bot.clearControlStates();
    s.bot.pathfinder.setGoal(null);
    send(msg.chat.id, `⏹️ Movement stopped for "${match[1]}".`);
  });

  telegram.onText(/^\/tp(?:@\w+)?\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/, (msg, match) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    const [, id, xRaw, yRaw, zRaw] = match;
    const s = getSession(id);
    if (!isConnected(s)) return send(msg.chat.id, '❌ Bot is not connected. Use /join <id>.');
    const x = Number(xRaw), y = Number(yRaw), z = Number(zRaw);
    if (![x, y, z].every(Number.isFinite)) return send(msg.chat.id, '❌ Coordinates are invalid.');
    s.bot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
    send(msg.chat.id, `📍 "${id}" is pathfinding toward ${x}, ${y}, ${z}. (This is walking, not instant teleportation.)`);
  });

  telegram.on('polling_error', err => {
    console.error('Telegram polling error:', err.message);
  });
}

// ---------- STARTUP ----------
function start() {
  if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in Render Environment.');
  if (!ADMIN_ID) throw new Error('Missing ADMIN_CHAT_ID in Render Environment.');

  loadServers();
  telegram = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  registerCommands();

  console.log('Telegram polling enabled.');
  console.log(`Loaded ${serverConfigs.size} Minecraft server(s).`);
}

try {
  start();
} catch (err) {
  console.error('Startup configuration error:', err.message);
}

// ---------- GRACEFUL SHUTDOWN ----------
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const id of [...sessions.keys()]) leaveServer(id);

  if (telegram) {
    try {
      const result = telegram.stopPolling();
      if (result && typeof result.catch === 'function') {
        result.catch(err => console.error('Polling shutdown:', err.message));
      }
    } catch (err) {
      console.error('Polling shutdown:', err.message);
    }
  }

  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
