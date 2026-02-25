import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@/app/(auth)/auth";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { chatModels, DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
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

  if (!session) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/chat/${id}`)}`);
  }

  if (!session.user) {
    return notFound();
  }

  if (session.user.id !== chat.userId) {
    return notFound();
  }

  const uiMessages = await getChatMessagesByChatId({
    chatId: id,
    userId: chat.userId,
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
          isReadonly={session?.user?.id !== chat.userId}
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
        isReadonly={session?.user?.id !== chat.userId}
      />
      <DataStreamHandler />
    </>
  );
}
