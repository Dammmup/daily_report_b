import crypto from "node:crypto";
import type { Request } from "express";
import { signOAuthState, verifyOAuthState } from "./auth.js";

export type OAuthProvider = "google_drive" | "notion" | "trello";

type TokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  externalAccountId?: string;
  externalAccountName?: string;
  metadata?: Record<string, unknown>;
};

const providerLabels: Record<OAuthProvider, string> = {
  google_drive: "Google Drive",
  notion: "Notion",
  trello: "Trello"
};

function envName(provider: OAuthProvider, suffix: "CLIENT_ID" | "CLIENT_SECRET" | "SCOPES") {
  return `${provider.toUpperCase()}_${suffix}`;
}

function getConfiguredScopes(provider: OAuthProvider) {
  const explicit = process.env[envName(provider, "SCOPES")];
  if (explicit) return explicit.split(/[,\s]+/).filter(Boolean);
  if (provider === "google_drive") {
    return [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata.readonly"
    ];
  }
  return [];
}

export function getFrontendBaseUrl() {
  return process.env.FRONTEND_URL || process.env.APP_URL || "http://127.0.0.1:5173";
}

export function getBackendBaseUrl(req: Request) {
  if (process.env.API_PUBLIC_URL) return process.env.API_PUBLIC_URL.replace(/\/+$/, "");
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, "");
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${req.get("host")}`.replace(/\/+$/, "");
}

export function getIntegrationRedirectUri(req: Request, provider: OAuthProvider) {
  return `${getBackendBaseUrl(req)}/api/integrations/oauth/${provider}/callback`;
}

export function getProviderConfig(provider: OAuthProvider) {
  const clientId = process.env[envName(provider, "CLIENT_ID")] || "";
  const clientSecret = process.env[envName(provider, "CLIENT_SECRET")] || "";
  return {
    provider,
    label: providerLabels[provider],
    clientId,
    clientSecret,
    configured: Boolean(clientId && (provider === "trello" || clientSecret)),
    scopes: getConfiguredScopes(provider)
  };
}

export function buildOAuthStartUrl(input: {
  provider: OAuthProvider;
  req: Request;
  userId: string;
  category?: string;
}) {
  const config = getProviderConfig(input.provider);
  if (!config.configured) return null;
  const redirectUri = getIntegrationRedirectUri(input.req, input.provider);
  const state = signOAuthState({
    provider: input.provider,
    userId: input.userId,
    category: input.category,
    redirectPath: "/"
  });

  if (input.provider === "google_drive") {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: config.scopes.join(" "),
      state
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  if (input.provider === "notion") {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      owner: "user",
      redirect_uri: redirectUri,
      state
    });
    return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
  }

  const callbackUrl = redirectUri;
  const params = new URLSearchParams({
    expiration: "never",
    name: "DailyReport ERP",
    scope: "read,write",
    response_type: "token",
    key: config.clientId,
    callback_method: "fragment",
    return_url: callbackUrl,
    state
  });
  return `https://trello.com/1/authorize?${params.toString()}`;
}

async function exchangeGoogleToken(input: {
  code: string;
  redirectUri: string;
}): Promise<TokenResult> {
  const config = getProviderConfig("google_drive");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!response.ok) throw new Error(`Google token exchange failed: ${response.status}`);
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  let account: { id?: string; email?: string; name?: string } = {};
  try {
    const accountResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${data.access_token}` }
    });
    if (accountResponse.ok) account = await accountResponse.json() as typeof account;
  } catch {
    account = {};
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
    scopes: data.scope?.split(/\s+/).filter(Boolean) || config.scopes,
    externalAccountId: account.id || account.email,
    externalAccountName: account.email || account.name,
    metadata: account
  };
}

async function exchangeNotionToken(input: {
  code: string;
  redirectUri: string;
}): Promise<TokenResult> {
  const config = getProviderConfig("notion");
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri
    })
  });
  if (!response.ok) throw new Error(`Notion token exchange failed: ${response.status}`);
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    workspace_id?: string;
    workspace_name?: string;
    bot_id?: string;
    owner?: unknown;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
    scopes: [],
    externalAccountId: data.workspace_id || data.bot_id,
    externalAccountName: data.workspace_name,
    metadata: {
      workspaceId: data.workspace_id,
      workspaceName: data.workspace_name,
      botId: data.bot_id,
      owner: data.owner
    }
  };
}

export async function exchangeOAuthCode(input: {
  provider: OAuthProvider;
  code: string;
  redirectUri: string;
}) {
  if (input.provider === "google_drive") return exchangeGoogleToken(input);
  if (input.provider === "notion") return exchangeNotionToken(input);
  throw new Error("Trello OAuth callback uses token mode and is not exchanged by code.");
}

function encryptionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.INTEGRATION_ENCRYPTION_KEY || process.env.JWT_SECRET || "dev-dailyreport-secret")
    .digest();
}

export function encryptIntegrationSecret(value = "") {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptIntegrationSecret(value = "") {
  if (!value) return "";
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

export async function refreshGoogleAccessToken(refreshTokenEncrypted: string): Promise<{
  accessToken: string;
  expiresAt: Date;
} | null> {
  const refreshToken = decryptIntegrationSecret(refreshTokenEncrypted);
  if (!refreshToken) return null;
  const config = getProviderConfig("google_drive");
  if (!config.clientId || !config.clientSecret) return null;

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000)
    };
  } catch {
    return null;
  }
}

async function fetchGoogleDriveContent(accessToken: string, fileId: string): Promise<string> {
  // Сначала получаем метаданные файла
  const metaResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,description,modifiedTime,owners`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metaResponse.ok) return "";
  const meta = (await metaResponse.json()) as {
    name?: string; mimeType?: string; description?: string;
    modifiedTime?: string; owners?: { displayName?: string }[];
  };

  const parts: string[] = [];
  if (meta.name) parts.push(`Файл: ${meta.name}`);
  if (meta.description) parts.push(`Описание: ${meta.description}`);
  if (meta.modifiedTime) parts.push(`Обновлён: ${meta.modifiedTime}`);
  if (meta.owners?.length) parts.push(`Автор: ${meta.owners.map(o => o.displayName).join(", ")}`);

  // Для Google Docs/Sheets/Slides — экспорт как текст
  const googleAppsMimeTypes: Record<string, string> = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain"
  };
  const exportMime = meta.mimeType ? googleAppsMimeTypes[meta.mimeType] : undefined;

  if (exportMime) {
    try {
      const contentResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (contentResponse.ok) {
        const text = await contentResponse.text();
        // Ограничиваем до ~4000 символов чтобы не перегружать AI
        parts.push(`Содержимое:\n${text.slice(0, 4000)}`);
      }
    } catch { /* не критично */ }
  }

  return parts.join("\n");
}

async function fetchNotionContent(accessToken: string, pageId: string): Promise<string> {
  const notionVersion = process.env.NOTION_VERSION || "2022-06-28";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": notionVersion,
    "Content-Type": "application/json"
  };

  // Получаем свойства страницы
  const pageResponse = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers });
  const parts: string[] = [];

  if (pageResponse.ok) {
    const page = (await pageResponse.json()) as {
      properties?: Record<string, {
        title?: { plain_text?: string }[];
        rich_text?: { plain_text?: string }[];
        type?: string;
      }>;
      last_edited_time?: string;
    };
    // Извлечь заголовок
    for (const [key, prop] of Object.entries(page.properties || {})) {
      if (prop.title?.length) {
        parts.push(`${key}: ${prop.title.map(t => t.plain_text).join("")}`);
      } else if (prop.rich_text?.length) {
        const text = prop.rich_text.map(t => t.plain_text).join("");
        if (text) parts.push(`${key}: ${text}`);
      }
    }
    if (page.last_edited_time) parts.push(`Обновлено: ${page.last_edited_time}`);
  }

  // Получаем блоки (контент страницы)
  try {
    const blocksResponse = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`,
      { headers }
    );
    if (blocksResponse.ok) {
      const blocksData = (await blocksResponse.json()) as {
        results?: {
          type?: string;
          [key: string]: unknown;
        }[];
      };
      const textParts: string[] = [];
      for (const block of blocksData.results || []) {
        const blockContent = block[block.type || ""] as {
          rich_text?: { plain_text?: string }[];
          text?: { content?: string }[];
        } | undefined;
        if (blockContent?.rich_text?.length) {
          textParts.push(blockContent.rich_text.map(t => t.plain_text).join(""));
        }
      }
      if (textParts.length) {
        parts.push(`Содержимое:\n${textParts.join("\n").slice(0, 4000)}`);
      }
    }
  } catch { /* не критично */ }

  return parts.join("\n");
}

async function fetchTrelloContent(accessToken: string, cardOrBoardId: string): Promise<string> {
  const config = getProviderConfig("trello");
  const params = `key=${config.clientId}&token=${accessToken}`;
  const parts: string[] = [];

  // Пробуем как карточку
  try {
    const cardResponse = await fetch(
      `https://api.trello.com/1/cards/${cardOrBoardId}?fields=name,desc,due,labels,url&${params}`
    );
    if (cardResponse.ok) {
      const card = (await cardResponse.json()) as {
        name?: string; desc?: string; due?: string;
        labels?: { name?: string }[]; url?: string;
      };
      if (card.name) parts.push(`Карточка: ${card.name}`);
      if (card.desc) parts.push(`Описание: ${card.desc.slice(0, 3000)}`);
      if (card.due) parts.push(`Дедлайн: ${card.due}`);
      if (card.labels?.length) parts.push(`Метки: ${card.labels.map(l => l.name).filter(Boolean).join(", ")}`);

      // Чек-листы карточки
      const checklistsResponse = await fetch(
        `https://api.trello.com/1/cards/${cardOrBoardId}/checklists?${params}`
      );
      if (checklistsResponse.ok) {
        const checklists = (await checklistsResponse.json()) as {
          name?: string;
          checkItems?: { name?: string; state?: string }[];
        }[];
        for (const cl of checklists) {
          if (cl.name) parts.push(`Чек-лист "${cl.name}":`);
          for (const item of cl.checkItems || []) {
            parts.push(`  ${item.state === "complete" ? "✅" : "⬜"} ${item.name}`);
          }
        }
      }
      return parts.join("\n");
    }
  } catch { /* не карточка — пробуем как доску */ }

  // Пробуем как доску
  try {
    const boardResponse = await fetch(
      `https://api.trello.com/1/boards/${cardOrBoardId}?fields=name,desc,url&${params}`
    );
    if (boardResponse.ok) {
      const board = (await boardResponse.json()) as { name?: string; desc?: string };
      if (board.name) parts.push(`Доска: ${board.name}`);
      if (board.desc) parts.push(`Описание: ${board.desc.slice(0, 2000)}`);
    }

    const listsResponse = await fetch(
      `https://api.trello.com/1/boards/${cardOrBoardId}/lists?fields=name&cards=open&card_fields=name&${params}`
    );
    if (listsResponse.ok) {
      const lists = (await listsResponse.json()) as {
        name?: string;
        cards?: { name?: string }[];
      }[];
      for (const list of lists.slice(0, 10)) {
        parts.push(`\nСписок "${list.name}":`);
        for (const card of (list.cards || []).slice(0, 8)) {
          parts.push(`  • ${card.name}`);
        }
      }
    }
  } catch { /* не критично */ }

  return parts.join("\n");
}

export async function fetchResourceContent(input: {
  provider: OAuthProvider | "manual";
  accessToken: string;
  externalId: string;
}): Promise<string> {
  if (!input.externalId || !input.accessToken) return "";
  try {
    if (input.provider === "google_drive") return await fetchGoogleDriveContent(input.accessToken, input.externalId);
    if (input.provider === "notion") return await fetchNotionContent(input.accessToken, input.externalId);
    if (input.provider === "trello") return await fetchTrelloContent(input.accessToken, input.externalId);
    return "";
  } catch (error) {
    console.error(`Content fetch error for ${input.provider}/${input.externalId}:`, error);
    return "";
  }
}

export function readOAuthState(state?: string) {
  if (!state) return null;
  const parsed = verifyOAuthState(state);
  if (!parsed) return null;
  return parsed.provider === "google_drive" || parsed.provider === "notion" || parsed.provider === "trello" ? parsed : null;
}
