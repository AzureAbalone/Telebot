const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "finput.txt");
const OUTPUT_FILE = path.join(__dirname, "foutput.txt");

function loadLines(file) {
  if (!fs.existsSync(file)) return [];
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

function vietnamTimeForMessage(message) {
  const timestamp = Number.isFinite(message.date) ? message.date * 1000 : Date.now();
  return new Date(timestamp + 7 * 60 * 60 * 1000);
}

function isQuietTime(message) {
  const vnTime = vietnamTimeForMessage(message);
  const hour = vnTime.getUTCHours();
  const minute = vnTime.getUTCMinutes();
  return hour >= 16 && hour <= 18 && minute >= 14 && minute < 24;
}

function vietnamCounterPeriod(message) {
  const vnTime = vietnamTimeForMessage(message);
  const date = vnTime.toISOString().slice(0, 10);
  const minute = vnTime.getUTCHours() * 60 + vnTime.getUTCMinutes();
  const start = minute >= 17 * 60 + 18 ? "17:18"
    : minute >= 16 * 60 + 18 ? "16:18"
      : minute >= 12 * 60 ? "12:00" : "00:00";
  return `${date}T${start}`;
}

function createForwardMiddleware(telegram, excludedUserIds, log, logError, onSourceText, onSourceReset) {
  return (ctx, next) => {
    const message = ctx.message;
    const sourceId = ctx.chat?.id?.toString();
    const senderId = ctx.from?.id;

    const resetCommand = message?.text?.match(/^\/reset(?:@([\w]+))?\s*$/i);
    if (resetCommand && (!resetCommand[1] ||
        resetCommand[1].toLowerCase() === ctx.botInfo?.username?.toLowerCase())) {
      if ((ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") &&
          sourceId && senderId && !ctx.from?.is_bot) {
        try {
          const configured = loadLines(INPUT_FILE).some((id) =>
            id && !id.startsWith("#") && matchesSourceId(id, sourceId, ctx.chat.type));
          if (configured) {
            const period = vietnamCounterPeriod(message);
            const counterKey = period.endsWith("T00:00")
              ? sourceId : `${sourceId}@${period.slice(-5)}`;
            if (typeof onSourceReset === "function") onSourceReset(ctx, counterKey);
          }
        } catch (err) {
          logError("❌ [Counter]", `Could not queue reset for ${sourceId}:`, err.message);
        }
      }
      return;
    }

    // Text-only forwarding. Media captions and messages without a sender are ignored.
    if (message?.text && sourceId && senderId && senderId !== ctx.botInfo?.id) {
      try {
        const inputLines = loadLines(INPUT_FILE);
        const outputLines = loadLines(OUTPUT_FILE);
        const hasIds = (lines) => lines.some((id) => /^-?\d+$/.test(id));
        if (!hasIds(inputLines) || !hasIds(outputLines)) return next();
        const sourceLine = inputLines.findIndex((id) =>
          id && !id.startsWith("#") && matchesSourceId(id, sourceId, ctx.chat?.type));
        if (sourceLine !== -1) {
          if (isQuietTime(message)) {
            log("🔇 [Forwarder]", `Quiet period; skipped msg ${message.message_id} from ${sourceId}`);
            return next();
          }
          try {
            const period = vietnamCounterPeriod(message);
            // Existing index.js counter resets at midnight. Use separate keys
            // for later VN reset windows without changing its reply flow.
            const counterKey = period.endsWith("T00:00")
              ? sourceId : `${sourceId}@${period.slice(-5)}`;
            onSourceText(ctx, counterKey);
          } catch (err) {
            logError("❌ [Forwarder]", `Could not queue count for msg ${message.message_id}:`, err.message);
          }

          if (!excludedUserIds.includes(senderId)) {
            const targetId = outputLines[sourceLine];
            if (!targetId || !/^-?\d+$/.test(targetId) ||
                matchesSourceId(targetId, sourceId, ctx.chat?.type)) {
              log("⏭️  [Forwarder]", `No valid foutput.txt line ${sourceLine + 1} for finput.txt line ${sourceLine + 1}; skipped msg ${message.message_id} from ${sourceId}`);
            } else {
              void (async () => {
                let attemptedTarget = targetId;
                try {
                  await telegram.forwardMessage(targetId, sourceId, message.message_id);
                  log("📤 [Forwarder]", `Forwarded msg ${message.message_id} from ${sourceId} to ${targetId}`);
                } catch (err) {
                  const fallbackId = targetId.startsWith("-") && !targetId.startsWith("-100")
                    ? `-100${targetId.slice(1)}` : null;
                  if (fallbackId && /chat not found/i.test(err.message || "")) {
                    attemptedTarget = fallbackId;
                    try {
                      const chat = await telegram.getChat(fallbackId);
                      await telegram.forwardMessage(fallbackId, sourceId, message.message_id);
                      log("📤 [Forwarder]", `Forwarded msg ${message.message_id} to ${fallbackId} (${chat.title || "untitled"}; foutput.txt: ${targetId})`);
                      return;
                    } catch (fallbackError) {
                      err = fallbackError;
                    }
                  }
                  logError("❌ [Forwarder]", `Failed to forward msg ${message.message_id} to ${targetId} (last tried ${attemptedTarget}):`, err.message, "Check bot membership and Bot API chat ID.");
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
