# ovh-exchange-mcp

Serveur MCP (Model Context Protocol) distant et multi-utilisateurs qui expose des boîtes Exchange (EWS, authentification NTLM) à Claude (web, desktop, mobile) — recherche, lecture, envoi, réponse, transfert d'emails, gestion des dossiers et pièces jointes.

## Fonctionnement

Le serveur est un MCP **distant** (Streamable HTTP + OAuth 2.1). Il s'utilise comme connecteur personnalisé dans Claude sur le **web, desktop, iOS et Android**, et il est **multi-utilisateurs**. Chaque personne se connecte avec sa propre adresse Exchange :

1. Dans Claude, la personne ajoute le connecteur `https://<domaine>/mcp`, puis clique sur « Se connecter ».
2. Une page de connexion hébergée par ce serveur demande l'adresse email et le mot de passe Exchange.
3. Le serveur vérifie ces identifiants auprès d'EWS. Seuls les domaines listés dans `ALLOWED_DOMAINS` sont acceptés.
4. Le mot de passe est stocké chiffré (AES-256-GCM) dans `data/mcp.sqlite`, et Claude reçoit un token d'accès.
5. Chaque appel de tool utilise la boîte mail de la personne liée au token.

Les tokens d'accès expirent après 1 h. Les refresh tokens durent 30 jours et changent à chaque utilisation. Seuls des hashes des tokens sont stockés. Pour enregistrer un client OAuth, son URL de callback doit figurer dans `ALLOWED_REDIRECT_URIS` (par défaut, Claude uniquement). Cela empêche un tiers d'utiliser la page de connexion pour du phishing.

## Déploiement sur Coolify (Traefik)

Coolify et son proxy Traefik gèrent le certificat HTTPS et le routage. Le serveur écoute sur le port **3000** dans le conteneur.

1. Créer un enregistrement DNS A (ex. `mcp.exemple.fr`) qui pointe vers le VPS.
2. Dans Coolify : *New Resource* → dépôt Git → build pack **Dockerfile**. Le build pack *Docker Compose* fonctionne aussi avec le `docker-compose.yml` fourni.
3. **Domains** : `https://mcp.exemple.fr`. Avec le build pack Compose, ajouter le port du conteneur : `https://mcp.exemple.fr:3000`.
4. **Ports Exposes** : `3000`. Ne publier aucun port sur l'hôte : Traefik s'en charge.
5. **Persistent Storage** : un volume monté sur `/app/data`, qui contient la base SQLite. Sans ce volume, tout est perdu à chaque redéploiement.
6. **Environment Variables** : voir le tableau ci-dessous. Générer `ENCRYPTION_KEY` avec `openssl rand -base64 32`.
7. Déployer, puis vérifier :

```
curl https://mcp.exemple.fr/health
curl https://mcp.exemple.fr/.well-known/oauth-authorization-server
```

Variables d'environnement :

| Variable | Rôle |
|---|---|
| `PUBLIC_URL` | URL publique du serveur, ex. `https://mcp.exemple.fr` (identique au domaine configuré dans Coolify) |
| `EWS_URL` | Endpoint EWS, ex. `https://ex2.mail.ovh.net/EWS/Exchange.asmx` |
| `EWS_DOMAIN` | Domaine Windows NTLM, en général vide |
| `ALLOWED_DOMAINS` | Domaines email autorisés, séparés par des virgules |
| `ENCRYPTION_KEY` | 32 octets en base64. **Ne pas changer** après la mise en service, sinon tous les utilisateurs devront se reconnecter |
| `ALLOWED_REDIRECT_URIS` | Optionnel. Callbacks OAuth autorisés (par défaut ceux de claude.ai et claude.com) |

Le serveur fait confiance à **un seul** proxy devant lui (Traefik) pour connaître l'IP du client, ce qui sert à la limitation des tentatives de connexion. Si Cloudflare (mode proxy) est ajouté devant Traefik, passer `trust proxy` à `2` dans `index.js`.

## Ajouter le connecteur dans Claude

- **Compte individuel (Pro/Max)** : Settings → Connectors → *Add custom connector*, URL `https://mcp.exemple.fr/mcp`. Le connecteur est ensuite disponible automatiquement dans l'app mobile.
- **Team / Enterprise** : un administrateur ajoute le connecteur une seule fois dans les paramètres de l'organisation. Chaque membre clique ensuite sur « Connect » et se connecte avec sa propre boîte mail.

## Développement local

```
npm install
PUBLIC_URL=http://localhost:3000 ALLOWED_REDIRECT_URIS=http://localhost:6274/oauth/callback npm start
npx @modelcontextprotocol/inspector   # se connecter à http://localhost:3000/mcp
```

(`PUBLIC_URL` en http n'est accepté que pour `localhost`.)

## Test manuel du client EWS

Renseigner `EWS_USERNAME` et `EWS_PASSWORD` dans `.env` (utilisés uniquement par ce script) :

```
node test-manual.js verify
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
