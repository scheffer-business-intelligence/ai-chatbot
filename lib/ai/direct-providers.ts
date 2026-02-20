import { AGENT_ENGINE_CHAT_MODEL } from "@/lib/ai/models";
import type { ChatMessage } from "@/lib/types";
import { getTextFromMessage } from "@/lib/utils";

type DirectProvider = "openai" | "google";

function getDirectProvider(modelId: string): DirectProvider | null {
  if (modelId.startsWith("openai/")) {
    return "openai";
  }

  if (modelId.startsWith("google/") && modelId !== AGENT_ENGINE_CHAT_MODEL) {
    return "google";
  }

  return null;
}

function modelNameFromId(modelId: string) {
  const [provider, ...rest] = modelId.split("/");
  if (!provider || rest.length === 0) {
    return modelId;
  }
  return rest.join("/");
}

function toConversationMessages(messages: ChatMessage[]) {
  const conversation: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [];

  for (const message of messages) {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "system"
    ) {
      continue;
    }

    const content = getTextFromMessage(message).trim();

    if (!content) {
      continue;
    }

    conversation.push({
      role: message.role,
      content,
    });
  }

  return conversation;
}

async function* parseSSEPayloads(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let receivedDone = false;

  const flushEvent = function* (): Generator<string, void, void> {
    if (dataLines.length === 0) {
      return;
    }

    const payload = dataLines.join("\n").trim();
    dataLines = [];

    if (!payload) {
      return;
    }

    if (payload === "[DONE]") {
      receivedDone = true;
      return;
    }

    yield payload;
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
          for (const payload of flushEvent()) {
            yield payload;
          }

          if (receivedDone) {
            return;
          }

          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.replace(/^data:\s?/, ""));
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

        dataLines.push(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (buffer.trim()) {
      const tailLine = buffer.replace(/\r$/, "");
      if (tailLine.startsWith("data:")) {
        dataLines.push(tailLine.replace(/^data:\s?/, ""));
      } else if (!tailLine.startsWith(":") && !tailLine.includes(":")) {
        dataLines.push(tailLine);
      }
    }

    for (const payload of flushEvent()) {
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function buildOpenAIRequestMessages(
  messages: ChatMessage[],
  system: string
): OpenAIMessage[] {
  const conversation = toConversationMessages(messages);
  const requestMessages: OpenAIMessage[] = [];

  if (system.trim()) {
    requestMessages.push({ role: "system", content: system });
  }

  requestMessages.push(...conversation);

  return requestMessages;
}

function normalizeOpenAIModelName(model: string) {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function getOpenAIModelCandidates(model: string): string[] {
  const normalizedModel = normalizeOpenAIModelName(model);
  return [...new Set([model, normalizedModel])].filter(Boolean);
}

function shouldRetryWithNextModel(status: number, errorText: string): boolean {
  if (status !== 400 && status !== 404) {
    return false;
  }

  return /model|does not exist|not found|unsupported/i.test(errorText);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high";

function shouldPreferOpenAIResponses(model: string): boolean {
  const normalizedModel = normalizeOpenAIModelName(model).toLowerCase();

  return (
    normalizedModel.startsWith("gpt-5") ||
    normalizedModel.startsWith("o1") ||
    normalizedModel.startsWith("o3") ||
    normalizedModel.startsWith("o4")
  );
}

function getOpenAIReasoningEffort(
  model: string
): OpenAIReasoningEffort | undefined {
  const configured = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();

  if (
    configured &&
    (configured === "minimal" ||
      configured === "low" ||
      configured === "medium" ||
      configured === "high")
  ) {
    return configured;
  }

  const normalizedModel = normalizeOpenAIModelName(model).toLowerCase();

  if (normalizedModel.startsWith("gpt-5") && normalizedModel.includes("pro")) {
    return "medium";
  }

  return undefined;
}

async function* streamOpenAIChatCompletions({
  apiKey,
  models,
  requestMessages,
  signal,
}: {
  apiKey: string;
  models: string[];
  requestMessages: OpenAIMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<string, void, void> {
  let fallbackError: Error | null = null;

  for (const [index, model] of models.entries()) {
    let hasOutput = false;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        messages: requestMessages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const canTryNext =
        index < models.length - 1 &&
        shouldRetryWithNextModel(response.status, errorText);

      if (canTryNext) {
        fallbackError = new Error(
          `OpenAI chat/completions rejected model "${model}": ${response.status} - ${errorText}`
        );
        continue;
      }

      throw new Error(
        `OpenAI chat/completions error (${model}): ${response.status} - ${errorText}`
      );
    }

    if (!response.body) {
      throw new Error(
        "OpenAI chat/completions returned an empty response body."
      );
    }

    for await (const payload of parseSSEPayloads(response.body)) {
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
          }>;
        };

        const delta =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content;

        if (delta) {
          hasOutput = true;
          yield delta;
        }
      } catch {
        // Ignore malformed chunks.
      }
    }

    if (!hasOutput) {
      throw new Error(`OpenAI chat/completions produced no text (${model}).`);
    }

    return;
  }

  if (fallbackError) {
    throw fallbackError;
  }

  throw new Error("OpenAI chat/completions failed for all model candidates.");
}

function extractTextFromOpenAIResponseObject(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const record = data as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };

  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  if (!Array.isArray(record.output)) {
    return "";
  }

  const texts: string[] = [];

  for (const item of record.output) {
    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
        continue;
      }

      if (typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }

  return texts.join("");
}

type OpenAIResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string };

type OpenAIResponsesInputItem = {
  role: OpenAIMessage["role"];
  content: OpenAIResponsesInputContent[];
};

function toOpenAIResponsesInput(
  requestMessages: OpenAIMessage[]
): OpenAIResponsesInputItem[] {
  return requestMessages.map((message) => ({
    role: message.role,
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: message.content,
      },
    ],
  }));
}

async function requestOpenAIResponsesWithoutStream({
  apiKey,
  model,
  input,
  reasoningEffort,
  signal,
}: {
  apiKey: string;
  model: string;
  input: OpenAIResponsesInputItem[];
  reasoningEffort?: OpenAIReasoningEffort;
  signal?: AbortSignal;
}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      input,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI responses fallback error (${model}): ${response.status} - ${errorText}`
    );
  }

  const data = (await response.json()) as unknown;
  const text = extractTextFromOpenAIResponseObject(data);

  if (!text.trim()) {
    throw new Error(`OpenAI responses fallback produced no text (${model}).`);
  }

  return text;
}

async function* streamOpenAIResponses({
  apiKey,
  models,
  requestMessages,
  signal,
}: {
  apiKey: string;
  models: string[];
  requestMessages: OpenAIMessage[];
  signal?: AbortSignal;
}): AsyncGenerator<string, void, void> {
  let fallbackError: Error | null = null;

  for (const [index, model] of models.entries()) {
    let hasOutput = false;
    const reasoningEffort = getOpenAIReasoningEffort(model);
    const input = toOpenAIResponsesInput(requestMessages);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        input,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const canTryNext =
        index < models.length - 1 &&
        shouldRetryWithNextModel(response.status, errorText);

      if (canTryNext) {
        fallbackError = new Error(
          `OpenAI responses rejected model "${model}": ${response.status} - ${errorText}`
        );
        continue;
      }

      throw new Error(
        `OpenAI responses error (${model}): ${response.status} - ${errorText}`
      );
    }

    if (!response.body) {
      throw new Error("OpenAI responses returned an empty response body.");
    }

    let accumulated = "";

    for await (const payload of parseSSEPayloads(response.body)) {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const eventType =
          typeof parsed.type === "string" ? parsed.type : undefined;

        if (
          eventType === "response.output_text.delta" &&
          typeof parsed.delta === "string"
        ) {
          accumulated += parsed.delta;
          hasOutput = true;
          yield parsed.delta;
          continue;
        }

        if (
          eventType === "response.output_text.done" &&
          typeof parsed.text === "string"
        ) {
          if (parsed.text.startsWith(accumulated)) {
            const delta = parsed.text.slice(accumulated.length);
            if (delta) {
              accumulated = parsed.text;
              hasOutput = true;
              yield delta;
            }
          } else if (parsed.text) {
            accumulated += parsed.text;
            hasOutput = true;
            yield parsed.text;
          }
          continue;
        }

        if (eventType === "response.completed") {
          const completedText = extractTextFromOpenAIResponseObject(
            parsed.response
          );

          if (completedText.startsWith(accumulated)) {
            const delta = completedText.slice(accumulated.length);
            if (delta) {
              accumulated = completedText;
              hasOutput = true;
              yield delta;
            }
          } else if (completedText) {
            accumulated += completedText;
            hasOutput = true;
            yield completedText;
          }
        }
      } catch {
        // Ignore malformed chunks.
      }
    }

    if (!hasOutput) {
      try {
        const fallbackText = await requestOpenAIResponsesWithoutStream({
          apiKey,
          model,
          input,
          reasoningEffort,
          signal,
        });

        hasOutput = true;
        yield fallbackText;
      } catch (fallbackError) {
        throw new Error(
          `OpenAI responses produced no streamed text (${model}). Fallback failed: ${getErrorMessage(
            fallbackError
          )}`
        );
      }
    }

    if (!hasOutput) {
      throw new Error(`OpenAI responses produced no text (${model}).`);
    }

    return;
  }

  if (fallbackError) {
    throw fallbackError;
  }

  throw new Error("OpenAI responses failed for all model candidates.");
}

async function* streamOpenAIChat({
  modelId,
  messages,
  system,
  signal,
}: {
  modelId: string;
  messages: ChatMessage[];
  system: string;
  signal?: AbortSignal;
}): AsyncGenerator<string, void, void> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const model = modelNameFromId(modelId);
  const models = getOpenAIModelCandidates(model);
  const requestMessages = buildOpenAIRequestMessages(messages, system);
  const shouldStartWithResponses = shouldPreferOpenAIResponses(model);

  if (shouldStartWithResponses) {
    let responsesError: unknown;

    try {
      for await (const delta of streamOpenAIResponses({
        apiKey,
        models,
        requestMessages,
        signal,
      })) {
        yield delta;
      }
      return;
    } catch (error) {
      responsesError = error;
    }

    try {
      for await (const delta of streamOpenAIChatCompletions({
        apiKey,
        models,
        requestMessages,
        signal,
      })) {
        yield delta;
      }
      return;
    } catch (chatCompletionsError) {
      throw new Error(
        `OpenAI request failed. responses: ${getErrorMessage(
          responsesError
        )} | chat/completions: ${getErrorMessage(chatCompletionsError)}`
      );
    }
  }

  let chatCompletionsError: unknown;

  try {
    for await (const delta of streamOpenAIChatCompletions({
      apiKey,
      models,
      requestMessages,
      signal,
    })) {
      yield delta;
    }
    return;
  } catch (error) {
    chatCompletionsError = error;
  }

  try {
    for await (const delta of streamOpenAIResponses({
      apiKey,
      models,
      requestMessages,
      signal,
    })) {
      yield delta;
    }
    return;
  } catch (responsesError) {
    throw new Error(
      `OpenAI request failed. chat/completions: ${getErrorMessage(
        chatCompletionsError
      )} | responses: ${getErrorMessage(responsesError)}`
    );
  }
}

function extractGeminiText(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const record = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const firstCandidate = record.candidates?.[0];
  const parts = firstCandidate?.content?.parts;

  if (!parts || parts.length === 0) {
    return "";
  }

  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function toGeminiContents(messages: ChatMessage[]) {
  const contents: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }> = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = getTextFromMessage(message).trim();
    if (!text) {
      continue;
    }

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text }],
    });
  }

  return contents;
}

async function* streamGoogleGemini({
  modelId,
  messages,
  system,
  signal,
}: {
  modelId: string;
  messages: ChatMessage[];
  system: string;
  signal?: AbortSignal;
}): AsyncGenerator<string, void, void> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not configured.");
  }

  const model = modelNameFromId(modelId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      ...(system.trim()
        ? { systemInstruction: { parts: [{ text: system }] } }
        : {}),
      contents: toGeminiContents(messages),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini error: ${response.status} - ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Gemini returned an empty response body.");
  }

  let accumulated = "";
  let hasOutput = false;

  for await (const payload of parseSSEPayloads(response.body)) {
    try {
      const parsed = JSON.parse(payload);
      const text = extractGeminiText(parsed);
      if (!text) {
        continue;
      }

      if (text.startsWith(accumulated)) {
        const delta = text.slice(accumulated.length);
        if (delta) {
          accumulated = text;
          hasOutput = true;
          yield delta;
        }
      } else {
        accumulated += text;
        hasOutput = true;
        yield text;
      }
    } catch {
      // Ignore malformed chunks.
    }
  }

  if (!hasOutput) {
    throw new Error(`Gemini stream produced no text (${model}).`);
  }
}

export function isDirectProviderModel(modelId: string) {
  return getDirectProvider(modelId) !== null;
}

export async function* streamDirectProviderResponse({
  modelId,
  messages,
  system,
  signal,
}: {
  modelId: string;
  messages: ChatMessage[];
  system: string;
  signal?: AbortSignal;
}): AsyncGenerator<string, void, void> {
  const provider = getDirectProvider(modelId);

  if (!provider) {
    throw new Error(`Model ${modelId} is not a direct provider model.`);
  }

  if (provider === "openai") {
    for await (const delta of streamOpenAIChat({
      modelId,
      messages,
      system,
      signal,
    })) {
      yield delta;
    }
    return;
  }

  for await (const delta of streamGoogleGemini({
    modelId,
    messages,
    system,
    signal,
  })) {
    yield delta;
  }
}
