require("dotenv").config();
const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ─── Logger ───────────────────────────────────────────────────────
function vnTimestamp() {
  const now = new Date();
  return now.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}

function log(tag, ...args) {
  console.log(`[${vnTimestamp()}] ${tag}`, ...args);
}

function logError(tag, ...args) {
  console.error(`[${vnTimestamp()}] ${tag}`, ...args);
}

function userLabel(from) {
  if (!from) return "unknown";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "NoName";
  const username = from.username ? `@${from.username}` : "no-username";
  return `${name} (${username}, id:${from.id})`;
}

function chatLabel(chat) {
  if (!chat) return "unknown-chat";
  const title = chat.title || chat.username || chat.first_name || "DM";
  return `"${title}" (type:${chat.type}, id:${chat.id})`;  
}

function preview(text, maxLen) {
  maxLen = maxLen || 80;
  if (!text) return "[empty]";
  const oneLine = text.replace(/\n/g, "⏎").replace(/\r/g, "");
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen) + "…";
}

// ─── Config ───────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

const TARGET_BOT_ID = 6218688053;
const HEADER_PATTERN = "📌 Tin vượt chuẩn trả lại những số sau:";
const ALLOWED_FORWARD_FROM = (process.env.ALLOWED_FORWARD_FROM || "")
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => !isNaN(id));

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING || "";

const CHAT_FILE = path.join(__dirname, "chat.txt");
const PORT = process.env.PORT || 3000;

// ─── Health check server (for cron jobs) ───────────────────────────
const startedAt = Date.now();
const server = http.createServer((req, res) => {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const status = {
    status: "ok",
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
    started: new Date(startedAt).toISOString(),
    chats: loadChatIds().length,
    timestamp: new Date().toISOString(),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log("⚠️  [Health]", `Port ${PORT} already in use — health server skipped (bot still runs)`);
  } else {
    logError("❌ [Health]", "Server error:", err);
  }
});

server.listen(PORT, () => {
  log("🌐 [Health]", `Server listening on port ${PORT}`);
});

// ─── Normalize Telegram chat IDs ──────────────────────────────────
// Supergroups: Telegram internally uses -100XXXXXXXXXX
// Users often store -XXXXXXXXXX (without -100 prefix)
// This function normalizes both forms to the FULL -100 form
function normalizeChatId(id) {
  const s = String(id).trim();
  // If it starts with -100 and has more than 4 digits after, it's already full form
  if (s.indexOf("-100") === 0 && s.length > 7) return s;
  // If it starts with - but not -100, add the -100 prefix
  if (s.indexOf("-") === 0) {
    const num = s.substring(1); // remove leading -
    return "-100" + num;
  }
  return s;
}

// ─── Load chat IDs from chat.txt ──────────────────────────────────
function loadChatIds() {
  try {
    if (!fs.existsSync(CHAT_FILE)) {
      fs.writeFileSync(CHAT_FILE, "# Add chat IDs here, one per line\n# Example: -5157920720\n");
      log("📄 [Config]", "Created chat.txt — add your group chat IDs there.");
      return [];
    }
    const content = fs.readFileSync(CHAT_FILE, "utf-8");
    const ids = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    log("📄 [Config]", `Loaded ${ids.length} chat(s) from chat.txt (raw):`, ids);
    return ids;
  } catch (err) {
    logError("❌ [Config]", "Error loading chat.txt:", err.message);
    return [];
  }
}

// ─── Helper: escape HTML special chars ────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Helper: get VN time suffix for 2d/3d/4d keys ───────────────
function getTimeSuffix() {
  // VN time = UTC+7
  const now = new Date();
  const vnHour = (now.getUTCHours() + 7) % 24;
  const vnMinute = now.getUTCMinutes();
  const vnTime = vnHour * 60 + vnMinute; // total minutes since midnight

  const mnStart = 12 * 60;       // 12:00
  const mnEnd = 16 * 60 + 30;    // 16:30
  const mtStart = 16 * 60 + 50;  // 16:50
  const mtEnd = 17 * 60 + 30;    // 17:30

  if (vnTime >= mnStart && vnTime <= mnEnd) return "mn";
  if (vnTime >= mtStart && vnTime <= mtEnd) return "mt";
  return "";
}

function isSaturday() {
  // VN time = UTC+7
  const now = new Date();
  const vnOffset = 7 * 60 * 60 * 1000;
  const vnDate = new Date(now.getTime() + vnOffset);
  return vnDate.getUTCDay() === 6; // 6 = Saturday
}

// ─── Helper: apply time-based suffix to key ──────────────────────
function applyKeySuffix(key) {
  const suffix = getTimeSuffix();
  const lower = key.toLowerCase();

  // 2d and 3d: apply mn/mt based on time
  if (lower === "2d" || lower === "3d") {
    if (suffix) return lower + suffix;
    return lower;
  }

  // 4d: only on Saturday, always use mn
  if (lower === "4d") {
    if (isSaturday()) return lower + "mn";
    return lower;
  }

  return lower;
}

// ─── Helper: remove backticks from string (no regex) ─────────────
function removeBackticks(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== "`") {
      result += str[i];
    }
  }
  return result;
}

// ─── Helper: replace 'lo' with 'b' case-insensitive (no regex) ──
function replaceLoWithB(str) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (
      i + 1 < str.length &&
      (str[i] === "l" || str[i] === "L") &&
      (str[i + 1] === "o" || str[i + 1] === "O")
    ) {
      result += "b";
      i += 2;
    } else if (
      i + 1 < str.length &&
      (str[i] === "d" || str[i] === "D") &&
      (str[i + 1] === "x" || str[i + 1] === "X")
    ) {
      result += "da";
      i += 2;
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}

// ─── Helper: process message ─────────────────────────────────────
function processMessage(text) {
  // Step 1: Check for header and extract raw content after it
  if (!text.includes(HEADER_PATTERN)) return null;

  const lastIndex = text.lastIndexOf(HEADER_PATTERN);
  let content = text.substring(lastIndex + HEADER_PATTERN.length).trim();

  if (!content) {
    const firstIndex = text.indexOf(HEADER_PATTERN);
    content = text.substring(firstIndex + HEADER_PATTERN.length).trim();
  }
  if (!content) return null;

  // Step 2: Remove extra backticks (no regex)
  content = removeBackticks(content).trim();
  if (!content) return null;

  // Step 3: Normalize newlines to commas, then separate by ','
  // Replace all newline characters with commas so multi-line input is handled correctly
  var normalized = "";
  for (var c = 0; c < content.length; c++) {
    if (content[c] === "\n" || content[c] === "\r") {
      normalized += ",";
    } else {
      normalized += content[c];
    }
  }
  const segments = normalized.split(",");

  // Step 4: For each instance, split by ' ' → first item is key, rest are values
  //         Build object: { key: [values] }
  const grouped = {};

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s].trim();
    if (!segment) continue;

    const parts = segment.split(" ").filter(function (p) { return p !== ""; });
    if (parts.length === 0) continue;

    // First item is the key (e.g. "lo", "2d", "dd"), rest are values
    const rawKey = parts[0];
    const values = parts.slice(1);

    // Apply 'lo' → 'b' replacement on the key
    let transformedKey = replaceLoWithB(rawKey);

    // Replace 'lo' with 'b' in each value
    const transformedValues = [];
    for (let v = 0; v < values.length; v++) {
      transformedValues.push(replaceLoWithB(values[v]));
    }

    // Special rule: if key is "ag" and first value is "tn", combine into "2d"
    if (transformedKey === "ag" && transformedValues.length > 0 && transformedValues[0] === "tn") {
      transformedKey = "2d";
      transformedValues.shift();
    }

    // Apply time-based suffix to 2d/3d/4d keys
    const finalKey = applyKeySuffix(transformedKey);

    // Accumulate into grouped object
    if (!grouped[finalKey]) {
      grouped[finalKey] = [];
    }
    for (let v = 0; v < transformedValues.length; v++) {
      grouped[finalKey].push(transformedValues[v]);
    }
  }

  // Step 5: Sort the object keys alphabetically ascending
  const sortedKeys = Object.keys(grouped).sort();

  // Step 6: Combine into nested arrays [[key, val1, val2, ...], ...]
  const nestedArrays = [];
  for (let k = 0; k < sortedKeys.length; k++) {
    const key = sortedKeys[k];
    const row = [key];
    const vals = grouped[key];
    for (let v = 0; v < vals.length; v++) {
      row.push(vals[v]);
    }
    nestedArrays.push(row);
  }

  if (nestedArrays.length === 0) return null;

  // Step 7: Flatten all groups into one token list
  const allTokens = [];
  for (let i = 0; i < nestedArrays.length; i++) {
    for (let j = 0; j < nestedArrays[i].length; j++) {
      allTokens.push(nestedArrays[i][j]);
    }
  }

  // Combine all tokens: use '\n' after tokens ending with 'n', otherwise ' '
  let result = "";
  for (let i = 0; i < allTokens.length; i++) {
    result += allTokens[i];
    if (i < allTokens.length - 1) {
      // Check if current token ends with 'n' or 'N'
      var lastChar = allTokens[i][allTokens[i].length - 1];
      if (lastChar === "n" || lastChar === "N") {
        result += "\n";
      } else {
        result += " ";
      }
    }
  }

  return result;
}

// ─── Send to all chats in chat.txt ────────────────────────────────
async function sendToAllChats(result, sourceInfo) {
  const chatIds = loadChatIds();
  if (chatIds.length === 0) {
    log("⚠️  [Broadcast]", "No chats in chat.txt to send to.");
    return;
  }

  log("📡 [Broadcast]", `Sending to ${chatIds.length} chat(s) | source: ${sourceInfo || "unknown"} | content: ${preview(result)}`);

  for (const rawChatId of chatIds) {
    const chatId = normalizeChatId(rawChatId);
    try {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      await bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML" });
      log("📤 [Broadcast]", `✅ Delivered to chat ${chatId}`);
    } catch (err) {
      logError("❌ [Broadcast]", `Failed to send to ${chatId}:`, err.message);
    }
  }
}

// ─── Telegraf Bot Commands ────────────────────────────────────────
bot.start((ctx) => {
  ctx.reply(
    "👋 Xin chào! Bot tự động đọc tin vượt chuẩn và thay 'lo' → 'b'.\n" +
    "Bot đang chạy ở chế độ tự động."
  );
});

bot.help((ctx) => {
  ctx.reply(
    "📖 Bot tự động:\n" +
    "• Đọc tin từ bot vượt chuẩn trong group\n" +
    "• Thay 'lo' → 'b'\n" +
    "• Gửi kết quả về tất cả group trong chat.txt\n\n" +
    "Bạn cũng có thể forward tin nhắn trực tiếp cho bot."
  );
});

// Handle text — groups directly, DMs only if forwarded from allowed users
bot.on("text", async (ctx) => {
  const chatType = ctx.chat?.type;
  const msg = ctx.message;
  const text = msg.text || "";
  const who = userLabel(msg.from);
  const where = chatLabel(ctx.chat);

  // ── Private / DM ──
  if (chatType === "private") {
    const senderId = msg.from?.id;
    const forwardFrom =
      msg.forward_origin?.type === "user" ? msg.forward_origin.sender_user?.id :
        msg.forward_from?.id ?? null;
    const forwardName = msg.forward_from
      ? userLabel(msg.forward_from)
      : (msg.forward_origin?.sender_user ? userLabel(msg.forward_origin.sender_user) : null);

    const isAllowed =
      ALLOWED_FORWARD_FROM.includes(senderId) ||
      (forwardFrom && ALLOWED_FORWARD_FROM.includes(forwardFrom));

    log("📩 [Bot/DM]", `Incoming message from ${who}` +
      (forwardFrom ? ` | forwarded from: ${forwardName || forwardFrom}` : "") +
      ` | preview: ${preview(text)}`);

    if (!isAllowed) {
      log("⛔ [Bot/DM]", `REJECTED — user ${who} not in ALLOWED_FORWARD_FROM (forward: ${forwardFrom || "none"})`);
      return;
    }

    log("✅ [Bot/DM]", `AUTHORIZED — processing message from ${who}`);

    // For DMs: try with header first, then treat as raw data
    const result = processMessage(text);
    if (result) {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      ctx.reply(html, { parse_mode: "HTML" });
      log("📤 [Bot/DM]", `Replied to ${who} | result: ${preview(result)}`);
    } else {
      log("⏭️  [Bot/DM]", `No header found in message from ${who} — skipped`);
    }
    return;
  }

  // ── Groups / Supergroups ──
  if (chatType === "group" || chatType === "supergroup") {
    const hasHeader = text.includes(HEADER_PATTERN);
    log("📩 [Bot/Group]", `Message from ${who} in ${where} | has_header: ${hasHeader} | preview: ${preview(text)}`);

    const result = processMessage(text);
    if (result) {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      ctx.reply(html, { parse_mode: "HTML" });
      log("📤 [Bot/Group]", `Replied in ${where} | triggered by: ${who} | result: ${preview(result)}`);
    }
  }
});

// ─── GramJS Userbot (auto-read from group) ────────────────────────
async function startUserbot() {
  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: Infinity,
    retryDelay: 3000,
    autoReconnect: true,
    timeout: 30,
    useWSS: false,
  });

  log("🔑 [Userbot]", "Logging in to Telegram user account...");
  await client.start({
    phoneNumber: async () => await input.text("📱 Enter your phone number: "),
    password: async () => await input.text("🔒 Enter 2FA password (if any): "),
    phoneCode: async () => await input.text("📟 Enter the code you received: "),
    onError: (err) => logError("❌ [Userbot]", "Login error:", err),
  });

  const savedSession = client.session.save();
  log("✅ [Userbot]", "Logged in successfully!");
  log("🔑 [Userbot]", `SESSION_STRING=${savedSession}`);

  // Listen for new messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.text) return;

      const senderId = message.senderId?.toString();
      const chatId = message.chatId || message.peerId;

      if (senderId !== TARGET_BOT_ID.toString()) return;

      // Only care about messages with the header
      if (!message.text.includes(HEADER_PATTERN)) return;

      log("📩 [Userbot]", `Header message detected from bot ${TARGET_BOT_ID} in chat ${chatId} | preview: ${preview(message.text)}`);

      const result = processMessage(message.text);
      if (!result) return;

      log("⚙️  [Userbot]", `Processed result: ${preview(result)}`);

      // Only reply in allowed chats from chat.txt (normalize both sides)
      const normalizedChatId = normalizeChatId(chatId);
      const allowedChats = loadChatIds().map(normalizeChatId);
      if (!allowedChats.includes(normalizedChatId)) {
        log("⛔ [Userbot]", `REJECTED — chat ${chatId} (normalized: ${normalizedChatId}) not in allowed: [${allowedChats.join(", ")}]`);
        return;
      }
      try {
        await bot.telegram.sendMessage(normalizedChatId, `<pre>${escapeHtml(result)}</pre>`, { parse_mode: "HTML" });
        log("📤 [Userbot]", `✅ Delivered to chat ${chatId} | result: ${preview(result)}`);
      } catch (e) {
        logError("❌ [Userbot]", `Failed to reply in chat ${chatId}:`, e.message);
      }
    } catch (err) {
      logError("❌ [Userbot]", "Error handling message:", err.message, err.stack);
    }
  }, new NewMessage({ fromUsers: [TARGET_BOT_ID] }));

  log("👁️  [Userbot]", `Monitoring for messages from bot ${TARGET_BOT_ID}`);

  // Keep-alive: ping Telegram periodically to prevent TIMEOUT
  setInterval(async () => {
    try {
      if (client.connected) {
        await client.invoke(new (require("telegram/tl").Api.Ping)({ pingId: BigInt(Math.floor(Math.random() * 1e15)) }));
      } else {
        log("🔄 [Userbot]", "Reconnecting...");
        await client.connect();
        log("✅ [Userbot]", "Reconnected!");
      }
    } catch (err) {
      logError("⚠️  [Userbot]", "Keep-alive/reconnect error:", err.message);
      try {
        await client.connect();
        log("✅ [Userbot]", "Reconnected after keep-alive failure!");
      } catch (reconnectErr) {
        logError("❌ [Userbot]", "Reconnect failed:", reconnectErr.message);
      }
    }
  }, 60000); // ping every 60 seconds
}

// ─── Launch everything ────────────────────────────────────────────
async function main() {
  loadChatIds();

  bot.launch();
  log("🤖 [Boot]", "Telegraf bot is running...");
  log("📋 [Boot]", `ALLOWED_FORWARD_FROM: [${ALLOWED_FORWARD_FROM.join(", ")}]`);
  log("📋 [Boot]", `TARGET_BOT_ID: ${TARGET_BOT_ID}`);

  if (API_ID && API_HASH) {
    try {
      await startUserbot();
    } catch (err) {
      logError("❌ [Boot]", "Userbot failed to start:", err.message);
      log("⚠️  [Boot]", "Bot will still work for forwarded/pasted messages.");
    }
  } else {
    log("⚠️  [Boot]", "No API_ID/API_HASH in .env — userbot disabled.");
  }
}

main();

process.once("SIGINT", () => { bot.stop("SIGINT"); process.exit(0); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); process.exit(0); });

// Catch uncaught errors to prevent crashes
process.on("uncaughtException", (err) => {
  logError("⚠️  [CRASH]", "Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (err) => {
  logError("⚠️  [CRASH]", "Unhandled rejection:", err.message || err);
});
