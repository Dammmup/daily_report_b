import { Router } from "express";
import { Types } from "mongoose";
import { analyzeExternalResourceFit } from "../../ai.js";
import { categories, categoryValues } from "../../constants.js";
import {
  buildOAuthStartUrl,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  exchangeOAuthCode,
  fetchResourceContent,
  getFrontendBaseUrl,
  getIntegrationRedirectUri,
  getProviderConfig,
  readOAuthState,
  refreshGoogleAccessToken,
  type OAuthProvider
} from "../../integrations.js";
import { AuditLogModel, ExternalResourceAiCheckModel, ExternalResourceModel, IntegrationConnectionModel, PlanModel, UserModel } from "../../models.js";
import type { Category } from "../../types.js";
import { auth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { externalResourceAiCheckSchema, externalResourceSchema, integrationManualConnectionSchema } from "../schemas.js";

export const integrationRouter = Router();

const providers: OAuthProvider[] = ["google_drive", "notion", "trello"];

function categoryFromString(value?: string | null) {
  return value && (categoryValues as readonly string[]).includes(value) ? (value as Category) : undefined;
}

function serializeResource(resource: Awaited<ReturnType<typeof ExternalResourceModel.findOne>>) {
  if (!resource) return null;
  const item = resource.toObject();
  return {
    ...item,
    id: resource.id,
    planId: item.planId?.toString(),
    createdBy: item.createdBy?.toString(),
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    lastAiCheckAt: item.lastAiCheckAt?.toISOString()
  };
}

function serializeCheck(check: Awaited<ReturnType<typeof ExternalResourceAiCheckModel.findOne>>) {
  if (!check) return null;
  const item = check.toObject();
  return {
    ...item,
    id: check.id,
    resourceId: item.resourceId.toString(),
    planId: item.planId.toString(),
    createdBy: item.createdBy.toString(),
    createdAt: check.createdAt.toISOString(),
    updatedAt: check.updatedAt.toISOString()
  };
}

function serializeConnection(connection: Awaited<ReturnType<typeof IntegrationConnectionModel.findOne>>) {
  if (!connection) return null;
  return {
    id: connection.id,
    provider: connection.provider,
    category: connection.category,
    status: connection.status,
    externalAccountId: connection.externalAccountId,
    externalAccountName: connection.externalAccountName,
    scopes: connection.scopes,
    expiresAt: connection.expiresAt?.toISOString(),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString()
  };
}

function providerResourceType(input: { provider: OAuthProvider; mimeType?: string; object?: string }) {
  if (input.provider === "google_drive") {
    if (input.mimeType === "application/vnd.google-apps.folder") return "folder";
    return "document";
  }
  if (input.provider === "notion") return input.object === "database" ? "database" : "page";
  if (input.provider === "trello") return "board";
  return "other";
}

async function findActiveConnection(req: AuthedRequest, provider: OAuthProvider) {
  return IntegrationConnectionModel.findOne({
    provider,
    connectedByUserId: req.user!._id,
    status: "configured"
  }).sort({ updatedAt: -1 });
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listProviderResources(input: {
  provider: OAuthProvider;
  accessToken: string;
  query: string;
}) {
  if (input.provider === "google_drive") {
    const filters = ["trashed = false"];
    if (input.query) filters.push(`name contains '${escapeDriveQuery(input.query)}'`);
    const params = new URLSearchParams({
      pageSize: "12",
      fields: "files(id,name,mimeType,webViewLink)",
      q: filters.join(" and ")
    });
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: { Authorization: `Bearer ${input.accessToken}` }
    });
    if (!response.ok) throw new Error(`Google Drive search failed: ${response.status}`);
    const data = (await response.json()) as { files?: { id: string; name: string; mimeType?: string; webViewLink?: string }[] };
    return (data.files || []).map((file) => ({
      provider: input.provider,
      externalId: file.id,
      title: file.name,
      externalUrl: file.webViewLink || `https://drive.google.com/open?id=${file.id}`,
      resourceType: providerResourceType({ provider: input.provider, mimeType: file.mimeType })
    }));
  }

  if (input.provider === "notion") {
    const response = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": process.env.NOTION_VERSION || "2022-06-28"
      },
      body: JSON.stringify({
        query: input.query || undefined,
        page_size: 12
      })
    });
    if (!response.ok) throw new Error(`Notion search failed: ${response.status}`);
    const data = (await response.json()) as {
      results?: {
        id: string;
        object: "page" | "database";
        url?: string;
        title?: { plain_text?: string }[];
        properties?: Record<string, { title?: { plain_text?: string }[] }>;
      }[];
    };
    return (data.results || []).map((item) => {
      const title =
        item.object === "database"
          ? item.title?.map((part) => part.plain_text).filter(Boolean).join("") || "Notion database"
          : Object.values(item.properties || {})
              .flatMap((property) => property.title || [])
              .map((part) => part.plain_text)
              .filter(Boolean)
              .join("") || "Notion page";
      return {
        provider: input.provider,
        externalId: item.id,
        title,
        externalUrl: item.url || `https://www.notion.so/${item.id.replace(/-/g, "")}`,
        resourceType: providerResourceType({ provider: input.provider, object: item.object })
      };
    });
  }

  const config = getProviderConfig("trello");
  const params = new URLSearchParams({
    key: config.clientId,
    token: input.accessToken,
    fields: "name,url",
    filter: "open"
  });
  const response = await fetch(`https://api.trello.com/1/members/me/boards?${params.toString()}`);
  if (!response.ok) throw new Error(`Trello boards search failed: ${response.status}`);
  const boards = (await response.json()) as { id: string; name: string; url: string }[];
  return boards
    .filter((board) => !input.query || board.name.toLowerCase().includes(input.query.toLowerCase()))
    .slice(0, 12)
    .map((board) => ({
      provider: input.provider,
      externalId: board.id,
      title: board.name,
      externalUrl: board.url,
      resourceType: "board"
    }));
}

async function upsertConnection(input: {
  provider: OAuthProvider;
  userId: string;
  category?: Category;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  externalAccountId?: string;
  externalAccountName?: string;
  metadata?: Record<string, unknown>;
}) {
  return IntegrationConnectionModel.findOneAndUpdate(
    {
      provider: input.provider,
      connectedByUserId: input.userId,
      category: input.category || { $exists: false }
    } as any,
    {
      provider: input.provider,
      connectedByUserId: input.userId,
      category: input.category,
      status: "configured",
      externalAccountId: input.externalAccountId || "",
      externalAccountName: input.externalAccountName || "",
      accessTokenEncrypted: encryptIntegrationSecret(input.accessToken),
      refreshTokenEncrypted: encryptIntegrationSecret(input.refreshToken || ""),
      scopes: input.scopes || [],
      expiresAt: input.expiresAt,
      metadata: input.metadata
    },
    { upsert: true, returnDocument: "after" }
  );
}

async function findPlanVisibleToUser(req: AuthedRequest, planId: string) {
  if (!Types.ObjectId.isValid(planId)) return null;
  if (req.user!.role === "admin") return PlanModel.findById(planId);
  if (!req.user!.category) return null;
  return PlanModel.findOne({ _id: planId, category: req.user!.category });
}

async function resolveResourceContext(req: AuthedRequest, input: {
  linkedEntityType: "department" | "plan" | "step";
  linkedEntityId: string;
  category?: Category;
}) {
  if (input.linkedEntityType === "plan") {
    const plan = await findPlanVisibleToUser(req, input.linkedEntityId);
    return plan
      ? { category: plan.category as Category, planId: plan._id, stepId: "" }
      : null;
  }

  if (input.linkedEntityType === "step") {
    const plan =
      req.user!.role === "admin"
        ? await PlanModel.findOne({ "steps._id": input.linkedEntityId } as any)
        : req.user!.category
          ? await PlanModel.findOne({ category: req.user!.category, "steps._id": input.linkedEntityId } as any)
          : null;
    const step = plan?.steps.id(input.linkedEntityId);
    return plan && step
      ? { category: plan.category as Category, planId: plan._id, stepId: step._id.toString() }
      : null;
  }

  const category = req.user!.role === "admin" ? input.category : req.user!.category;
  return category ? { category: category as Category, planId: undefined, stepId: "" } : null;
}

async function findResourceVisibleToUser(req: AuthedRequest, id: string) {
  if (!Types.ObjectId.isValid(id)) return null;
  const resource = await ExternalResourceModel.findById(id);
  if (!resource) return null;
  if (req.user!.role === "admin") return resource;
  if (req.user!.category && resource.category === req.user!.category) return resource;
  return null;
}

integrationRouter.get("/integrations/status", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const connections = await IntegrationConnectionModel.find({
    connectedByUserId: req.user!._id,
    status: { $ne: "disabled" }
  });

  res.json({
    providers: providers.map((provider) => {
      const config = getProviderConfig(provider);
      const connection = connections.find((item) => item.provider === provider);
      return {
        provider,
        connected: Boolean(connection),
        oauthConfigured: config.configured,
        authMode: provider === "trello" ? "manual_token" : "oauth",
        mode: "oauth_resource_linking",
        connection: serializeConnection(connection || null)
      };
    })
  });
});

integrationRouter.post("/integrations/oauth/:provider/start", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const provider = String(req.params.provider) as OAuthProvider;
  if (!providers.includes(provider)) {
    res.status(404).json({ message: "Провайдер интеграции не найден" });
    return;
  }
  if (provider === "trello") {
    res.status(400).json({ message: "Для Trello сейчас используется подключение через token в интерфейсе." });
    return;
  }

  const category = req.user!.role === "admin" ? categoryFromString(String(req.query.category || "")) : categoryFromString(req.user!.category);
  const url = buildOAuthStartUrl({
    provider,
    req,
    userId: req.user!.id,
    category
  });

  if (!url) {
    res.status(400).json({ message: "OAuth для провайдера не настроен на сервере" });
    return;
  }

  res.json({ url });
});

integrationRouter.get("/integrations/oauth/:provider/callback", async (req, res) => {
  const provider = String(req.params.provider) as OAuthProvider;
  const frontendUrl = getFrontendBaseUrl();
  const fail = (message: string) => {
    const params = new URLSearchParams({ integration: provider, status: "error", message });
    res.redirect(`${frontendUrl}/?${params.toString()}`);
  };

  if (!providers.includes(provider)) {
    fail("Провайдер интеграции не найден");
    return;
  }

  const state = readOAuthState(String(req.query.state || ""));
  if (!state || state.provider !== provider) {
    fail("OAuth state не прошел проверку");
    return;
  }

  const user = await UserModel.findById(state.userId);
  if (!user || (user.role !== "lead" && user.role !== "admin")) {
    fail("Пользователь для OAuth-подключения не найден");
    return;
  }

  const code = String(req.query.code || "");
  if (!code) {
    fail("OAuth provider не вернул code");
    return;
  }

  try {
    const tokens = await exchangeOAuthCode({
      provider,
      code,
      redirectUri: getIntegrationRedirectUri(req, provider)
    });
    const connection = await upsertConnection({
      provider,
      userId: user.id,
      category: categoryFromString(state.category),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      externalAccountId: tokens.externalAccountId,
      externalAccountName: tokens.externalAccountName,
      metadata: tokens.metadata
    });

    await AuditLogModel.create({
      actorId: user._id,
      action: "integration_connected",
      entityType: "integration_connection",
      entityId: connection.id,
      category: categoryFromString(state.category),
      message: `Подключена интеграция ${provider}`,
      meta: { provider, externalAccountName: connection.externalAccountName }
    });

    const params = new URLSearchParams({ integration: provider, status: "connected" });
    res.redirect(`${frontendUrl}/?${params.toString()}`);
  } catch (error) {
    console.error("Integration OAuth callback error", error);
    fail("Не удалось завершить OAuth-подключение");
  }
});

integrationRouter.post("/integrations/manual-token", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const body = integrationManualConnectionSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректные данные интеграции" });
    return;
  }

  const category = req.user!.role === "admin" ? body.data.category : categoryFromString(req.user!.category);
  const connection = await upsertConnection({
    provider: body.data.provider,
    userId: req.user!.id,
    category,
    accessToken: body.data.accessToken,
    scopes: ["read", "write"],
    externalAccountId: body.data.externalAccountId,
    externalAccountName: body.data.externalAccountName || "Trello token"
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "integration_connected",
    entityType: "integration_connection",
    entityId: connection.id,
    category,
    message: `Подключена интеграция ${body.data.provider}`,
    meta: { provider: body.data.provider, mode: "manual_token" }
  });

  res.status(201).json(serializeConnection(connection));
});

integrationRouter.delete("/integrations/connections/:provider", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const provider = String(req.params.provider) as OAuthProvider;
  if (!providers.includes(provider)) {
    res.status(404).json({ message: "Провайдер интеграции не найден" });
    return;
  }

  const category = req.user!.role === "admin" ? categoryFromString(String(req.query.category || "")) : categoryFromString(req.user!.category);
  await IntegrationConnectionModel.updateMany(
    {
      provider,
      connectedByUserId: req.user!._id,
      ...(category ? { category } : {})
    },
    { $set: { status: "disabled" } }
  );

  res.json({ ok: true });
});

integrationRouter.get("/integrations/provider/:provider/resources", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const provider = String(req.params.provider) as OAuthProvider;
  if (!providers.includes(provider)) {
    res.status(404).json({ message: "Провайдер интеграции не найден" });
    return;
  }

  const connection = await findActiveConnection(req, provider);
  if (!connection) {
    res.status(404).json({ message: "Сначала подключите интеграцию" });
    return;
  }

  let accessToken = decryptIntegrationSecret(connection.accessTokenEncrypted);
  if (!accessToken) {
    res.status(400).json({ message: "Токен интеграции недоступен. Подключите сервис повторно." });
    return;
  }

  const query = String(req.query.query || "").trim();

  try {
    res.json({
      resources: await listProviderResources({ provider, accessToken, query })
    });
  } catch (error) {
    // При 401 от Google — пробуем refresh token
    const errorMessage = error instanceof Error ? error.message : "";
    if (provider === "google_drive" && errorMessage.includes("401") && connection.refreshTokenEncrypted) {
      const refreshed = await refreshGoogleAccessToken(connection.refreshTokenEncrypted);
      if (refreshed) {
        connection.accessTokenEncrypted = encryptIntegrationSecret(refreshed.accessToken);
        connection.expiresAt = refreshed.expiresAt;
        await connection.save();
        accessToken = refreshed.accessToken;
        try {
          res.json({
            resources: await listProviderResources({ provider, accessToken, query })
          });
          return;
        } catch (retryError) {
          console.error("Integration retry after refresh failed", retryError);
        }
      } else {
        // Refresh не удался — нужна переавторизация
        connection.status = "needs_reauth";
        await connection.save();
        res.status(401).json({ message: "Токен Google Drive истёк. Переподключите интеграцию.", needsReauth: true });
        return;
      }
    }
    console.error("Integration provider resource search error", error);
    res.status(502).json({ message: "Не удалось получить список ресурсов из внешнего сервиса" });
  }
});

integrationRouter.get("/integrations/resources", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const linkedEntityType = String(req.query.linkedEntityType || "");
  const linkedEntityId = String(req.query.linkedEntityId || "");
  const planId = String(req.query.planId || "");

  const query: Record<string, unknown> = {};
  if (linkedEntityType && linkedEntityId) {
    query.linkedEntityType = linkedEntityType;
    query.linkedEntityId = linkedEntityId;
  }
  // planId — ObjectId-поле: невалидную строку не пускаем в запрос (иначе CastError → 500).
  if (planId) {
    if (!Types.ObjectId.isValid(planId)) {
      res.json([]);
      return;
    }
    query.planId = planId;
  }
  if (req.user!.role !== "admin") {
    // Лид без департамента не должен видеть ресурсы без категории — возвращаем пусто.
    if (!req.user!.category) {
      res.json([]);
      return;
    }
    query.category = req.user!.category;
  }

  const resources = await ExternalResourceModel.find(query).sort({ createdAt: -1 });
  const latestChecks = await ExternalResourceAiCheckModel.find({ resourceId: { $in: resources.map((resource) => resource._id) } }).sort({ createdAt: -1 });

  res.json(
    resources.map((resource) => ({
      ...serializeResource(resource),
      latestAiCheck: serializeCheck(latestChecks.find((check) => check.resourceId.toString() === resource.id) || null)
    }))
  );
});

integrationRouter.post("/integrations/resources", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const body = externalResourceSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный внешний ресурс" });
    return;
  }

  const context = await resolveResourceContext(req, {
    linkedEntityType: body.data.linkedEntityType,
    linkedEntityId: body.data.linkedEntityId,
    category: body.data.category
  });
  if (!context) {
    res.status(404).json({ message: "План, шаг или департамент для привязки не найден" });
    return;
  }

  const resource = await ExternalResourceModel.create({
    provider: body.data.provider,
    externalId: body.data.externalId || "",
    externalUrl: body.data.externalUrl,
    title: body.data.title,
    resourceType: body.data.resourceType,
    linkedEntityType: body.data.linkedEntityType,
    linkedEntityId: body.data.linkedEntityId,
    category: context.category,
    planId: context.planId,
    stepId: context.stepId,
    createdBy: req.user!._id,
    contentSummary: body.data.contentSummary || ""
  });

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "external_resource_linked",
    entityType: body.data.linkedEntityType,
    entityId: body.data.linkedEntityId,
    category: context.category,
    message: `Привязан внешний ресурс "${resource.title}"`,
    meta: { provider: resource.provider, resourceType: resource.resourceType, url: resource.externalUrl }
  });

  res.status(201).json(serializeResource(resource));
});

integrationRouter.delete("/integrations/resources/:id", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const resource = await findResourceVisibleToUser(req, String(req.params.id));
  if (!resource) {
    res.status(404).json({ message: "Внешний ресурс не найден" });
    return;
  }

  await ExternalResourceAiCheckModel.deleteMany({ resourceId: resource._id });
  await ExternalResourceModel.deleteOne({ _id: resource._id });
  res.json({ ok: true });
});

integrationRouter.post("/integrations/resources/:id/ai-check", auth, requireRole("lead", "admin"), async (req: AuthedRequest, res) => {
  const body = externalResourceAiCheckSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ message: "Некорректный запрос AI-проверки" });
    return;
  }

  const resource = await findResourceVisibleToUser(req, String(req.params.id));
  if (!resource) {
    res.status(404).json({ message: "Внешний ресурс не найден" });
    return;
  }

  const planId = body.data.planId || resource.planId?.toString();
  const plan = planId ? await findPlanVisibleToUser(req, planId) : null;
  if (!plan) {
    res.status(400).json({ message: "Для AI-проверки нужно привязать ресурс к плану или указать planId" });
    return;
  }

  // Автоматический фетч контента из подключенного сервиса
  let enrichedContent = resource.contentSummary || "";
  if (resource.externalId && resource.provider !== "manual") {
    const connection = await IntegrationConnectionModel.findOne({
      provider: resource.provider,
      connectedByUserId: req.user!._id,
      status: "configured"
    });
    if (connection) {
      let accessToken = decryptIntegrationSecret(connection.accessTokenEncrypted);

      // Для Google — проверяем refresh при необходимости
      if (resource.provider === "google_drive" && connection.expiresAt && connection.expiresAt < new Date() && connection.refreshTokenEncrypted) {
        const refreshed = await refreshGoogleAccessToken(connection.refreshTokenEncrypted);
        if (refreshed) {
          connection.accessTokenEncrypted = encryptIntegrationSecret(refreshed.accessToken);
          connection.expiresAt = refreshed.expiresAt;
          await connection.save();
          accessToken = refreshed.accessToken;
        }
      }

      if (accessToken) {
        const liveContent = await fetchResourceContent({
          provider: resource.provider as OAuthProvider,
          accessToken,
          externalId: resource.externalId
        });
        if (liveContent) {
          enrichedContent = liveContent + (enrichedContent ? `\n\nДополнительное описание: ${enrichedContent}` : "");
        }
      }
    }
  }

  const result = await analyzeExternalResourceFit({
    planTitle: plan.title,
    categoryLabel: categories[plan.category as Category],
    milestones: plan.milestones,
    steps: (plan.steps || []).map((step) => ({ title: step.title, description: step.description, deadline: step.deadline })),
    resourceTitle: resource.title,
    provider: resource.provider,
    resourceType: resource.resourceType,
    externalUrl: resource.externalUrl,
    contentSummary: enrichedContent
  });

  const check = await ExternalResourceAiCheckModel.create({
    resourceId: resource._id,
    planId: plan._id,
    createdBy: req.user!._id,
    matchScore: result.matchScore,
    riskLevel: result.riskLevel,
    summary: result.summary,
    matchedSteps: result.matchedSteps,
    missingRequirements: result.missingRequirements,
    suggestedActions: result.suggestedActions,
    rawResponse: result.rawResponse
  });

  resource.lastAiCheckAt = new Date();
  await resource.save();

  await AuditLogModel.create({
    actorId: req.user!._id,
    action: "external_resource_ai_checked",
    entityType: "external_resource",
    entityId: resource.id,
    category: resource.category,
    message: `AI проверил внешний ресурс "${resource.title}" на соответствие плану "${plan.title}"`,
    meta: { matchScore: check.matchScore, riskLevel: check.riskLevel, contentFetched: enrichedContent.length > 0 }
  });

  res.status(201).json(serializeCheck(check));
});
