import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessageChunk,
} from "ai";
import { auth, type UserType } from "@/app/(auth)/auth";
import {
  isDirectProviderModel,
  streamDirectProviderResponse,
} from "@/lib/ai/direct-providers";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { AGENT_ENGINE_CHAT_MODEL } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { getServiceAccountAccessToken } from "@/lib/auth/service-account-token";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import {
  buildAgentEngineErrorEnvelope,
  type AgentEngineErrorStage,
} from "@/lib/agent-engine/error-envelope";
import {
  countRecentUserMessages,
  getChatMessagesByChatId,
  softDeleteSessionMessagesByChatId,
} from "@/lib/chat-store";
import { isProductionEnvironment } from "@/lib/constants";
import {
  deleteChatById,
  getChatById,
  getProviderSessionByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateChatVisibilityById,
  updateMessage,
  updateMessageAnsweredIn,
  upsertProviderSession,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import { generateSignedUrl } from "@/lib/gcp/storage";
import type { ChatMessage } from "@/lib/types";
import { generateUUID, getTextFromMessage } from "@/lib/utils";
import {
  AGENT_ENGINE_PROVIDER_ID,
  createVertexSession,
  isInvalidVertexSessionError,
  streamVertexQuery,
  type VertexExtractedContext,
} from "@/lib/vertex/agent-engine";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 300;
const DEFAULT_AGENT_ENGINE_MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;
const AGENT_ENGINE_SESSION_RECOVERY_ATTEMPTS = 1;
const AGENT_ENGINE_EMPTY_RESPONSE_FALLBACK_MESSAGE =
  "Nao foi possivel obter resposta do Scheffer Agent Engine nesta tentativa. Tente novamente em alguns instantes.";
const AGENT_ENGINE_INLINE_XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const agentSessionRefreshLocks = new Map<string, Promise<string>>();

function logAgentEngineEvent(
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>
) {
  const logPayload = {
    provider: AGENT_ENGINE_PROVIDER_ID,
    ...payload,
  };

  if (level === "error") {
    console.error("[agent-engine]", logPayload);
    return;
  }

  if (level === "warn") {
    console.warn("[agent-engine]", logPayload);
    return;
  }

  console.info("[agent-engine]", logPayload);
}

function resetExtractedContext(context: VertexExtractedContext) {
  context.chartSpec = null;
  context.chartSpecs = [];
  context.chartError = null;
  context.hasChartContext = false;
  context.contextSheets = [];
}

function getAgentSessionRefreshLockKey(chatId: string) {
  return `${AGENT_ENGINE_PROVIDER_ID}:${chatId}`;
}

async function refreshAgentEngineProviderSession({
  chatId,
  userId,
  previousSessionId,
  requestId,
  modelId,
}: {
  chatId: string;
  userId: string;
  previousSessionId: string;
  requestId: string;
  modelId: string;
}) {
  const lockKey = getAgentSessionRefreshLockKey(chatId);
  const inFlight = agentSessionRefreshLocks.get(lockKey);

  if (inFlight) {
    return await inFlight;
  }

  const refreshPromise = (async () => {
    let latestProviderSession: Awaited<
      ReturnType<typeof getProviderSessionByChatId>
    > = null;

    try {
      latestProviderSession = await getProviderSessionByChatId({
        chatId,
        provider: AGENT_ENGINE_PROVIDER_ID,
      });
    } catch (error) {
      logAgentEngineEvent("warn", {
        event: "provider_session_lookup_failed",
        request_id: requestId,
        chat_id: chatId,
        session_id: previousSessionId,
        user_id: userId,
        model_id: modelId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (
      latestProviderSession?.sessionId &&
      latestProviderSession.sessionId !== previousSessionId
    ) {
      logAgentEngineEvent("info", {
        event: "provider_session_resolved",
        request_id: requestId,
        chat_id: chatId,
        session_id: latestProviderSession.sessionId,
        user_id: userId,
        model_id: modelId,
        source: "existing",
      });
      return latestProviderSession.sessionId;
    }

    const accessToken = await getServiceAccountAccessToken();
    const nextSessionId = await createVertexSession(accessToken, userId);

    try {
      await upsertProviderSession({
        chatId,
        provider: AGENT_ENGINE_PROVIDER_ID,
        sessionId: nextSessionId,
        userId,
      });
    } catch (error) {
      logAgentEngineEvent("warn", {
        event: "provider_session_persist_failed",
        request_id: requestId,
        chat_id: chatId,
        session_id: nextSessionId,
        user_id: userId,
        model_id: modelId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    logAgentEngineEvent("info", {
      event: "provider_session_resolved",
      request_id: requestId,
      chat_id: chatId,
      session_id: nextSessionId,
      user_id: userId,
      model_id: modelId,
      source: "created",
    });

    return nextSessionId;
  })().finally(() => {
    agentSessionRefreshLocks.delete(lockKey);
  });

  agentSessionRefreshLocks.set(lockKey, refreshPromise);
  return await refreshPromise;
}

function getAgentEngineMaxInlineFileBytes() {
  const configuredLimit = process.env.AGENT_ENGINE_MAX_INLINE_FILE_BYTES;

  if (!configuredLimit) {
    return DEFAULT_AGENT_ENGINE_MAX_INLINE_FILE_BYTES;
  }

  const parsedLimit = Number.parseInt(configuredLimit, 10);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return DEFAULT_AGENT_ENGINE_MAX_INLINE_FILE_BYTES;
  }

  return parsedLimit;
}

function isAllowedInlineAttachmentMimeType(mediaType: string) {
  return (
    mediaType === "application/pdf" ||
    mediaType === AGENT_ENGINE_INLINE_XLSX_MIME_TYPE ||
    mediaType.startsWith("image/")
  );
}

function isAgentEngineModel(modelId: string) {
  return modelId === AGENT_ENGINE_CHAT_MODEL;
}

function getLatestUserMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role === "user") {
      return candidate;
    }
  }

  return null;
}

function isExportIntentText(text: string) {
  if (!text.trim()) {
    return false;
  }

  return /\b(exportar|exporte|export|excel|xlsx|planilha|baixar\s+planilha|download\s+(?:da\s+)?(?:tabela|planilha))\b/i.test(
    text
  );
}

function deriveExportFilenameFromPrompt(text: string) {
  const normalized = text.toLowerCase();

  if (/\brecomend/.test(normalized) || /\bmanejo\b/.test(normalized)) {
    return "recomendacoes_manejo";
  }

  if (/\bseiva\b/.test(normalized)) {
    return "analise_seiva";
  }

  if (/\bsolo\b/.test(normalized)) {
    return "analise_solo";
  }

  return "dados_exportados";
}

function buildExportHintFromUserMessage(message: ChatMessage | null) {
  if (!message) {
    return null;
  }

  const promptText = getTextFromMessage(message).replace(/\s+/g, " ").trim();
  if (!isExportIntentText(promptText)) {
    return null;
  }

  return {
    filename: deriveExportFilenameFromPrompt(promptText),
    description: "Baixar os dados desta resposta em Excel.",
  };
}

function shouldAllowTableChartFallback(message: ChatMessage): boolean {
  const userText = getTextFromMessage(message);

  if (!userText.trim()) {
    return false;
  }

  return /\b(gr[aá]fico|chart|plot|plotar|visualiza(?:r|ção))\b/i.test(
    userText
  );
}

function createLocalChatTitle(message: ChatMessage) {
  const normalized = getTextFromMessage(message).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Nova Conversa";
  }
  return normalized.slice(0, 80);
}

async function buildVertexMessageFromUserMessage(
  message: ChatMessage,
  signal?: AbortSignal
): Promise<string | { role: "user"; parts: Record<string, unknown>[] }> {
  const parts: Record<string, unknown>[] = [];
  const maxInlineFileBytes = getAgentEngineMaxInlineFileBytes();
  let hasInlineData = false;

  for (const part of message.parts ?? []) {
    if (part.type === "text") {
      if (part.text.trim()) {
        parts.push({ text: part.text });
      }
      continue;
    }

    if (part.type === "file") {
      const displayName =
        ("name" in part && typeof part.name === "string" && part.name) ||
        ("filename" in part &&
          typeof part.filename === "string" &&
          part.filename) ||
        "uploaded_file";
      const gcsUrl =
        "gcsUrl" in part && typeof part.gcsUrl === "string" ? part.gcsUrl : "";
      const fileUrl =
        "url" in part && typeof part.url === "string" ? part.url : "";
      const mediaType =
        "mediaType" in part && typeof part.mediaType === "string"
          ? part.mediaType
          : "application/octet-stream";
      const downloadUrl =
        gcsUrl.trim().length > 0
          ? gcsUrl
          : fileUrl.startsWith("gs://")
            ? fileUrl
            : fileUrl;

      if (!downloadUrl) {
        throw new Error(`Attachment ${displayName} is missing a URL.`);
      }

      if (!isAllowedInlineAttachmentMimeType(mediaType)) {
        throw new Error(
          `Attachment ${displayName} has unsupported media type for Agent Engine: ${mediaType}`
        );
      }

      let fileResponse: Response;
      try {
        const fetchUrl = downloadUrl.startsWith("gs://")
          ? await generateSignedUrl(downloadUrl)
          : downloadUrl;
        fileResponse = await fetch(fetchUrl, { signal });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        throw new Error(
          `Failed to fetch attachment ${displayName} from ${downloadUrl}: ${reason}`
        );
      }

      if (!fileResponse.ok) {
        const errorText = await fileResponse.text();
        throw new Error(
          `Failed to download attachment ${displayName}: ${fileResponse.status} - ${errorText}`
        );
      }

      const contentLengthHeader = fileResponse.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = Number.parseInt(contentLengthHeader, 10);
        if (
          Number.isFinite(contentLength) &&
          contentLength > maxInlineFileBytes
        ) {
          const attachmentKind =
            mediaType === "application/pdf"
              ? "PDF"
              : mediaType === AGENT_ENGINE_INLINE_XLSX_MIME_TYPE
                ? "Spreadsheet"
                : "File";
          throw new Error(
            `${attachmentKind} ${displayName} is too large for Agent Engine inline upload. Maximum allowed size is ${maxInlineFileBytes} bytes.`
          );
        }
      }

      const arrayBuffer = await fileResponse.arrayBuffer();
      if (arrayBuffer.byteLength > maxInlineFileBytes) {
        const attachmentKind =
          mediaType === "application/pdf"
            ? "PDF"
            : mediaType === AGENT_ENGINE_INLINE_XLSX_MIME_TYPE
              ? "Spreadsheet"
              : "File";
        throw new Error(
          `${attachmentKind} ${displayName} is too large for Agent Engine inline upload. Maximum allowed size is ${maxInlineFileBytes} bytes.`
        );
      }

      const base64Data = Buffer.from(arrayBuffer).toString("base64");

      parts.push({
        inline_data: {
          data: base64Data,
          mime_type: mediaType,
          display_name: displayName,
        },
      });
      hasInlineData = true;
    }
  }

  if (parts.length === 0) {
    return "";
  }

  if (!hasInlineData) {
    return parts
      .map((part) =>
        typeof part.text === "string" ? part.text.trim() : undefined
      )
      .filter((text): text is string => Boolean(text))
      .join("\n\n");
  }

  return {
    role: "user",
    parts,
  };
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;
  const requestId = generateUUID();

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel } = requestBody;
    const requestStartedAtMs = Date.now();
    const chatVisibility = "private" as const;
    const isAgentEngineRequest = isAgentEngineModel(selectedChatModel);

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const [bigQueryUserId, fallbackBigQueryUserId] =
      getBigQueryUserIdCandidates(session.user);
    if (!bigQueryUserId) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }
    const chatOwnerIds = new Set(
      [session.user.id, bigQueryUserId, fallbackBigQueryUserId].filter(
        Boolean
      ) as string[]
    );

    const userType: UserType = session.user.type;

    const [messageCount, chat] = await Promise.all([
      countRecentUserMessages({
        userId: bigQueryUserId,
        fallbackUserId: fallbackBigQueryUserId,
        differenceInHours: 24,
      }),
      getChatById({ id }).catch((error) => {
        console.warn(
          "Failed to resolve chat by id before handling request, proceeding as new chat:",
          error
        );
        return null;
      }),
    ]);

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);
    let messageHistory: ChatMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (!chatOwnerIds.has(chat.userId)) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow && !isAgentEngineRequest) {
        messageHistory = await getChatMessagesByChatId({
          chatId: id,
          userId: bigQueryUserId,
          fallbackUserId: fallbackBigQueryUserId,
          dedupeAssistantDuplicates: true,
        });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: bigQueryUserId,
        title: "Nova Conversa",
        visibility: chatVisibility,
      });
      if (
        isAgentEngineModel(selectedChatModel) ||
        isDirectProviderModel(selectedChatModel)
      ) {
        titlePromise = Promise.resolve(
          createLocalChatTitle(message as ChatMessage)
        );
      } else {
        titlePromise = generateTitleFromUserMessage({ message });
      }
    }

    const uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...messageHistory, message as ChatMessage];
    const latestUserMessage =
      message?.role === "user"
        ? (message as ChatMessage)
        : getLatestUserMessage(uiMessages);
    const exportHint = buildExportHintFromUserMessage(latestUserMessage);

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };
    let preflightDoneAtMs: number | null = null;

    const incomingUserDbMessage =
      message?.role === "user"
        ? {
            chatId: id,
            id: message.id,
            role: "user" as const,
            parts: message.parts,
            attachments: [],
            chartSpec: null,
            chartError: null,
            createdAt: new Date(),
          }
        : null;

    if (incomingUserDbMessage && !isToolApprovalFlow && !isAgentEngineRequest) {
      await saveMessages({
        messages: [incomingUserDbMessage],
        sessionId: id,
      });
    }

    if (isAgentEngineRequest) {
      preflightDoneAtMs = Date.now();
      logAgentEngineEvent("info", {
        event: "preflight_done",
        request_id: requestId,
        chat_id: id,
        user_id: bigQueryUserId,
        model_id: selectedChatModel,
        preflight_done_ms: preflightDoneAtMs - requestStartedAtMs,
        is_tool_approval_flow: isToolApprovalFlow,
      });
    }

    const extractedContext: VertexExtractedContext = {
      chartSpec: null,
      chartSpecs: [],
      chartError: null,
      hasChartContext: false,
      contextSheets: [],
    };
    let providerSessionIdForPersistence: string | undefined;
    let providerSessionReadyAtMs: number | null = null;
    let streamOpenedAtMs: number | null = null;
    let firstDeltaAtMs: number | null = null;
    const pendingPersistenceTasks: Promise<void>[] = [];

    const queuePersistenceTask = (task: Promise<void>, context: string) => {
      const trackedTask = task.catch((error) => {
        logAgentEngineEvent("warn", {
          event: "message_persist_failed",
          request_id: requestId,
          chat_id: id,
          session_id: providerSessionIdForPersistence,
          user_id: bigQueryUserId,
          model_id: selectedChatModel,
          context,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

      pendingPersistenceTasks.push(trackedTask);
    };

    const getPersistenceSessionId = () => {
      if (!isAgentEngineRequest) {
        return id;
      }

      if (!providerSessionIdForPersistence) {
        throw new ChatSDKError(
          "bad_request:agent_engine",
          "Missing Vertex session id for message persistence."
        );
      }

      return providerSessionIdForPersistence;
    };

    const handleOnFinish = async ({
      messages: finishedMessages,
    }: {
      messages: ChatMessage[];
    }) => {
      if (pendingPersistenceTasks.length > 0) {
        await Promise.allSettled([...pendingPersistenceTasks]);
      }

      const answeredInMs = Math.max(Date.now() - requestStartedAtMs, 0);
      const lastAssistantMessageId = [...finishedMessages]
        .reverse()
        .find((currentMessage) => currentMessage.role === "assistant")?.id;

      if (isToolApprovalFlow) {
        for (const finishedMsg of finishedMessages) {
          const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
          const shouldPersistChartContext =
            isAgentEngineRequest &&
            finishedMsg.role === "assistant" &&
            finishedMsg.id === lastAssistantMessageId;

          if (existingMsg) {
            await updateMessage({
              id: finishedMsg.id,
              parts: finishedMsg.parts,
              chartSpec: shouldPersistChartContext
                ? extractedContext.chartSpec
                : undefined,
              chartError: shouldPersistChartContext
                ? extractedContext.chartError
                : undefined,
            });
          } else {
            await saveMessages({
              messages: [
                {
                  id: finishedMsg.id,
                  role: finishedMsg.role,
                  parts: finishedMsg.parts,
                  createdAt: new Date(),
                  attachments: [],
                  chartSpec: shouldPersistChartContext
                    ? extractedContext.chartSpec
                    : null,
                  chartError: shouldPersistChartContext
                    ? extractedContext.chartError
                    : null,
                  chatId: id,
                },
              ],
              sessionId: getPersistenceSessionId(),
            });
          }
        }
      } else if (finishedMessages.length > 0) {
        await saveMessages({
          messages: finishedMessages.map((currentMessage) => ({
            id: currentMessage.id,
            role: currentMessage.role,
            parts: currentMessage.parts,
            createdAt: new Date(),
            attachments: [],
            chartSpec:
              isAgentEngineRequest &&
              currentMessage.role === "assistant" &&
              currentMessage.id === lastAssistantMessageId
                ? extractedContext.chartSpec
                : null,
            chartError:
              isAgentEngineRequest &&
              currentMessage.role === "assistant" &&
              currentMessage.id === lastAssistantMessageId
                ? extractedContext.chartError
                : null,
            chatId: id,
          })),
          sessionId: getPersistenceSessionId(),
        });
      }

      if (lastAssistantMessageId) {
        await updateMessageAnsweredIn({
          id: lastAssistantMessageId,
          answeredIn: answeredInMs,
        });
      }

      if (isAgentEngineRequest) {
        logAgentEngineEvent("info", {
          event: "request_latency_summary",
          request_id: requestId,
          chat_id: id,
          session_id: providerSessionIdForPersistence,
          user_id: bigQueryUserId,
          model_id: selectedChatModel,
          preflight_done_ms: preflightDoneAtMs
            ? preflightDoneAtMs - requestStartedAtMs
            : null,
          provider_session_ready_ms: providerSessionReadyAtMs
            ? providerSessionReadyAtMs - requestStartedAtMs
            : null,
          stream_opened_ms: streamOpenedAtMs
            ? streamOpenedAtMs - requestStartedAtMs
            : null,
          first_delta_ms: firstDeltaAtMs
            ? firstDeltaAtMs - requestStartedAtMs
            : null,
          total_request_ms: Date.now() - requestStartedAtMs,
        });
      }
    };

    let stream: ReadableStream<UIMessageChunk>;

    if (isAgentEngineRequest) {
      try {
        if (!latestUserMessage) {
          return new ChatSDKError(
            "bad_request:api",
            "No user message found for Agent Engine request."
          ).toResponse();
        }
        const [serviceAccountAccessToken, existingProviderSession] =
          await Promise.all([
            getServiceAccountAccessToken(),
            getProviderSessionByChatId({
              chatId: id,
              provider: AGENT_ENGINE_PROVIDER_ID,
            }).catch((error) => {
              logAgentEngineEvent("warn", {
                event: "provider_session_lookup_failed",
                request_id: requestId,
                chat_id: id,
                user_id: bigQueryUserId,
                model_id: selectedChatModel,
                reason: error instanceof Error ? error.message : String(error),
              });
              return null;
            }),
          ]);

        let providerSessionId = existingProviderSession?.sessionId;
        const providerSessionSource = providerSessionId ? "existing" : "created";

        if (!providerSessionId) {
          providerSessionId = await createVertexSession(
            serviceAccountAccessToken,
            bigQueryUserId
          );

          try {
            await upsertProviderSession({
              chatId: id,
              provider: AGENT_ENGINE_PROVIDER_ID,
              sessionId: providerSessionId,
              userId: bigQueryUserId,
            });
          } catch (error) {
            logAgentEngineEvent("warn", {
              event: "provider_session_persist_failed",
              request_id: requestId,
              chat_id: id,
              session_id: providerSessionId,
              user_id: bigQueryUserId,
              model_id: selectedChatModel,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!providerSessionId) {
          throw new Error(
            "Failed to initialize Agent Engine provider session."
          );
        }
        logAgentEngineEvent("info", {
          event: "provider_session_resolved",
          request_id: requestId,
          chat_id: id,
          session_id: providerSessionId,
          user_id: bigQueryUserId,
          model_id: selectedChatModel,
          source: providerSessionSource,
        });
        providerSessionIdForPersistence = providerSessionId;
        providerSessionReadyAtMs = Date.now();
        logAgentEngineEvent("info", {
          event: "provider_session_ready",
          request_id: requestId,
          chat_id: id,
          session_id: providerSessionIdForPersistence,
          user_id: bigQueryUserId,
          model_id: selectedChatModel,
          provider_session_ready_ms: providerSessionReadyAtMs - requestStartedAtMs,
        });

        if (incomingUserDbMessage && !isToolApprovalFlow) {
          queuePersistenceTask(
            saveMessages({
              messages: [incomingUserDbMessage],
              sessionId: getPersistenceSessionId(),
            }),
            "incoming_user_before_stream"
          );
        }

        const vertexMessage = await buildVertexMessageFromUserMessage(
          latestUserMessage,
          request.signal
        );
        const allowTableChartFallback =
          shouldAllowTableChartFallback(latestUserMessage);
        const initialProviderSessionId: string = providerSessionId;

        stream = createUIMessageStream({
          originalMessages: isToolApprovalFlow ? uiMessages : undefined,
          execute: async ({ writer: dataStream }) => {
            const textPartId = generateUUID();
            let hasVisibleOutput = false;
            let activeProviderSessionId = initialProviderSessionId;
            if (streamOpenedAtMs === null) {
              streamOpenedAtMs = Date.now();
              logAgentEngineEvent("info", {
                event: "stream_opened",
                request_id: requestId,
                chat_id: id,
                session_id: activeProviderSessionId,
                user_id: bigQueryUserId,
                model_id: selectedChatModel,
                stream_opened_ms: streamOpenedAtMs - requestStartedAtMs,
              });
            }
            dataStream.write({ type: "start" });
            dataStream.write({ type: "text-start", id: textPartId });
            if (exportHint) {
              dataStream.write({
                type: "data-export-hint",
                data: exportHint,
              });
            }

            const streamAgentEngineResponse = async (
              currentProviderSessionId: string
            ) => {
              const streamStartedAtMs = Date.now();
              logAgentEngineEvent("info", {
                event: "vertex_stream_started",
                request_id: requestId,
                chat_id: id,
                session_id: currentProviderSessionId,
                user_id: bigQueryUserId,
                model_id: selectedChatModel,
              });

              for await (const event of streamVertexQuery({
                accessToken: serviceAccountAccessToken,
                sessionId: currentProviderSessionId,
                userId: bigQueryUserId,
                message: vertexMessage,
                signal: request.signal,
                extractedContext,
                allowTableChartFallback,
              })) {
                if (event.type === "status") {
                  if (!event.status) {
                    continue;
                  }

                  dataStream.write({
                    type: "data-agent-status",
                    data: event.status,
                  });
                  continue;
                }

                const { delta } = event;
                if (!delta) {
                  continue;
                }

                dataStream.write({
                  type: "text-delta",
                  id: textPartId,
                  delta,
                });

                if (delta.trim().length > 0) {
                  if (firstDeltaAtMs === null) {
                    firstDeltaAtMs = Date.now();
                    logAgentEngineEvent("info", {
                      event: "first_delta",
                      request_id: requestId,
                      chat_id: id,
                      session_id: currentProviderSessionId,
                      user_id: bigQueryUserId,
                      model_id: selectedChatModel,
                      first_delta_ms: firstDeltaAtMs - requestStartedAtMs,
                    });
                  }
                  hasVisibleOutput = true;
                }
              }

              logAgentEngineEvent("info", {
                event: "vertex_stream_finished",
                request_id: requestId,
                chat_id: id,
                session_id: currentProviderSessionId,
                user_id: bigQueryUserId,
                model_id: selectedChatModel,
                duration_ms: Date.now() - streamStartedAtMs,
              });
            };

            for (
              let attempt = 0;
              attempt <= AGENT_ENGINE_SESSION_RECOVERY_ATTEMPTS;
              attempt += 1
            ) {
              try {
                await streamAgentEngineResponse(activeProviderSessionId);

                if (hasVisibleOutput) {
                  break;
                }

                const canRetryEmptyResponse =
                  attempt < AGENT_ENGINE_SESSION_RECOVERY_ATTEMPTS;
                if (!canRetryEmptyResponse) {
                  break;
                }

                resetExtractedContext(extractedContext);
                const previousProviderSessionId = activeProviderSessionId;
                activeProviderSessionId =
                  await refreshAgentEngineProviderSession({
                    chatId: id,
                    userId: bigQueryUserId,
                    previousSessionId: activeProviderSessionId,
                    requestId,
                    modelId: selectedChatModel,
                  });
                providerSessionId = activeProviderSessionId;
                providerSessionIdForPersistence = activeProviderSessionId;

                logAgentEngineEvent("warn", {
                  event: "provider_session_rotated",
                  request_id: requestId,
                  chat_id: id,
                  session_id: activeProviderSessionId,
                  previous_session_id: previousProviderSessionId,
                  user_id: bigQueryUserId,
                  model_id: selectedChatModel,
                  attempt: attempt + 1,
                  reason: "Vertex AI returned an empty response",
                });

                continue;
              } catch (error) {
                const canRecoverSession =
                  attempt < AGENT_ENGINE_SESSION_RECOVERY_ATTEMPTS &&
                  !hasVisibleOutput &&
                  isInvalidVertexSessionError(error);
                const errorReason =
                  error instanceof Error ? error.message : String(error);

                if (!canRecoverSession) {
                  logAgentEngineEvent("error", {
                    event: "vertex_stream_failed",
                    request_id: requestId,
                    chat_id: id,
                    session_id: activeProviderSessionId,
                    user_id: bigQueryUserId,
                    model_id: selectedChatModel,
                    attempt: attempt + 1,
                    reason: errorReason,
                  });
                  throw error;
                }

                resetExtractedContext(extractedContext);
                const previousProviderSessionId = activeProviderSessionId;
                activeProviderSessionId =
                  await refreshAgentEngineProviderSession({
                    chatId: id,
                    userId: bigQueryUserId,
                    previousSessionId: activeProviderSessionId,
                    requestId,
                    modelId: selectedChatModel,
                  });
                providerSessionId = activeProviderSessionId;
                providerSessionIdForPersistence = activeProviderSessionId;

                logAgentEngineEvent("warn", {
                  event: "provider_session_rotated",
                  request_id: requestId,
                  chat_id: id,
                  session_id: activeProviderSessionId,
                  previous_session_id: previousProviderSessionId,
                  user_id: bigQueryUserId,
                  model_id: selectedChatModel,
                  attempt: attempt + 1,
                  reason: errorReason,
                });
              }
            }

            if (!hasVisibleOutput) {
              resetExtractedContext(extractedContext);

              dataStream.write({
                type: "text-delta",
                id: textPartId,
                delta: AGENT_ENGINE_EMPTY_RESPONSE_FALLBACK_MESSAGE,
              });

              if (firstDeltaAtMs === null) {
                firstDeltaAtMs = Date.now();
              }

              hasVisibleOutput = true;

              logAgentEngineEvent("warn", {
                event: "vertex_empty_response_fallback",
                request_id: requestId,
                chat_id: id,
                session_id: activeProviderSessionId,
                user_id: bigQueryUserId,
                model_id: selectedChatModel,
              });
            }

            if (extractedContext.chartSpecs.length > 1) {
              dataStream.write({
                type: "data-chart-specs",
                data: extractedContext.chartSpecs,
              });
            }

            if (extractedContext.chartSpec) {
              dataStream.write({
                type: "data-chart-spec",
                data: extractedContext.chartSpec,
              });
            }

            if (extractedContext.chartError) {
              const normalizedChartError = extractedContext.chartError
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
              const isIncompleteChartBlockWarning =
                normalizedChartError === "bloco de grafico incompleto." ||
                normalizedChartError === "bloco chart_context incompleto.";

              if (!isIncompleteChartBlockWarning) {
                dataStream.write({
                  type: "data-chart-warning",
                  data: extractedContext.chartError,
                });
              }
            }

            if (extractedContext.contextSheets.length > 0) {
              dataStream.write({
                type: "data-export-context",
                data: extractedContext.contextSheets,
              });
            }

            dataStream.write({ type: "text-end", id: textPartId });
            dataStream.write({ type: "finish", finishReason: "stop" });

            if (titlePromise) {
              const title = await titlePromise;
              dataStream.write({ type: "data-chat-title", data: title });
              updateChatTitleById({ chatId: id, title });
            }
          },
          generateId: generateUUID,
          onFinish: handleOnFinish,
          onError: (error) => {
            const stage: AgentEngineErrorStage =
              firstDeltaAtMs === null ? "stream_open" : "stream_runtime";
            const envelope = buildAgentEngineErrorEnvelope({
              requestId,
              modelId: selectedChatModel,
              sessionId: providerSessionIdForPersistence ?? providerSessionId,
              stage,
              error,
            });
            logAgentEngineEvent("error", {
              event: "vertex_stream_failed",
              request_id: requestId,
              chat_id: id,
              session_id: providerSessionId,
              user_id: bigQueryUserId,
              model_id: selectedChatModel,
              preflight_done_ms: preflightDoneAtMs
                ? preflightDoneAtMs - requestStartedAtMs
                : null,
              provider_session_ready_ms: providerSessionReadyAtMs
                ? providerSessionReadyAtMs - requestStartedAtMs
                : null,
              stream_opened_ms: streamOpenedAtMs
                ? streamOpenedAtMs - requestStartedAtMs
                : null,
              first_delta_ms: firstDeltaAtMs
                ? firstDeltaAtMs - requestStartedAtMs
                : null,
              total_request_ms: Date.now() - requestStartedAtMs,
              reason: error instanceof Error ? error.message : String(error),
              error_envelope: envelope,
            });
            return envelope;
          },
        });
      } catch (error) {
        const envelope = buildAgentEngineErrorEnvelope({
          requestId,
          modelId: selectedChatModel,
          sessionId: providerSessionIdForPersistence,
          stage: "request_setup",
          error,
        });
        logAgentEngineEvent("error", {
          event: "agent_engine_request_failed",
          request_id: requestId,
          chat_id: id,
          user_id: bigQueryUserId,
          model_id: selectedChatModel,
          preflight_done_ms: preflightDoneAtMs
            ? preflightDoneAtMs - requestStartedAtMs
            : null,
          provider_session_ready_ms: providerSessionReadyAtMs
            ? providerSessionReadyAtMs - requestStartedAtMs
            : null,
          stream_opened_ms: streamOpenedAtMs
            ? streamOpenedAtMs - requestStartedAtMs
            : null,
          first_delta_ms: firstDeltaAtMs
            ? firstDeltaAtMs - requestStartedAtMs
            : null,
          total_request_ms: Date.now() - requestStartedAtMs,
          reason: error instanceof Error ? error.message : String(error),
          error_envelope: envelope,
        });
        return new ChatSDKError("bad_request:agent_engine", envelope).toResponse();
      }
    } else if (isDirectProviderModel(selectedChatModel)) {
      stream = createUIMessageStream({
        originalMessages: isToolApprovalFlow ? uiMessages : undefined,
        execute: async ({ writer: dataStream }) => {
          const textPartId = generateUUID();
          dataStream.write({ type: "start" });
          dataStream.write({ type: "text-start", id: textPartId });
          if (exportHint) {
            dataStream.write({
              type: "data-export-hint",
              data: exportHint,
            });
          }

          for await (const delta of streamDirectProviderResponse({
            modelId: selectedChatModel,
            messages: uiMessages,
            system: systemPrompt({ selectedChatModel, requestHints }),
            signal: request.signal,
          })) {
            if (!delta) {
              continue;
            }

            dataStream.write({
              type: "text-delta",
              id: textPartId,
              delta,
            });
          }

          dataStream.write({ type: "text-end", id: textPartId });
          dataStream.write({ type: "finish", finishReason: "stop" });

          if (titlePromise) {
            const title = await titlePromise;
            dataStream.write({ type: "data-chat-title", data: title });
            updateChatTitleById({ chatId: id, title });
          }
        },
        generateId: generateUUID,
        onFinish: handleOnFinish,
        onError: (error) => {
          console.error("Direct provider stream error:", error);
          if (error instanceof Error) {
            return error.message;
          }
          return "Oops, an error occurred!";
        },
      });
    } else {
      const isReasoningModel =
        selectedChatModel.includes("reasoning") ||
        selectedChatModel.includes("thinking");

      const modelMessages = await convertToModelMessages(uiMessages);

      stream = createUIMessageStream({
        originalMessages: isToolApprovalFlow ? uiMessages : undefined,
        execute: async ({ writer: dataStream }) => {
          const result = streamText({
            model: getLanguageModel(selectedChatModel),
            system: systemPrompt({ selectedChatModel, requestHints }),
            messages: modelMessages,
            stopWhen: stepCountIs(5),
            experimental_activeTools: isReasoningModel
              ? []
              : ["getWeather", "createDocument", "updateDocument"],
            providerOptions: isReasoningModel
              ? {
                  anthropic: {
                    thinking: { type: "enabled", budgetTokens: 10_000 },
                  },
                }
              : undefined,
            tools: {
              getWeather,
              createDocument: createDocument({ session, dataStream }),
              updateDocument: updateDocument({ session, dataStream }),
            },
            experimental_telemetry: {
              isEnabled: isProductionEnvironment,
              functionId: "stream-text",
            },
          });

          dataStream.merge(result.toUIMessageStream({ sendReasoning: true }));

          if (exportHint) {
            dataStream.write({
              type: "data-export-hint",
              data: exportHint,
            });
          }

          if (titlePromise) {
            const title = await titlePromise;
            dataStream.write({ type: "data-chat-title", data: title });
            updateChatTitleById({ chatId: id, title });
          }
        },
        generateId: generateUUID,
        onFinish: handleOnFinish,
        onError: () => "Oops, an error occurred!",
      });
    }

    return createUIMessageStreamResponse({
      stream,
      headers: {
        "x-chat-request-id": requestId,
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
      const causeText =
        typeof error.cause === "string" ? error.cause.toLowerCase() : "";
      const tokenEndpointUnavailable =
        error.surface === "database" &&
        (causeText.includes("service-account token endpoint") ||
          causeText.includes("service-account access token") ||
          causeText.includes("oauth2.googleapis.com/token"));

      if (tokenEndpointUnavailable) {
        const offlineCause =
          typeof error.cause === "string" ? error.cause : undefined;
        return new ChatSDKError("offline:chat", offlineCause).toResponse();
      }

      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatSDKError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, {
      vercelId,
      request_id: requestId,
      chat_id: requestBody.id,
      model_id: requestBody.selectedChatModel,
    });
    return new ChatSDKError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const [bigQueryUserId, fallbackBigQueryUserId] = getBigQueryUserIdCandidates(
    session.user
  );
  if (!bigQueryUserId) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }
  const chatOwnerIds = new Set(
    [session.user.id, bigQueryUserId, fallbackBigQueryUserId].filter(
      Boolean
    ) as string[]
  );

  const chat = await getChatById({ id });

  if (chat && !chatOwnerIds.has(chat.userId)) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  await softDeleteSessionMessagesByChatId({
    chatId: id,
    userId: bigQueryUserId,
    fallbackUserId: fallbackBigQueryUserId,
  });

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}

export async function PATCH(request: Request) {
  let requestBody: { id?: string; visibility?: "public" | "private" };

  try {
    requestBody = (await request.json()) as {
      id?: string;
      visibility?: "public" | "private";
    };
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const id = typeof requestBody.id === "string" ? requestBody.id : "";
  const visibility = requestBody.visibility;

  if (!id || (visibility !== "public" && visibility !== "private")) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const [bigQueryUserId, fallbackBigQueryUserId] = getBigQueryUserIdCandidates(
    session.user
  );
  if (!bigQueryUserId) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chatOwnerIds = new Set(
    [session.user.id, bigQueryUserId, fallbackBigQueryUserId].filter(
      Boolean
    ) as string[]
  );

  const chat = await getChatById({ id });

  if (!chat) {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  if (!chatOwnerIds.has(chat.userId)) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  try {
    await updateChatVisibilityById({
      chatId: id,
      visibility,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    return new ChatSDKError("bad_request:database").toResponse();
  }

  return Response.json(
    {
      id,
      visibility,
    },
    { status: 200 }
  );
}
