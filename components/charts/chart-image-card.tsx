"use client";

import { Check, Copy, Download, Maximize2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type ChartImageCardProps = {
  src: string;
  title: string;
  alt?: string;
  className?: string;
};

function slugifyTitle(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function getUrlExtension(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").filter(Boolean).at(-1) ?? "";
    const match = filename.match(/\.([a-zA-Z0-9]+)$/);

    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function getExtensionFromContentType(contentType: string | null): string {
  const normalized = contentType?.toLowerCase() ?? "";

  if (normalized.includes("image/jpeg")) {
    return "jpg";
  }

  if (normalized.includes("image/png")) {
    return "png";
  }

  if (normalized.includes("image/webp")) {
    return "webp";
  }

  if (normalized.includes("image/gif")) {
    return "gif";
  }

  if (normalized.includes("image/svg")) {
    return "svg";
  }

  return "png";
}

export function ChartImageCard({
  src,
  title,
  alt,
  className,
}: ChartImageCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleDownload = async () => {
    try {
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`Falha ao baixar grafico (${response.status}).`);
      }

      const blob = await response.blob();
      const contentType = blob.type || response.headers.get("content-type");
      const extension =
        getUrlExtension(src) ?? getExtensionFromContentType(contentType);

      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const baseName = slugifyTitle(title || "grafico");

      anchor.href = downloadUrl;
      anchor.download = `${baseName || "grafico"}.${extension}`;
      anchor.click();

      URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao baixar grafico.";
      toast.error(message);
    }
  };

  const handleCopy = async () => {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      toast.error("Copia de imagem nao suportada neste navegador.");
      return;
    }

    try {
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`Falha ao carregar grafico (${response.status}).`);
      }

      const blob = await response.blob();
      const clipboardType = blob.type || "image/png";

      await navigator.clipboard.write([
        new ClipboardItem({
          [clipboardType]: blob,
        }),
      ]);

      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1300);
      toast.success("Grafico copiado.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao copiar grafico.";
      toast.error(message);
    }
  };

  return (
    <div className={cn("rounded-xl border bg-card p-3 md:p-4", className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-sm md:text-base">{title}</div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            onClick={() => setIsExpanded(true)}
            size="icon-sm"
            title="Expandir grafico"
            type="button"
            variant="ghost"
          >
            <Maximize2 className="size-4" />
          </Button>

          <Button
            onClick={handleDownload}
            size="icon-sm"
            title="Baixar grafico"
            type="button"
            variant="ghost"
          >
            <Download className="size-4" />
          </Button>

          <Button
            onClick={handleCopy}
            size="icon-sm"
            title={isCopied ? "Copiado" : "Copiar grafico"}
            type="button"
            variant="ghost"
          >
            {isCopied ? (
              <Check className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {/* biome-ignore lint/performance/noImgElement: external storage image URL */}
        <img
          alt={alt ?? title}
          className="h-auto max-h-[520px] w-full object-contain"
          loading="lazy"
          src={src}
        />
      </div>

      <Dialog onOpenChange={setIsExpanded} open={isExpanded}>
        <DialogContent className="max-h-[92vh] max-w-[96vw] overflow-auto p-4 md:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Visualizacao expandida do grafico da resposta.
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-auto rounded-lg border">
            {/* biome-ignore lint/performance/noImgElement: external storage image URL */}
            <img
              alt={alt ?? title}
              className="mx-auto h-auto max-h-[78vh] w-full object-contain md:w-auto"
              src={src}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
