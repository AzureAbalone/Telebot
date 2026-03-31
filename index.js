require("dotenv").config();
const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
const fs = require("fs");
const path = require("path");
const http = require("http");

const pino = require("pino");

// ─── Logger (Pino + custom compact output) ────────────────────────
const levelColors = { 30: "\x1b[32m", 40: "\x1b[33m", 50: "\x1b[31m", 60: "\x1b[35m" };
const levelNames = { 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
const R = "\x1b[0m", DIM = "\x1b[2m", BOLD = "\x1b[1m", ID_HL = "\x1b[1;97;44m";

function highlightIds(msg, fallbackColor) {
  return msg.replace(/-?\d{7,}/g, (id) => `${ID_HL} ${id} ${R}${fallbackColor}`);
}

const logger = pino({ level: "info" }, {
  write(str) {
    try {
      const o = JSON.parse(str);
      const d = new Date(o.time);
      const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
      const c = levelColors[o.level] || "";
      const n = levelNames[o.level] || "LOG";
      const msg = highlightIds(o.msg || "", c);
      process.stdout.write(`${DIM}${t}${R} ${c}${BOLD}${n}${R} ${o.tag || ""} ${c}${msg}${R}\n`);
    } catch { process.stdout.write(str); }
  },
});

function log(tag, ...args) {
  logger.info({ tag }, args.join(" "));
}

function logError(tag, ...args) {
  logger.error({ tag }, args.join(" "));
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
const ERROR_CHAT_ID = 5064866550;
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
    log("📄 [Config]", `Loaded ${ids.length} chat(s) from chat.txt:`, ids);
    return ids;
  } catch (err) {
    logError("❌ [Config]", "Error loading chat.txt:", err.message);
    return [];
  }
}


// ─── Helper: check if current VN time is in quiet period ─────────
function isQuietPeriod() {
  const now = new Date();
  const vnHour = (now.getUTCHours() + 7) % 24;
  const vnMinute = now.getUTCMinutes();
  const vnTime = vnHour * 60 + vnMinute;

  // VN day-of-week (0=Sun, 4=Thu)
  const vnOffset = 7 * 60 * 60 * 1000;
  const vnDay = new Date(now.getTime() + vnOffset).getUTCDay();

  // Thu & Sun: quiet 16:12 - 16:25 (MN ends earlier)
  if ((vnDay === 4 || vnDay === 0) && vnTime >= 16 * 60 + 12 && vnTime <= 16 * 60 + 25) return true;

  // Normal days: quiet 16:15 - 16:25
  if (vnTime >= 16 * 60 + 15 && vnTime <= 16 * 60 + 25) return true;
  // Quiet 17:15 - 17:25 (between MT and rest)
  if (vnTime >= 17 * 60 + 15 && vnTime <= 17 * 60 + 25) return true;
  // Quiet 18:15 - midnight (after rest period)
  if (vnTime >= 18 * 60 + 15) return true;

  return false;
}

// ─── Helper: check if message is valid (not just dots/empty) ─────
function isValidInputMessage(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ".") return true;
  }
  return false; // all dots
}

// ─── Helper: check if text is a pure bet (not mixed with conversation) ──
function isPureBet(text) {
  if (!text) return false;
  var lower = text.toLowerCase();

  // 1) Must have at least one digit (bets always contain numbers)
  if (!/\d/.test(lower)) return false;

  // 2) Must contain at least one bet keyword OR amount pattern like 912x40
  if (!/(xduoidao|xdaudao|xdaodau|xdaodui|xdaoduoi|xcdaoduoi|xcdaodui|xcdaodau|xcduoidao|xcdaudao|daoxcdui|daoxcdau|xcdao|xcduoi|xcdui|xcdau|duoidao|duidao|daudao|xdau|xduoi|xdui|daodui|daodau|daoduoi|b7lo|baylo|dao|dd|dđ|dat|dau|duoi|dui|dx|xc|xd|da|[234]d|[234](?:nn|mm|m[nrt])|đ(?:mnt|mn|mt|[aáàảãạ]|ài|[nt])|\dđ|\d\s*(?:đầu|đuôi|đuối)|lo|\db|\bb\d|\bb\b|\d+x\d)/i.test(lower)) return false;

  // 3) Reject if contains Vietnamese conversation words
  if (/(^|\s)(anh|chi|chị|em|oi|ơi|nhe|nhé|nha|ghi|cho|toi|tôi|minh|mình|ban|bạn|duoc|được|khong|không|hom|hôm|gui|gửi|them|thêm|sua|sửa|xoa|xóa|huy|hủy|hello|hi|chao|chào|thanks|ok|roi|rồi|vay|vậy|di|đi)(\s|$)/i.test(lower)) return false;

  return true;
}

// ─── Helper: escape HTML special chars ────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Helper: get VN time suffix for 2d/3d/4d keys ───────────────
// Normal:   MN 12:00-16:15 | quiet 16:15-16:25 | MT 16:25-17:15 | quiet 17:15-17:25 | rest 17:25-18:15 | quiet 18:15+
// Thu+Sun:  MN 12:00-16:12 | quiet 16:12-16:25 | MT 16:25-17:15 | same as above
function getTimeSuffix() {
  // VN time = UTC+7
  const now = new Date();
  const vnHour = (now.getUTCHours() + 7) % 24;
  const vnMinute = now.getUTCMinutes();
  const vnTime = vnHour * 60 + vnMinute; // total minutes since midnight

  // VN day-of-week (0=Sun, 4=Thu)
  const vnOffset = 7 * 60 * 60 * 1000;
  const vnDay = new Date(now.getTime() + vnOffset).getUTCDay();

  const mnStart = 12 * 60;                                        // 12:00
  const mnEnd = (vnDay === 4 || vnDay === 0) ? 16 * 60 + 12       // Thu+Sun: 16:12
    : 16 * 60 + 15;      // Normal:  16:15
  const mtStart = 16 * 60 + 25;  // 16:25
  const mtEnd = 17 * 60 + 15;    // 17:15

  if (vnTime >= mnStart && vnTime < mnEnd) return "mn";
  if (vnTime >= mtStart && vnTime < mtEnd) return "mt";
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

// ─── Helper: replace 'lo' with 'b', 'dx' with 'da', 'dat' with 'da' case-insensitive (no regex) ──
function replaceLoWithB(str) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (
      i + 1 < str.length &&
      (str[i] === "l" || str[i] === "L") &&
      (str[i + 1] === "o" || str[i + 1] === "O")
    ) {
      // Skip lo→b if it's part of 'b7lo' pattern
      if (i >= 2 && (str[i - 2] === "b" || str[i - 2] === "B") && str[i - 1] === "7") {
        result += str[i];
        i++;
      } else {
        result += "b";
        i += 2;
      }
    } else if (
      i + 1 < str.length &&
      (str[i] === "d" || str[i] === "D") &&
      (str[i + 1] === "x" || str[i + 1] === "X")
    ) {
      result += "da";
      i += 2;
    } else if (
      i + 2 < str.length &&
      (str[i] === "d" || str[i] === "D") &&
      (str[i + 1] === "a" || str[i + 1] === "A") &&
      (str[i + 2] === "t" || str[i + 2] === "T")
    ) {
      result += "da";
      i += 3;
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}

// ─── Helper: replace '; ' with '/' (no regex) ───────────────────
function replaceSemicolonSpace(str) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === ";" && i + 1 < str.length && str[i + 1] === " ") {
      result += "/";
      i += 2;
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}

// ─── Helper: classify line for custom sort order ────────────────
function getLineGroup(lineArr) {
  if (!lineArr || lineArr.length === 0) return 99;

  var hasB = false;
  var hasDd = false;
  var hasDuoi = false;
  var hasXc = false;
  var hasDau = false;
  var hasXcDau = false;
  var hasXcDuoi = false;
  var hasXdaudao = false;
  var hasXdaoDuoi = false;

  for (var i = 0; i < lineArr.length; i++) {
    var el = lineArr[i].toLowerCase();
    if (el === "b") hasB = true;
    if (el === "dd") hasDd = true;
    if (el === "duoi" || el === "dui") hasDuoi = true;
    if (el === "xc") hasXc = true;
    if (el === "dau") hasDau = true;
    if (el === "xcdau" || el === "xdau") hasXcDau = true;
    if (el === "xcduoi" || el === "xcdui") hasXcDuoi = true;
    if (el === "xdaudao") hasXdaudao = true;
    if (el === "xduoidao" || el === "xdaodui" || el === "xdaoduoi") hasXdaoDuoi = true;
  }

  // Group 1: contains 'b'
  if (hasB) return 1;

  // Group 2: contains 'dd'
  if (hasDd) return 2;

  // Group 3: contains 'dau' (standalone, no xc)
  if (hasDau && !hasXc) return 3;

  // Group 4: contains 'duoi'/'dui' but NOT 'xc'
  if (hasDuoi && !hasXc) return 4;

  // Group 5: xcdau / xdau / xdaudao / xc + dau
  if (hasXcDau) return 5;
  if (hasXdaudao) return 5;
  if (hasXc && hasDau) return 5;

  // Group 6: xcduoi / xcdui / xduoidao / xc + duoi / xc + dui
  if (hasXcDuoi) return 6;
  if (hasXdaoDuoi) return 6;
  if (hasXc && hasDuoi) return 6;

  // Group 7: only 'xc' (no duoi/dui/dau)
  if (hasXc) return 7;

  // Everything else
  return 99;
}

// ─── Helper: process message ─────────────────────────────────────
function processMessage(text) {
  // Replace 'baylo' → 'b7lo' BEFORE any parsing (so 'lo' in 'baylo' isn't parsed as bet keyword)
  text = text.replace(/\bbaylo\b/gi, "b7lo");

  // Step 1: Check for header and extract raw content after ALL headers
  if (!text.includes(HEADER_PATTERN)) return null;

  // Split by header pattern → collect content after every occurrence
  const parts = text.split(HEADER_PATTERN);
  const contentParts = [];
  for (let p = 1; p < parts.length; p++) { // skip parts[0] (text before first header)
    const part = parts[p].trim();
    if (part) contentParts.push(part);
  }
  let content = contentParts.join("\n");
  if (!content) return null;

  // Step 2: Remove extra backticks (no regex)
  content = removeBackticks(content).trim();
  if (!content) return null;

  // Step 3: Normalize newlines to commas, then separate by ','
  var normalized = "";
  for (var c = 0; c < content.length; c++) {
    if (content[c] === "\n" || content[c] === "\r") {
      normalized += ",";
    } else {
      normalized += content[c];
    }
  }
  const rawSegments = normalized.split(",");

  // Step 3b: Further split segments at 'n' boundaries (not 'tn')
  // e.g. "11 dd 360n 49 67 79 dd 10n" → ["11 dd 360n", "49 67 79 dd 10n"]
  // EXCEPTION: if a raw segment contains BOTH lo/b AND dd, do NOT split — keep as one line
  const segments = [];
  for (let rs = 0; rs < rawSegments.length; rs++) {
    const seg = rawSegments[rs].trim();
    if (!seg) continue;
    const words = seg.split(" ").filter(function (w) { return w !== ""; });

    // Check if this segment has both lo/b/b7lo AND dd → if so, skip n-splitting
    // Also skip if segment has both b AND b7lo (same bet entry)
    // Also skip if segment contains 'da' (the 'n' suffix is amount notation, not entry delimiter)
    var segHasLoOrB = false;
    var segHasB7lo = false;
    var segHasDd = false;
    var segHasDa = false;
    for (let chk = 0; chk < words.length; chk++) {
      var chkLower = words[chk].toLowerCase();
      if (chkLower === "lo" || chkLower === "b") segHasLoOrB = true;
      if (chkLower === "b7lo") { segHasB7lo = true; segHasLoOrB = true; }
      if (chkLower === "dd") segHasDd = true;
      if (/\b(da|dx|dat)\b/i.test(chkLower) || /\d(da|dx|dat)/i.test(chkLower)) segHasDa = true;
    }

    if ((segHasLoOrB && segHasDd) || (segHasLoOrB && segHasB7lo) || segHasDa) {
      // Don't split at n boundaries — keep entire segment as one line
      segments.push(words.join(" "));
      continue;
    }

    var current = [];
    for (let w = 0; w < words.length; w++) {
      current.push(words[w]);
      var lower = words[w].toLowerCase();
      // If word ends in 'n', isn't exactly 'tn', and contains a digit → this ends the current entry
      // e.g. "8n", "360n", "0.5n" split — but "dn", "qn" do NOT split
      var hasDigit = false;
      for (var di = 0; di < lower.length; di++) {
        if (lower[di] >= "0" && lower[di] <= "9") { hasDigit = true; break; }
      }
      if (lower.length > 0 && lower[lower.length - 1] === "n" && lower !== "tn" && hasDigit) {
        segments.push(current.join(" "));
        current = [];
      }
    }
    // Any remaining words that didn't end with 'n'
    if (current.length > 0) {
      segments.push(current.join(" "));
    }
  }

  // Step 4: For each instance, split by ' ' → first item is key, rest are values
  const grouped = {};
  const keyOrder = []; // Track insertion order (Object.keys reorders numeric keys!)

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s].trim();
    if (!segment) continue;

    const parts = segment.split(" ").filter(function (p) { return p !== ""; });
    if (parts.length === 0) continue;

    const rawKey = parts[0];
    const values = parts.slice(1);

    let transformedKey = replaceLoWithB(rawKey);

    // Time-based resolution: 'dn' → 'dnang' (MT time) or 'dnai' (MN time)
    if (transformedKey.toLowerCase() === "dn") {
      const timeSuffix = getTimeSuffix();
      if (timeSuffix === "mt") {
        transformedKey = "dnang";
      } else if (timeSuffix === "mn") {
        transformedKey = "dnai";
      }
    }

    const transformedValues = [];
    for (let v = 0; v < values.length; v++) {
      let tv = replaceLoWithB(values[v]);
      // Time-based resolution: 'dn' → 'dnang' (MT time) or 'dnai' (MN time)
      if (tv.toLowerCase() === "dn") {
        const timeSuffix = getTimeSuffix();
        if (timeSuffix === "mt") {
          tv = "dnang";
        } else if (timeSuffix === "mn") {
          tv = "dnai";
        }
      }
      transformedValues.push(tv);
    }

    // Special rule: if key is "ag" and first value is "tn", combine into "2d"
    if (transformedKey === "ag" && transformedValues.length > 0 && transformedValues[0] === "tn") {
      transformedKey = "2d";
      transformedValues.shift();
    }

    // Apply time-based suffix to 2d/3d/4d keys
    const finalKey = applyKeySuffix(transformedKey);

    // Accumulate into grouped object: { key: [[val1, val2], [val3, val4], ...] }
    if (!grouped[finalKey]) {
      grouped[finalKey] = [];
      keyOrder.push(finalKey); // Only push on first occurrence to preserve original order
    }
    if (transformedValues.length > 0) {
      grouped[finalKey].push(transformedValues);
    }
  }

  // Step 5: Use keyOrder to preserve original insertion order
  const sortedKeys = keyOrder;

  if (sortedKeys.length === 0) return null;

  // Step 6+7: Build result — each sub-array becomes its own line: "key val1 val2"
  let result = "";
  for (let k = 0; k < sortedKeys.length; k++) {
    const key = sortedKeys[k];
    const subArrays = grouped[key];
    for (let s = 0; s < subArrays.length; s++) {
      let line = key;
      for (let v = 0; v < subArrays[s].length; v++) {
        line += " " + subArrays[s][v];
      }
      if (result.length > 0) {
        result += "\n";
      }
      result += line;
    }
  }

  // Step 8: Replace '; ' with '/'
  result = replaceSemicolonSpace(result);

  // Step 9: Split result by newline
  const lines = result.split("\n");

  // Step 10: Split each line by space → nested array
  const nested = [];
  for (let li = 0; li < lines.length; li++) {
    const trimmed = lines[li].trim();
    if (!trimmed) continue;
    const lineParts = trimmed.split(" ").filter(function (p) { return p !== ""; });
    if (lineParts.length > 0) {
      nested.push(lineParts);
    }
  }

  // Step 11: Sort by custom group order, preserving relative order within groups
  const GROUP_ORDER = [1, 2, 3, 4, 5, 6, 7, 99];
  const lineGroups = {};
  for (let ni = 0; ni < nested.length; ni++) {
    const g = getLineGroup(nested[ni]);
    if (!lineGroups[g]) lineGroups[g] = [];
    lineGroups[g].push(nested[ni]);
  }

  const resultParts = [];
  for (let gi = 0; gi < GROUP_ORDER.length; gi++) {
    const gid = GROUP_ORDER[gi];
    if (lineGroups[gid] && lineGroups[gid].length > 0) {
      const groupLines = [];
      for (let gj = 0; gj < lineGroups[gid].length; gj++) {
        groupLines.push(lineGroups[gid][gj].join(" "));
      }
      resultParts.push(groupLines.join("\n"));
    }
  }

  result = resultParts.join("\n\n");

  return result;
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
    const senderId = msg.from?.id;
    const hasHeader = text.includes(HEADER_PATTERN);
    log("📩 [Bot/Group]", `Message from ${who} in ${where} | has_header: ${hasHeader} | preview: ${preview(text)}`);

    // Only process messages from the target bot
    if (senderId !== TARGET_BOT_ID) {
      return;
    }

    const result = processMessage(text);
    if (result) {
      const html = `<pre>${escapeHtml(result)}</pre>`;
      ctx.reply(html, { parse_mode: "HTML" });
      log("📤 [Bot/Group]", `Replied to msg ${msg.message_id} in ${where} | triggered by: ${who} | result: ${preview(result)}`);
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

  // Store client reference globally for crash notification system
  _userbotClient = client;

  // Listen for new messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.text) return;

      const senderId = message.senderId?.toString();
      const chatId = message.chatId || message.peerId;

      if (senderId !== TARGET_BOT_ID.toString()) return;

      // Detect "Cú pháp không hợp lệ" error from bot → notify ERROR_CHAT_ID
      if (message.text.includes("Cú pháp không hợp lệ")) {
        log("⚠️  [Userbot]", `Bot reported invalid syntax in chat ${chatId}`);
        try {
          await bot.telegram.sendMessage(ERROR_CHAT_ID, "⚠️ Bot báo lỗi cú pháp:\n\n" + message.text);
        } catch (notifyErr) {
          logError("❌ [Userbot]", "Failed to notify ERROR_CHAT_ID about syntax error:", notifyErr.message);
        }
        return;
      }

      // Only care about messages with the header
      if (!message.text.includes(HEADER_PATTERN)) return;

      log("📩 [Userbot]", `Header message detected from bot ${TARGET_BOT_ID} in chat ${chatId} | preview: ${preview(message.text)}`);

      let result = processMessage(message.text);
      if (!result) return;

      // Replace 'th' → 'hue' (Thừa Thiên Huế shorthand)
      result = result.replace(/\bth\b/gi, "hue");

      log("⚙️  [Userbot]", `Processed result: ${preview(result)}`);

      // Only reply in allowed chats from chat.txt
      const allowedChats = loadChatIds();
      const botChatId = Number(chatId); // Convert BigInt from GramJS to Number for Bot API
      if (!allowedChats.includes(chatId.toString()) && !allowedChats.includes(botChatId.toString())) {
        log("⛔ [Userbot]", `REJECTED — chat ${chatId} (botId: ${botChatId}) not in chat.txt (allowed: [${allowedChats.join(", ")}])`);
        return;
      }
      try {
        const html = `<pre>${escapeHtml(result)}</pre>`;
        await bot.telegram.sendMessage(botChatId, html, { parse_mode: "HTML" });
        log("📤 [Bot via Userbot]", `✅ Replied to msg ${message.id} in chat ${botChatId} | result: ${preview(result)}`);
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

  // ─── 409 Conflict Prevention ─────────────────────────────────────
  // Every 15 min, delete any stale webhook to prevent 409 conflicts
  // that occur when Render spins up a new instance while an old one lingers.
  setInterval(async () => {
    try {
      await bot.telegram.callApi("deleteWebhook", { drop_pending_updates: false });
      log("🔄 [Keep-Alive]", "Cleared webhook (409 prevention)");
    } catch (err) {
      logError("⚠️  [Keep-Alive]", "Failed to clear webhook:", err.message || err);
    }
  }, 15 * 60 * 1000); // every 15 minutes
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

// ─── Crash Notification System ───────────────────────────────────
// Global reference to the GramJS client so crash handlers can send urgent messages
let _userbotClient = null;

/**
 * Send urgent crash notification to ERROR_CHAT_ID before the process dies.
 * Tries userbot (GramJS) first — more reliable during crashes.
 * Falls back to Telegraf bot API if userbot is unavailable.
 * Waits up to 3 seconds for the message to be delivered.
 */
async function sendCrashNotification(reason, error) {
  const timestamp = new Date().toISOString();
  const errorMsg = error instanceof Error
    ? `${error.message}\n\n${error.stack || ""}`
    : String(error || "Unknown error");

  const urgentMessage =
    `🚨🚨🚨 BOT CRASH — URGENT 🚨🚨🚨\n\n` +
    `⏰ Time: ${timestamp}\n` +
    `💀 Reason: ${reason}\n` +
    `📛 Error: ${errorMsg}\n\n` +
    `⚠️ Bot is shutting down NOW. Auto-restart should kick in.`;

  const promises = [];

  // Try 1: Send via userbot (GramJS) — works even when Telegraf is dead
  if (_userbotClient && _userbotClient.connected) {
    promises.push(
      _userbotClient.sendMessage(ERROR_CHAT_ID.toString(), { message: urgentMessage })
        .then(() => log("🚨 [Crash]", "Urgent message sent via userbot"))
        .catch((e) => logError("❌ [Crash]", "Userbot send failed:", e.message))
    );
  }

  // Try 2: Send via Telegraf bot API — backup
  promises.push(
    bot.telegram.sendMessage(ERROR_CHAT_ID, urgentMessage)
      .then(() => log("🚨 [Crash]", "Urgent message sent via Telegraf"))
      .catch((e) => logError("❌ [Crash]", "Telegraf send failed:", e.message))
  );

  // Wait up to 3 seconds for at least one message to go through
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (_) {
    // Best effort — don't let notification failure prevent exit
  }
}

process.once("SIGINT", async () => {
  log("⚠️  [SHUTDOWN]", "Received SIGINT — graceful shutdown (no crash notification)");
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", async () => {
  log("⚠️  [SHUTDOWN]", "Received SIGTERM — graceful shutdown (no crash notification)");
  bot.stop("SIGTERM");
  process.exit(0);
});

// Catch uncaught errors, send urgent notification, then exit so Render/Docker can auto-restart.
process.on("uncaughtException", async (err) => {
  logError("🚨 [CRASH]", "Uncaught exception:", err.message, err.stack);
  await sendCrashNotification("Uncaught Exception", err);
  process.exit(1);
});

process.on("unhandledRejection", async (err) => {
  logError("🚨 [CRASH]", "Unhandled rejection:", err?.message || err);
  await sendCrashNotification("Unhandled Promise Rejection", err);
  process.exit(1);
});
