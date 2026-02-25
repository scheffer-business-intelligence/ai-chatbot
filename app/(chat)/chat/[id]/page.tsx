import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@/app/(auth)/auth";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { chatModels, DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import { getChatMessagesByChatId } from "@/lib/chat-store";
import { getChatById } from "@/lib/db/queries";

export default function Page(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <ChatPage params={props.params} />
    </Suspense>
  );
}

async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = await getChatById({ id });

  if (!chat) {
    redirect("/");
  }

  const session = await auth();
  const sessionUser = session?.user;

  let isOwner = false;
  let resolvedUserId = chat.userId;
  let resolvedFallbackUserId: string | undefined;

  if (sessionUser) {
    const [bigQueryUserId, fallbackBigQueryUserId] =
      getBigQueryUserIdCandidates(sessionUser);
    const chatOwnerIds = new Set(
      [sessionUser.id, bigQueryUserId, fallbackBigQueryUserId].filter(
        Boolean
      ) as string[]
    );

    isOwner = chatOwnerIds.has(chat.userId);

    if (!isOwner && chat.visibility !== "public") {
      return notFound();
    }

    if (isOwner) {
      resolvedUserId = bigQueryUserId || chat.userId;
      resolvedFallbackUserId = fallbackBigQueryUserId || undefined;
    }
  } else if (chat.visibility !== "public") {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/chat/${id}`)}`);
  }

  const uiMessages = await getChatMessagesByChatId({
    chatId: id,
    userId: resolvedUserId,
    fallbackUserId: isOwner ? resolvedFallbackUserId : undefined,
  });

  const cookieStore = await cookies();
  const chatModelFromCookie = cookieStore.get("chat-model");
  const selectedModelId =
    chatModelFromCookie &&
    chatModels.some((model) => model.id === chatModelFromCookie.value)
      ? chatModelFromCookie.value
      : DEFAULT_CHAT_MODEL;

  if (!chatModelFromCookie || selectedModelId === DEFAULT_CHAT_MODEL) {
    return (
      <>
        <Chat
          id={chat.id}
          initialChatModel={DEFAULT_CHAT_MODEL}
          initialMessages={uiMessages}
          isReadonly={!isOwner}
        />
        <DataStreamHandler />
      </>
    );
  }

  return (
    <>
      <Chat
        id={chat.id}
        initialChatModel={selectedModelId}
        initialMessages={uiMessages}
        isReadonly={!isOwner}
      />
      <DataStreamHandler />
    </>
  );
}
