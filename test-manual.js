// Script de test manuel — pas de framework de test, juste des appels directs.
// Usage: node test-manual.js <step>
// step: search | get <itemId> | send | folders | update <itemId> | attachments <itemId> [attachmentId] | reply <itemId> | forward <itemId>
const ews = require("./ews-client");

async function main() {
  const [step, ...args] = process.argv.slice(2);

  switch (step) {
    case "search": {
      const results = await ews.searchEmails("inbox", undefined, 5);
      console.log(JSON.stringify(results, null, 2));
      break;
    }
    case "get": {
      const email = await ews.getEmail(args[0]);
      console.log(JSON.stringify(email, null, 2));
      break;
    }
    case "send": {
      const res = await ews.sendEmail(args[0], "Test MCP Exchange", "<p>Ceci est un test.</p>");
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "folders": {
      const folders = await ews.listFolders();
      console.log(JSON.stringify(folders, null, 2));
      break;
    }
    case "update": {
      const res = await ews.updateEmail(args[0], { markAsRead: true });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "attachments": {
      const res = await ews.getAttachments(args[0], args[1]);
      console.log(args[1] ? `[base64 tronqué] ${JSON.stringify({ ...res, contentBase64: res.contentBase64.slice(0, 50) + "..." }, null, 2)}` : JSON.stringify(res, null, 2));
      break;
    }
    case "reply": {
      const res = await ews.replyToEmail(args[0], "<p>Réponse de test.</p>", false);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "forward": {
      const res = await ews.forwardEmail(args[0], args[1], "Transfert de test.");
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    default:
      console.log("Usage: node test-manual.js <search|get|send|folders|update|attachments|reply|forward> [args...]");
  }
}

main().catch((err) => {
  console.error("ERREUR:", err.message);
  process.exit(1);
});
