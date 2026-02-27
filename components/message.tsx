"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useState } from "react";
import { useDataStream } from "@/components/data-stream-provider";
import {
  DATA_FROM_CONTEXT_MARKER,
  type ExportContextSheet,
  extractContextSheets,
  parseExportAwareText,
} from "@/lib/export-context";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { ChartRenderer } from "./charts/chart-renderer";
import { DocumentPreview } from "./document-preview";
import { MessageContent } from "./elements/message";
import { Response } from "./elements/response";
import { Tool, ToolContent, ToolHeader, ToolInput } from "./elements/tool";
import { ExportButton } from "./export-button";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageEditor } from "./message-editor";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { Weather } from "./weather";

const PurePreviewMessage = ({
  chatId,
  addToolApprovalResponse,
  message,
  isLoading,
  setMessages,
  regenerate,
  onRegenerate,
  isReadonly,
  canRegenerate,
  inheritedExportContextSheets = [],
  requiresScrollPadding: _requiresScrollPadding,
}: {
  chatId: string;
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  message: ChatMessage;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  onRegenerate?: () => Promise<void>;
  isReadonly: boolean;
  canRegenerate?: boolean;
  inheritedExportContextSheets?: ExportContextSheet[];
  requiresScrollPadding: boolean;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");

  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );
  const chartSpecsFromParts = (
    message.parts.find((part) => part.type === "data-chart-specs") as
      | { type: "data-chart-specs"; data?: unknown }
      | undefined
  )?.data;
  const chartSpecFromParts = (
    message.parts.find((part) => part.type === "data-chart-spec") as
      | { type: "data-chart-spec"; data?: unknown }
      | undefined
  )?.data;
  const chartWarningFromParts = (
    message.parts.find((part) => part.type === "data-chart-warning") as
      | { type: "data-chart-warning"; data?: unknown }
      | undefined
  )?.data;
  const exportContextFromParts = (
    message.parts.find((part) => part.type === "data-export-context") as
      | { type: "data-export-context"; data?: unknown }
      | undefined
  )?.data;
  const exportHintFromParts = (
    message.parts.find((part) => part.type === "data-export-hint") as
      | {
          type: "data-export-hint";
          data?: { filename?: unknown; description?: unknown };
        }
      | undefined
  )?.data;
  const chartSpecs =
    Array.isArray(chartSpecsFromParts) && chartSpecsFromParts.length > 0
      ? chartSpecsFromParts.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null
        )
      : chartSpecFromParts &&
          typeof chartSpecFromParts === "object" &&
          chartSpecFromParts !== null
        ? [chartSpecFromParts as Record<string, unknown>]
        : message.metadata?.chartSpec &&
            typeof message.metadata.chartSpec === "object" &&
            message.metadata.chartSpec !== null
          ? [message.metadata.chartSpec as Record<string, unknown>]
          : [];
  const chartWarning =
    (typeof chartWarningFromParts === "string"
      ? chartWarningFromParts
      : null) ??
    message.metadata?.chartError ??
    null;
  const exportContextSheetsFromParts = extractContextSheets(
    exportContextFromParts
  );
  const exportHint =
    exportHintFromParts &&
    typeof exportHintFromParts === "object" &&
    typeof exportHintFromParts.filename === "string" &&
    exportHintFromParts.filename.trim()
      ? {
          filename: exportHintFromParts.filename.trim(),
          description:
            typeof exportHintFromParts.description === "string" &&
            exportHintFromParts.description.trim()
              ? exportHintFromParts.description.trim()
              : "Baixar os dados desta resposta em Excel.",
        }
      : null;
  const hasTextOrExportParts =
    message.parts?.some((part) => {
      if (part.type !== "text") {
        return false;
      }

      const parsedText = parseExportAwareText(part.text);
      const visibleText = sanitizeText(parsedText.cleanText).trim();
      const contextSheets =
        exportContextSheetsFromParts.length > 0
          ? exportContextSheetsFromParts
          : parsedText.contextSheets.length > 0
            ? parsedText.contextSheets
            : inheritedExportContextSheets;
      const hasFallbackExport =
        message.role === "assistant" &&
        exportHint !== null &&
        contextSheets.length > 0;

      return (
        visibleText.length > 0 ||
        parsedText.exportData !== null ||
        hasFallbackExport
      );
    }) ?? false;
  const hasVisibleAssistantContent =
    message.role !== "assistant" ||
    attachmentsFromMessage.length > 0 ||
    chartSpecs.length > 0 ||
    typeof chartWarning === "string" ||
    message.parts.some((part) => {
      if (part.type === "text") {
        const parsedText = parseExportAwareText(part.text);
        const contextSheets =
          exportContextSheetsFromParts.length > 0
            ? exportContextSheetsFromParts
            : parsedText.contextSheets.length > 0
              ? parsedText.contextSheets
              : inheritedExportContextSheets;
        const hasFallbackExport =
          message.role === "assistant" &&
          exportHint !== null &&
          contextSheets.length > 0;

        return (
          sanitizeText(parsedText.cleanText).trim().length > 0 ||
          parsedText.exportData !== null ||
          hasFallbackExport
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
        part.type === "data-chart-specs" ||
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
    });

  useDataStream();

  if (!hasVisibleAssistantContent) {
    return null;
  }

  return (
    <div
      className="group/message fade-in w-full animate-in duration-200"
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn("flex w-full items-start gap-2 md:gap-3", {
          "justify-end": message.role === "user" && mode !== "edit",
          "justify-start": message.role === "assistant",
        })}
      >
        {message.role === "assistant" && (
          <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div
          className={cn("flex flex-col", {
            "gap-2 md:gap-4": hasTextOrExportParts,
            "w-full":
              (message.role === "assistant" &&
                (hasTextOrExportParts ||
                  message.parts?.some((p) => p.type.startsWith("tool-")) ||
                  chartSpecs.length > 0 ||
                  typeof chartWarning === "string")) ||
              mode === "edit",
            "w-fit max-w-[calc(100%-2.5rem)] sm:max-w-[80%]":
              message.role === "user" && mode !== "edit",
          })}
        >
          {attachmentsFromMessage.length > 0 && (
            <div
              className="flex flex-row justify-end gap-2"
              data-testid={"message-attachments"}
            >
              {attachmentsFromMessage.map((attachment) => (
                <PreviewAttachment
                  attachment={{
                    name: attachment.filename ?? "file",
                    contentType: attachment.mediaType,
                    url: attachment.url,
                  }}
                  key={attachment.url}
                />
              ))}
            </div>
          )}

          {message.parts?.map((part, index) => {
            const { type } = part;
            const key = `message-${message.id}-part-${index}`;

            if (type === "reasoning") {
              const hasContent = part.text?.trim().length > 0;
              const isStreaming = "state" in part && part.state === "streaming";
              if (hasContent || isStreaming) {
                return (
                  <MessageReasoning
                    isLoading={isLoading || isStreaming}
                    key={key}
                    reasoning={part.text || ""}
                  />
                );
              }
            }

            if (type === "text") {
              const parsedText = parseExportAwareText(part.text);
              const visibleText = sanitizeText(parsedText.cleanText);
              const contextSheets =
                exportContextSheetsFromParts.length > 0
                  ? exportContextSheetsFromParts
                  : parsedText.contextSheets.length > 0
                    ? parsedText.contextSheets
                    : inheritedExportContextSheets;
              const exportData =
                parsedText.exportData !== null
                  ? {
                      ...parsedText.exportData,
                      query: DATA_FROM_CONTEXT_MARKER,
                      contextSheets,
                    }
                  : message.role === "assistant" &&
                      exportHint &&
                      contextSheets.length > 0
                    ? {
                        query: DATA_FROM_CONTEXT_MARKER,
                        filename: exportHint.filename,
                        description: exportHint.description,
                        contextSheets,
                      }
                    : null;

              if (mode === "view") {
                if (!visibleText.trim() && !exportData) {
                  return null;
                }

                return (
                  <div key={key}>
                    {visibleText.trim().length > 0 && (
                      <MessageContent
                        className={cn({
                          "wrap-break-word w-fit rounded-2xl px-3 py-2 text-right text-white":
                            message.role === "user",
                          "bg-transparent px-0 py-0 text-left":
                            message.role === "assistant",
                        })}
                        data-testid="message-content"
                        style={
                          message.role === "user"
                            ? { backgroundColor: "#006cff" }
                            : undefined
                        }
                      >
                        <Response mode={isLoading ? "streaming" : "static"}>
                          {visibleText}
                        </Response>
                      </MessageContent>
                    )}

                    {message.role === "assistant" && exportData && (
                      <ExportButton exportData={exportData} />
                    )}
                  </div>
                );
              }

              if (mode === "edit") {
                return (
                  <div
                    className="flex w-full flex-row items-start gap-3"
                    key={key}
                  >
                    <div className="size-8" />
                    <div className="min-w-0 flex-1">
                      <MessageEditor
                        key={message.id}
                        message={message}
                        regenerate={regenerate}
                        setMessages={setMessages}
                        setMode={setMode}
                      />
                    </div>
                  </div>
                );
              }
            }

            if (type === "tool-getWeather") {
              const { toolCallId, state } = part;
              const approvalId = (part as { approval?: { id: string } })
                .approval?.id;
              const isDenied =
                state === "output-denied" ||
                (state === "approval-responded" &&
                  (part as { approval?: { approved?: boolean } }).approval
                    ?.approved === false);
              const widthClass = "w-[min(100%,450px)]";

              if (state === "output-available") {
                return (
                  <div className={widthClass} key={toolCallId}>
                    <Weather weatherAtLocation={part.output} />
                  </div>
                );
              }

              if (isDenied) {
                return (
                  <div className={widthClass} key={toolCallId}>
                    <Tool className="w-full" defaultOpen={true}>
                      <ToolHeader
                        state="output-denied"
                        type="tool-getWeather"
                      />
                      <ToolContent>
                        <div className="px-4 py-3 text-muted-foreground text-sm">
                          Weather lookup was denied.
                        </div>
                      </ToolContent>
                    </Tool>
                  </div>
                );
              }

              if (state === "approval-responded") {
                return (
                  <div className={widthClass} key={toolCallId}>
                    <Tool className="w-full" defaultOpen={true}>
                      <ToolHeader state={state} type="tool-getWeather" />
                      <ToolContent>
                        <ToolInput input={part.input} />
                      </ToolContent>
                    </Tool>
                  </div>
                );
              }

              return (
                <div className={widthClass} key={toolCallId}>
                  <Tool className="w-full" defaultOpen={true}>
                    <ToolHeader state={state} type="tool-getWeather" />
                    <ToolContent>
                      {(state === "input-available" ||
                        state === "approval-requested") && (
                        <ToolInput input={part.input} />
                      )}
                      {state === "approval-requested" && approvalId && (
                        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
                          <button
                            className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
                            onClick={() => {
                              addToolApprovalResponse({
                                id: approvalId,
                                approved: false,
                                reason: "User denied weather lookup",
                              });
                            }}
                            type="button"
                          >
                            Deny
                          </button>
                          <button
                            className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                            onClick={() => {
                              addToolApprovalResponse({
                                id: approvalId,
                                approved: true,
                              });
                            }}
                            type="button"
                          >
                            Allow
                          </button>
                        </div>
                      )}
                    </ToolContent>
                  </Tool>
                </div>
              );
            }

            if (type === "tool-createDocument") {
              const { toolCallId } = part;

              if (part.output && "error" in part.output) {
                return (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
                    key={toolCallId}
                  >
                    Error creating document: {String(part.output.error)}
                  </div>
                );
              }

              return (
                <DocumentPreview
                  isReadonly={isReadonly}
                  key={toolCallId}
                  result={part.output}
                />
              );
            }

            if (type === "tool-updateDocument") {
              const { toolCallId } = part;

              if (part.output && "error" in part.output) {
                return (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
                    key={toolCallId}
                  >
                    Error updating document: {String(part.output.error)}
                  </div>
                );
              }

              return (
                <div className="relative" key={toolCallId}>
                  <DocumentPreview
                    args={{ ...part.output, isUpdate: true }}
                    isReadonly={isReadonly}
                    result={part.output}
                  />
                </div>
              );
            }

            return null;
          })}

          {message.role === "assistant" &&
            (chartSpecs.length > 0 ? (
              <div className="flex w-full flex-col gap-3">
                {chartSpecs.map((chartSpec, index) => (
                  <ChartRenderer
                    chartSpec={chartSpec}
                    chartWarning={index === 0 ? chartWarning : null}
                    key={`chart-${message.id}-${index}`}
                  />
                ))}
              </div>
            ) : (
              <ChartRenderer chartSpec={null} chartWarning={chartWarning} />
            ))}

          {!isReadonly && (
            <MessageActions
              canRegenerate={canRegenerate}
              chatId={chatId}
              isLoading={isLoading}
              key={`action-${message.id}`}
              message={message}
              regenerate={onRegenerate ?? regenerate}
              setMode={setMode}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = ({ statusText }: { statusText?: string }) => {
  const normalizedStatus = statusText?.trim();
  const showThinkingDots = !normalizedStatus;
  const label = normalizedStatus ?? "Pensando";

  return (
    <div
      className="group/message fade-in w-full animate-in duration-300"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start justify-start gap-3">
        <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
          <div className="animate-pulse">
            <SparklesIcon size={14} />
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 md:gap-4">
          <div className="flex items-center gap-1 p-0 text-muted-foreground text-sm">
            <span className="animate-pulse">{label}</span>
            {showThinkingDots && (
              <span className="inline-flex">
                <span className="animate-bounce [animation-delay:0ms]">.</span>
                <span className="animate-bounce [animation-delay:150ms]">
                  .
                </span>
                <span className="animate-bounce [animation-delay:300ms]">
                  .
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
