export type ChartImageFallbackItem = {
  url: string;
  alt: string | null;
  title: string;
};

const ALLOWED_CHART_IMAGE_PROTOCOL = "https:";
const ALLOWED_CHART_IMAGE_HOST = "storage.googleapis.com";
const ALLOWED_CHART_IMAGE_PATH_PREFIX =
  "/gen-ai-exports/agente-agro/charts/";

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function normalizeUrlCandidate(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function isAllowedChartImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === ALLOWED_CHART_IMAGE_PROTOCOL &&
      parsed.hostname === ALLOWED_CHART_IMAGE_HOST &&
      parsed.pathname.startsWith(ALLOWED_CHART_IMAGE_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

export function extractAllowedChartImageItems(
  markdown: string
): ChartImageFallbackItem[] {
  if (!markdown.trim()) {
    return [];
  }

  const items: ChartImageFallbackItem[] = [];
  const seenUrls = new Set<string>();

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const altRaw = match[1] ?? "";
    const urlRaw = match[2] ?? "";
    const url = normalizeUrlCandidate(urlRaw);

    if (!url || !isAllowedChartImageUrl(url) || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);

    const alt = altRaw.trim() || null;
    items.push({
      url,
      alt,
      title: alt ?? "Grafico",
    });
  }

  return items;
}

export function containsAllowedChartImageMarkdown(markdown: string): boolean {
  return extractAllowedChartImageItems(markdown).length > 0;
}
