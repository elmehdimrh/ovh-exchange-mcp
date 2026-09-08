const httpntlm = require("httpntlm");
const { XMLParser } = require("fast-xml-parser");
const config = require("./config");

const NS_MESSAGES = "http://schemas.microsoft.com/exchange/services/2006/messages";
const NS_TYPES = "http://schemas.microsoft.com/exchange/services/2006/types";
const NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/";

const DISTINGUISHED_FOLDERS = {
  inbox: "inbox",
  sent: "sentitems",
  sentitems: "sentitems",
  drafts: "drafts",
  deleteditems: "deleteditems",
  trash: "deleteditems",
  junk: "junkemail",
  junkemail: "junkemail",
  outbox: "outbox",
  archive: "archive",
  root: "msgfolderroot",
  msgfolderroot: "msgfolderroot",
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  }[c]));
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function soapEnvelope(bodyXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="${NS_SOAP}" xmlns:t="${NS_TYPES}">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013" />
  </soap:Header>
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;
}

function postSoap(bodyXml) {
  const envelope = soapEnvelope(bodyXml);
  if (process.env.DEBUG_EWS) console.error("--- REQUEST ---\n" + envelope);
  return new Promise((resolve, reject) => {
    httpntlm.post(
      {
        url: config.ewsUrl,
        username: config.username,
        password: config.password,
        domain: config.domain,
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: envelope,
      },
      (err, res) => {
        if (err) return reject(err);
        if (res.statusCode >= 400) {
          return reject(new Error(`EWS HTTP ${res.statusCode}: ${res.body}`));
        }
        try {
          resolve(parser.parse(res.body));
        } catch (e) {
          reject(new Error(`Réponse EWS illisible: ${e.message}`));
        }
      }
    );
  });
}

// Envoie une requête SOAP pour l'opération donnée et retourne le tableau des
// ResponseMessage correspondants, après avoir vérifié qu'aucun n'est en erreur.
async function callEws(operation, bodyXml) {
  const parsed = await postSoap(bodyXml);
  const body = parsed?.Envelope?.Body;
  if (!body) throw new Error("Réponse SOAP invalide (pas de Body)");
  if (body.Fault) {
    const fault = body.Fault.faultstring ?? body.Fault;
    throw new Error(`SOAP Fault: ${typeof fault === "string" ? fault : JSON.stringify(fault)}`);
  }
  const responseTag = `${operation}Response`;
  const messageTag = `${operation}ResponseMessage`;
  const response = body[responseTag];
  if (!response) {
    throw new Error(`Réponse EWS inattendue pour ${operation}: ${JSON.stringify(body)}`);
  }
  const messages = asArray(response.ResponseMessages?.[messageTag]);
  for (const msg of messages) {
    if (msg["@_ResponseClass"] === "Error") {
      throw new Error(`Erreur EWS (${operation}): ${msg.MessageText || msg["@_ResponseCode"]}`);
    }
  }
  return messages;
}

async function folderIdXml(folder) {
  const key = String(folder).toLowerCase().replace(/\s+/g, "");
  if (DISTINGUISHED_FOLDERS[key]) {
    return `<t:DistinguishedFolderId Id="${DISTINGUISHED_FOLDERS[key]}" />`;
  }
  const folders = await listFolders();
  const match = folders.find((f) => f.name.toLowerCase() === String(folder).toLowerCase());
  return `<t:FolderId Id="${escapeXml(match ? match.id : folder)}" />`;
}

function mailboxesXml(addresses) {
  return String(addresses)
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => `<t:Mailbox><t:EmailAddress>${escapeXml(a)}</t:EmailAddress></t:Mailbox>`)
    .join("");
}

function toEmailArray(recipients) {
  if (!recipients) return [];
  return asArray(recipients.Mailbox).map((m) => m.EmailAddress || m.Name || "");
}

function extractAttachments(item) {
  const raw = item.Attachments;
  if (!raw) return [];
  const files = asArray(raw.FileAttachment);
  const items = asArray(raw.ItemAttachment);
  return [...files, ...items].map((a) => ({
    id: a.AttachmentId?.["@_Id"],
    name: a.Name,
    contentType: a.ContentType || "",
    size: a.Size !== undefined ? Number(a.Size) : null,
  }));
}

function bodyText(item) {
  if (item?.Body === undefined) return "";
  return typeof item.Body === "object" ? item.Body["#text"] ?? "" : item.Body;
}

// --- search_emails ---
async function searchEmails(folder, query, maxResults = 25) {
  const queryXml = query ? `<QueryString>${escapeXml(query)}</QueryString>` : "";
  const body = `
    <FindItem xmlns="${NS_MESSAGES}" Traversal="Shallow">
      <ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject" />
          <t:FieldURI FieldURI="message:From" />
          <t:FieldURI FieldURI="item:DateTimeReceived" />
          <t:FieldURI FieldURI="item:Preview" />
        </t:AdditionalProperties>
      </ItemShape>
      <IndexedPageItemView MaxEntriesReturned="${Number(maxResults)}" Offset="0" BasePoint="Beginning" />
      <ParentFolderIds>
        ${await folderIdXml(folder)}
      </ParentFolderIds>
      ${queryXml}
    </FindItem>`;
  const [msg] = await callEws("FindItem", body);
  const items = asArray(msg.RootFolder?.Items?.Message);
  return items.map((item) => ({
    id: item.ItemId?.["@_Id"],
    subject: item.Subject || "(sans sujet)",
    from: item.From?.Mailbox?.EmailAddress || "",
    date: item.DateTimeReceived || "",
    preview: item.Preview || "",
  }));
}

// --- get_email ---
async function fetchItem(itemId) {
  const body = `
    <GetItem xmlns="${NS_MESSAGES}">
      <ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:BodyType>HTML</t:BodyType>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:DateTimeReceived" />
        </t:AdditionalProperties>
      </ItemShape>
      <ItemIds>
        <t:ItemId Id="${escapeXml(itemId)}" />
      </ItemIds>
    </GetItem>`;
  const [msg] = await callEws("GetItem", body);
  return msg.Items?.Message;
}

async function getEmail(itemId) {
  const item = await fetchItem(itemId);
  if (!item) throw new Error(`Email introuvable: ${itemId}`);
  return {
    id: item.ItemId?.["@_Id"],
    changeKey: item.ItemId?.["@_ChangeKey"],
    subject: item.Subject || "",
    from: item.From?.Mailbox?.EmailAddress || "",
    to: toEmailArray(item.ToRecipients),
    cc: toEmailArray(item.CcRecipients),
    date: item.DateTimeReceived || "",
    bodyType: item.Body?.["@_BodyType"] || "",
    body: bodyText(item),
    attachments: extractAttachments(item),
  };
}

// --- send_email ---
async function sendEmail(to, subject, body, cc) {
  const ccXml = cc ? `<t:CcRecipients>${mailboxesXml(cc)}</t:CcRecipients>` : "";
  const requestBody = `
    <CreateItem xmlns="${NS_MESSAGES}" MessageDisposition="SendAndSaveCopy">
      <SavedItemFolderId>
        <t:DistinguishedFolderId Id="sentitems" />
      </SavedItemFolderId>
      <Items>
        <t:Message>
          <t:Subject>${escapeXml(subject)}</t:Subject>
          <t:Body BodyType="HTML">${escapeXml(body)}</t:Body>
          <t:ToRecipients>${mailboxesXml(to)}</t:ToRecipients>
          ${ccXml}
        </t:Message>
      </Items>
    </CreateItem>`;
  await callEws("CreateItem", requestBody);
  return { sent: true, to, cc: cc || null };
}

// --- list_folders ---
async function listFolders() {
  const body = `
    <FindFolder xmlns="${NS_MESSAGES}" Traversal="Deep">
      <FolderShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="folder:UnreadCount" />
        </t:AdditionalProperties>
      </FolderShape>
      <ParentFolderIds>
        <t:DistinguishedFolderId Id="msgfolderroot" />
      </ParentFolderIds>
    </FindFolder>`;
  const [msg] = await callEws("FindFolder", body);
  const folders = asArray(msg.RootFolder?.Folders?.Folder);
  return folders.map((f) => ({
    id: f.FolderId?.["@_Id"],
    name: f.DisplayName || "",
    unreadCount: f.UnreadCount !== undefined ? Number(f.UnreadCount) : null,
  }));
}

// --- update_email ---
async function updateEmail(itemId, { markAsRead, moveToFolder } = {}) {
  const result = {};

  if (markAsRead !== undefined) {
    const body = `
      <UpdateItem xmlns="${NS_MESSAGES}" MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
        <ItemChanges>
          <t:ItemChange>
            <t:ItemId Id="${escapeXml(itemId)}" />
            <t:Updates>
              <t:SetItemField>
                <t:FieldURI FieldURI="message:IsRead" />
                <t:Message><t:IsRead>${markAsRead ? "true" : "false"}</t:IsRead></t:Message>
              </t:SetItemField>
            </t:Updates>
          </t:ItemChange>
        </ItemChanges>
      </UpdateItem>`;
    await callEws("UpdateItem", body);
    result.markedAsRead = markAsRead;
  }

  if (moveToFolder) {
    const targetXml = await folderIdXml(moveToFolder);
    const body = `
      <MoveItem xmlns="${NS_MESSAGES}">
        <ToFolderId>${targetXml}</ToFolderId>
        <ItemIds>
          <t:ItemId Id="${escapeXml(itemId)}" />
        </ItemIds>
      </MoveItem>`;
    await callEws("MoveItem", body);
    result.movedTo = moveToFolder;
  }

  return result;
}

// --- get_attachments ---
async function getAttachments(itemId, attachmentId) {
  if (!attachmentId) {
    const item = await fetchItem(itemId);
    if (!item) throw new Error(`Email introuvable: ${itemId}`);
    return extractAttachments(item);
  }

  const body = `
    <GetAttachment xmlns="${NS_MESSAGES}">
      <AttachmentShape>
        <t:IncludeMimeContent>false</t:IncludeMimeContent>
      </AttachmentShape>
      <AttachmentIds>
        <t:AttachmentId Id="${escapeXml(attachmentId)}" />
      </AttachmentIds>
    </GetAttachment>`;
  const [msg] = await callEws("GetAttachment", body);
  const attachment = msg.Attachments?.FileAttachment || msg.Attachments?.ItemAttachment;
  if (!attachment) throw new Error(`Pièce jointe introuvable: ${attachmentId}`);
  return {
    name: attachment.Name,
    contentType: attachment.ContentType || "",
    size: attachment.Size !== undefined ? Number(attachment.Size) : null,
    contentBase64: attachment.Content || "",
  };
}

// --- reply_to_email ---
async function replyToEmail(itemId, body, replyAll = false) {
  const original = await fetchItem(itemId);
  if (!original) throw new Error(`Email introuvable: ${itemId}`);

  const originalId = original.ItemId?.["@_Id"];
  const originalChangeKey = original.ItemId?.["@_ChangeKey"];
  const fromAddr = original.From?.Mailbox?.EmailAddress;
  const subject = original.Subject || "";
  const replySubject = /^re:/i.test(subject) ? subject : `RE: ${subject}`;

  const toList = replyAll
    ? [fromAddr, ...toEmailArray(original.ToRecipients)].filter(Boolean)
    : [fromAddr].filter(Boolean);
  const ccList = replyAll ? toEmailArray(original.CcRecipients).filter(Boolean) : [];

  if (toList.length === 0) throw new Error("Impossible de déterminer le destinataire de la réponse (expéditeur d'origine introuvable)");

  const toXml = toList.map((a) => `<t:Mailbox><t:EmailAddress>${escapeXml(a)}</t:EmailAddress></t:Mailbox>`).join("");
  const ccXml = ccList.length
    ? `<t:CcRecipients>${ccList.map((a) => `<t:Mailbox><t:EmailAddress>${escapeXml(a)}</t:EmailAddress></t:Mailbox>`).join("")}</t:CcRecipients>`
    : "";

  const requestBody = `
    <CreateItem xmlns="${NS_MESSAGES}" MessageDisposition="SendAndSaveCopy">
      <Items>
        <t:Message>
          <t:Subject>${escapeXml(replySubject)}</t:Subject>
          <t:Body BodyType="HTML">${escapeXml(body)}</t:Body>
          <t:ToRecipients>${toXml}</t:ToRecipients>
          ${ccXml}
          <t:ReferenceItemId Id="${escapeXml(originalId)}" ChangeKey="${escapeXml(originalChangeKey)}" />
        </t:Message>
      </Items>
    </CreateItem>`;
  await callEws("CreateItem", requestBody);
  return { sent: true, to: toList, cc: ccList };
}

// --- forward_email ---
async function forwardEmail(itemId, to, comment) {
  const original = await fetchItem(itemId);
  if (!original) throw new Error(`Email introuvable: ${itemId}`);

  const originalId = original.ItemId?.["@_Id"];
  const originalChangeKey = original.ItemId?.["@_ChangeKey"];
  const subject = original.Subject || "";
  const fwdSubject = /^fw:/i.test(subject) ? subject : `FW: ${subject}`;
  const commentBlock = comment ? `<p>${comment}</p><hr/>` : "";
  const fullBody = `${commentBlock}${bodyText(original)}`;

  const requestBody = `
    <CreateItem xmlns="${NS_MESSAGES}" MessageDisposition="SendAndSaveCopy">
      <Items>
        <t:Message>
          <t:Subject>${escapeXml(fwdSubject)}</t:Subject>
          <t:Body BodyType="HTML">${escapeXml(fullBody)}</t:Body>
          <t:ToRecipients>${mailboxesXml(to)}</t:ToRecipients>
          <t:ReferenceItemId Id="${escapeXml(originalId)}" ChangeKey="${escapeXml(originalChangeKey)}" />
        </t:Message>
      </Items>
    </CreateItem>`;
  await callEws("CreateItem", requestBody);
  return { sent: true, to };
}

module.exports = {
  searchEmails,
  getEmail,
  sendEmail,
  listFolders,
  updateEmail,
  getAttachments,
  replyToEmail,
  forwardEmail,
};
