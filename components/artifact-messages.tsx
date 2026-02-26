import type { UseChatHelpers } from "@ai-sdk/react";
import { AnimatePresence, motion } from "framer-motion";
import { memo } from "react";
import { deleteTrailingMessages } from "@/app/(chat)/actions";
import { useMessages } from "@/hooks/use-messages";
import {
  type ExportContextSheet,
  extractContextSheets,
  parseExportAwareText,
} from "@/lib/export-context";
import type { ChatMessage } from "@/lib/types";
import { sanitizeText } from "@/lib/utils";
import type { UIArtifact } from "./artifact";
import { PreviewMessage, ThinkingMessage } from "./message";

type ArtifactMessagesProps = {
  chatId: string;
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  agentStatus: string | null;
  status: UseChatHelpers<ChatMessage>["status"];
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  artifactStatus: UIArtifact["status"];
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

function PureArtifactMessages({
  chatId,
  addToolApprovalResponse,
  agentStatus,
  status,
  messages,
  setMessages,
  regenerate,
  isReadonly,
}: ArtifactMessagesProps) {
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    onViewportEnter,
    onViewportLeave,
    hasSentMessage,
  } = useMessages({
    status,
  });

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
    <div
      className="flex h-full flex-col items-center gap-4 overflow-y-scroll px-4 pt-20"
      ref={messagesContainerRef}
    >
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
                message.role === "assistant" && index === messages.length - 1
              }
              chatId={chatId}
              inheritedExportContextSheets={inheritedContext}
              isLoading={
                status === "streaming" && index === messages.length - 1
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

      <AnimatePresence mode="wait">
        {shouldShowStatusLine && (
          <ThinkingMessage
            key={agentStatus ? `thinking-${agentStatus}` : "thinking"}
            statusText={agentStatus ?? undefined}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {shouldShowThinkingFallback && <ThinkingMessage key="thinking" />}
      </AnimatePresence>

      <motion.div
        className="min-h-[24px] min-w-[24px] shrink-0"
        onViewportEnter={onViewportEnter}
        onViewportLeave={onViewportLeave}
        ref={messagesEndRef}
      />
    </div>
  );
}

function areEqual(
  prevProps: ArtifactMessagesProps,
  nextProps: ArtifactMessagesProps
) {
  if (prevProps.agentStatus !== nextProps.agentStatus) {
    return false;
  }

  if (
    prevProps.artifactStatus === "streaming" &&
    nextProps.artifactStatus === "streaming"
  ) {
    return true;
  }

  if (prevProps.status !== nextProps.status) {
    return false;
  }
  if (prevProps.status && nextProps.status) {
    return false;
  }
  if (prevProps.messages.length !== nextProps.messages.length) {
    return false;
  }

  return true;
}

export const ArtifactMessages = memo(PureArtifactMessages, areEqual);
