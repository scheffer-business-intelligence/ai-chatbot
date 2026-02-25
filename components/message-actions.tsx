import { memo, useState } from "react";
import { toast } from "sonner";
import { useCopyToClipboard } from "usehooks-ts";
import { parseExportAwareText } from "@/lib/export-context";
import type { ChatMessage } from "@/lib/types";
import { sanitizeText } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { Action, Actions } from "./elements/actions";
import {
  CopyIcon,
  PencilEditIcon,
  RedoIcon,
  WarningIcon,
} from "./icons";

const MAX_FEEDBACK_LENGTH = 5000;

export function PureMessageActions({
  chatId,
  message,
  isLoading,
  setMode,
  regenerate,
  canRegenerate,
}: {
  chatId: string;
  message: ChatMessage;
  isLoading: boolean;
  setMode?: (mode: "view" | "edit") => void;
  regenerate?: () => void;
  canRegenerate?: boolean;
}) {
  const [_, copyToClipboard] = useCopyToClipboard();
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);

  if (isLoading) {
    return null;
  }

  const textFromParts = message.parts
    ?.filter((part) => part.type === "text")
    .map((part) => {
      const parsedText = parseExportAwareText(part.text);
      return sanitizeText(parsedText.cleanText);
    })
    .join("\n")
    .trim();
  const canSendFeedback = message.role === "assistant" && Boolean(textFromParts);

  const handleCopy = async () => {
    if (!textFromParts) {
      toast.error("There's no text to copy!");
      return;
    }

    await copyToClipboard(textFromParts);
    toast.success("Copiado para a área de transferência!");
  };

  const openFeedbackDialog = () => {
    if (!canSendFeedback) {
      return;
    }

    setFeedbackText("");
    setFeedbackError(null);
    setIsFeedbackOpen(true);
  };

  const closeFeedbackDialog = () => {
    if (isSubmittingFeedback) {
      return;
    }

    setIsFeedbackOpen(false);
    setFeedbackError(null);
  };

  const handleFeedbackSubmit = async () => {
    const trimmedFeedback = feedbackText.trim();

    if (!trimmedFeedback) {
      setFeedbackError(
        "Descreva rapidamente o que não gostou na resposta do agente."
      );
      return;
    }

    if (trimmedFeedback.length > MAX_FEEDBACK_LENGTH) {
      setFeedbackError(
        `Feedback muito longo (máx. ${MAX_FEEDBACK_LENGTH} caracteres).`
      );
      return;
    }

    setIsSubmittingFeedback(true);
    setFeedbackError(null);

    try {
      const response = await fetch("/api/feedbacks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chatId,
          messageId: message.id,
          feedback: trimmedFeedback,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { message?: string; cause?: string; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(
          payload?.cause ||
            payload?.error ||
            payload?.message ||
            "Falha ao enviar feedback."
        );
      }

      setFeedbackText("");
      setIsFeedbackOpen(false);
      toast.success("Feedback enviado. Obrigado!");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao enviar feedback.";
      setFeedbackError(message);
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  // User messages get edit (on hover) and copy actions
  if (message.role === "user") {
    return (
      <Actions className="-mr-0.5 justify-end">
        <div className="relative">
          {setMode && (
            <Action
              className="absolute top-0 -left-10 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/message:opacity-100"
              data-testid="message-edit-button"
              onClick={() => setMode("edit")}
              tooltip="Editar"
            >
              <PencilEditIcon />
            </Action>
          )}
          <Action onClick={handleCopy} tooltip="Copiar">
            <CopyIcon />
          </Action>
        </div>
      </Actions>
    );
  }

  return (
    <>
      <Actions className="-ml-0.5">
        {canRegenerate && regenerate && (
          <Action
            onClick={async () => {
              await regenerate();
            }}
            tooltip="Gerar novamente"
          >
            <RedoIcon />
          </Action>
        )}
        <Action
          disabled={!canSendFeedback}
          onClick={openFeedbackDialog}
          tooltip={
            canSendFeedback
              ? "Enviar feedback"
              : "Feedback indisponível para esta mensagem"
          }
        >
          <WarningIcon />
        </Action>
        <Action onClick={handleCopy} tooltip="Copiar">
          <CopyIcon />
        </Action>
      </Actions>

      <Dialog onOpenChange={(isOpen) => (isOpen ? openFeedbackDialog() : closeFeedbackDialog())} open={isFeedbackOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar feedback</DialogTitle>
            <DialogDescription>
              Conte rapidamente o que não gostou nesta resposta.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/20 px-3 py-2 text-muted-foreground text-sm">
            <p className="whitespace-pre-wrap wrap-break-word">{textFromParts}</p>
          </div>

          <div className="space-y-2">
            <Textarea
              maxLength={MAX_FEEDBACK_LENGTH}
              onChange={(event) => setFeedbackText(event.target.value)}
              placeholder="Descreva o que está incorreto, genérico ou incompleto na resposta."
              rows={4}
              value={feedbackText}
            />
            <div className="text-muted-foreground text-xs">
              {feedbackText.length}/{MAX_FEEDBACK_LENGTH}
            </div>
          </div>

          {feedbackError && (
            <p className="text-destructive text-sm" role="alert">
              {feedbackError}
            </p>
          )}

          <DialogFooter>
            <Button
              disabled={isSubmittingFeedback}
              onClick={closeFeedbackDialog}
              type="button"
              variant="outline"
            >
              Cancelar
            </Button>
            <Button
              disabled={isSubmittingFeedback}
              onClick={handleFeedbackSubmit}
              type="button"
            >
              {isSubmittingFeedback ? "Enviando..." : "Enviar feedback"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const MessageActions = memo(
  PureMessageActions,
  (prevProps, nextProps) => {
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }

    return true;
  }
);
