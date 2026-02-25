"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { ChatHeader } from "@/components/chat-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useArtifactSelector } from "@/hooks/use-artifact";
import { ChatSDKError } from "@/lib/errors";
import type { Attachment, ChatMessage } from "@/lib/types";
import { fetchWithErrorHandlers, generateUUID } from "@/lib/utils";
import { Artifact } from "./artifact";
import { useDataStream } from "@/components/data-stream-provider";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";
import { getChatHistoryPaginationKey } from "./sidebar-history";
import { toast } from "./toast";

export function Chat({
  id,
  initialMessages,
  initialChatModel,
  isReadonly,
}: {
  id: string;
  initialMessages: ChatMessage[];
  initialChatModel: string;
  isReadonly: boolean;
}) {
  const router = useRouter();

  const { mutate } = useSWRConfig();

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      // When user navigates back/forward, refresh to sync with URL
      router.refresh();
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [router]);
  const { setDataStream } = useDataStream();

  const [input, setInput] = useState<string>("");
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);
  const [isContinuingSharedChat, setIsContinuingSharedChat] = useState(false);
  const [currentModelId, setCurrentModelId] = useState(initialChatModel);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const currentModelIdRef = useRef(currentModelId);
  const hasStreamedAssistantTextRef = useRef(false);

  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    generateId: generateUUID,
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      const shouldContinue =
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false;
      return shouldContinue;
    },
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);
        const isToolApprovalContinuation =
          lastMessage?.role !== "user" ||
          request.messages.some((msg) =>
            msg.parts?.some((part) => {
              const state = (part as { state?: string }).state;
              return (
                state === "approval-responded" || state === "output-denied"
              );
            })
          );

        return {
          body: {
            id: request.id,
            ...(isToolApprovalContinuation
              ? { messages: request.messages }
              : { message: lastMessage }),
            selectedChatModel: currentModelIdRef.current,
            ...request.body,
          },
        };
      },
    }),
    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));

      if (dataPart.type === "data-agent-status") {
        if (hasStreamedAssistantTextRef.current) {
          return;
        }

        const normalizedStatus =
          typeof dataPart.data === "string" ? dataPart.data.trim() : "";

        if (normalizedStatus) {
          setAgentStatus(normalizedStatus);
        }
      }
    },
    onFinish: () => {
      hasStreamedAssistantTextRef.current = false;
      setAgentStatus(null);
      mutate(unstable_serialize(getChatHistoryPaginationKey));
    },
    onError: (error) => {
      hasStreamedAssistantTextRef.current = false;
      setAgentStatus(null);
      if (error instanceof ChatSDKError) {
        if (
          error.message?.includes("AI Gateway requires a valid credit card")
        ) {
          setShowCreditCardAlert(true);
        } else {
          const errorCause =
            typeof error.cause === "string" ? error.cause.trim() : "";

          toast({
            type: "error",
            description: errorCause || error.message,
          });
        }
        return;
      }

      const description =
        error instanceof Error && error.message
          ? error.message
          : "Falha ao obter resposta do modelo selecionado.";

      toast({
        type: "error",
        description,
      });
    },
  });

  useEffect(() => {
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    const hasVisibleAssistantContent =
      lastMessage.parts?.some((part) => {
        if (part.type === "text") {
          return part.text.trim().length > 0;
        }

        if (part.type === "reasoning") {
          return part.text.trim().length > 0;
        }

        if (part.type.startsWith("tool-")) {
          return true;
        }

        if (
          part.type === "data-chart-spec" ||
          part.type === "data-chart-warning" ||
          part.type === "data-export-context"
        ) {
          return true;
        }

        return part.type === "file";
      }) ?? false;

    if (hasVisibleAssistantContent) {
      hasStreamedAssistantTextRef.current = true;
      setAgentStatus(null);
    }
  }, [messages]);

  useEffect(() => {
    if (status === "error" || status === "ready") {
      hasStreamedAssistantTextRef.current = false;
      setAgentStatus(null);
    }
  }, [status]);

  const sendMessageWithStatusReset: typeof sendMessage = useCallback(
    (message, options) => {
      hasStreamedAssistantTextRef.current = false;
      setAgentStatus(null);
      return sendMessage(message, options);
    },
    [sendMessage]
  );

  const searchParams = useSearchParams();
  const query = searchParams.get("query");

  const [hasAppendedQuery, setHasAppendedQuery] = useState(false);

  useEffect(() => {
    if (query && !hasAppendedQuery) {
      sendMessageWithStatusReset({
        role: "user" as const,
        parts: [{ type: "text", text: query }],
      });

      setHasAppendedQuery(true);
      window.history.replaceState({}, "", `/chat/${id}`);
    }
  }, [query, sendMessageWithStatusReset, hasAppendedQuery, id]);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);

  const handleContinueSharedChat = useCallback(async () => {
    if (isContinuingSharedChat) {
      return;
    }

    setIsContinuingSharedChat(true);

    try {
      const response = await fetch("/api/share/continue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ chatId: id }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { chatId?: string; message?: string; cause?: string; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(
          payload?.cause ||
            payload?.error ||
            payload?.message ||
            "Falha ao criar nova sessão."
        );
      }

      const nextChatId = payload?.chatId;
      if (!nextChatId) {
        throw new Error("Falha ao criar nova sessão.");
      }

      await mutate(unstable_serialize(getChatHistoryPaginationKey));
      router.push(`/chat/${nextChatId}`);
      router.refresh();
      toast({
        type: "success",
        description: "Nova sessão criada com o contexto da conversa.",
      });
    } catch (error) {
      toast({
        type: "error",
        description:
          error instanceof Error ? error.message : "Falha ao continuar conversa.",
      });
    } finally {
      setIsContinuingSharedChat(false);
    }
  }, [id, isContinuingSharedChat, mutate, router]);

  return (
    <>
      <div className="overscroll-behavior-contain flex h-dvh min-w-0 touch-pan-y flex-col bg-background">
        <ChatHeader />

        <Messages
          addToolApprovalResponse={addToolApprovalResponse}
          agentStatus={agentStatus}
          chatId={id}
          isArtifactVisible={isArtifactVisible}
          isReadonly={isReadonly}
          messages={messages}
          regenerate={regenerate}
          selectedModelId={initialChatModel}
          setMessages={setMessages}
          status={status}
        />

        <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 pb-3 md:px-4 md:pb-4">
          {!isReadonly && (
            <MultimodalInput
              attachments={attachments}
              chatId={id}
              input={input}
              messages={messages}
              onModelChange={setCurrentModelId}
              selectedModelId={currentModelId}
              sendMessage={sendMessageWithStatusReset}
              setAttachments={setAttachments}
              setInput={setInput}
              setMessages={setMessages}
              status={status}
              stop={stop}
            />
          )}
          {isReadonly && (
            <div className="flex w-full items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
              <p className="text-muted-foreground text-sm">
                Este chat compartilhado está em modo somente leitura.
              </p>
              <Button
                disabled={isContinuingSharedChat}
                onClick={handleContinueSharedChat}
                size="sm"
                type="button"
              >
                {isContinuingSharedChat
                  ? "Abrindo..."
                  : "Continuar em nova conversa"}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Artifact
        addToolApprovalResponse={addToolApprovalResponse}
        agentStatus={agentStatus}
        attachments={attachments}
        chatId={id}
        input={input}
        isReadonly={isReadonly}
        messages={messages}
        regenerate={regenerate}
        selectedModelId={currentModelId}
        sendMessage={sendMessageWithStatusReset}
        setAttachments={setAttachments}
        setInput={setInput}
        setMessages={setMessages}
        status={status}
        stop={stop}
      />

      <AlertDialog
        onOpenChange={setShowCreditCardAlert}
        open={showCreditCardAlert}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate AI Gateway</AlertDialogTitle>
            <AlertDialogDescription>
              This application requires{" "}
              {process.env.NODE_ENV === "production" ? "the owner" : "you"} to
              activate Vercel AI Gateway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                window.open(
                  "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card",
                  "_blank"
                );
                window.location.href = "/";
              }}
            >
              Activate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
