import { parseChartContextFromText } from "@/lib/charts/context";
import type { ChartSpecV1 } from "@/lib/charts/schema";
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
};

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

  for (const key of [
    "response",
    "output",
    "event",
    "events",
    "payload",
    "data",
    "result",
  ]) {
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

  return (
    extractTextDeep(response) ||
    extractTextDeep(output) ||
    extractTextDeep(data)
  );
}

function parseVertexResponseText(responseText: string): string[] {
  const allTexts: string[] = [];

  try {
    const data = JSON.parse(responseText) as Record<string, unknown>;
    const text = extractTextFromVertexResponse(data);
    if (text) {
      allTexts.push(text);
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
        const data = JSON.parse(payload) as Record<string, unknown>;
        const text = extractTextFromVertexResponse(data);
        if (text) {
          allTexts.push(text);
        }
      } catch {
        // Ignore non-JSON lines.
      }
    }
  }

  return allTexts;
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
  const response = await fetch(url, {
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

  return `${accumulatedRawText}${incomingText}`;
}

function extractVisibleDelta(
  nextRawText: string,
  accumulatedVisibleText: string
): { delta: string; nextVisibleText: string } {
  const nextVisibleText = stripContextBlocksForStream(nextRawText);

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
}): AsyncGenerator<string, void, void> {
  if (!VERTEX_PROJECT_ID) {
    throw new Error("VERTEX_PROJECT_ID is not configured");
  }

  const engineId = getReasoningEngineId();
  const url = `${getBaseVertexUrl(engineId)}:streamQuery?alt=sse`;

  const response = await fetch(url, {
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

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vertex AI error: ${response.status} - ${errorText}`);
  }

  let accumulatedRawText = "";
  let accumulatedVisibleText = "";
  const writeExtractedContext = (rawText: string) => {
    if (!extractedContext) {
      return;
    }
    const parsedContext = parseChartContextFromText(rawText);
    extractedContext.chartSpec = parsedContext.chartSpec;
    extractedContext.chartError = parsedContext.chartError;
    extractedContext.hasChartContext = parsedContext.hasChartContext;
  };

  if (!response.body) {
    const responseText = await response.text();
    const texts = parseVertexResponseText(responseText);

    if (texts.length === 0 && responseText.trim()) {
      console.warn(
        "Vertex streamQuery (no body) raw response sample:",
        responseText.slice(0, 2000)
      );
    }

    for (const text of texts) {
      const nextRawText = computeNextRawText(text, accumulatedRawText);
      const { delta, nextVisibleText } = extractVisibleDelta(
        nextRawText,
        accumulatedVisibleText
      );

      accumulatedRawText = nextRawText;
      accumulatedVisibleText = nextVisibleText;

      if (delta) {
        yield delta;
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
      accumulatedVisibleText
    );

    accumulatedRawText = nextRawText;
    accumulatedVisibleText = nextVisibleText;

    if (delta) {
      yield delta;
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
