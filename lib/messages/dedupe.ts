import type { DBMessage } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";

export const ASSISTANT_DUPLICATE_WINDOW_MS = 10_000;

type MessageShape = {
  role: string;
  text: string;
  timestampMs: number | null;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  const text = parts
    .filter(
      (
        part
      ): part is {
        type?: unknown;
        text?: unknown;
      } => Boolean(part && typeof part === "object")
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");

  return normalizeText(text);
}

function parseTimestampMs(value: Date | string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  const timestampMs = date.getTime();
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function isAssistantDuplicate(
  previous: MessageShape,
  current: MessageShape,
  windowMs: number
) {
  if (previous.role !== "assistant" || current.role !== "assistant") {
    return false;
  }

  if (!previous.text || !current.text || previous.text !== current.text) {
    return false;
  }

  if (previous.timestampMs === null || current.timestampMs === null) {
    return false;
  }

  return Math.abs(current.timestampMs - previous.timestampMs) <= windowMs;
}

function dedupeAssistantMessagesWithWindow<T>({
  messages,
  getShape,
  windowMs,
}: {
  messages: T[];
  getShape: (message: T) => MessageShape;
  windowMs: number;
}) {
  const deduped: T[] = [];
  let previousShape: MessageShape | null = null;

  for (const message of messages) {
    const currentShape = getShape(message);

    if (
      previousShape &&
      isAssistantDuplicate(previousShape, currentShape, windowMs)
    ) {
      continue;
    }

    deduped.push(message);
    previousShape = currentShape;
  }

  return deduped;
}

export function dedupeChatAssistantMessages(
  messages: ChatMessage[],
  windowMs = ASSISTANT_DUPLICATE_WINDOW_MS
) {
  return dedupeAssistantMessagesWithWindow({
    messages,
    windowMs,
    getShape: (message) => ({
      role: message.role,
      text: extractTextFromParts(message.parts),
      timestampMs: parseTimestampMs(message.metadata?.createdAt),
    }),
  });
}

export function dedupeDbAssistantMessages(
  messages: DBMessage[],
  windowMs = ASSISTANT_DUPLICATE_WINDOW_MS
) {
  return dedupeAssistantMessagesWithWindow({
    messages,
    windowMs,
    getShape: (message) => ({
      role: message.role,
      text: extractTextFromParts(message.parts),
      timestampMs: parseTimestampMs(message.createdAt),
    }),
  });
}
