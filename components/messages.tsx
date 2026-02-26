import type { UseChatHelpers } from "@ai-sdk/react";
import { ArrowDownIcon } from "lucide-react";
import { deleteTrailingMessages } from "@/app/(chat)/actions";
import { useDataStream } from "@/components/data-stream-provider";
import { useMessages } from "@/hooks/use-messages";
import {
  type ExportContextSheet,
  extractContextSheets,
  parseExportAwareText,
} from "@/lib/export-context";
import type { ChatMessage } from "@/lib/types";
import { sanitizeText } from "@/lib/utils";
import { Greeting } from "./greeting";
import { PreviewMessage, ThinkingMessage } from "./message";

type MessagesProps = {
  chatId: string;
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  agentStatus: string | null;
  status: UseChatHelpers<ChatMessage>["status"];
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  isArtifactVisible: boolean;
  selectedModelId: string;
};

function getContextSheetsFromMessage(
  message: ChatMessage
): ExportContextSheet[] {
  const contextFromParts = extractContextSheets(
    (
      message.parts.find((part) => part.type === "data-export-context") as
        | { type: "data-export-context"; data?: unknown }
        | undefined
    )?.data
  );

  if (contextFromParts.length > 0) {
    return contextFromParts;
  }

  for (const part of message.parts) {
    if (part.type !== "text") {
      continue;
    }

    const parsedText = parseExportAwareText(part.text);
    if (parsedText.contextSheets.length > 0) {
      return parsedText.contextSheets;
    }
  }

  return [];
}

function PureMessages({
  chatId,
  addToolApprovalResponse,
  agentStatus,
  status,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  selectedModelId: _selectedModelId,
}: MessagesProps) {
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    scrollToBottom,
    hasSentMessage,
  } = useMessages({
    status,
  });

  useDataStream();

  const hasToolApprovalResponse = messages.some((msg) =>
    msg.parts?.some(
      (part) => "state" in part && part.state === "approval-responded"
    )
  );

  const hasVisibleStreamingAssistantContent =
    status === "streaming" &&
    (() => {
      const lastMessage = messages.at(-1);

      if (!lastMessage || lastMessage.role !== "assistant") {
        return false;
      }

      return (
        lastMessage.parts?.some((part) => {
          if (part.type === "text") {
            const parsedText = parseExportAwareText(part.text);
            return (
              sanitizeText(parsedText.cleanText).trim().length > 0 ||
              parsedText.exportData !== null
            );
          }

          if (part.type === "reasoning") {
            return part.text.trim().length > 0;
          }

          if (part.type.startsWith("tool-")) {
            return true;
          }

          if (
            part.type === "data-chart-spec" ||
            part.type === "data-chart-warning"
          ) {
            return true;
          }

          if (part.type === "data-export-context") {
            return true;
          }

          if (part.type === "data-export-hint") {
            return true;
          }

          return part.type === "file";
        }) ?? false
      );
    })();

  const isWaitingForAssistant =
    !hasToolApprovalResponse &&
    (status === "submitted" || status === "streaming");
  const shouldShowStatusLine = isWaitingForAssistant && Boolean(agentStatus);
  const shouldShowThinkingFallback =
    isWaitingForAssistant &&
    !agentStatus &&
    (status === "submitted" ||
      (status === "streaming" && !hasVisibleStreamingAssistantContent));

  const createRegenerateHandler = (assistantMessageIndex: number) => {
    return async () => {
      const userMessage = [...messages]
        .slice(0, assistantMessageIndex)
        .reverse()
        .find((candidate) => candidate.role === "user");

      if (!userMessage) {
        await regenerate();
        return;
      }

      await deleteTrailingMessages({ id: userMessage.id });

      setMessages((currentMessages) => {
        const userIndex = currentMessages.findIndex(
          (currentMessage) => currentMessage.id === userMessage.id
        );

        if (userIndex === -1) {
          return currentMessages;
        }

        return currentMessages.slice(0, userIndex + 1);
      });

      await regenerate();
    };
  };

  return (
    <div className="relative flex-1">
      <div
        className="absolute inset-0 touch-pan-y overflow-y-auto"
        ref={messagesContainerRef}
      >
        <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4 px-2 py-4 md:gap-6 md:px-4">
          {messages.length === 0 && <Greeting />}

          {(() => {
            let latestAssistantContext: ExportContextSheet[] = [];

            return messages.map((message, index) => {
              let inheritedContext = latestAssistantContext;

              if (message.role === "assistant") {
                const messageContext = getContextSheetsFromMessage(message);
                if (messageContext.length > 0) {
                  latestAssistantContext = messageContext;
                  inheritedContext = messageContext;
                }
              }

              return (
                <PreviewMessage
                  addToolApprovalResponse={addToolApprovalResponse}
                  canRegenerate={
                    message.role === "assistant" &&
                    index === messages.length - 1
                  }
                  chatId={chatId}
                  inheritedExportContextSheets={inheritedContext}
                  isLoading={
                    status === "streaming" && messages.length - 1 === index
                  }
                  isReadonly={isReadonly}
                  key={message.id}
                  message={message}
                  onRegenerate={createRegenerateHandler(index)}
                  regenerate={regenerate}
                  requiresScrollPadding={
                    hasSentMessage && index === messages.length - 1
                  }
                  setMessages={setMessages}
                />
              );
            });
          })()}

          {shouldShowStatusLine && (
            <ThinkingMessage statusText={agentStatus ?? undefined} />
          )}

          {shouldShowThinkingFallback && <ThinkingMessage />}

          <div
            className="min-h-[24px] min-w-[24px] shrink-0"
            ref={messagesEndRef}
          />
        </div>
      </div>

      <button
        aria-label="Scroll to bottom"
        className={`absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background p-2 shadow-lg transition-all hover:bg-muted ${
          isAtBottom
            ? "pointer-events-none scale-0 opacity-0"
            : "pointer-events-auto scale-100 opacity-100"
        }`}
        onClick={() => scrollToBottom("smooth")}
        type="button"
      >
        <ArrowDownIcon className="size-4" />
      </button>
    </div>
  );
}

export const Messages = PureMessages;
