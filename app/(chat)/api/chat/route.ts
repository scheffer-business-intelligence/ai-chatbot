import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
  type UIMessageChunk,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
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
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { getServiceAccountAccessToken } from "@/lib/auth/service-account-token";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getProviderSessionByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
  upsertProviderSession,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import {
  AGENT_ENGINE_PROVIDER_ID,
  createVertexSession,
  streamVertexQuery,
  type VertexExtractedContext,
} from "@/lib/vertex/agent-engine";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 300;
const DEFAULT_AGENT_ENGINE_MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;
const AGENT_ENGINE_INLINE_XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
        "name" in part && typeof part.name === "string"
          ? part.name
          : "uploaded_file";
      const fileUrl =
        "url" in part && typeof part.url === "string" ? part.url : "";
      const mediaType =
        "mediaType" in part && typeof part.mediaType === "string"
          ? part.mediaType
          : "application/octet-stream";

      if (!fileUrl) {
        throw new Error(`Attachment ${displayName} is missing a URL.`);
      }

      if (!isAllowedInlineAttachmentMimeType(mediaType)) {
        throw new Error(
          `Attachment ${displayName} has unsupported media type for Agent Engine: ${mediaType}`
        );
      }

      let fileResponse: Response;
      try {
        fileResponse = await fetch(fileUrl, { signal });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        throw new Error(
          `Failed to fetch attachment ${displayName} from ${fileUrl}: ${reason}`
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

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow) {
        messagesFromDb = await getMessagesByChatId({ id });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        userId: session.user.id,
        title: "Nova Conversa",
        visibility: selectedVisibilityType,
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
      : [...convertToUIMessages(messagesFromDb), message as ChatMessage];

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    if (message?.role === "user" && !isToolApprovalFlow) {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            chartSpec: null,
            chartError: null,
            createdAt: new Date(),
          },
        ],
      });
    }

    const extractedContext: VertexExtractedContext = {
      chartSpec: null,
      chartError: null,
      hasChartContext: false,
      contextSheets: [],
    };

    const handleOnFinish = async ({
      messages: finishedMessages,
    }: {
      messages: ChatMessage[];
    }) => {
      const lastAssistantMessageId = [...finishedMessages]
        .reverse()
        .find((currentMessage) => currentMessage.role === "assistant")?.id;

      if (isToolApprovalFlow) {
        for (const finishedMsg of finishedMessages) {
          const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
          const shouldPersistChartContext =
            isAgentEngineModel(selectedChatModel) &&
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
              isAgentEngineModel(selectedChatModel) &&
              currentMessage.role === "assistant" &&
              currentMessage.id === lastAssistantMessageId
                ? extractedContext.chartSpec
                : null,
            chartError:
              isAgentEngineModel(selectedChatModel) &&
              currentMessage.role === "assistant" &&
              currentMessage.id === lastAssistantMessageId
                ? extractedContext.chartError
                : null,
            chatId: id,
          })),
        });
      }
    };

    let stream: ReadableStream<UIMessageChunk>;

    if (isAgentEngineModel(selectedChatModel)) {
      try {
        const serviceAccountAccessToken = await getServiceAccountAccessToken();

        const latestUserMessage =
          message?.role === "user"
            ? (message as ChatMessage)
            : getLatestUserMessage(uiMessages);

        if (!latestUserMessage) {
          return new ChatSDKError(
            "bad_request:api",
            "No user message found for Agent Engine request."
          ).toResponse();
        }

        const existingProviderSession = await getProviderSessionByChatId({
          chatId: id,
          provider: AGENT_ENGINE_PROVIDER_ID,
        });

        let providerSessionId = existingProviderSession?.sessionId;

        if (!providerSessionId) {
          providerSessionId = await createVertexSession(
            serviceAccountAccessToken,
            session.user.id
          );

          await upsertProviderSession({
            chatId: id,
            provider: AGENT_ENGINE_PROVIDER_ID,
            sessionId: providerSessionId,
            userId: session.user.id,
          });
        }

        const vertexMessage = await buildVertexMessageFromUserMessage(
          latestUserMessage,
          request.signal
        );

        stream = createUIMessageStream({
          originalMessages: isToolApprovalFlow ? uiMessages : undefined,
          execute: async ({ writer: dataStream }) => {
            const textPartId = generateUUID();
            let hasVisibleOutput = false;
            dataStream.write({ type: "start" });
            dataStream.write({ type: "text-start", id: textPartId });

            for await (const delta of streamVertexQuery({
              accessToken: serviceAccountAccessToken,
              sessionId: providerSessionId,
              userId: session.user.id,
              message: vertexMessage,
              signal: request.signal,
              extractedContext,
            })) {
              if (!delta) {
                continue;
              }

              if (!delta.trim()) {
                continue;
              }

              dataStream.write({
                type: "text-delta",
                id: textPartId,
                delta,
              });
              hasVisibleOutput = true;
            }

            if (!hasVisibleOutput) {
              throw new Error(
                "Scheffer Agente Engine retornou resposta vazia."
              );
            }

            if (extractedContext.chartSpec) {
              dataStream.write({
                type: "data-chart-spec",
                data: extractedContext.chartSpec,
              });
            } else if (extractedContext.chartError) {
              dataStream.write({
                type: "data-chart-warning",
                data: extractedContext.chartError,
              });
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
            console.error("Agent Engine stream error:", error);
            if (error instanceof Error) {
              return `Não consegui obter resposta do Scheffer Agente Engine: ${error.message}`;
            }
            return "Não consegui obter resposta do Scheffer Agente Engine.";
          },
        });
      } catch (error) {
        const cause =
          error instanceof Error
            ? error.message
            : "Unexpected Agent Engine error";
        return new ChatSDKError("bad_request:agent_engine", cause).toResponse();
      }
    } else if (isDirectProviderModel(selectedChatModel)) {
      stream = createUIMessageStream({
        originalMessages: isToolApprovalFlow ? uiMessages : undefined,
        execute: async ({ writer: dataStream }) => {
          const textPartId = generateUUID();
          dataStream.write({ type: "start" });
          dataStream.write({ type: "text-start", id: textPartId });

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
              : [
                  "getWeather",
                  "createDocument",
                  "updateDocument",
                  "requestSuggestions",
                ],
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
              requestSuggestions: requestSuggestions({ session, dataStream }),
            },
            experimental_telemetry: {
              isEnabled: isProductionEnvironment,
              functionId: "stream-text",
            },
          });

          dataStream.merge(result.toUIMessageStream({ sendReasoning: true }));

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
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          // ignore redis errors
        }
      },
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatSDKError) {
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

    console.error("Unhandled error in chat API:", error, { vercelId });
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

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
