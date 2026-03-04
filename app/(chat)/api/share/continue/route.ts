import { auth } from "@/app/(auth)/auth";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import {
  getChatMessagesByChatId,
  persistMessageToBigQuery,
} from "@/lib/chat-store";
import { getChatById, saveChat } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

type ContinueShareRequestBody = {
  chatId?: string;
};

function toMonotonicIsoTimestamp({
  rawCreatedAt,
  previousCreatedAtMs,
  fallbackNowMs,
}: {
  rawCreatedAt?: string;
  previousCreatedAtMs: number | null;
  fallbackNowMs: number;
}) {
  const parsedMs =
    typeof rawCreatedAt === "string" ? new Date(rawCreatedAt).getTime() : NaN;
  const candidateMs = Number.isFinite(parsedMs) ? parsedMs : fallbackNowMs;

  if (previousCreatedAtMs === null) {
    return {
      createdAt: new Date(candidateMs).toISOString(),
      createdAtMs: candidateMs,
    };
  }

  const normalizedMs =
    candidateMs > previousCreatedAtMs ? candidateMs : previousCreatedAtMs + 1;

  return {
    createdAt: new Date(normalizedMs).toISOString(),
    createdAtMs: normalizedMs,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ContinueShareRequestBody;
    const sourceChatId = typeof body.chatId === "string" ? body.chatId : "";
    if (!sourceChatId) {
      return new ChatSDKError("bad_request:api").toResponse();
    }

    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const [bigQueryUserId, fallbackBigQueryUserId] =
      getBigQueryUserIdCandidates(session.user);
    if (!bigQueryUserId) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const sourceChat = await getChatById({ id: sourceChatId });
    if (!sourceChat) {
      return new ChatSDKError("not_found:chat").toResponse();
    }

    const chatOwnerIds = new Set(
      [session.user.id, bigQueryUserId, fallbackBigQueryUserId].filter(
        Boolean
      ) as string[]
    );
    const isOwner = chatOwnerIds.has(sourceChat.userId);

    if (!isOwner && sourceChat.visibility !== "public") {
      return new ChatSDKError("forbidden:chat").toResponse();
    }

    const sourceMessages = await getChatMessagesByChatId({
      chatId: sourceChatId,
      userId: sourceChat.userId,
      dedupeAssistantDuplicates: true,
    });

    const messagesToClone = sourceMessages.filter(
      (message) => message.role === "user" || message.role === "assistant"
    );

    const newChatId = generateUUID();
    await saveChat({
      id: newChatId,
      userId: bigQueryUserId,
      title: sourceChat.title,
      visibility: "private",
    });

    let previousCreatedAtMs: number | null = null;
    const fallbackNowMs = Date.now();

    for (const [index, sourceMessage] of messagesToClone.entries()) {
      const { createdAt, createdAtMs } = toMonotonicIsoTimestamp({
        rawCreatedAt: sourceMessage.metadata?.createdAt,
        previousCreatedAtMs,
        fallbackNowMs: fallbackNowMs + index,
      });
      previousCreatedAtMs = createdAtMs;

      const clonedMessage: ChatMessage = {
        id: generateUUID(),
        role: sourceMessage.role,
        parts: sourceMessage.parts,
        metadata: {
          createdAt,
          chartSpec: sourceMessage.metadata?.chartSpec ?? null,
          chartError: sourceMessage.metadata?.chartError ?? null,
        },
      };

      await persistMessageToBigQuery({
        chatId: newChatId,
        sessionId: newChatId,
        userId: bigQueryUserId,
        message: clonedMessage,
        visibility: "private",
        chartSpec: sourceMessage.metadata?.chartSpec ?? undefined,
        chartError: sourceMessage.metadata?.chartError ?? null,
        answeredIn: null,
      });
    }

    return Response.json({ chatId: newChatId }, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    const cause =
      error instanceof Error ? error.message : "Failed to clone shared chat.";
    return new ChatSDKError("bad_request:database", cause).toResponse();
  }
}
