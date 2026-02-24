"use server";

import { generateText, type UIMessage } from "ai";
import { cookies } from "next/headers";
import { auth } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/visibility-selector";
import { titlePrompt } from "@/lib/ai/prompts";
import { getTitleModel } from "@/lib/ai/providers";
import {
  deleteTrailingMessagesByTimestamp,
  findMessageReferenceById,
} from "@/lib/chat-store";
import { updateChatVisibilityById } from "@/lib/db/queries";
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

  const messageReference = await findMessageReferenceById({
    messageId: id,
    userId: session.user.id,
  });

  if (!messageReference) {
    return;
  }

  await deleteTrailingMessagesByTimestamp({
    chatId: messageReference.chatId,
    userId: session.user.id,
    timestamp: messageReference.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  await updateChatVisibilityById({ chatId, visibility });
}
