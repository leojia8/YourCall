// Manual check for proactive alerts (the bot messages someone first):
//   npx tsx scripts/send-alert.ts +15195551234 "3 requests need you\nhttps://github.com"
// A literal \n in the text becomes a line break; a line that is only a URL is sent
// as a rich link preview. The first line must not contain a link (Linq rule).
import { startConversation } from "../src/linq/linq.service";

const [to, ...words] = process.argv.slice(2);
const text = words.join(" ").replace(/\\n/g, "\n");

if (!to || !text.trim()) {
  console.error('usage: npx tsx scripts/send-alert.ts <+E164 number> "<message>"');
  process.exit(1);
}

startConversation(to, text)
  .then((conversationId) => console.log("sent. conversationId =", conversationId))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  });
