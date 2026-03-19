require("dotenv").config();
const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ─── Config ───────────────────────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

const TARGET_BOT_ID = 6218688053;
const HEADER_PATTERN = "📌 Tin vượt chuẩn trả lại những số sau:";
const ALLOWED_FORWARD_FROM = [5646104183, 5064866550];

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

server.listen(PORT, () => {
  console.log(`🌐 Health server on port ${PORT}`);
});

// ─── Load chat IDs from chat.txt ──────────────────────────────────
function loadChatIds() {
  try {
    if (!fs.existsSync(CHAT_FILE)) {
      fs.writeFileSync(CHAT_FILE, "# Add chat IDs here, one per line\n# Example: -5157920720\n");
      console.log("📄 Created chat.txt — add your group chat IDs there.");
      return [];
    }
    const content = fs.readFileSync(CHAT_FILE, "utf-8");
    const ids = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    console.log(`📄 Loaded ${ids.length} chat(s) from chat.txt:`, ids);
    return ids;
  } catch (err) {
    console.error("❌ Error loading chat.txt:", err.message);
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

  // Step 3: Separate by ','
  const segments = content.split(",");

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
    const transformedKey = replaceLoWithB(rawKey);

    // Apply time-based suffix to 2d/3d/4d keys
    const finalKey = applyKeySuffix(transformedKey);

    // Replace 'lo' with 'b' in each value
    const transformedValues = [];
    for (let v = 0; v < values.length; v++) {
      transformedValues.push(replaceLoWithB(values[v]));
    }

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
async function sendToAllChats(result) {
  const chatIds = loadChatIds();
  if (chatIds.length === 0) {
    console.log("⚠️  No chats in chat.txt to send to.");
    return;
  }

  for (const chatId of chatIds) {
    try {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      await bot.telegram.sendMessage(chatId, html, { parse_mode: "HTML" });
      console.log(`📤 Sent to chat ${chatId}`);
    } catch (err) {
      console.error(`❌ Failed to send to ${chatId}:`, err.message);
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

  // ── Private / DM ──
  if (chatType === "private") {
    const senderId = msg.from?.id;
    const forwardFrom =
      msg.forward_origin?.type === "user" ? msg.forward_origin.sender_user?.id :
        msg.forward_from?.id ?? null;

    const isAllowed =
      ALLOWED_FORWARD_FROM.includes(senderId) ||
      (forwardFrom && ALLOWED_FORWARD_FROM.includes(forwardFrom));

    if (!isAllowed) {
      console.log(`⛔ [Bot/DM] Rejected message from unauthorized user ${senderId} (forward: ${forwardFrom})`);
      return;
    }

    // For DMs: try with header first, then treat as raw data
    const result = processMessage(text);
    if (result) {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      ctx.reply(html, { parse_mode: "HTML" });
      console.log("📤 [Bot/DM] From", senderId, "→", result);
    }
    return;
  }

  // ── Groups / Supergroups ──
  if (chatType === "group" || chatType === "supergroup") {
    const result = processMessage(text);
    if (result) {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      ctx.reply(html, { parse_mode: "HTML" });
      console.log("📤 [Bot/Group] Sent modified message:", result);
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

  console.log("🔑 Logging in to Telegram user account...");
  await client.start({
    phoneNumber: async () => await input.text("📱 Enter your phone number: "),
    password: async () => await input.text("🔒 Enter 2FA password (if any): "),
    phoneCode: async () => await input.text("📟 Enter the code you received: "),
    onError: (err) => console.error("❌ Login error:", err),
  });

  const savedSession = client.session.save();
  console.log("\n✅ Logged in successfully!");
  console.log(`SESSION_STRING=${savedSession}\n`);

  // Listen for new messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.text) return;

      const senderId = message.senderId?.toString();
      if (senderId !== TARGET_BOT_ID.toString()) return;

      // Only care about messages with the header
      if (!message.text.includes(HEADER_PATTERN)) return;

      console.log(`📩 [Userbot] Detected header message, processing...`);

      const result = processMessage(message.text);
      if (!result) return;

      // Only reply in allowed chats from chat.txt
      const chatId = message.chatId || message.peerId;
      const allowedChats = loadChatIds();
      if (!allowedChats.includes(chatId.toString())) {
        console.log(`⛔ [Userbot] Rejected — chat ${chatId} not in chat.txt`);
        return;
      }
      try {
        await bot.telegram.sendMessage(chatId.toString(), `<pre>${escapeHtml(result)}</pre>`, { parse_mode: "HTML" });
        console.log(`📤 [Userbot] Replied in chat ${chatId}`);
      } catch (e) {
        console.error(`❌ [Userbot] Failed to reply in chat ${chatId}:`, e.message);
      }
    } catch (err) {
      console.error("❌ [Userbot] Error handling message:", err.message);
    }
  }, new NewMessage({ fromUsers: [TARGET_BOT_ID] }));

  console.log("👁️  Userbot is monitoring for messages from bot", TARGET_BOT_ID);

  // Keep-alive: ping Telegram periodically to prevent TIMEOUT
  setInterval(async () => {
    try {
      if (client.connected) {
        await client.invoke(new (require("telegram/tl").Api.Ping)({ pingId: BigInt(Math.floor(Math.random() * 1e15)) }));
      } else {
        console.log("🔄 Reconnecting userbot...");
        await client.connect();
        console.log("✅ Reconnected!");
      }
    } catch (err) {
      console.error("⚠️  Keep-alive/reconnect error:", err.message);
      try {
        await client.connect();
        console.log("✅ Reconnected after keep-alive failure!");
      } catch (reconnectErr) {
        console.error("❌ Reconnect failed:", reconnectErr.message);
      }
    }
  }, 60000); // ping every 60 seconds
}

// ─── Launch everything ────────────────────────────────────────────
async function main() {
  loadChatIds();

  bot.launch();
  console.log("🤖 Telegraf bot is running...");

  if (API_ID && API_HASH) {
    try {
      await startUserbot();
    } catch (err) {
      console.error("❌ Userbot failed to start:", err.message);
      console.log("⚠️  Bot will still work for forwarded/pasted messages.");
    }
  } else {
    console.log("⚠️  No API_ID/API_HASH in .env — userbot disabled.");
  }
}

main();

process.once("SIGINT", () => { bot.stop("SIGINT"); process.exit(0); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); process.exit(0); });

// Catch uncaught errors to prevent crashes
process.on("uncaughtException", (err) => {
  console.error("⚠️  Uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("⚠️  Unhandled rejection:", err.message || err);
});
