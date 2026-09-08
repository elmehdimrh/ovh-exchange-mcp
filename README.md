# ovh-exchange-mcp

Serveur MCP (Model Context Protocol) qui expose une boîte Exchange (EWS, authentification NTLM) à un agent IA — recherche, lecture, envoi, réponse, transfert d'emails, gestion des dossiers et pièces jointes.

## Configuration

Copier `.env.example` en `.env` et remplir les variables :

```
EWS_URL=https://ex2.mail.ovh.net/EWS/Exchange.asmx
EWS_USERNAME=votre.adresse@domaine.fr
EWS_PASSWORD=votre_mot_de_passe
EWS_DOMAIN=
```

- `EWS_USERNAME` : l'adresse email complète (pas juste le login).
- `EWS_DOMAIN` : laisser vide sauf si le serveur exige un domaine Windows explicite.

Installer les dépendances :

```
npm install
```

## Connexion à Claude Desktop

Ajouter dans `claude_desktop_config.json` (menu Claude Desktop > Settings > Developer > Edit Config) :

```json
{
  "mcpServers": {
    "ovh-exchange": {
      "command": "node",
      "args": ["/chemin/absolu/vers/ovh-exchange-mcp/index.js"],
      "env": {
        "EWS_URL": "https://ex2.mail.ovh.net/EWS/Exchange.asmx",
        "EWS_USERNAME": "votre.adresse@domaine.fr",
        "EWS_PASSWORD": "votre_mot_de_passe",
        "EWS_DOMAIN": ""
      }
    }
  }
}
```

Redémarrer Claude Desktop. Les 8 tools doivent apparaître dans la liste des outils disponibles.

## Test manuel

```
node test-manual.js search
node test-manual.js get <itemId>
node test-manual.js folders
node test-manual.js update <itemId>
node test-manual.js attachments <itemId> [attachmentId]
node test-manual.js reply <itemId>
node test-manual.js forward <itemId> <destinataire>
node test-manual.js send <destinataire>
```

Ajouter `DEBUG_EWS=1` devant la commande pour afficher la requête SOAP envoyée.

## Tools disponibles

### `search_emails(folder, query?, maxResults?)`
Liste les emails d'un dossier.
```json
{ "folder": "inbox", "query": "subject:facture", "maxResults": 10 }
```

### `get_email(itemId)`
Récupère le contenu complet d'un email (corps HTML, destinataires, pièces jointes).
```json
{ "itemId": "AQMkAD..." }
```

### `send_email(to, subject, body, cc?)`
**Action irréversible** — envoie réellement un email.
```json
{ "to": "quelqu'un@exemple.fr", "subject": "Bonjour", "body": "<p>Contenu</p>" }
```

### `list_folders()`
Énumère tous les dossiers de la boîte mail avec leur nombre d'emails non lus.
```json
{}
```

### `update_email(itemId, markAsRead?, moveToFolder?)`
Marque comme lu/non lu et/ou déplace vers un autre dossier (par nom d'affichage ou nom standard).
```json
{ "itemId": "AQMkAD...", "markAsRead": true, "moveToFolder": "Archive" }
```

### `get_attachments(itemId, attachmentId?)`
Sans `attachmentId` : liste les pièces jointes. Avec : télécharge le contenu en base64.
```json
{ "itemId": "AQMkAD..." }
{ "itemId": "AQMkAD...", "attachmentId": "AAMkAD..." }
```

### `reply_to_email(itemId, body, replyAll?)`
**Action irréversible** — envoie réellement une réponse.
```json
{ "itemId": "AQMkAD...", "body": "<p>Merci, c'est noté.</p>", "replyAll": false }
```

### `forward_email(itemId, to, comment?)`
**Action irréversible** — transfère réellement l'email.
```json
{ "itemId": "AQMkAD...", "to": "collegue@exemple.fr", "comment": "Pour info" }
```

## Notes

- Les tools `send_email`, `reply_to_email` et `forward_email` sont marqués comme irréversibles dans leur description : un agent IA bien élevé doit demander confirmation du destinataire et du contenu avant de les appeler.
- La vulnérabilité npm `underscore` (dépendance transitive de `httpntlm`) est corrigée via le champ `overrides` du `package.json`, sans changer de version de `httpntlm`.
