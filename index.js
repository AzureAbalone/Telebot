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
const INPUT_FILE = path.join(__dirname, "input.json");
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

// ─── Load input.json groups ──────────────────────────────────────
function loadInputGroups() {
  try {
    if (!fs.existsSync(INPUT_FILE)) {
      log("📄 [Config]", "input.json not found — input group listener disabled.");
      return {};
    }
    const content = fs.readFileSync(INPUT_FILE, "utf-8");
    const groups = JSON.parse(content);
    const count = Object.keys(groups).length;
    log("📄 [Config]", `Loaded ${count} input group(s) from input.json`);
    return groups;
  } catch (err) {
    logError("❌ [Config]", "Error loading input.json:", err.message);
    return {};
  }
}

// ─── Helper: check if current VN time is in quiet period ─────────
function isQuietPeriod() {
  const now = new Date();
  const vnHour = (now.getUTCHours() + 7) % 24;
  const vnMinute = now.getUTCMinutes();
  const vnTime = vnHour * 60 + vnMinute;

  // 16:15 - 16:20
  if (vnTime >= 16 * 60 + 15 && vnTime <= 16 * 60 + 20) return true;
  // 17:15 - 17:25
  if (vnTime >= 17 * 60 + 15 && vnTime <= 17 * 60 + 25) return true;
  // 18:15 - midnight
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

  // 2) Must contain at least one bet keyword (including Vietnamese đ variants)
  if (!/(dau|duoi|dui|dao|dd|xc|xd|da|đ[aáàảãạ]|đài|\dđ|lo|\db|\bb\d)/i.test(lower)) return false;

  // 3) Reject if contains Vietnamese conversation words
  if (/(^|\s)(anh|chi|chị|em|oi|ơi|nhe|nhé|nha|ghi|cho|toi|tôi|minh|mình|ban|bạn|duoc|được|khong|không|hom|hôm|gui|gửi|them|thêm|sua|sửa|xoa|xóa|huy|hủy|hello|hi|chao|chào|thanks|ok|roi|rồi|vay|vậy|di|đi)(\s|$)/i.test(lower)) return false;

  return true;
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
  const mtStart = 16 * 60 + 35;  // 16:35
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

// ─── Helper: format input group message for chat.txt bot ────────
function formatInputMessage(text) {
  var lines = text.split("\n");
  var formattedLines = [];
  var wasFormatted = false;
  var errors = [];

  for (var l = 0; l < lines.length; l++) {
    var formatted = lines[l];
    var prev;

    // Rule: 'dat' → 'da'
    prev = formatted;
    formatted = formatted.replace(/\bdat\b/gi, "da");
    if (formatted !== prev) wasFormatted = true;

    // Rule: 'dau duoi' → 'dd'
    prev = formatted;
    formatted = formatted.replace(/dau\s+duoi/gi, "dd");
    if (formatted !== prev) wasFormatted = true;

    // Rule: Province abbreviations
    // 1) Specific common full-name provinces
    prev = formatted;
    formatted = formatted.replace(/\b(ha\s*noi|hanoi|hnoi)\b/gi, "hn");
    formatted = formatted.replace(/\b(hai\s*phong|hphong)\b/gi, "hp");
    formatted = formatted.replace(/\b(ho\s*chi\s*minh|hcm)\b/gi, "hcm");
    formatted = formatted.replace(/\b(da\s*nang|dnang)\b/gi, "dnang");
    formatted = formatted.replace(/\b(kon\s*tum|kontum)\b/gi, "kt");
    formatted = formatted.replace(/\b(khanh\s*hoa|khanhhoa)\b/gi, "kh");
    formatted = formatted.replace(/\b(binh\s*duong|bduong)\b/gi, "bd");
    formatted = formatted.replace(/\b(binh\s*dinh|bdinh)\b/gi, "bdi");
    formatted = formatted.replace(/\b(binh\s*phuoc|bphuoc)\b/gi, "bp");
    formatted = formatted.replace(/\b(binh\s*thuan|bthuan)\b/gi, "bth");
    formatted = formatted.replace(/\b(quang\s*ngai|qngai)\b/gi, "qngai");
    formatted = formatted.replace(/\b(quang\s*nam|qnam)\b/gi, "qna");
    formatted = formatted.replace(/\b(quang\s*binh|qbinh)\b/gi, "qb");
    formatted = formatted.replace(/\b(quang\s*tri|qtri)\b/gi, "qt");
    if (formatted !== prev) wasFormatted = true;

    // 2) Đ/đ + dot/space + word → d + first letter (e.g. Đ nẵng→dn, đ.nẵng→dn)
    prev = formatted;
    formatted = formatted.replace(/[đĐ][.\s]\s?([a-zA-Z])\S*/g, function (match, p1) {
      return ("d" + p1).toLowerCase();
    });
    if (formatted !== prev) wasFormatted = true;

    // 3) ASCII letter + dot + word → first two letters (e.g. h.noi→hn, t.pho→tp)
    prev = formatted;
    formatted = formatted.replace(/\b([a-zA-Z])\.\s?([a-zA-Z])\S*/gi, function (match, p1, p2) {
      return (p1 + p2).toLowerCase();
    });
    if (formatted !== prev) wasFormatted = true;

    // 4) Single letter + space + word → first two letters (e.g. k tum→kt, k hoa→kh, h noi→hn)
    prev = formatted;
    formatted = formatted.replace(/\b([a-zA-Z])\s+([a-zA-Z])\S*/gi, function (match, p1, p2) {
      // Only match if first part is a single letter (not a known keyword)
      if (/^(b|dd|da|lo|xc)$/i.test(p1)) return match; // skip bet keywords
      return (p1 + p2).toLowerCase();
    });
    if (formatted !== prev) wasFormatted = true;

    // Rule: 2d/3d/4d suffix stripping (with or without space)
    // Handles: 2dn, 2dt, 2dmn, 2dmt, 2dmnt, 2d n, 2d t, 2mn, 2mt → 2d (same for 3d, 4d)
    prev = formatted;
    formatted = formatted.replace(/\b2d\s*(mnt|mn|mt|[nt])\b/gi, "2d");
    formatted = formatted.replace(/\b3d\s*(mnt|mn|mt|[nt])\b/gi, "3d");
    formatted = formatted.replace(/\b4d\s*(mnt|mn|mt|[nt])\b/gi, "4d");
    formatted = formatted.replace(/\b2m[nt]\b/gi, "2d");
    formatted = formatted.replace(/\b3m[nt]\b/gi, "3d");
    formatted = formatted.replace(/\b4mn\b/gi, "4d");
    if (formatted !== prev) wasFormatted = true;

    // Rule: Split 4+ consecutive digits with 'da' suffix
    // e.g. "8998da0,5" → "89 98 da 0,5"
    prev = formatted;
    formatted = formatted.replace(/(\d{4,})(da)([\d,]+)/gi, function (match, digits, da, value) {
      if (digits.length % 2 !== 0) {
        errors.push("Odd digit count in \"" + match + "\"");
        return match;
      }
      var pairs = [];
      for (var i = 0; i < digits.length; i += 2) {
        pairs.push(digits.substr(i, 2));
      }
      return pairs.join(" ") + " da " + value;
    });
    if (formatted !== prev) wasFormatted = true;

    // Rule: Split remaining 4+ consecutive digits into pairs (ONLY when line contains 'da')
    // e.g. "5191 da 10" → "51 91 da 10", but "5191 b 10" stays as-is
    if (/\bda\b/i.test(formatted)) {
      prev = formatted;
      formatted = formatted.replace(/\d{4,}/g, function (match) {
        if (match.length % 2 !== 0) {
          errors.push("Odd digit count: \"" + match + "\"");
          return match;
        }
        var pairs = [];
        for (var i = 0; i < match.length; i += 2) {
          pairs.push(match.substr(i, 2));
        }
        return pairs.join(" ");
      });
      if (formatted !== prev) wasFormatted = true;
    }

    // Rule: '/' → ';'
    prev = formatted;
    formatted = formatted.replace(/\//g, ";");
    if (formatted !== prev) wasFormatted = true;

    formattedLines.push(formatted);
  }

  return { formatted: formattedLines.join("\n"), wasFormatted: wasFormatted, errors: errors };
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

    // Check if this segment has both lo/b AND dd → if so, skip n-splitting
    var segHasLoOrB = false;
    var segHasDd = false;
    for (let chk = 0; chk < words.length; chk++) {
      var chkLower = words[chk].toLowerCase();
      if (chkLower === "lo" || chkLower === "b") segHasLoOrB = true;
      if (chkLower === "dd") segHasDd = true;
    }

    if (segHasLoOrB && segHasDd) {
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

    // Rename short keys: dn → dnang, qn → qngai
    if (transformedKey === "dn") transformedKey = "dnang";
    if (transformedKey === "qn") transformedKey = "qngai";

    const transformedValues = [];
    for (let v = 0; v < values.length; v++) {
      let tv = replaceLoWithB(values[v]);
      if (tv === "dn") tv = "dnang";
      if (tv === "qn") tv = "qngai";
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

      const result = processMessage(message.text);
      if (!result) return;

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

  // ─── Input Group Listener (standalone) ────────────────────────────
  const inputGroups = loadInputGroups();
  const inputGroupIds = []; // normalized IDs from input.json
  const messageCounters = {}; // per-group counters

  for (const name in inputGroups) {
    const id = inputGroups[name].ID;
    if (id) {
      inputGroupIds.push(id.toString());
      messageCounters[id.toString()] = 0;
      const label = inputGroups[name].name || name;
      log("👁️  [InputListener]", `Monitoring input group "${label}" (ID: ${id})`);
    }
  }

  // Get the userbot's own ID
  const me = await client.getMe();
  const userbotSelfId = me.id.toString();
  log("👁️  [Userbot]", `Userbot self ID: ${userbotSelfId}`);

  if (inputGroupIds.length > 0) {
    // Get bot's own ID to ignore its replies (prevent loops)
    const botInfo = await bot.telegram.getMe();
    const botSelfId = botInfo.id;
    log("👁️  [InputListener]", `Bot self ID: ${botSelfId} — will ignore own messages`);

    // Resolve only the specific groups we need (no bulk dialog fetch)
    const { Api } = require("telegram/tl");

    // Helper: resolve a Telegram entity from a raw ID string (handles channels, groups, users/bots)
    async function resolveEntity(rawId) {
      const idStr = rawId.toString();
      if (idStr.startsWith("-100")) {
        // Supergroup / Channel
        const channelId = BigInt(idStr.slice(4)); // remove "-100"
        return await client.getEntity(new Api.PeerChannel({ channelId }));
      } else if (idStr.startsWith("-")) {
        // Legacy group chat (negative, no -100 prefix)
        const chatId = BigInt(idStr.slice(1)); // remove "-"
        return await client.getEntity(new Api.PeerChat({ chatId }));
      } else {
        // User / Bot (positive ID)
        const userId = BigInt(idStr);
        return await client.getEntity(new Api.PeerUser({ userId }));
      }
    }

    // Pre-resolve input.json group entities (for fromPeer when forwarding)
    const resolvedInputGroups = {};
    for (let i = 0; i < inputGroupIds.length; i++) {
      try {
        const entity = await resolveEntity(inputGroupIds[i]);
        resolvedInputGroups[inputGroupIds[i]] = entity;
        log("✅ [InputListener]", `Resolved input group entity: ${inputGroupIds[i]}`);
      } catch (e) {
        logError("❌ [InputListener]", `Failed to resolve input group ${inputGroupIds[i]}:`, e.message);
      }
    }

    // Pre-resolve chat.txt entities (for target when forwarding)
    const resolvedTargetChats = {};
    const chatIds = loadChatIds();
    for (let t = 0; t < chatIds.length; t++) {
      try {
        const entity = await resolveEntity(chatIds[t]);
        resolvedTargetChats[chatIds[t]] = entity;
        log("✅ [InputListener]", `Resolved chat.txt entity: ${chatIds[t]}`);
      } catch (e) {
        logError("❌ [InputListener]", `Failed to resolve chat ${chatIds[t]}:`, e.message);
      }
    }

    // === Forward Queue — process messages one at a time ===
    const forwardQueue = [];
    let isProcessingQueue = false;

    async function processForwardQueue() {
      if (isProcessingQueue) return;
      isProcessingQueue = true;
      while (forwardQueue.length > 0) {
        const task = forwardQueue.shift();
        try {
          await task();
        } catch (e) {
          logError("❌ [Queue]", "Error processing queued task:", e.message);
        }
      }
      isProcessingQueue = false;
    }

    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || !message.text) return;

        const chatId = (message.chatId || message.peerId).toString();
        const senderId = message.senderId?.toString();

        // Ignore messages from the bot itself (counter replies)
        if (senderId === botSelfId.toString()) return;

        // Ignore outgoing messages from userbot itself (except in no-ignore groups)
        const NO_IGNORE_USERBOT_GROUPS = ["-1003724203074"];
        if (message.out || senderId === userbotSelfId) {
          let skipIgnore = false;
          for (let i = 0; i < NO_IGNORE_USERBOT_GROUPS.length; i++) {
            const gid = NO_IGNORE_USERBOT_GROUPS[i];
            if (chatId === gid || "-100" + chatId === gid || chatId === gid.replace(/^-100/, "")) {
              skipIgnore = true;
              break;
            }
          }
          if (!skipIgnore) return;
        }

        // Check if this message is from an input.json group
        let matchedGroupId = null;
        for (let i = 0; i < inputGroupIds.length; i++) {
          const gid = inputGroupIds[i];
          // input.json has "-100xxxx", GramJS might give "xxxx" without -100
          if (chatId === gid || "-100" + chatId === gid || chatId === gid.replace(/^-100/, "")) {
            matchedGroupId = gid;
            break;
          }
        }

        if (!matchedGroupId) return;

        // Check quiet period
        if (isQuietPeriod()) {
          log("🔇 [InputListener]", `Quiet period — skipping message in group ${matchedGroupId}`);
          return;
        }

        // Check if message is valid (not just dots)
        if (!isValidInputMessage(message.text)) {
          log("⏭️  [InputListener]", `Invalid message (dots only) in group ${matchedGroupId} — skipped`);
          return;
        }

        // Increment counter
        messageCounters[matchedGroupId]++;
        const counter = messageCounters[matchedGroupId];

        // Resolve sender name (first + last)
        let senderName = "unknown";
        if (message.senderId) {
          try {
            const senderEntity = await client.getEntity(message.senderId);
            const first = senderEntity.firstName || "";
            const last = senderEntity.lastName || "";
            senderName = (first + " " + last).trim() || "unknown";
          } catch (e) {
            logError("⚠️  [InputListener]", `Could not resolve sender ${senderId}: ${e.message}`);
            try { await bot.telegram.sendMessage(ERROR_CHAT_ID, "⚠️ Could not resolve sender " + senderId + ": " + e.message); } catch (_) { }
          }
        }

        // Get group name from input.json
        let groupName = matchedGroupId;
        for (const key in inputGroups) {
          if (inputGroups[key].ID === matchedGroupId) {
            groupName = inputGroups[key].name || matchedGroupId;
            break;
          }
        }

        log("📩 [InputListener]", `Valid message #${counter} from ${senderName} in "${groupName}" (${matchedGroupId}) | preview: ${preview(message.text)}`);

        const botChatId = Number(matchedGroupId);

        // Format the message for chat.txt bot
        const { formatted, wasFormatted, errors } = formatInputMessage(message.text);

        // Only reply with counter if message is a pure bet (no conversation mixed in)
        if (!isPureBet(message.text)) {
          log("⏭️  [InputListener]", `Message #${counter} in "${groupName}" is not a pure bet — skipping reply & forward | original: ${preview(message.text)} | formatted: ${preview(formatted)}`);
          messageCounters[matchedGroupId]--; // revert counter since it's not a valid bet
          return;
        }

        // Bot replies with counter to the original message in the same input group
        try {
          await bot.telegram.sendMessage(botChatId, `${counter}`);
          log("📤 [InputListener]", `Bot replied "${counter}" to msg ${message.id} in group ${matchedGroupId}`);
        } catch (e) {
          logError("❌ [InputListener]", `Failed to reply counter in group ${matchedGroupId}:`, e.message);
          try { await bot.telegram.sendMessage(ERROR_CHAT_ID, "❌ Failed to reply counter in group " + matchedGroupId + ": " + e.message); } catch (_) { }
        }

        // Log format errors to error chat
        if (errors.length > 0) {
          try {
            const errorMsg = "⚠️ Format errors in \"" + groupName + "\" from " + senderName + ":\n" +
              errors.map(function (e) { return "• " + e; }).join("\n") +
              "\n\nOriginal:\n" + message.text;
            await bot.telegram.sendMessage(ERROR_CHAT_ID, errorMsg);
            logError("⚠️  [InputListener]", `Format errors sent to error chat: ${errors.join(", ")}`);
          } catch (e) {
            logError("❌ [InputListener]", `Failed to send error to ${ERROR_CHAT_ID}: ${e.message}`);
          }
        }

        // Resolve entities for send/forward
        const fromEntity = resolvedInputGroups[matchedGroupId];
        if (!fromEntity) {
          logError("❌ [InputListener]", `No resolved entity for source group ${matchedGroupId} — cannot forward/send`);
          try { await bot.telegram.sendMessage(ERROR_CHAT_ID, "❌ No resolved entity for group " + matchedGroupId + " — cannot forward/send"); } catch (_) { }
          return;
        }

        const msgId = message.id;

        // Decide: forward directly if no reformatting needed, else send formatted text
        const fullMessage = formatted;

        forwardQueue.push(async () => {
          if (wasFormatted) {
            // Message was reformatted → send the formatted text + extra info message
            log("📬 [Queue]", `Processing formatted send for message #${counter} (queue size: ${forwardQueue.length})`);
            const infoMessage = senderName + " - " + groupName;
            const chatKeys = Object.keys(resolvedTargetChats);
            for (let ci = 0; ci < chatKeys.length; ci++) {
              const chatKey = chatKeys[ci];
              try {
                await client.sendMessage(resolvedTargetChats[chatKey], { message: fullMessage });
                log("📤 [InputListener]", `Userbot sent formatted message #${counter} to chat ${chatKey}`);
                // Send extra message with sender name + group name
                await client.sendMessage(resolvedTargetChats[chatKey], { message: infoMessage });
                log("📤 [InputListener]", `Userbot sent info "${infoMessage}" to chat ${chatKey}`);
              } catch (e) {
                logError("❌ [InputListener]", `Failed to send to chat ${chatKey}: ${e.message}`);
                try { await bot.telegram.sendMessage(ERROR_CHAT_ID, "❌ Failed to send formatted msg #" + counter + " to chat " + chatKey + ": " + e.message); } catch (_) { }
              }
              if (ci < chatKeys.length - 1) {
                const delay = Math.floor(Math.random() * 3 + 3) * 1000;
                log("⏳ [InputListener]", `Waiting ${delay / 1000}s before next send...`);
                await new Promise((r) => setTimeout(r, delay));
              }
            }
          } else {
            // Message doesn't need reformatting → forward directly
            log("📬 [Queue]", `Processing direct forward for message #${counter} (queue size: ${forwardQueue.length})`);
            const chatKeys = Object.keys(resolvedTargetChats);
            for (let ci = 0; ci < chatKeys.length; ci++) {
              const chatKey = chatKeys[ci];
              try {
                await client.forwardMessages(resolvedTargetChats[chatKey], {
                  messages: [msgId],
                  fromPeer: fromEntity,
                });
                log("📤 [InputListener]", `Userbot forwarded original message #${counter} to chat ${chatKey}`);
              } catch (e) {
                logError("❌ [InputListener]", `Failed to forward to chat ${chatKey}: ${e.message}`);
                try { await bot.telegram.sendMessage(ERROR_CHAT_ID, "❌ Failed to forward msg #" + counter + " to chat " + chatKey + ": " + e.message); } catch (_) { }
              }
              if (ci < chatKeys.length - 1) {
                const delay = Math.floor(Math.random() * 3 + 3) * 1000;
                log("⏳ [InputListener]", `Waiting ${delay / 1000}s before next send...`);
                await new Promise((r) => setTimeout(r, delay));
              }
            }
          }
        });

        processForwardQueue();
      } catch (err) {
        logError("❌ [InputListener]", "Error handling input group message:", err.message, err.stack);
        try { await bot.telegram.sendMessage(ERROR_CHAT_ID, "❌ InputListener crash: " + err.message + "\n" + err.stack); } catch (_) { }
      }
    }, new NewMessage({}));

    log("👁️  [InputListener]", `Listening to ${inputGroupIds.length} input group(s)`);

    // Reset counters at midnight, 16:35, and 17:35 VN time
    let lastResetKey = "";
    setInterval(() => {
      const now = new Date();
      const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const vnHour = vnTime.getUTCHours();
      const vnMinute = vnTime.getUTCMinutes();
      const resetKey = vnTime.getUTCFullYear() + "-" + vnTime.getUTCMonth() + "-" + vnTime.getUTCDate() + "_" + vnHour + ":" + vnMinute;
      if ((vnHour === 0 && vnMinute === 0) || (vnHour === 16 && vnMinute === 35) || (vnHour === 17 && vnMinute === 35)) {
        if (lastResetKey !== resetKey) {
          lastResetKey = resetKey;
          for (const gid in messageCounters) {
            messageCounters[gid] = 0;
          }
          log("🔄 [InputListener]", `Counters reset at ${vnHour}:${vnMinute} VN time`);
        }
      }
    }, 30000); // check every 30s
  }

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
