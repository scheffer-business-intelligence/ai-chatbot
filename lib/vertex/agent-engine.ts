export const AGENT_ENGINE_PROVIDER_ID = "google-agent-engine";
export const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || "";
export const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";
export const VERTEX_REASONING_ENGINE =
  process.env.VERTEX_REASONING_ENGINE || "";

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

function isTerminalVertexEvent(data: Record<string, unknown>): boolean {
  const terminalValues = new Set([
    "done",
    "completed",
    "complete",
    "finished",
    "finish",
    "end",
    "ended",
    "succeeded",
    "success",
  ]);

  const isTerminalValue = (value: unknown): boolean => {
    if (value === true) {
      return true;
    }

    if (typeof value === "string") {
      return terminalValues.has(value.toLowerCase());
    }

    return false;
  };

  const checkNode = (node: unknown, depth = 0): boolean => {
    if (!node || depth > 4) {
      return false;
    }

    if (typeof node !== "object") {
      return false;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        if (checkNode(item, depth + 1)) {
          return true;
        }
      }
      return false;
    }

    const record = node as Record<string, unknown>;

    for (const key of [
      "done",
      "isDone",
      "is_done",
      "completed",
      "isComplete",
      "is_complete",
      "finish",
      "finished",
      "status",
      "state",
      "event",
      "type",
    ]) {
      if (!(key in record)) {
        continue;
      }

      if (isTerminalValue(record[key])) {
        return true;
      }
    }

    for (const key of [
      "response",
      "output",
      "result",
      "event",
      "events",
      "data",
    ]) {
      if (!(key in record)) {
        continue;
      }

      if (checkNode(record[key], depth + 1)) {
        return true;
      }
    }

    return false;
  };

  return checkNode(data);
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
  return stripContextBlock(text, "BQ_CONTEXT").trimEnd();
}

async function* parseJsonStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedDoneMarker = false;
  let eventDataLines: string[] = [];

  const parsePayload = (payload: string): Record<string, unknown>[] => {
    if (!payload) {
      return [];
    }
    if (payload === "[DONE]") {
      receivedDoneMarker = true;
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
      return [];
    }

    return [];
  };

  const parseAndYield = function* (
    payload: string
  ): Generator<Record<string, unknown>, void, void> {
    for (const parsed of parsePayload(payload)) {
      yield parsed;

      if (isTerminalVertexEvent(parsed)) {
        receivedDoneMarker = true;
      }
    }
  };

  const flushEvent = function* (): Generator<
    Record<string, unknown>,
    void,
    void
  > {
    if (eventDataLines.length === 0) {
      return;
    }

    const payload = eventDataLines.join("\n").trim();
    eventDataLines = [];

    if (!payload) {
      return;
    }

    yield* parseAndYield(payload);
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
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim() === "") {
          for (const parsed of flushEvent()) {
            yield parsed;
          }

          if (receivedDoneMarker) {
            return;
          }

          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("data:")) {
          eventDataLines.push(line.replace(/^data:\s?/, ""));
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith(":")) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.includes(":")) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        for (const parsed of parseAndYield(line.trim())) {
          yield parsed;
        }

        if (receivedDoneMarker) {
          return;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (buffer.trim()) {
      const tailLine = buffer.replace(/\r$/, "");
      if (tailLine.startsWith("data:")) {
        eventDataLines.push(tailLine.replace(/^data:\s?/, ""));
      } else if (!tailLine.startsWith(":") && !tailLine.includes(":")) {
        for (const parsed of parseAndYield(tailLine.trim())) {
          yield parsed;
        }
      }
    }

    for (const parsed of flushEvent()) {
      yield parsed;
    }

    if (receivedDoneMarker) {
      return;
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
}: {
  accessToken: string;
  sessionId: string;
  userId: string;
  message: string | { role: "user"; parts: Record<string, unknown>[] };
  signal?: AbortSignal;
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

  if (!response.body) {
    const responseText = await response.text();
    const texts = parseVertexResponseText(responseText);

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

    if (!accumulatedVisibleText.trim()) {
      throw new Error("Vertex AI returned an empty response");
    }

    return;
  }

  for await (const data of parseJsonStream(response.body)) {
    const isTerminalEvent = isTerminalVertexEvent(data);
    const text = extractTextFromVertexResponse(data);
    if (!text) {
      if (isTerminalEvent) {
        break;
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

    if (isTerminalEvent) {
      break;
    }
  }

  if (!accumulatedVisibleText.trim()) {
    throw new Error("Vertex AI returned an empty response");
  }
}
