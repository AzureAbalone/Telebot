const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "finput.txt");
const OUTPUT_FILE = path.join(__dirname, "foutput.txt");

function loadIds(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function createForwardMiddleware(telegram, excludedUserIds, log, logError) {
  return (ctx, next) => {
    const message = ctx.message;
    const sourceId = ctx.chat?.id?.toString();
    const senderId = ctx.from?.id;

    // Text-only forwarding. Media captions and messages without a sender are ignored.
    if (message?.text && sourceId && senderId &&
        senderId !== ctx.botInfo?.id && !excludedUserIds.includes(senderId)) {
      try {
        const inputIds = loadIds(INPUT_FILE);
        if (inputIds.includes(sourceId)) {
          const outputIds = loadIds(OUTPUT_FILE).filter((id) => id !== sourceId);
          // Run separately from the main bot handler; forwarding never sends a reply.
          void Promise.all(outputIds.map(async (targetId) => {
            try {
              await telegram.forwardMessage(targetId, sourceId, message.message_id);
              log("📤 [Forwarder]", `Forwarded msg ${message.message_id} from ${sourceId} to ${targetId}`);
            } catch (err) {
              logError("❌ [Forwarder]", `Failed to forward msg ${message.message_id} to ${targetId}:`, err.message);
            }
          }));
        }
      } catch (err) {
        logError("❌ [Forwarder]", "Could not read finput.txt or foutput.txt:", err.message);
      }
    }

    return next();
  };
}

module.exports = { createForwardMiddleware };
