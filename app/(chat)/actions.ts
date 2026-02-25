"use server";

import { generateText, type UIMessage } from "ai";
import { cookies } from "next/headers";
import { auth } from "@/app/(auth)/auth";
import { titlePrompt } from "@/lib/ai/prompts";
import { getTitleModel } from "@/lib/ai/providers";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import {
  deleteTrailingMessagesByTimestamp,
  findMessageReferenceById,
} from "@/lib/chat-store";
import { getTextFromMessage } from "@/lib/utils";

function createFallbackTitle(input: string) {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Nova Conversa";
  }

  return normalized.slice(0, 80);
}

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set("chat-model", model);
}

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  const prompt = getTextFromMessage(message);

  try {
    const { text } = await generateText({
      model: getTitleModel(),
      system: titlePrompt,
      prompt,
    });

    const sanitizedTitle = text
      .replace(/^[#*"\s]+/, "")
      .replace(/["]+$/, "")
      .trim();

    return sanitizedTitle || createFallbackTitle(prompt);
  } catch (error) {
    console.warn("Title generation failed; using fallback title.", error);
    return createFallbackTitle(prompt);
  }
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const session = await auth();

  if (!session?.user) {
    return;
  }

  const [bigQueryUserId, fallbackBigQueryUserId] =
    getBigQueryUserIdCandidates(session.user);
  if (!bigQueryUserId) {
    return;
  }

  const messageReference = await findMessageReferenceById({
    messageId: id,
    userId: bigQueryUserId,
    fallbackUserId: fallbackBigQueryUserId,
  });

  if (!messageReference) {
    return;
  }

  await deleteTrailingMessagesByTimestamp({
    chatId: messageReference.chatId,
    userId: bigQueryUserId,
    fallbackUserId: fallbackBigQueryUserId,
    timestamp: messageReference.createdAt,
  });
}
