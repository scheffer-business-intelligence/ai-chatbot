import { auth } from "@/app/(auth)/auth";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import { getChatById, getVotesByChatId, voteMessage } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return new ChatSDKError(
      "bad_request:api",
      "Parameter chatId is required."
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:vote").toResponse();
  }
  const [bigQueryUserId, fallbackBigQueryUserId] =
    getBigQueryUserIdCandidates(session.user);
  if (!bigQueryUserId) {
    return new ChatSDKError("unauthorized:vote").toResponse();
  }
  const chatOwnerIds = new Set(
    [session.user.id, bigQueryUserId, fallbackBigQueryUserId].filter(
      Boolean
    ) as string[]
  );

  const chat = await getChatById({ id: chatId });

  if (!chat) {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  if (!chatOwnerIds.has(chat.userId)) {
    return new ChatSDKError("forbidden:vote").toResponse();
  }

  const votes = await getVotesByChatId({ id: chatId });

  return Response.json(votes, { status: 200 });
}

export async function PATCH(request: Request) {
  const {
    chatId,
    messageId,
    type,
  }: { chatId: string; messageId: string; type: "up" | "down" } =
    await request.json();

  if (!chatId || !messageId || !type) {
    return new ChatSDKError(
      "bad_request:api",
      "Parameters chatId, messageId, and type are required."
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:vote").toResponse();
  }
  const [bigQueryUserId, fallbackBigQueryUserId] =
    getBigQueryUserIdCandidates(session.user);
  if (!bigQueryUserId) {
    return new ChatSDKError("unauthorized:vote").toResponse();
  }
  const chatOwnerIds = new Set(
    [session.user.id, bigQueryUserId, fallbackBigQueryUserId].filter(
      Boolean
    ) as string[]
  );

  const chat = await getChatById({ id: chatId });

  if (!chat) {
    return new ChatSDKError("not_found:vote").toResponse();
  }

  if (!chatOwnerIds.has(chat.userId)) {
    return new ChatSDKError("forbidden:vote").toResponse();
  }

  await voteMessage({
    chatId,
    messageId,
    type,
  });

  return new Response("Message voted", { status: 200 });
}
