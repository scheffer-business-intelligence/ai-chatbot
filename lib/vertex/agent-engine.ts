import { parseChartContextFromText } from "@/lib/charts/context";
import type { ChartSpecV1 } from "@/lib/charts/schema";
import {
  type ExportContextSheet,
  parseBqContextFromText,
} from "@/lib/export-context";
import { sanitizeText } from "@/lib/utils";

export const AGENT_ENGINE_PROVIDER_ID = "google-agent-engine";
export const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || "";
export const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";
export const VERTEX_REASONING_ENGINE =
  process.env.VERTEX_REASONING_ENGINE || "";

export type VertexExtractedContext = {
  chartSpec: ChartSpecV1 | null;
  chartError: string | null;
  hasChartContext: boolean;
  contextSheets: ExportContextSheet[];
};

export type VertexStreamEvent =
  | { type: "status"; status: string }
  | { type: "text"; delta: string };

const DEFAULT_AGENT_STATUS_PREFIXES = [
  "Processando sua solicitação...",
  "Ativando o agente especialista",
  "Ativando a agente especialista",
  "Obtendo os dados...",
  "Dados obtidos com sucesso!",
  "Dados obtidos com sucesso",
  "Gerando resposta...",
];

function getBaseVertexUrl(engineId: string) {
  return `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/reasoningEngines/${engineId}`;
}

function extractTextFromContent(content: unknown): string | null {
  if (!content) {
    return null;
  }
  if (typeof content === "string") {
    return content.trim() ? content : null;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];

    for (const item of content) {
      const itemText = extractTextFromContent(item);
      if (itemText) {
        texts.push(itemText);
      }
    }

    if (texts.length > 0) {
      return texts.join("");
    }

    return null;
  }
  if (typeof content !== "object") {
    return null;
  }

  const record = content as Record<string, unknown>;
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text;
  }

  if (Array.isArray(record.parts)) {
    const texts: string[] = [];

    for (const part of record.parts) {
      if (typeof part !== "object" || !part) {
        continue;
      }
      const partText = (part as { text?: string }).text;
      if (partText) {
        texts.push(partText);
      }
    }

    if (texts.length > 0) {
      return texts.join("");
    }
  }

  return null;
}

function extractLatestAssistantText(
  messages: unknown[] | undefined
): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  let latest: string | null = null;

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : undefined;
    const author =
      typeof record.author === "string" ? record.author : undefined;
    const contentRole =
      typeof record.content === "object" &&
      record.content &&
      typeof (record.content as { role?: unknown }).role === "string"
        ? ((record.content as { role: string }).role as string)
        : undefined;

    const normalizedRole = role ?? author ?? contentRole;

    if (normalizedRole === "user") {
      continue;
    }

    const text =
      extractTextFromContent(record.content) ||
      extractTextFromContent(record.message) ||
      extractTextFromContent(record);

    if (text) {
      latest = text;
    }
  }

  return latest;
}

function extractTextFromCandidates(
  candidates: unknown[] | undefined
): string | null {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const text =
      extractTextFromContent(record.content) ||
      extractTextFromContent(record.message) ||
      extractTextFromContent(record);

    if (text) {
      return text;
    }
  }

  return null;
}

function extractTextDeep(node: unknown, depth = 0): string | null {
  if (!node || depth > 6) {
    return null;
  }
  if (typeof node === "string") {
    return node.trim() ? node : null;
  }
  if (typeof node !== "object") {
    return null;
  }

  if (Array.isArray(node)) {
    let latest: string | null = null;
    for (const item of node) {
      const found = extractTextDeep(item, depth + 1);
      if (found) {
        latest = found;
      }
    }
    return latest;
  }

  const record = node as Record<string, unknown>;

  const messageText = extractLatestAssistantText(
    record.messages as unknown[] | undefined
  );
  if (messageText) {
    return messageText;
  }

  const candidateText = extractTextFromCandidates(
    record.candidates as unknown[] | undefined
  );
  if (candidateText) {
    return candidateText;
  }

  const contentText =
    extractTextFromContent(record.content) ||
    extractTextFromContent(record.message) ||
    extractTextFromContent(record);
  if (contentText) {
    return contentText;
  }

  for (const key of ["response", "output"]) {
    if (!(key in record)) {
      continue;
    }
    const found = extractTextDeep(record[key], depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

function extractTextFromVertexResponse(
  data: Record<string, unknown>
): string | null {
  const response = data.response as Record<string, unknown> | undefined;
  const responseOutput = response?.output as
    | Record<string, unknown>
    | undefined;
  const output = data.output as Record<string, unknown> | undefined;

  const messageText =
    extractLatestAssistantText(response?.messages as unknown[] | undefined) ||
    extractLatestAssistantText(data.messages as unknown[] | undefined) ||
    extractLatestAssistantText(
      responseOutput?.messages as unknown[] | undefined
    ) ||
    extractLatestAssistantText(output?.messages as unknown[] | undefined);
  if (messageText) {
    return messageText;
  }

  const candidateText =
    extractTextFromCandidates(response?.candidates as unknown[] | undefined) ||
    extractTextFromCandidates(data.candidates as unknown[] | undefined) ||
    extractTextFromCandidates(
      responseOutput?.candidates as unknown[] | undefined
    ) ||
    extractTextFromCandidates(output?.candidates as unknown[] | undefined);
  if (candidateText) {
    return candidateText;
  }

  const contentText =
    extractTextFromContent(data.content) ||
    extractTextFromContent(response?.content) ||
    extractTextFromContent(responseOutput) ||
    extractTextFromContent(output);
  if (contentText) {
    return contentText;
  }

  return extractTextDeep(response) || extractTextDeep(output);
}

function parseVertexResponsePayloads(
  responseText: string
): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];

  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object") {
          payloads.push(item as Record<string, unknown>);
        }
      }
    } else if (parsed && typeof parsed === "object") {
      payloads.push(parsed as Record<string, unknown>);
    }
  } catch {
    const lines = responseText.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const payload = trimmed.startsWith("data:")
        ? trimmed.replace(/^data:\s*/, "")
        : trimmed;

      if (!payload || payload === "[DONE]") {
        continue;
      }
      if (!payload.startsWith("{") && !payload.startsWith("[")) {
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === "object") {
              payloads.push(item as Record<string, unknown>);
            }
          }
        } else if (parsed && typeof parsed === "object") {
          payloads.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore non-JSON lines.
      }
    }
  }

  return payloads;
}

function normalizeStatusText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ensureStatusSuffix(text: string): string {
  const normalized = normalizeStatusText(text);
  if (!normalized) {
    return normalized;
  }

  if (/[.!?…]$/.test(normalized)) {
    return normalized;
  }

  return `${normalized}...`;
}

type KnownStatusMatch = {
  index: number;
  status: string;
};

function extractKnownStatusesInOrder(text: string): string[] {
  const normalizedText = normalizeStatusText(text);
  if (!normalizedText) {
    return [];
  }

  const patterns: Array<{
    regex: RegExp;
    format: (rawMatch: string) => string;
  }> = [
    {
      regex: /processando sua solicitação\.{0,3}/gi,
      format: (rawMatch) => ensureStatusSuffix(rawMatch),
    },
    {
      regex:
        /ativando(?:\s+(?:o|a))?\s+agente especialista(?:\s*\([^)]+\))?\.{0,3}/gi,
      format: (rawMatch) => ensureStatusSuffix(rawMatch),
    },
    {
      regex: /obtendo os dados\.{0,3}/gi,
      format: (rawMatch) => ensureStatusSuffix(rawMatch),
    },
    {
      regex: /dados obtidos com sucesso!?\.{0,3}/gi,
      format: (rawMatch) => ensureStatusSuffix(rawMatch),
    },
    {
      regex: /gerando resposta\.{0,3}/gi,
      format: (rawMatch) => ensureStatusSuffix(rawMatch),
    },
  ];

  const matches: KnownStatusMatch[] = [];

  for (const pattern of patterns) {
    let match = pattern.regex.exec(normalizedText);
    while (match) {
      const rawMatch = normalizeStatusText(match[0]);
      if (rawMatch) {
        matches.push({
          index: match.index,
          status: pattern.format(rawMatch),
        });
      }

      if (match[0].length === 0) {
        pattern.regex.lastIndex += 1;
      }

      match = pattern.regex.exec(normalizedText);
    }
  }

  if (matches.length === 0) {
    return [];
  }

  matches.sort((a, b) => a.index - b.index);
  const orderedStatuses: string[] = [];
  let previousStatus = "";

  for (const item of matches) {
    if (item.status === previousStatus) {
      continue;
    }

    orderedStatuses.push(item.status);
    previousStatus = item.status;
  }

  return orderedStatuses;
}

function isLikelyStatusText(text: string): boolean {
  if (!text) {
    return false;
  }

  if (text.length > 180) {
    return false;
  }

  if (text.includes("```")) {
    return false;
  }

  if (/^#{1,6}\s/.test(text)) {
    return false;
  }

  if (/^[-*]\s/.test(text)) {
    return false;
  }

  return true;
}

function collectStatusCandidateTexts(node: unknown, depth = 0): string[] {
  if (!node || depth > 6) {
    return [];
  }

  if (typeof node === "string") {
    const normalized = normalizeStatusText(node);
    return normalized ? [normalized] : [];
  }

  if (typeof node !== "object") {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((item) => collectStatusCandidateTexts(item, depth + 1));
  }

  const record = node as Record<string, unknown>;
  const candidates: string[] = [];

  for (const key of [
    "status",
    "statusMessage",
    "status_message",
    "message",
    "text",
    "title",
    "description",
    "detail",
  ]) {
    if (typeof record[key] === "string") {
      const normalized = normalizeStatusText(record[key] as string);
      if (normalized) {
        candidates.push(normalized);
      }
    }
  }

  const contentText = extractTextFromContent(record.content);
  if (contentText) {
    const normalized = normalizeStatusText(contentText);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  for (const key of [
    "event",
    "events",
    "payload",
    "data",
    "result",
    "message",
    "content",
    "parts",
  ]) {
    if (!(key in record)) {
      continue;
    }

    candidates.push(...collectStatusCandidateTexts(record[key], depth + 1));
  }

  return candidates;
}

function extractStatusUpdatesFromVertexResponse(
  data: Record<string, unknown>
): string[] {
  const response = data.response as Record<string, unknown> | undefined;
  const output = data.output as Record<string, unknown> | undefined;
  const sources: unknown[] = [
    data.event,
    data.events,
    response?.event,
    response?.events,
    output?.event,
    output?.events,
  ];

  let latestStatus: string | null = null;

  for (const source of sources) {
    for (const candidate of collectStatusCandidateTexts(source)) {
      const knownStatuses = extractKnownStatusesInOrder(candidate);
      if (knownStatuses.length > 0) {
        latestStatus = knownStatuses.at(-1) ?? latestStatus;
        continue;
      }

      if (isLikelyStatusText(candidate)) {
        latestStatus = ensureStatusSuffix(candidate);
      }
    }
  }

  return latestStatus ? [latestStatus] : [];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingAgentStatuses(
  text: string,
  statusHistory: string[]
): string {
  if (!text) {
    return text;
  }

  const stripKnownStatusTokens = (value: string): string => {
    const knownStatusRegex =
      /^\s*(?:processando sua solicitação|ativando(?:\s+(?:o|a))?\s+agente especialista(?:\s*\([^)]+\))?|obtendo os dados|dados obtidos com sucesso!?|gerando resposta)\s*\.{0,3}\s*/i;
    const agentTagRegex = /^\s*\([^)]+_agent\)\s*\.{0,3}\s*/i;

    let nextValue = value;

    while (true) {
      const withoutAgentTag = nextValue.replace(agentTagRegex, "");
      const withoutKnownStatus = withoutAgentTag.replace(knownStatusRegex, "");

      if (withoutKnownStatus === nextValue) {
        break;
      }

      nextValue = withoutKnownStatus;
    }

    return nextValue.replace(/^\s+/, "");
  };

  let nextText = stripKnownStatusTokens(text);

  const candidates = [...statusHistory, ...DEFAULT_AGENT_STATUS_PREFIXES]
    .flatMap((status) => {
      const knownStatuses = extractKnownStatusesInOrder(status);
      if (knownStatuses.length > 0) {
        return knownStatuses;
      }

      return [ensureStatusSuffix(status)];
    })
    .map((status) => normalizeStatusText(status))
    .filter(Boolean);

  if (candidates.length === 0) {
    return nextText;
  }

  const uniqueCandidates = [...new Set(candidates)].sort(
    (a, b) => b.length - a.length
  );
  const statusPattern = uniqueCandidates.map(escapeRegex).join("|");

  if (!statusPattern) {
    return nextText;
  }

  const leadingStatusesRegex = new RegExp(
    `^(?:\\s*(?:${statusPattern})\\s*)+`,
    "i"
  );

  while (leadingStatusesRegex.test(nextText)) {
    nextText = nextText.replace(leadingStatusesRegex, "").replace(/^\s+/, "");
  }

  return stripKnownStatusTokens(nextText);
}

function stripContextBlock(text: string, tagName: string): string {
  const tag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRegex = new RegExp(
    `(?:\\[\\s*${tag}\\s*\\]|${tag}\\])[\\s\\S]*?\\[\\s*\\/\\s*${tag}\\s*\\]`,
    "gi"
  );
  const danglingOpenRegex = new RegExp(
    `(?:\\[\\s*${tag}\\s*\\]|${tag}\\])[\\s\\S]*$`,
    "i"
  );
  const cleaned = text.replace(blockRegex, "");
  const withoutDanglingOpen = cleaned.replace(danglingOpenRegex, "");

  return withoutDanglingOpen.replace(
    new RegExp(`\\[\\s*\\/\\s*${tag}\\s*\\]`, "gi"),
    ""
  );
}

function stripContextBlocksForStream(text: string): string {
  const withoutBqAndMarkers = sanitizeText(text);
  return stripContextBlock(withoutBqAndMarkers, "CHART_CONTEXT").trimEnd();
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }

  if (typeof error === "string") {
    return error.toLowerCase();
  }

  if (!error || typeof error !== "object") {
    return "";
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return "";
  }
}

const INVALID_VERTEX_SESSION_STATE_MARKERS = [
  "invalid session",
  "session invalid",
  "session expired",
  "session not found",
  "session does not exist",
  "unknown session",
  "invalid_argument",
  "not_found",
  "failed_precondition",
];

const INVALID_VERTEX_SESSION_SCOPE_MARKERS = [
  "session_id",
  "session id",
  '"session"',
  "session",
];

export function isInvalidVertexSessionError(error: unknown): boolean {
  const errorText = toErrorText(error);

  if (!errorText) {
    return false;
  }

  const hasSessionScope = INVALID_VERTEX_SESSION_SCOPE_MARKERS.some((marker) =>
    errorText.includes(marker)
  );

  if (!hasSessionScope) {
    return false;
  }

  const hasInvalidState = INVALID_VERTEX_SESSION_STATE_MARKERS.some((marker) =>
    errorText.includes(marker)
  );

  if (!hasInvalidState) {
    return false;
  }

  return (
    errorText.includes("vertex ai error: 400") ||
    errorText.includes("vertex ai error: 404") ||
    errorText.includes('"code":400') ||
    errorText.includes('"code":404') ||
    errorText.includes('status": "invalid_argument"') ||
    errorText.includes('status": "not_found"') ||
    errorText.includes('status": "failed_precondition"')
  );
}

async function* parseJsonStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let parsedCount = 0;
  const rawPayloadSamples: string[] = [];

  const parsePayload = (payload: string): Record<string, unknown>[] => {
    if (!payload) {
      return [];
    }
    if (payload === "[DONE]") {
      return [];
    }

    try {
      const parsed = JSON.parse(payload) as unknown;

      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item) => item && typeof item === "object"
        ) as Record<string, unknown>[];
      }

      if (parsed && typeof parsed === "object") {
        return [parsed as Record<string, unknown>];
      }
    } catch {
      if (rawPayloadSamples.length < 3) {
        rawPayloadSamples.push(payload.slice(0, 2000));
      }
      return [];
    }

    return [];
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        const payload = line.startsWith("data:")
          ? line.replace(/^data:\s*/, "")
          : line;

        if (payload === "[DONE]") {
          return;
        }

        for (const parsed of parsePayload(payload)) {
          parsedCount += 1;
          yield parsed;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail) {
      const payload = tail.startsWith("data:")
        ? tail.replace(/^data:\s*/, "")
        : tail;

      if (payload !== "[DONE]") {
        for (const parsed of parsePayload(payload)) {
          parsedCount += 1;
          yield parsed;
        }
      }
    }

    if (parsedCount === 0 && rawPayloadSamples.length > 0) {
      console.warn(
        "Vertex stream raw payload sample (no JSON parsed):",
        rawPayloadSamples
      );
    }
  } finally {
    reader.releaseLock();
  }
}

export function getReasoningEngineId(): string {
  if (!VERTEX_REASONING_ENGINE) {
    throw new Error("VERTEX_REASONING_ENGINE is not configured");
  }

  const match = VERTEX_REASONING_ENGINE.match(/reasoningEngines\/(\d+)/);
  return match ? match[1] : VERTEX_REASONING_ENGINE;
}

export async function createVertexSession(
  accessToken: string,
  userId: string
): Promise<string> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error("VERTEX_PROJECT_ID is not configured");
  }

  const engineId = getReasoningEngineId();
  const url = `${getBaseVertexUrl(engineId)}:query`;
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        class_method: "create_session",
        input: { user_id: userId },
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `Failed to reach Vertex create_session (${url}): ${reason}`
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create session: ${response.status} - ${errorText}`
    );
  }

  const data = (await response.json()) as { output?: { id?: string } };
  const sessionId = data.output?.id;

  if (!sessionId) {
    throw new Error("No session ID returned from Vertex AI");
  }

  return sessionId;
}

function computeNextRawText(
  incomingText: string,
  accumulatedRawText: string
): string {
  if (!incomingText) {
    return accumulatedRawText;
  }

  if (!accumulatedRawText) {
    return incomingText;
  }

  if (incomingText.startsWith(accumulatedRawText)) {
    return incomingText;
  }

  if (accumulatedRawText.startsWith(incomingText)) {
    return accumulatedRawText;
  }

  if (accumulatedRawText.includes(incomingText)) {
    return accumulatedRawText;
  }

  if (incomingText.includes(accumulatedRawText)) {
    return incomingText;
  }

  const maxOverlap = Math.min(accumulatedRawText.length, incomingText.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (accumulatedRawText.endsWith(incomingText.slice(0, size))) {
      return `${accumulatedRawText}${incomingText.slice(size)}`;
    }
  }

  return `${accumulatedRawText}${incomingText}`;
}

function extractVisibleDelta(
  nextRawText: string,
  accumulatedVisibleText: string,
  statusHistory: string[]
): { delta: string; nextVisibleText: string } {
  const nextVisibleText = stripLeadingAgentStatuses(
    stripContextBlocksForStream(nextRawText),
    statusHistory
  );

  if (nextVisibleText.startsWith(accumulatedVisibleText)) {
    return {
      delta: nextVisibleText.slice(accumulatedVisibleText.length),
      nextVisibleText,
    };
  }

  return {
    delta: nextVisibleText,
    nextVisibleText,
  };
}

export async function* streamVertexQuery({
  accessToken,
  sessionId,
  userId,
  message,
  signal,
  extractedContext,
}: {
  accessToken: string;
  sessionId: string;
  userId: string;
  message: string | { role: "user"; parts: Record<string, unknown>[] };
  signal?: AbortSignal;
  extractedContext?: VertexExtractedContext;
}): AsyncGenerator<VertexStreamEvent, void, void> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error("VERTEX_PROJECT_ID is not configured");
  }

  const engineId = getReasoningEngineId();
  const url = `${getBaseVertexUrl(engineId)}:streamQuery?alt=sse`;

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      signal,
      body: JSON.stringify({
        class_method: "stream_query",
        input: {
          user_id: userId,
          session_id: sessionId,
          message,
          run_config: { streaming_mode: "sse" },
        },
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to reach Vertex stream_query (${url}): ${reason}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vertex AI error: ${response.status} - ${errorText}`);
  }

  let accumulatedRawText = "";
  let accumulatedVisibleText = "";
  let lastStatus: string | null = null;
  const statusHistory: string[] = [];
  const seenStatuses = new Set<string>();
  const collectNewStatuses = (candidates: string[]): string[] => {
    const nextStatuses: string[] = [];

    for (const candidate of candidates) {
      const normalizedStatus = normalizeStatusText(candidate);
      if (!normalizedStatus || seenStatuses.has(normalizedStatus)) {
        continue;
      }

      seenStatuses.add(normalizedStatus);
      statusHistory.push(normalizedStatus);

      if (normalizedStatus !== lastStatus) {
        nextStatuses.push(normalizedStatus);
        lastStatus = normalizedStatus;
      }
    }

    return nextStatuses;
  };
  const writeExtractedContext = (rawText: string) => {
    if (!extractedContext) {
      return;
    }
    const parsedContext = parseChartContextFromText(rawText);
    const parsedBqContext = parseBqContextFromText(rawText);
    extractedContext.chartSpec = parsedContext.chartSpec;
    extractedContext.chartError = parsedContext.chartError;
    extractedContext.hasChartContext = parsedContext.hasChartContext;
    extractedContext.contextSheets = parsedBqContext.contextSheets;
  };

  if (!response.body) {
    const responseText = await response.text();
    const payloads = parseVertexResponsePayloads(responseText);

    if (payloads.length === 0 && responseText.trim()) {
      console.warn(
        "Vertex streamQuery (no body) raw response sample:",
        responseText.slice(0, 2000)
      );
    }

    for (const payload of payloads) {
      for (const status of collectNewStatuses(
        extractStatusUpdatesFromVertexResponse(payload)
      )) {
        yield { type: "status", status };
      }

      const text = extractTextFromVertexResponse(payload);
      if (!text) {
        continue;
      }

      const nextRawText = computeNextRawText(text, accumulatedRawText);
      const { delta, nextVisibleText } = extractVisibleDelta(
        nextRawText,
        accumulatedVisibleText,
        statusHistory
      );

      accumulatedRawText = nextRawText;
      accumulatedVisibleText = nextVisibleText;

      for (const status of collectNewStatuses(
        extractKnownStatusesInOrder(nextRawText)
      )) {
        yield { type: "status", status };
      }

      if (delta) {
        yield { type: "text", delta };
      }
    }

    writeExtractedContext(accumulatedRawText);

    if (!accumulatedVisibleText.trim()) {
      throw new Error("Vertex AI returned an empty response");
    }

    return;
  }

  const rawSamples: string[] = [];

  for await (const data of parseJsonStream(response.body)) {
    for (const status of collectNewStatuses(
      extractStatusUpdatesFromVertexResponse(data)
    )) {
      yield { type: "status", status };
    }

    const text = extractTextFromVertexResponse(data);
    if (!text) {
      if (rawSamples.length < 3) {
        try {
          rawSamples.push(JSON.stringify(data).slice(0, 2000));
        } catch {
          rawSamples.push(String(data).slice(0, 2000));
        }
      }
      continue;
    }

    const nextRawText = computeNextRawText(text, accumulatedRawText);
    const { delta, nextVisibleText } = extractVisibleDelta(
      nextRawText,
      accumulatedVisibleText,
      statusHistory
    );

    accumulatedRawText = nextRawText;
    accumulatedVisibleText = nextVisibleText;

    for (const status of collectNewStatuses(
      extractKnownStatusesInOrder(nextRawText)
    )) {
      yield { type: "status", status };
    }

    if (delta) {
      yield { type: "text", delta };
    }
  }

  writeExtractedContext(accumulatedRawText);

  if (!accumulatedVisibleText.trim()) {
    if (rawSamples.length > 0) {
      console.warn(
        "Vertex stream payload sample (no text extracted):",
        rawSamples
      );
    }
    throw new Error("Vertex AI returned an empty response");
  }
}
