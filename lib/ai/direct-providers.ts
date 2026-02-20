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

        if (line.startsWith("data:")) {
          const payload = line.replace(/^data:\s*/, "");
          if (!payload) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          if (payload === "[DONE]") {
            return;
          }

          yield payload;
        }

        newlineIndex = buffer.indexOf("\n");
      }
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
          yield delta;
        }
      } catch {
        // Ignore malformed chunks.
      }
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
    const input = requestMessages.map((message) => ({
      role: message.role,
      content: [{ type: "input_text", text: message.content }],
    }));

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
              yield delta;
            }
          } else if (parsed.text) {
            accumulated += parsed.text;
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
              yield delta;
            }
          } else if (completedText) {
            accumulated += completedText;
            yield completedText;
          }
        }
      } catch {
        // Ignore malformed chunks.
      }
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
          yield delta;
        }
      } else {
        accumulated += text;
        yield text;
      }
    } catch {
      // Ignore malformed chunks.
    }
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
