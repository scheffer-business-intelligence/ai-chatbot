import { auth } from "@/app/(auth)/auth";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import { persistMessageToBigQuery } from "@/lib/chat-store";
import { getChatById, getMessagesByChatId, saveChat } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import { dedupeDbAssistantMessages } from "@/lib/messages/dedupe";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

type ContinueShareRequestBody = {
  chatId?: string;
};

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

    const sourceMessages = await getMessagesByChatId({ id: sourceChatId });
    const messagesToClone = dedupeDbAssistantMessages(
      sourceMessages.filter(
        (message) => message.role === "user" || message.role === "assistant"
      )
    );

    const newChatId = generateUUID();
    await saveChat({
      id: newChatId,
      userId: bigQueryUserId,
      title: sourceChat.title,
      visibility: "private",
    });

    for (const sourceMessage of messagesToClone) {
      const clonedMessage: ChatMessage = {
        id: generateUUID(),
        role: sourceMessage.role as ChatMessage["role"],
        parts: sourceMessage.parts as ChatMessage["parts"],
        metadata: {
          createdAt: sourceMessage.createdAt.toISOString(),
          chartSpec: sourceMessage.chartSpec as any,
          chartError: sourceMessage.chartError ?? null,
        },
      };

      await persistMessageToBigQuery({
        chatId: newChatId,
        userId: bigQueryUserId,
        message: clonedMessage,
        visibility: "private",
        chartSpec: sourceMessage.chartSpec ?? undefined,
        chartError: sourceMessage.chartError ?? null,
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
