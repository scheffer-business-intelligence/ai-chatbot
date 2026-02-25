import "server-only";

import type { UIMessagePart } from "ai";
import { deleteMessagesByChatIdAfterTimestamp } from "@/lib/db/queries";
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
import type { ChatMessage, ChatTools, CustomUIDataTypes } from "@/lib/types";
import { sanitizeText } from "@/lib/utils";

type PersistChatMessageParams = {
  chatId: string;
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

function toChatMessageFromBigQueryRow(
  row: BigQueryChatMessageRow
): ChatMessage {
  const parsedParts = parseJsonString<
    UIMessagePart<CustomUIDataTypes, ChatTools>[]
  >(row.parts_json);
  const fallbackParts: UIMessagePart<CustomUIDataTypes, ChatTools>[] =
    row.content ? [{ type: "text", text: row.content }] : [];
  const parts =
    parsedParts && Array.isArray(parsedParts) ? parsedParts : fallbackParts;
  const createdAtIso =
    row.created_at && !Number.isNaN(new Date(row.created_at).getTime())
      ? new Date(row.created_at).toISOString()
      : new Date().toISOString();
  const chartSpec = parseJsonString(row.chart_spec_json);

  return {
    id: row.message_id,
    role: (row.role as ChatMessage["role"]) || "assistant",
    parts,
    metadata: {
      createdAt: createdAtIso,
      chartSpec: chartSpec as any,
      chartError: row.chart_error,
    },
  };
}

function toBigQueryMessageRow({
  chatId,
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
    session_id: chatId,
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
}: {
  chatId: string;
  userId: string;
  fallbackUserId?: string;
}): Promise<ChatMessage[]> {
  try {
    const accessToken = await getBigQueryAccessToken();

    const userIds = getDistinctUserIds(userId, fallbackUserId);
    if (userIds.length === 0) {
      return [];
    }

    const messagesById = new Map<string, BigQueryChatMessageRow>();

    for (const candidateUserId of userIds) {
      const candidateRows = await querySessionMessages(
        accessToken,
        candidateUserId,
        chatId
      );

      for (const candidateRow of candidateRows) {
        const existingRow = messagesById.get(candidateRow.message_id);
        if (!existingRow) {
          messagesById.set(candidateRow.message_id, candidateRow);
          continue;
        }

        const existingUpdatedAt = parseSortableTimestamp(existingRow.updated_at);
        const nextUpdatedAt = parseSortableTimestamp(candidateRow.updated_at);
        const existingCreatedAt = parseSortableTimestamp(existingRow.created_at);
        const nextCreatedAt = parseSortableTimestamp(candidateRow.created_at);

        if (
          nextUpdatedAt > existingUpdatedAt ||
          (nextUpdatedAt === existingUpdatedAt &&
            nextCreatedAt > existingCreatedAt)
        ) {
          messagesById.set(candidateRow.message_id, candidateRow);
        }
      }
    }

    return [...messagesById.values()]
      .sort((messageA, messageB) => {
        const messageATimestamp = parseSortableTimestamp(messageA.created_at);
        const messageBTimestamp = parseSortableTimestamp(messageB.created_at);
        return messageATimestamp - messageBTimestamp;
      })
      .map((row) => toChatMessageFromBigQueryRow(row));
  } catch (error) {
    console.error("Failed to load chat messages from BigQuery:", error);
    return [];
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
          chatId: message.session_id,
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
