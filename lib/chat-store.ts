import "server-only";

import type { UIMessagePart } from "ai";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getMessageById,
  getMessageCountByUserId,
  getMessagesByChatId,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
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
import { convertToUIMessages, sanitizeText } from "@/lib/utils";

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

function parseCreatedAtFromMetadata(message: ChatMessage) {
  if (message.metadata?.createdAt) {
    const parsed = new Date(message.metadata.createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
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

function toDbMessage({
  chatId,
  message,
  chartSpec,
  chartError,
  createdAt,
}: {
  chatId: string;
  message: ChatMessage;
  chartSpec?: unknown;
  chartError?: string | null;
  createdAt: Date;
}): DBMessage {
  return {
    id: message.id,
    chatId,
    role: message.role,
    parts: message.parts,
    attachments: extractAttachmentsFromMessage(message),
    chartSpec: (chartSpec ?? null) as DBMessage["chartSpec"],
    chartError: chartError ?? null,
    createdAt,
  };
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

export async function persistMessageToPostgres(
  params: Omit<
    PersistChatMessageParams,
    "visibility" | "answeredIn" | "isDeleted"
  >
) {
  const createdAt = parseCreatedAtFromMetadata(params.message);
  const dbMessage = toDbMessage({
    chatId: params.chatId,
    message: params.message,
    chartSpec: params.chartSpec,
    chartError: params.chartError,
    createdAt,
  });

  const { saveMessages } = await import("@/lib/db/queries");
  await saveMessages({ messages: [dbMessage] });
}

export async function getChatMessagesByChatId({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}): Promise<ChatMessage[]> {
  try {
    const accessToken = await getBigQueryAccessToken();
    const bqMessages = await querySessionMessages(accessToken, userId, chatId);

    if (bqMessages.length > 0) {
      return bqMessages.map((row) => toChatMessageFromBigQueryRow(row));
    }
  } catch (error) {
    console.error("Failed to load chat messages from BigQuery:", error);
  }

  const fallbackMessages = await getMessagesByChatId({ id: chatId });
  return convertToUIMessages(fallbackMessages);
}

export async function countRecentUserMessages({
  userId,
  differenceInHours,
}: {
  userId: string;
  differenceInHours: number;
}) {
  try {
    const accessToken = await getBigQueryAccessToken();
    const threshold = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    ).toISOString();
    const count = await countUserMessagesSince(accessToken, userId, threshold);
    return count;
  } catch (error) {
    console.error("Failed to count messages in BigQuery, falling back:", error);
    return await getMessageCountByUserId({
      id: userId,
      differenceInHours,
    });
  }
}

export async function findMessageReferenceById({
  messageId,
  userId,
}: {
  messageId: string;
  userId: string;
}): Promise<MessageReference | null> {
  try {
    const accessToken = await getBigQueryAccessToken();
    const message = await getChatMessageById(accessToken, userId, messageId);

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

  const fallbackMessage = await getMessageById({ id: messageId });
  const messageFromDb = fallbackMessage[0];

  if (!messageFromDb) {
    return null;
  }

  return {
    chatId: messageFromDb.chatId,
    createdAt: messageFromDb.createdAt,
  };
}

export async function deleteTrailingMessagesByTimestamp({
  chatId,
  userId,
  timestamp,
}: {
  chatId: string;
  userId: string;
  timestamp: Date;
}) {
  try {
    const accessToken = await getBigQueryAccessToken();
    await softDeleteMessagesAfterTimestamp(
      accessToken,
      userId,
      chatId,
      timestamp.toISOString()
    );
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
}: {
  chatId: string;
  userId: string;
}) {
  try {
    const accessToken = await getBigQueryAccessToken();
    await softDeleteSessionMessages(accessToken, userId, chatId);
  } catch (error) {
    console.error("Failed to soft delete chat messages in BigQuery:", error);
  }
}
