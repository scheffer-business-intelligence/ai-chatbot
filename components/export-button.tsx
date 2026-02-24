"use client";

import { Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DATA_FROM_CONTEXT_MARKER,
  type ExportContextSheet,
  ensureXlsxFilename,
  getTotalRowsFromSheets,
} from "@/lib/export-context";
import { Button } from "./ui/button";

export type ExportButtonData = {
  query: string;
  filename: string;
  description: string;
  contextSheets?: ExportContextSheet[];
};

function isContextExport(query: string) {
  return query.trim().toUpperCase().includes(DATA_FROM_CONTEXT_MARKER);
}

export function ExportButton({ exportData }: { exportData: ExportButtonData }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rowCount = useMemo(
    () => getTotalRowsFromSheets(exportData.contextSheets ?? []),
    [exportData.contextSheets]
  );
  const exportRequiresContext = isContextExport(exportData.query);
  const isDisabled = isLoading || (exportRequiresContext && rowCount === 0);

  const handleDownload = async () => {
    if (exportRequiresContext && rowCount === 0) {
      setError("Os dados de contexto ainda nao estao prontos para exportacao.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: DATA_FROM_CONTEXT_MARKER,
          filename: exportData.filename,
          contextSheets: exportData.contextSheets,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new Error(errorData.detail || "Erro ao exportar os dados");
      }

      const contentDisposition = response.headers.get("Content-Disposition");
      let filename = ensureXlsxFilename(exportData.filename);
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match?.[1]) {
          filename = ensureXlsxFilename(match[1]);
        }
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(anchor);
    } catch (downloadError) {
      console.error("Export error:", downloadError);
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Erro ao exportar os dados"
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 p-3">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-600">
          <FileSpreadsheet className="size-4" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">Exportar para Excel</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {exportData.description}
          </p>

          <Button
            className="mt-3 h-8 cursor-pointer rounded-md bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500 disabled:cursor-not-allowed"
            disabled={isDisabled}
            onClick={handleDownload}
            type="button"
          >
            {isLoading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Gerando arquivo...
              </>
            ) : (
              <>
                <Download className="size-3.5" />
                Baixar Excel
              </>
            )}
          </Button>

          {error && <p className="mt-2 text-destructive text-xs">{error}</p>}
        </div>
      </div>
    </div>
  );
}
