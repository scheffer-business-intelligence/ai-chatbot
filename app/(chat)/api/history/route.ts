import type { NextRequest } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import { deleteAllChatsByUserId, getChatsByUserId } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

const HISTORY_FALLBACK_LOG_COOLDOWN_MS = 30_000;
let lastHistoryFallbackLogAt = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const limit = Number.parseInt(searchParams.get("limit") || "10", 10);
  const startingAfter = searchParams.get("starting_after");
  const endingBefore = searchParams.get("ending_before");

  if (startingAfter && endingBefore) {
    return new ChatSDKError(
      "bad_request:api",
      "Only one of starting_after or ending_before can be provided."
    ).toResponse();
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

  try {
    let chats = await getChatsByUserId({
      id: bigQueryUserId,
      limit,
      startingAfter,
      endingBefore,
    });

    if (
      chats.chats.length === 0 &&
      fallbackBigQueryUserId &&
      fallbackBigQueryUserId !== bigQueryUserId
    ) {
      chats = await getChatsByUserId({
        id: fallbackBigQueryUserId,
        limit,
        startingAfter,
        endingBefore,
      });
    }

    return Response.json(chats);
  } catch (error) {
    const now = Date.now();
    if (now - lastHistoryFallbackLogAt >= HISTORY_FALLBACK_LOG_COOLDOWN_MS) {
      lastHistoryFallbackLogAt = now;
      console.warn(
        "Failed to load history from BigQuery, returning empty:",
        error
      );
    }
    return Response.json({ chats: [], hasMore: false });
  }
}

export async function DELETE() {
  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const [bigQueryUserId, fallbackBigQueryUserId] =
    getBigQueryUserIdCandidates(session.user);
  if (!bigQueryUserId) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const distinctUserIds = [
    ...new Set([bigQueryUserId, fallbackBigQueryUserId].filter(Boolean)),
  ] as string[];
  let deletedCount = 0;

  for (const userId of distinctUserIds) {
    const result = await deleteAllChatsByUserId({ userId });
    deletedCount += result.deletedCount;
  }

  return Response.json({ deletedCount }, { status: 200 });
}
