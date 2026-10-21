
const express = require("express");
const mineflayer = require("mineflayer");
const TelegramBot = require("node-telegram-bot-api");

const {
  pathfinder,
  Movements,
  goals: { GoalBlock }
} = require("mineflayer-pathfinder");

const app = express();
const PORT = Number(process.env.PORT || 10000);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_CHAT_ID;

const sessions = new Map();
const serverConfigs = new Map();

let telegram = null;
let shuttingDown = false;

// ---------- HTTP WEB SERVICE ----------

app.get("/", (req, res) => {
  res.status(200).send("SEM AFK BOT is running.");
});

app.get("/health", (req, res) => {
  const servers = {};

  for (const [id, session] of sessions) {
    servers[id] = {
      connected: Boolean(session.bot?.entity),
      connecting: session.connecting,
      lastEvent: session.lastEvent
    };
  }

  res.status(200).json({
    service: "SEM AFK BOT",
    status: "running",
    servers
  });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// ---------- LOAD SERVER CONFIG ----------

function loadServers() {
  let data;

  try {
    data = JSON.parse(process.env.MC_SERVERS || "[]");
  } catch {
    throw new Error("MC_SERVERS must contain valid JSON.");
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Add at least one server to MC_SERVERS.");
  }

  for (const config of data) {
    if (
      !config.id ||
      !/^[a-zA-Z0-9_-]+$/.test(config.id) ||
      !config.host ||
      !config.username
    ) {
      throw new Error(
        "Each server needs a valid id, host and username."
      );
    }

    const port = Number(config.port || 25565);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port for server ${config.id}.`);
    }

    if (serverConfigs.has(config.id)) {
      throw new Error(`Duplicate server ID: ${config.id}`);
    }

    serverConfigs.set(config.id, {
      id: config.id,
      host: config.host,
      port,
      username: config.username
    });

    sessions.set(config.id, {
      bot: null,
      connecting: false,
      sneaking: false,
      lastEvent: "Not connected",
      walkTimer: null,
      jumpTimer: null
    });
  }
}

// ---------- ADMIN CHECK ----------

function isAdmin(msg) {
  return Boolean(
    ADMIN_ID &&
    msg.from &&
    String(msg.from.id) === String(ADMIN_ID)
  );
}

function reply(msg, text) {
  return telegram.sendMessage(msg.chat.id, text)
    .catch(err => {
      console.error("Telegram send error:", err.message);
    });
}

function getSession(id) {
  return sessions.get(id);
}

function getBot(id) {
  return getSession(id)?.bot || null;
}

function isConnected(id) {
  return Boolean(getBot(id)?.entity);
}

// ---------- MOVEMENT HELPERS ----------

function stopMovement(id) {
  const session = getSession(id);
  if (!session) return;

  if (session.walkTimer) {
    clearTimeout(session.walkTimer);
    session.walkTimer = null;
  }

  if (session.jumpTimer) {
    clearTimeout(session.jumpTimer);
    session.jumpTimer = null;
  }

  if (session.bot) {
    session.bot.clearControlStates();

    try {
      session.bot.pathfinder.setGoal(null);
    } catch (_) {}
  }

  session.sneaking = false;
}

function jump(id) {
  const session = getSession(id);
  const bot = getBot(id);

  if (!session || !bot?.entity) {
    return "Bot is not connected.";
  }

  if (session.jumpTimer) clearTimeout(session.jumpTimer);

  bot.setControlState("jump", true);

  session.jumpTimer = setTimeout(() => {
    if (session.bot === bot) {
      bot.setControlState("jump", false);
    }
    session.jumpTimer = null;
  }, 350);

  return "Jump requested.";
}

function toggleSneak(id) {
  const session = getSession(id);
  const bot = getBot(id);

  if (!session || !bot?.entity) {
    return "Bot is not connected.";
  }

  session.sneaking = !session.sneaking;

  bot.setControlState("sneak", session.sneaking);

  return session.sneaking
    ? "Sneak enabled."
    : "Sneak disabled.";
}

function walk(id) {
  const session = getSession(id);
  const bot = getBot(id);

  if (!session || !bot?.entity) {
    return "Bot is not connected.";
  }

  stopMovement(id);

  bot.setControlState("forward", true);

  session.walkTimer = setTimeout(() => {
    if (session.bot === bot) {
      bot.setControlState("forward", false);
    }

    session.walkTimer = null;
  }, 2000);

  return "Walking forward for 2 seconds.";
}

function moveToCoordinates(id, x, y, z) {
  const bot = getBot(id);

  if (!bot?.entity) {
    return "Bot is not connected.";
  }

  if (!bot.pathfinder) {
    return "Pathfinder is not ready yet.";
  }

  const values = [x, y, z];

  if (
    !values.every(Number.isSafeInteger) ||
    values.some(n => Math.abs(n) > 30000000) ||
    y < -2048 ||
    y > 2048
  ) {
    return "Invalid coordinates.";
  }

  try {
    stopMovement(id);

    bot.pathfinder.setGoal(new GoalBlock(x, y, z));

    return `Pathfinding towards ${x} ${y} ${z}.`;
  } catch (err) {
    return `Movement error: ${err.message}`;
  }
}

// ---------- CONNECT TO A SERVER ----------

function joinServer(id) {
  const config = serverConfigs.get(id);
  const session = getSession(id);

  if (!config || !session) {
    return `Unknown server: ${id}. Use /servers.`;
  }

  if (session.connecting || session.bot) {
    return `${id}: already connected or connecting.`;
  }

  session.connecting = true;
  session.lastEvent = "Connection requested";

  let bot;

  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: "offline",
      hideErrors: false
    });

    session.bot = bot;

    bot.loadPlugin(pathfinder);

    bot.once("login", () => {
      if (session.bot !== bot) return;

      session.connecting = false;
      session.lastEvent = "Logged in";

      console.log(`[${id}] Login successful`);
    });

    bot.once("spawn", () => {
      if (session.bot !== bot) return;

      session.connecting = false;
      session.lastEvent = "Spawned in world";

      try {
        bot.pathfinder.setMovements(new Movements(bot));
      } catch (err) {
        console.error(`[${id}] Pathfinder:`, err.message);
      }

      console.log(`[${id}] Spawned in world`);
    });

    bot.on("kicked", reason => {
      if (session.bot !== bot) return;

      session.lastEvent =
        "Kicked: " + String(reason).slice(0, 180);

      console.log(`[${id}] ${session.lastEvent}`);
    });

    bot.on("error", err => {
      if (session.bot !== bot) return;

      session.lastEvent = "Error: " + err.message;
      console.error(`[${id}]`, err.message);
    });

    bot.on("end", () => {
      if (session.bot !== bot) return;

      stopMovement(id);
      session.bot = null;
      session.connecting = false;
      session.lastEvent = "Disconnected";

      console.log(`[${id}] Disconnected`);
    });

    return `${id}: connection attempt started.`;
  } catch (err) {
    if (session.bot === bot) session.bot = null;

    session.connecting = false;
    session.lastEvent = "Error: " + err.message;

    return `${id}: ${session.lastEvent}`;
  }
}

// ---------- DISCONNECT ----------

function leaveServer(id) {
  const session = getSession(id);

  if (!session) {
    return `Unknown server: ${id}. Use /servers.`;
  }

  const bot = session.bot;

  if (!bot) {
    return `${id}: not connected.`;
  }

  stopMovement(id);

  session.bot = null;
  session.connecting = false;
  session.lastEvent = "Disconnected by admin";

  try {
    bot.quit("Owner requested disconnect");
  } catch (err) {
    console.error(`[${id}] Disconnect error:`, err.message);
  }

  return `${id}: disconnected.`;
}

// ---------- STATUS ----------

function statusText(id) {
  const session = getSession(id);

  if (!session) return `Unknown server: ${id}.`;

  return [
    `🎮 Server: ${id}`,
    `Connection: ${isConnected(id) ? "ONLINE" : "OFFLINE"}`,
    `Connecting: ${session.connecting ? "YES" : "NO"}`,
    `Last event: ${session.lastEvent}`
  ].join("\n");
}

function allStatuses() {
  if (sessions.size === 0) return "No servers configured.";

  return [...sessions.keys()]
    .map(id => statusText(id))
    .join("\n\n");
}

// ---------- TELEGRAM COMMANDS ----------

function registerCommands() {
  telegram.onText(/^\/start(?:@\w+)?$/, msg => {
    if (!isAdmin(msg)) return;

    reply(
      msg,
      [
        "💜 SEM AFK BOT",
        "",
        "/servers",
        "/status",
        "/status <id>",
        "/join <id>",
        "/leave <id>",
        "/jump <id>",
        "/sneak <id>",
        "/walk <id>",
        "/stop <id>",
        "/tp <id> <x> <y> <z>",
        "/kill <id>",
        "",
        "Example: /join survival"
      ].join("\n")
    );
  });

  telegram.onText(/^\/servers(?:@\w+)?$/, msg => {
    if (!isAdmin(msg)) return;

    const list = [...serverConfigs.values()].map(s =>
      `${s.id} — ${s.host}:${s.port}`
    );

    reply(msg, list.join("\n") || "No servers configured.");
  });

  telegram.onText(/^\/status(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    const id = match[1];

    if (id) {
      reply(msg, statusText(id));
    } else {
      reply(msg, allStatuses());
    }
  });

  telegram.onText(/^\/join(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    const id = match[1];

    if (!id) {
      reply(msg, "Usage: /join <server_id>");
      return;
    }

    reply(msg, joinServer(id));
  });

  telegram.onText(/^\/leave(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    if (!match[1]) {
      reply(msg, "Usage: /leave <server_id>");
      return;
    }

    reply(msg, leaveServer(match[1]));
  });

  telegram.onText(/^\/kill(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    if (!match[1]) {
      reply(msg, "Usage: /kill <server_id>");
      return;
    }

    reply(msg, leaveServer(match[1]));
  });

  telegram.onText(/^\/jump(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    if (!match[1]) {
      reply(msg, "Usage: /jump <server_id>");
      return;
    }

    reply(msg, jump(match[1]));
  });

  telegram.onText(/^\/sneak(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    if (!match[1]) {
      reply(msg, "Usage: /sneak <server_id>");
      return;
    }

    reply(msg, toggleSneak(match[1]));
  });

  telegram.onText(/^\/walk(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    if (!match[1]) {
      reply(msg, "Usage: /walk <server_id>");
      return;
    }

    reply(msg, walk(match[1]));
  });

  telegram.onText(/^\/stop(?:@\w+)?(?:\s+(\S+))?$/, (msg, match) => {
    if (!isAdmin(msg)) return;

    const id = match[1];
    const session = getSession(id);

    if (!id || !session) {
      reply(msg, "Usage: /stop <server_id>");
      return;
    }

    stopMovement(id);
    reply(msg, `${id}: movement stopped.`);
  });

  telegram.onText(
    /^\/tp(?:@\w+)?\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/,
    (msg, match) => {
      if (!isAdmin(msg)) return;

      const [, id, x, y, z] = match;

      reply(
        msg,
        moveToCoordinates(id, Number(x), Number(y), Number(z))
      );
    }
  );

  telegram.on("polling_error", err => {
    console.error("Telegram polling error:", err.message);
  });
}


 https://sem-minecraft-afk-bot.onrender.com


  console.log(`Loaded ${serverConfigs.size} Minecraft server(s).`);
} catch (err) {
  console.error("Startup configuration error:", err.message);
}

// ---------- GRACEFUL SHUTDOWN ----------

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const id of sessions.keys()) {
    leaveServer(id);
  }

  if (telegram) {
    telegram.stopPolling()
      .catch(err => console.error("Polling shutdown:", err.message));
  }

  httpServer.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
                    
