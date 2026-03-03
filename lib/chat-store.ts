import "server-only";

import type { UIMessagePart } from "ai";
import {
  inferChartSpecsFromBulletListText,
  inferChartSpecsFromContextSheets,
  inferChartSpecsFromInlineSeriesText,
  inferChartSpecsFromTableText,
} from "@/lib/charts/context";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getProviderSessionByChatId,
} from "@/lib/db/queries";
import { parseBqContextFromText, parseExportAwareText } from "@/lib/export-context";
import {
  type BigQueryChatMessageRow,
  countUserMessagesSince,
  getBigQueryAccessToken,
  getChatMessageById,
  querySessionMessages,
  softDeleteMessagesAfterTimestamp,
  softDeleteSessionMessages,
  upsertChatMessageRow,
} from "@/lib/gcp/bigquery";
import {
  collapseAssistantResponseRegenerations,
  dedupeChatAssistantMessages,
} from "@/lib/messages/dedupe";
import type { ChatMessage, ChatTools, CustomUIDataTypes } from "@/lib/types";
import { sanitizeText } from "@/lib/utils";

const AGENT_ENGINE_PROVIDER = "google-agent-engine";
const INCOMPLETE_CHART_WARNINGS = new Set([
  "bloco de grafico incompleto.",
  "bloco chart_context incompleto.",
]);

type UIChatPart = UIMessagePart<CustomUIDataTypes, ChatTools>;

type PersistChatMessageParams = {
  chatId: string;
  sessionId: string;
  userId: string;
  message: ChatMessage;
  visibility?: "private" | "public";
  chartSpec?: unknown;
  chartError?: string | null;
  answeredIn?: number | null;
  isDeleted?: boolean;
};

type MessageReference = {
  chatId: string;
  sessionId: string;
  createdAt: Date;
};

const MESSAGE_COUNT_FALLBACK_LOG_COOLDOWN_MS = 60_000;
let lastMessageCountFallbackLogAtMs = 0;

function getDistinctUserIds(userId: string, fallbackUserId?: string) {
  return [...new Set([userId, fallbackUserId].filter(Boolean) as string[])];
}

function parseCreatedAtFromMetadata(message: ChatMessage) {
  if (message.metadata?.createdAt) {
    const parsed = new Date(message.metadata.createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function parseSortableTimestamp(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getPlainTextFromMessage(message: ChatMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => sanitizeText(part.text))
    .join("\n")
    .trim();
}

function extractAttachmentsFromMessage(message: ChatMessage) {
  return message.parts
    .filter((part) => part.type === "file")
    .map((part) => ({
      url: part.url,
      name:
        ("name" in part && typeof part.name === "string" && part.name) ||
        ("filename" in part &&
          typeof part.filename === "string" &&
          part.filename) ||
        "file",
      contentType:
        ("mediaType" in part &&
          typeof part.mediaType === "string" &&
          part.mediaType) ||
        "application/octet-stream",
    }));
}

function parseJsonString<T>(value: string | null | undefined): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeParsedParts(value: unknown): UIChatPart[] | null {
  if (Array.isArray(value)) {
    return value as UIChatPart[];
  }

  if (!isRecord(value)) {
    return null;
  }

  if (Array.isArray(value.parts)) {
    return value.parts as UIChatPart[];
  }

  if (typeof value.text === "string" && value.text.trim()) {
    return [{ type: "text", text: value.text }] as UIChatPart[];
  }

  if (typeof value.content === "string" && value.content.trim()) {
    return [{ type: "text", text: value.content }] as UIChatPart[];
  }

  return null;
}

function hasPartType(parts: UIChatPart[], type: string) {
  return parts.some((part) => part.type === type);
}

function extractTextFromParts(parts: UIChatPart[]) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function normalizeChartError(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}

function hydrateAssistantPartsFromRow({
  parts,
  row,
}: {
  parts: UIChatPart[];
  row: BigQueryChatMessageRow;
}) {
  const hydratedParts = [...parts];
  const hasChartSpecPart =
    hasPartType(hydratedParts, "data-chart-spec") ||
    hasPartType(hydratedParts, "data-chart-specs");
  const hasChartWarningPart = hasPartType(hydratedParts, "data-chart-warning");
  const hasExportContextPart = hasPartType(hydratedParts, "data-export-context");
  const hasExportHintPart = hasPartType(hydratedParts, "data-export-hint");
  const chartSpecFromRow = parseJsonString<unknown>(row.chart_spec_json);

  if (
    !hasChartSpecPart &&
    chartSpecFromRow &&
    typeof chartSpecFromRow === "object"
  ) {
    hydratedParts.push({
      type: "data-chart-spec",
      data: chartSpecFromRow,
    } as UIChatPart);
  }

  const text = extractTextFromParts(hydratedParts);
  const parsedBqContext = parseBqContextFromText(text);
  const parsedExportAwareText = parseExportAwareText(text);
  const contextSheets =
    parsedBqContext.contextSheets.length > 0
      ? parsedBqContext.contextSheets
      : parsedExportAwareText.contextSheets;
  const hasChartIntent =
    /\b(gr[a\u00e1]fic(?:o|a)|chart|plot|visualiza(?:r|c(?:ao|[\u00e7c][\u00e3a]o)))\b/i.test(
      text
    );

  if (!hasExportContextPart && contextSheets.length > 0) {
    hydratedParts.push({
      type: "data-export-context",
      data: contextSheets,
    } as UIChatPart);
  }

  if (!hasExportHintPart && parsedExportAwareText.exportData) {
    hydratedParts.push({
      type: "data-export-hint",
      data: {
        filename: parsedExportAwareText.exportData.filename,
        description: parsedExportAwareText.exportData.description,
      },
    } as UIChatPart);
  }

  if (
    !hasChartSpecPart &&
    (!chartSpecFromRow || typeof chartSpecFromRow !== "object") &&
    (contextSheets.length > 0 || hasChartIntent || Boolean(row.chart_error))
  ) {
    const visibleText =
      parsedExportAwareText.cleanText.trim() ||
      parsedBqContext.cleanText.trim() ||
      text;
    const inferredFromContext = inferChartSpecsFromContextSheets(contextSheets);
    const inferredFromTable =
      inferredFromContext.length > 0
        ? []
        : inferChartSpecsFromTableText(visibleText);
    const inferredFromInline =
      inferredFromContext.length > 0 || inferredFromTable.length > 0
        ? []
        : inferChartSpecsFromInlineSeriesText(visibleText);
    const inferredFromBullets =
      inferredFromContext.length > 0 ||
      inferredFromTable.length > 0 ||
      inferredFromInline.length > 0
        ? []
        : inferChartSpecsFromBulletListText(visibleText);
    const inferredSpecs =
      inferredFromContext.length > 0
        ? inferredFromContext
        : inferredFromTable.length > 0
          ? inferredFromTable
          : inferredFromInline.length > 0
            ? inferredFromInline
            : inferredFromBullets;

    if (inferredSpecs.length > 1) {
      hydratedParts.push({
        type: "data-chart-specs",
        data: inferredSpecs,
      } as UIChatPart);
    } else if (inferredSpecs.length === 1) {
      hydratedParts.push({
        type: "data-chart-spec",
        data: inferredSpecs[0],
      } as UIChatPart);
    }
  }

  if (!hasChartWarningPart && row.chart_error) {
    const normalizedChartError = normalizeChartError(row.chart_error);

    if (!INCOMPLETE_CHART_WARNINGS.has(normalizedChartError)) {
      hydratedParts.push({
        type: "data-chart-warning",
        data: row.chart_error,
      } as UIChatPart);
    }
  }

  return hydratedParts;
}

function toChatMessageFromBigQueryRow(
  row: BigQueryChatMessageRow
): ChatMessage {
  const parsedParts = normalizeParsedParts(parseJsonString<unknown>(row.parts_json));
  const fallbackParts: UIChatPart[] =
    row.content ? [{ type: "text", text: row.content }] : [];
  const role = (row.role as ChatMessage["role"]) || "assistant";
  const rawParts = parsedParts ?? fallbackParts;
  const parts =
    role === "assistant"
      ? hydrateAssistantPartsFromRow({ parts: rawParts, row })
      : rawParts;
  const createdAtIso =
    row.created_at && !Number.isNaN(new Date(row.created_at).getTime())
      ? new Date(row.created_at).toISOString()
      : new Date().toISOString();
  const chartSpecFromRow = parseJsonString(row.chart_spec_json);
  const chartSpecFromParts =
    (parts.find((part) => part.type === "data-chart-spec") as
      | { type: "data-chart-spec"; data?: unknown }
      | undefined)?.data ??
    (parts.find((part) => part.type === "data-chart-specs") as
      | { type: "data-chart-specs"; data?: unknown }
      | undefined)?.data;
  const chartSpec =
    chartSpecFromRow && typeof chartSpecFromRow === "object"
      ? chartSpecFromRow
      : Array.isArray(chartSpecFromParts)
        ? chartSpecFromParts[0]
        : chartSpecFromParts;
  const chartWarningFromParts = (parts.find(
    (part) => part.type === "data-chart-warning"
  ) as { type: "data-chart-warning"; data?: unknown } | undefined)?.data;

  return {
    id: row.message_id,
    role,
    parts,
    metadata: {
      createdAt: createdAtIso,
      sessionId: row.session_id || undefined,
      chartSpec: chartSpec as any,
      chartError:
        (typeof chartWarningFromParts === "string"
          ? chartWarningFromParts
          : row.chart_error) ?? null,
    },
  };
}

function toBigQueryMessageRow({
  chatId,
  sessionId,
  userId,
  message,
  visibility,
  chartSpec,
  chartError,
  answeredIn,
  isDeleted,
  createdAt,
}: PersistChatMessageParams & { createdAt: Date }): BigQueryChatMessageRow {
  const parts = message.parts ?? [];
  const attachments = extractAttachmentsFromMessage(message);

  return {
    message_id: message.id,
    // Keep chat_id for internal chat lookups while session_id tracks provider session.
    session_id: sessionId,
    chat_id: chatId,
    user_id: userId,
    role: message.role,
    content: getPlainTextFromMessage(message),
    created_at: createdAt.toISOString(),
    updated_at: new Date().toISOString(),
    parts_json: JSON.stringify(parts),
    attachments_json: JSON.stringify(attachments),
    chart_spec_json:
      chartSpec === undefined || chartSpec === null
        ? null
        : JSON.stringify(chartSpec),
    chart_error: chartError ?? null,
    answered_in: answeredIn ?? null,
    visibility: visibility ?? null,
    is_deleted: isDeleted ?? false,
  };
}

export async function persistMessageToBigQuery(
  params: PersistChatMessageParams
) {
  try {
    if (!params.sessionId.trim()) {
      throw new Error("Missing session id for message persistence.");
    }

    const createdAt = parseCreatedAtFromMetadata(params.message);
    const accessToken = await getBigQueryAccessToken();
    const row = toBigQueryMessageRow({ ...params, createdAt });

    await upsertChatMessageRow(accessToken, row);
  } catch (error) {
    console.error("Failed to persist chat message to BigQuery:", error);
  }
}

export async function getChatMessagesByChatId({
  chatId,
  userId,
  fallbackUserId,
  dedupeAssistantDuplicates = false,
}: {
  chatId: string;
  userId: string;
  fallbackUserId?: string;
  dedupeAssistantDuplicates?: boolean;
}): Promise<ChatMessage[]> {
  try {
    const accessToken = await getBigQueryAccessToken();

    const userIds = getDistinctUserIds(userId, fallbackUserId);
    if (userIds.length === 0) {
      return [];
    }

    const messagesById = new Map<string, BigQueryChatMessageRow>();
    let providerSessionId: string | null = null;

    // ── Primary lookup: query by chatId (matches chat_id or session_id) ──
    for (const candidateUserId of userIds) {
      const candidateRows = await querySessionMessages(
        accessToken,
        candidateUserId,
        chatId
      );

      for (const candidateRow of candidateRows) {
        mergeMessageRow(messagesById, candidateRow);
      }
    }

    // Merge provider-session rows as well so legacy messages stored only under
    // provider `session_id` are not missed when loading by `chat_id`.
    try {
      const providerSession = await getProviderSessionByChatId({
        chatId,
        provider: AGENT_ENGINE_PROVIDER,
      });
      providerSessionId = providerSession?.sessionId ?? null;
    } catch (providerError) {
      console.warn(
        "[getChatMessagesByChatId] Provider session lookup failed:",
        providerError
      );
    }

    if (providerSessionId && providerSessionId !== chatId) {
      console.log(
        messagesById.size === 0
          ? "[getChatMessagesByChatId] No messages found by chatId, retrying with provider sessionId."
          : "[getChatMessagesByChatId] Merging additional rows from provider sessionId.",
        { chatId, providerSessionId }
      );

      for (const candidateUserId of userIds) {
        const candidateRows = await querySessionMessages(
          accessToken,
          candidateUserId,
          providerSessionId
        );

        for (const candidateRow of candidateRows) {
          mergeMessageRow(messagesById, candidateRow);
        }
      }
    }

    const messages = [...messagesById.values()]
      .sort((messageA, messageB) => {
        const messageATimestamp = parseSortableTimestamp(messageA.created_at);
        const messageBTimestamp = parseSortableTimestamp(messageB.created_at);
        return messageATimestamp - messageBTimestamp;
      })
      .map((row) => toChatMessageFromBigQueryRow(row));
    const visibleMessages = collapseAssistantResponseRegenerations(messages);

    if (!dedupeAssistantDuplicates) {
      return visibleMessages;
    }

    return dedupeChatAssistantMessages(visibleMessages);
  } catch (error) {
    console.error("Failed to load chat messages from BigQuery:", error);
    return [];
  }
}

function getRowRichnessScore(row: BigQueryChatMessageRow) {
  let score = 0;
  const partsJson = row.parts_json?.trim() ?? "";
  const chartSpecJson = row.chart_spec_json?.trim() ?? "";

  if (partsJson && partsJson !== "[]" && partsJson !== "{}") {
    score += 1;
  }

  if (partsJson.includes('"type":"data-chart-specs"')) {
    score += 6;
  }

  if (partsJson.includes('"type":"data-chart-spec"')) {
    score += 5;
  }

  if (partsJson.includes('"type":"data-export-context"')) {
    score += 4;
  }

  if (partsJson.includes('"type":"data-export-hint"')) {
    score += 3;
  }

  if (chartSpecJson && chartSpecJson !== "null") {
    score += 4;
  }

  if ((row.chart_error ?? "").trim().length > 0) {
    score += 1;
  }

  return score;
}

function mergeMessageRow(
  messagesById: Map<string, BigQueryChatMessageRow>,
  candidateRow: BigQueryChatMessageRow
) {
  const existingRow = messagesById.get(candidateRow.message_id);
  if (!existingRow) {
    messagesById.set(candidateRow.message_id, candidateRow);
    return;
  }

  const existingUpdatedAt = parseSortableTimestamp(existingRow.updated_at);
  const nextUpdatedAt = parseSortableTimestamp(candidateRow.updated_at);
  const existingCreatedAt = parseSortableTimestamp(existingRow.created_at);
  const nextCreatedAt = parseSortableTimestamp(candidateRow.created_at);
  const existingRichnessScore = getRowRichnessScore(existingRow);
  const nextRichnessScore = getRowRichnessScore(candidateRow);
  const existingContent = sanitizeText(existingRow.content ?? "").trim();
  const nextContent = sanitizeText(candidateRow.content ?? "").trim();
  const sameContent =
    existingContent.length > 0 &&
    nextContent.length > 0 &&
    existingContent === nextContent;

  if (
    nextUpdatedAt > existingUpdatedAt ||
    (nextUpdatedAt === existingUpdatedAt &&
      nextCreatedAt > existingCreatedAt) ||
    (nextUpdatedAt === existingUpdatedAt &&
      nextCreatedAt === existingCreatedAt &&
      nextRichnessScore > existingRichnessScore) ||
    (sameContent && nextRichnessScore > existingRichnessScore)
  ) {
    messagesById.set(candidateRow.message_id, candidateRow);
  }
}

export async function countRecentUserMessages({
  userId,
  fallbackUserId,
  differenceInHours,
}: {
  userId: string;
  fallbackUserId?: string;
  differenceInHours: number;
}) {
  try {
    const accessToken = await getBigQueryAccessToken();
    const threshold = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    ).toISOString();

    const userIds = getDistinctUserIds(userId, fallbackUserId);
    let total = 0;

    for (const candidateUserId of userIds) {
      total += await countUserMessagesSince(
        accessToken,
        candidateUserId,
        threshold
      );
    }

    return total;
  } catch (error) {
    const now = Date.now();
    if (
      now - lastMessageCountFallbackLogAtMs >=
      MESSAGE_COUNT_FALLBACK_LOG_COOLDOWN_MS
    ) {
      lastMessageCountFallbackLogAtMs = now;
      console.warn(
        "Failed to count messages in BigQuery, falling back:",
        error
      );
    }
    return 0;
  }
}

export async function findMessageReferenceById({
  messageId,
  userId,
  fallbackUserId,
}: {
  messageId: string;
  userId: string;
  fallbackUserId?: string;
}): Promise<MessageReference | null> {
  try {
    const accessToken = await getBigQueryAccessToken();

    const userIds = getDistinctUserIds(userId, fallbackUserId);
    let message: BigQueryChatMessageRow | null = null;

    for (const candidateUserId of userIds) {
      message = await getChatMessageById(accessToken, candidateUserId, messageId);
      if (message) {
        break;
      }
    }

    if (message?.session_id && message.created_at) {
      const createdAt = new Date(message.created_at);
      if (!Number.isNaN(createdAt.getTime())) {
        return {
          chatId: message.chat_id || message.session_id,
          sessionId: message.session_id,
          createdAt,
        };
      }
    }
  } catch (error) {
    console.error("Failed to resolve message reference from BigQuery:", error);
  }
  return null;
}

export async function deleteTrailingMessagesByTimestamp({
  chatId,
  userId,
  fallbackUserId,
  timestamp,
}: {
  chatId: string;
  userId: string;
  fallbackUserId?: string;
  timestamp: Date;
}) {
  try {
    const accessToken = await getBigQueryAccessToken();
    const userIds = getDistinctUserIds(userId, fallbackUserId);

    for (const candidateUserId of userIds) {
      await softDeleteMessagesAfterTimestamp(
        accessToken,
        candidateUserId,
        chatId,
        timestamp.toISOString()
      );
    }
  } catch (error) {
    console.error(
      "Failed to soft delete trailing messages in BigQuery:",
      error
    );
  }

  await deleteMessagesByChatIdAfterTimestamp({ chatId, timestamp });
}

export async function softDeleteSessionMessagesByChatId({
  chatId,
  userId,
  fallbackUserId,
}: {
  chatId: string;
  userId: string;
  fallbackUserId?: string;
}) {
  try {
    const accessToken = await getBigQueryAccessToken();
    const userIds = getDistinctUserIds(userId, fallbackUserId);

    for (const candidateUserId of userIds) {
      await softDeleteSessionMessages(accessToken, candidateUserId, chatId);
    }
  } catch (error) {
    console.error("Failed to soft delete chat messages in BigQuery:", error);
  }
}
