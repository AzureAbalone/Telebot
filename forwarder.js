const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "finput.txt");
const OUTPUT_FILE = path.join(__dirname, "foutput.txt");
const STATE_DIR = process.env.FORWARDER_STATE_DIR || path.join(__dirname, "state");
const STATE_FILE = path.join(STATE_DIR, "finput-counts.json");

function loadLines(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());
}

function matchesSourceId(configuredId, sourceId, chatType) {
  if (configuredId === sourceId) return true;
  // Supergroups use -100<id> in Bot API; older config may contain -<id>.
  return chatType === "supergroup" && sourceId.startsWith("-100") &&
    configuredId === `-${sourceId.slice(4)}`;
}

function vietnamDate() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nextCount(sourceId, senderId) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let state = { date: vietnamDate(), counts: {} };
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  const today = vietnamDate();
  if (state.date !== today) state = { date: today, counts: {} };
  const key = `${sourceId}:${senderId}`;
  const count = (state.counts[key] || 0) + 1;
  state.counts[key] = count;
  const tempFile = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state));
  fs.renameSync(tempFile, STATE_FILE);
  return count;
}

function createForwardMiddleware(telegram, excludedUserIds, log, logError) {
  let countQueue = Promise.resolve();
  return (ctx, next) => {
    const message = ctx.message;
    const sourceId = ctx.chat?.id?.toString();
    const senderId = ctx.from?.id;

    // Text-only forwarding. Media captions and messages without a sender are ignored.
    if (message?.text && sourceId && senderId && senderId !== ctx.botInfo?.id) {
      try {
        const inputLines = loadLines(INPUT_FILE);
        const sourceLine = inputLines.findIndex((id) =>
          id && !id.startsWith("#") && matchesSourceId(id, sourceId, ctx.chat?.type));
        if (sourceLine !== -1) {
          if (excludedUserIds.includes(senderId)) {
            // Serialize owner counts; leave the main bot handler free to run.
            countQueue = countQueue.then(async () => {
              const count = nextCount(sourceId, senderId);
              await ctx.reply(String(count), { reply_to_message_id: message.message_id });
              log("📤 [Forwarder]", `Replied ${count} to owner msg ${message.message_id} in ${sourceId}`);
            }).catch((err) => {
              logError("❌ [Forwarder]", `Failed to count/reply to msg ${message.message_id}:`, err.message);
            });
          } else {
            const targetId = loadLines(OUTPUT_FILE)[sourceLine];
            if (!targetId || !/^-?\d+$/.test(targetId) ||
                matchesSourceId(targetId, sourceId, ctx.chat?.type)) {
              log("⏭️  [Forwarder]", `No valid foutput.txt line ${sourceLine + 1} for finput.txt line ${sourceLine + 1}; skipped msg ${message.message_id} from ${sourceId}`);
            } else {
              void (async () => {
                try {
                  await telegram.forwardMessage(targetId, sourceId, message.message_id);
                  log("📤 [Forwarder]", `Forwarded msg ${message.message_id} from ${sourceId} to ${targetId}`);
                } catch (err) {
                  logError("❌ [Forwarder]", `Failed to forward msg ${message.message_id} to ${targetId}:`, err.message);
                }
              })();
            }
          }
        }
      } catch (err) {
        logError("❌ [Forwarder]", "Could not read finput.txt or foutput.txt:", err.message);
      }
    }

    return next();
  };
}

module.exports = { createForwardMiddleware };
