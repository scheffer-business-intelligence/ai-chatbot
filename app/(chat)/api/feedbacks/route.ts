import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import { getChatById, getMessageById } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import { getBigQueryAccessToken, insertFeedbackRow } from "@/lib/gcp/bigquery";
import { sanitizeText } from "@/lib/utils";

const MAX_FEEDBACK_LENGTH = 5000;

const feedbackBodySchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  feedback: z.string().min(1),
});

function sanitizeFeedback(input: string) {
  return input
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_FEEDBACK_LENGTH);
}

function extractTextFromMessageParts(parts: unknown) {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
            typeof part === "object" &&
            "type" in part &&
            (part as { type?: unknown }).type === "text" &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
        )
    )
    .map((part) => sanitizeText(part.text))
    .join("\n")
    .trim();
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const [userId, fallbackUserId] = getBigQueryUserIdCandidates(session.user);
    if (!userId) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }
    const chatOwnerIds = new Set(
      [session.user.id, userId, fallbackUserId].filter(Boolean) as string[]
    );

    const rawBody = await request.json();
    const parsedBody = feedbackBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return new ChatSDKError(
        "bad_request:api",
        "chatId, messageId e feedback são obrigatórios."
      ).toResponse();
    }

    const { chatId, messageId, feedback } = parsedBody.data;
    const sanitizedFeedback = sanitizeFeedback(feedback);

    if (!sanitizedFeedback) {
      return new ChatSDKError(
        "bad_request:api",
        "Descreva rapidamente o feedback da resposta."
      ).toResponse();
    }

    if (feedback.trim().length > MAX_FEEDBACK_LENGTH) {
      return new ChatSDKError(
        "bad_request:api",
        `Feedback muito longo (máx. ${MAX_FEEDBACK_LENGTH} caracteres).`
      ).toResponse();
    }

    const chat = await getChatById({ id: chatId });

    if (!chat) {
      return new ChatSDKError("not_found:chat").toResponse();
    }

    if (!chatOwnerIds.has(chat.userId)) {
      return new ChatSDKError("forbidden:chat").toResponse();
    }

    const messages = await getMessageById({ id: messageId });
    const assistantMessage = messages.find(
      (message) => message.chatId === chatId && message.role === "assistant"
    );

    if (!assistantMessage) {
      return new ChatSDKError(
        "not_found:chat",
        "Mensagem do assistente não encontrada para este chat."
      ).toResponse();
    }

    const content = extractTextFromMessageParts(assistantMessage.parts);

    if (!content) {
      return new ChatSDKError(
        "bad_request:api",
        "A mensagem selecionada não possui conteúdo textual para feedback."
      ).toResponse();
    }

    const accessToken = await getBigQueryAccessToken();
    await insertFeedbackRow(accessToken, {
      message_id: assistantMessage.id,
      session_id: chatId,
      user_id: userId,
      role: assistantMessage.role,
      content,
      created_at: assistantMessage.createdAt.toISOString(),
      feedback_message: sanitizedFeedback,
    });

    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    const reason =
      error instanceof Error ? error.message : "Falha ao registrar feedback.";

    return Response.json({ error: reason }, { status: 500 });
  }
}
