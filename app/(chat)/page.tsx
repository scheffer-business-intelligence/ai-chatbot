import { cookies } from "next/headers";
import { Suspense } from "react";
import { Chat } from "@/components/chat";
import { DataStreamHandler } from "@/components/data-stream-handler";
import { DataStreamProvider } from "@/components/data-stream-provider";
import { chatModels, DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { generateUUID } from "@/lib/utils";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <NewChatPage />
    </Suspense>
  );
}

async function NewChatPage() {
  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get("chat-model");
  const id = generateUUID();
  const selectedModelId =
    modelIdFromCookie &&
    chatModels.some((model) => model.id === modelIdFromCookie.value)
      ? modelIdFromCookie.value
      : DEFAULT_CHAT_MODEL;

  if (!modelIdFromCookie || selectedModelId === DEFAULT_CHAT_MODEL) {
    return (
      <DataStreamProvider>
        <Chat
          id={id}
          initialChatModel={DEFAULT_CHAT_MODEL}
          initialMessages={[]}
          isReadonly={false}
          key={id}
        />
        <DataStreamHandler />
      </DataStreamProvider>
    );
  }

  return (
    <DataStreamProvider>
      <Chat
        id={id}
        initialChatModel={selectedModelId}
        initialMessages={[]}
        isReadonly={false}
        key={id}
      />
      <DataStreamHandler />
    </DataStreamProvider>
  );
}
