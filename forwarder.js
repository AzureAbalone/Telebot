const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "finput.txt");
const OUTPUT_FILE = path.join(__dirname, "foutput.txt");

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

function createForwardMiddleware(telegram, excludedUserIds, log, logError, onSourceText) {
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
          try {
            onSourceText(ctx, sourceId);
          } catch (err) {
            logError("❌ [Forwarder]", `Could not queue count for msg ${message.message_id}:`, err.message);
          }

          if (!excludedUserIds.includes(senderId)) {
            const targetId = loadLines(OUTPUT_FILE)[sourceLine];
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
