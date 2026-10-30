const { z } = require("zod");

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  return { content: [{ type: "text", text: `Erreur: ${err.message}` }], isError: true };
}

function tool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return fail(err);
    }
  });
}

// Enregistre les tools Exchange sur un McpServer, liés au client EWS de l'utilisateur.
function registerTools(server, ews) {
  tool(
    server,
    "search_emails",
    {
      title: "Rechercher des emails",
      description: "Liste les emails d'un dossier Exchange (inbox, sent, drafts, ou un nom de dossier personnalisé), avec un filtre de recherche optionnel (AQS).",
      inputSchema: {
        folder: z.string().describe("Nom du dossier: inbox, sent, drafts, deleteditems, junkemail, ou le nom d'affichage d'un dossier personnalisé"),
        query: z.string().optional().describe("Filtre de recherche (Advanced Query Syntax), ex: subject:facture"),
        maxResults: z.number().int().positive().max(100).optional().describe("Nombre maximum de résultats (défaut: 25)"),
      },
    },
    ({ folder, query, maxResults }) => ews.searchEmails(folder, query, maxResults)
  );

  tool(
    server,
    "get_email",
    {
      title: "Récupérer un email",
      description: "Récupère le contenu complet d'un email (corps HTML, destinataires, pièces jointes) à partir de son identifiant.",
      inputSchema: {
        itemId: z.string().describe("Identifiant EWS de l'email (obtenu via search_emails)"),
      },
    },
    ({ itemId }) => ews.getEmail(itemId)
  );

  tool(
    server,
    "send_email",
    {
      title: "Envoyer un email",
      description: "ACTION IRRÉVERSIBLE: envoie réellement un nouvel email. L'agent DOIT toujours demander confirmation explicite du destinataire, du sujet et du contenu à l'utilisateur avant d'appeler cet outil.",
      inputSchema: {
        to: z.string().describe("Destinataire(s), séparés par des virgules"),
        subject: z.string().describe("Sujet de l'email"),
        body: z.string().describe("Corps de l'email (HTML)"),
        cc: z.string().optional().describe("Destinataires en copie, séparés par des virgules"),
      },
    },
    ({ to, subject, body, cc }) => ews.sendEmail(to, subject, body, cc)
  );

  tool(
    server,
    "list_folders",
    {
      title: "Lister les dossiers",
      description: "Énumère tous les dossiers de la boîte mail (Inbox, Éléments envoyés, Brouillons, dossiers personnalisés...) avec leur nombre d'emails non lus.",
      inputSchema: {},
    },
    () => ews.listFolders()
  );

  tool(
    server,
    "update_email",
    {
      title: "Mettre à jour un email",
      description: "Marque un email comme lu/non lu et/ou le déplace vers un autre dossier.",
      inputSchema: {
        itemId: z.string().describe("Identifiant EWS de l'email"),
        markAsRead: z.boolean().optional().describe("true pour marquer comme lu, false pour marquer comme non lu"),
        moveToFolder: z.string().optional().describe("Nom du dossier de destination (nom d'affichage ou nom standard: inbox, sent, drafts...)"),
      },
    },
    ({ itemId, markAsRead, moveToFolder }) => ews.updateEmail(itemId, { markAsRead, moveToFolder })
  );

  tool(
    server,
    "get_attachments",
    {
      title: "Lister ou télécharger les pièces jointes",
      description: "Sans attachmentId: liste les pièces jointes d'un email (nom, type, taille, id). Avec attachmentId: télécharge le contenu de la pièce jointe encodé en base64.",
      inputSchema: {
        itemId: z.string().describe("Identifiant EWS de l'email"),
        attachmentId: z.string().optional().describe("Identifiant de la pièce jointe à télécharger (obtenu en listant les pièces jointes)"),
      },
    },
    ({ itemId, attachmentId }) => ews.getAttachments(itemId, attachmentId)
  );

  tool(
    server,
    "reply_to_email",
    {
      title: "Répondre à un email",
      description: "ACTION IRRÉVERSIBLE: envoie réellement une réponse à un email existant. L'agent DOIT toujours demander confirmation explicite du contenu (et du choix répondre/répondre à tous) à l'utilisateur avant d'appeler cet outil.",
      inputSchema: {
        itemId: z.string().describe("Identifiant EWS de l'email auquel répondre"),
        body: z.string().describe("Corps de la réponse (HTML)"),
        replyAll: z.boolean().optional().describe("true pour répondre à tous les destinataires d'origine, false pour répondre seulement à l'expéditeur (défaut)"),
      },
    },
    ({ itemId, body, replyAll }) => ews.replyToEmail(itemId, body, replyAll)
  );

  tool(
    server,
    "forward_email",
    {
      title: "Transférer un email",
      description: "ACTION IRRÉVERSIBLE: transfère réellement un email existant à un nouveau destinataire. L'agent DOIT toujours demander confirmation explicite du destinataire et du commentaire à l'utilisateur avant d'appeler cet outil.",
      inputSchema: {
        itemId: z.string().describe("Identifiant EWS de l'email à transférer"),
        to: z.string().describe("Destinataire(s) du transfert, séparés par des virgules"),
        comment: z.string().optional().describe("Commentaire à ajouter avant le contenu transféré"),
      },
    },
    ({ itemId, to, comment }) => ews.forwardEmail(itemId, to, comment)
  );
}

module.exports = { registerTools };
