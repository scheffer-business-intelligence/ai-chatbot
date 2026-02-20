import type {
  AssistantModelMessage,
  ToolModelMessage,
  UIMessage,
  UIMessagePart,
} from 'ai';
import { type ClassValue, clsx } from 'clsx';
import { formatISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';
import type { DBMessage, Document } from '@/lib/db/schema';
import { ChatSDKError, type ErrorCode } from './errors';
import type {
  ChatMessage,
  ChatTools,
  CustomUIDataTypes,
  MessageMetadata,
} from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    const { code, cause } = await response.json();
    throw new ChatSDKError(code as ErrorCode, cause);
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatSDKError(code as ErrorCode, cause);
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new ChatSDKError('offline:chat');
    }

    throw error;
  }
}

export function getLocalStorage(key: string) {
  if (typeof window !== 'undefined') {
    return JSON.parse(localStorage.getItem(key) || '[]');
  }
  return [];
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type ResponseMessageWithoutId = ToolModelMessage | AssistantModelMessage;
type ResponseMessage = ResponseMessageWithoutId & { id: string };

export function getMostRecentUserMessage(messages: UIMessage[]) {
  const userMessages = messages.filter((message) => message.role === 'user');
  return userMessages.at(-1);
}

export function getDocumentTimestampByIndex(
  documents: Document[],
  index: number,
) {
  if (!documents) { return new Date(); }
  if (index > documents.length) { return new Date(); }

  return documents[index].createdAt;
}

export function getTrailingMessageId({
  messages,
}: {
  messages: ResponseMessage[];
}): string | null {
  const trailingMessage = messages.at(-1);

  if (!trailingMessage) { return null; }

  return trailingMessage.id;
}

export function sanitizeText(text: string) {
  const bqContextOpenTag = '[BQ_CONTEXT]';
  const bqContextCloseTag = '[/BQ_CONTEXT]';
  const chartContextOpenTag = '[CHART_CONTEXT]';
  const chartContextCloseTag = '[/CHART_CONTEXT]';

  const getTrailingTagPrefixLength = (value: string, tag: string) => {
    const maxLength = Math.min(value.length, tag.length - 1);

    for (let length = maxLength; length > 0; length -= 1) {
      if (value.endsWith(tag.slice(0, length))) {
        return length;
      }
    }

    return 0;
  };

  const stripTrailingPartialTag = (value: string, tag: string) => {
    const partialLength = getTrailingTagPrefixLength(value, tag);
    if (partialLength === 0) {
      return value;
    }

    return value.slice(0, value.length - partialLength);
  };

  const withoutContextBlocks = text
    .replace(/\[BQ_CONTEXT\][\s\S]*?\[\/BQ_CONTEXT\]/g, '')
    .replace(/\[BQ_CONTEXT\][\s\S]*$/g, '')
    .replace(/\[\/BQ_CONTEXT\]/g, '')
    .replace(/\[CHART_CONTEXT\][\s\S]*?\[\/CHART_CONTEXT\]/g, '')
    .replace(/\[CHART_CONTEXT\][\s\S]*$/g, '')
    .replace(/\[\/CHART_CONTEXT\]/g, '');

  return stripTrailingPartialTag(
    stripTrailingPartialTag(
      stripTrailingPartialTag(
        stripTrailingPartialTag(
          withoutContextBlocks.replace('<has_function_call>', ''),
          chartContextOpenTag,
        ),
        chartContextCloseTag,
      ),
      bqContextOpenTag,
    ),
    bqContextCloseTag,
  );
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const metadata: MessageMetadata = {
      createdAt: formatISO(message.createdAt),
      chartSpec: (message.chartSpec as MessageMetadata['chartSpec']) ?? null,
      chartError: message.chartError ?? null,
    };

    return {
      id: message.id,
      role: message.role as 'user' | 'assistant' | 'system',
      parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
      metadata,
    };
  });
}

export function getTextFromMessage(message: ChatMessage | UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string}).text)
    .join('');
}
