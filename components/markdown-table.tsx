"use client";

import { Check, Copy, Download, Maximize2 } from "lucide-react";
import type { TableHTMLAttributes } from "react";
import { useContext, useRef, useState } from "react";
import { toast } from "sonner";
import { StreamdownContext } from "streamdown";
import { normalizeExportFilename } from "@/lib/export-context";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type MarkdownTableProps = TableHTMLAttributes<HTMLTableElement> & {
  node?: unknown;
};

type CopyFormat = "csv" | "tsv";
type DownloadFormat = "csv" | "markdown" | "xlsx";

const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function normalizeCellText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function tableToRows(table: HTMLTableElement): string[][] {
  const rows = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) =>
      normalizeCellText(cell.textContent ?? "")
    )
  );

  return rows.filter((row) => row.some((cell) => cell.length > 0));
}

function escapeDelimitedCell(value: string, delimiter: string): string {
  const escapedValue = value.replace(/"/g, '""');
  if (
    escapedValue.includes(delimiter) ||
    escapedValue.includes('"') ||
    escapedValue.includes("\n")
  ) {
    return `"${escapedValue}"`;
  }

  return escapedValue;
}

function rowsToDelimited(rows: string[][], delimiter: string): string {
  return rows
    .map((row) =>
      row.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter)
    )
    .join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }

  const header = rows[0] ?? [];
  if (header.length === 0) {
    return "";
  }

  const separator = header.map(() => "---");
  const bodyRows = rows.slice(1);

  const markdownRows = [
    `| ${header.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...bodyRows.map((row) => {
      const paddedRow = [...row];
      while (paddedRow.length < header.length) {
        paddedRow.push("");
      }
      return `| ${paddedRow
        .slice(0, header.length)
        .map(escapeMarkdownCell)
        .join(" | ")} |`;
    }),
  ];

  return markdownRows.join("\n");
}

function triggerDownload(
  filename: string,
  content: BlobPart,
  mimeType: string
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function getFilenameFromContentDisposition(
  contentDisposition: string | null
): string | null {
  if (!contentDisposition) {
    return null;
  }

  const match = contentDisposition.match(/filename="(.+)"/i);
  if (!match?.[1]) {
    return null;
  }

  return match[1];
}

function getLastTextBeforeTarget(candidates: Element[], target: Element) {
  let lastText: string | null = null;

  for (const candidate of candidates) {
    if (candidate === target || candidate.contains(target)) {
      continue;
    }

    const relation = candidate.compareDocumentPosition(target);
    const isBefore = Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!isBefore) {
      continue;
    }

    const candidateText = normalizeCellText(candidate.textContent ?? "");
    if (!candidateText) {
      continue;
    }

    lastText = candidateText;
  }

  return lastText;
}

function resolveMessageTitle(table: HTMLTableElement) {
  const contentRoot =
    table.closest("[data-testid='message-content']") ??
    table.closest("[data-role='assistant']") ??
    table.parentElement;

  if (!contentRoot) {
    return "Tabela da resposta";
  }

  const headingText = getLastTextBeforeTarget(
    Array.from(contentRoot.querySelectorAll("h1, h2, h3, h4, h5, h6")),
    table
  );
  if (headingText) {
    return headingText;
  }

  const paragraphText = getLastTextBeforeTarget(
    Array.from(contentRoot.querySelectorAll("p")),
    table
  );
  if (paragraphText) {
    return paragraphText;
  }

  return "Tabela da resposta";
}

export function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: MarkdownTableProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDownloadingExcel, setIsDownloadingExcel] = useState(false);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const { isAnimating } = useContext(StreamdownContext);

  const getRowsOrNotify = () => {
    const table = tableRef.current;
    if (!table) {
      toast.error("Tabela nao encontrada.");
      return null;
    }

    const rows = tableToRows(table);
    if (rows.length === 0) {
      toast.error("Tabela vazia.");
      return null;
    }

    return rows;
  };

  const handleCopy = async (format: CopyFormat) => {
    const rows = getRowsOrNotify();
    if (!rows) {
      return;
    }

    if (!navigator.clipboard?.writeText) {
      toast.error("Clipboard API indisponivel.");
      return;
    }

    try {
      const content =
        format === "csv"
          ? rowsToDelimited(rows, ",")
          : rowsToDelimited(rows, "\t");

      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1300);
      toast.success(
        format === "csv" ? "Tabela copiada em CSV." : "Tabela copiada em TSV."
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao copiar tabela.";
      toast.error(message);
    }
  };

  const handleDownload = async (format: DownloadFormat) => {
    if (format === "xlsx" && isDownloadingExcel) {
      toast.info("O download do Excel ja esta em andamento.");
      return;
    }

    const rows = getRowsOrNotify();
    if (!rows) {
      return;
    }

    try {
      if (format === "csv") {
        triggerDownload("tabela.csv", rowsToDelimited(rows, ","), "text/csv");
        toast.success("Tabela baixada em CSV.");
        return;
      }

      if (format === "xlsx") {
        setIsDownloadingExcel(true);
        const loadingToastId = toast.loading(
          "O arquivo sera baixado em breve..."
        );

        const table = tableRef.current;
        if (!table) {
          toast.dismiss(loadingToastId);
          toast.error("Tabela nao encontrada.");
          return;
        }

        const title = resolveMessageTitle(table);
        const response = await fetch("/api/export", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filename: title,
            tableTitle: title,
            tableRows: rows,
          }),
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as {
            detail?: string;
          };
          toast.dismiss(loadingToastId);
          throw new Error(
            errorData.detail || "Falha ao baixar tabela em Excel."
          );
        }

        const blob = await response.blob();
        const filenameFromHeader = getFilenameFromContentDisposition(
          response.headers.get("Content-Disposition")
        );
        const fallbackName = `${normalizeExportFilename(title)}.xlsx`;
        const filename = filenameFromHeader ?? fallbackName;

        triggerDownload(filename, blob, blob.type || EXCEL_CONTENT_TYPE);
        toast.dismiss(loadingToastId);
        toast.success("Tabela baixada em Excel.");
        return;
      }

      triggerDownload("tabela.md", rowsToMarkdown(rows), "text/markdown");
      toast.success("Tabela baixada em Markdown.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao baixar tabela.";
      toast.error(message);
    } finally {
      if (format === "xlsx") {
        setIsDownloadingExcel(false);
      }
    }
  };

  const actionDisabled = isAnimating || isDownloadingExcel;
  const tableClassName = cn(
    "w-full border-collapse border border-border",
    className
  );

  return (
    <div
      className="my-4 flex flex-col space-y-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end gap-1">
        <Button
          disabled={actionDisabled}
          onClick={() => setIsExpanded(true)}
          size="icon-sm"
          title="Expandir tabela"
          type="button"
          variant="ghost"
        >
          <Maximize2 className="size-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              disabled={actionDisabled}
              size="icon-sm"
              title="Baixar tabela"
              type="button"
              variant="ghost"
            >
              <Download className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                handleDownload("csv");
              }}
            >
              Baixar CSV
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isDownloadingExcel}
              onClick={() => {
                handleDownload("xlsx");
              }}
            >
              {isDownloadingExcel ? "Gerando Excel..." : "Baixar Excel"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                handleDownload("markdown");
              }}
            >
              Baixar Markdown
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              disabled={actionDisabled}
              size="icon-sm"
              title={isCopied ? "Tabela copiada" : "Copiar tabela"}
              type="button"
              variant="ghost"
            >
              {isCopied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleCopy("csv")}>
              Copiar como CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopy("tsv")}>
              Copiar como TSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="overflow-x-auto">
        <table
          className={tableClassName}
          data-streamdown="table"
          ref={tableRef}
          {...props}
        >
          {children}
        </table>
      </div>

      <Dialog onOpenChange={setIsExpanded} open={isExpanded}>
        <DialogContent className="flex max-h-[92vh] max-w-[96vw] flex-col overflow-hidden p-4 md:max-w-6xl">
          <DialogHeader>
            <DialogTitle>Tabela</DialogTitle>
            <DialogDescription>
              Visualização expandida da tabela da resposta.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-auto pb-2">
            <table className={tableClassName}>{children}</table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
