import { type ChartSpecV1, chartSpecSchema } from "./schema";

const CHART_CONTEXT_TAG = "CHART_CONTEXT";
const CHART_TAG = "CHART";

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractContextBlock(
  text: string,
  tagName: string
): {
  hasTag: boolean;
  payload: string | null;
  cleanedText: string;
} {
  const escapedTag = escapeForRegex(tagName);
  const completeRegex = new RegExp(
    `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])\\s*([\\s\\S]*?)\\s*\\[\\s*\\/\\s*${escapedTag}\\s*\\]`,
    "i"
  );
  const openTagRegex = new RegExp(
    `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])`,
    "i"
  );
  const closingTagRegex = new RegExp(
    `\\[\\s*\\/\\s*${escapedTag}\\s*\\]`,
    "gi"
  );

  const completeMatch = text.match(completeRegex);

  if (completeMatch) {
    return {
      hasTag: true,
      payload: completeMatch[1].trim(),
      cleanedText: text.replace(completeRegex, "").trim(),
    };
  }

  if (openTagRegex.test(text)) {
    const danglingMatch = text.match(
      new RegExp(
        `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])\\s*([\\s\\S]*)$`,
        "i"
      )
    );
    const danglingPayload = danglingMatch?.[1]?.trim();
    const withoutDangling = text.replace(
      new RegExp(
        `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])[\\s\\S]*$`,
        "i"
      ),
      ""
    );

    return {
      hasTag: true,
      payload:
        danglingPayload && danglingPayload.length > 0 ? danglingPayload : null,
      cleanedText: withoutDangling.replace(closingTagRegex, "").trim(),
    };
  }

  return {
    hasTag: false,
    payload: null,
    cleanedText: text.replace(closingTagRegex, "").trim(),
  };
}

export type ParsedChartContext = {
  cleanText: string;
  chartSpec: ChartSpecV1 | null;
  chartSpecs: ChartSpecV1[];
  chartError: string | null;
  chartErrorDetails: string | null;
  hasChartContext: boolean;
};

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/g)
    .map((cell) => stripInlineMarkdown(cell.replace(/\\\|/g, "|").trim()));
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }

  const cells = splitMarkdownTableRow(line).filter((cell) => cell.length > 0);
  if (cells.length < 2) {
    return false;
  }

  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function parseLocaleNumber(value: string): number | null {
  const normalized = value
    .replace(/\s+/g, "")
    .replace(/[^\d,.-]/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  let candidate = normalized;

  if (candidate.includes(",") && candidate.includes(".")) {
    if (candidate.lastIndexOf(",") > candidate.lastIndexOf(".")) {
      candidate = candidate.replace(/\./g, "").replace(",", ".");
    } else {
      candidate = candidate.replace(/,/g, "");
    }
  } else if (candidate.includes(",")) {
    candidate = candidate.replace(/\./g, "").replace(",", ".");
  } else {
    candidate = candidate.replace(/,/g, "");
  }

  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractTableTitle(
  lines: string[],
  tableHeaderLineIndex: number
): string {
  for (
    let lineIndex = tableHeaderLineIndex - 1;
    lineIndex >= 0 && lineIndex >= tableHeaderLineIndex - 6;
    lineIndex -= 1
  ) {
    const candidate = lines[lineIndex]?.trim() ?? "";
    if (!candidate) {
      continue;
    }

    const headingMatch = candidate.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch?.[1]) {
      return stripInlineMarkdown(headingMatch[1]).slice(0, 120);
    }

    if (candidate.startsWith("|") || isMarkdownTableSeparatorLine(candidate)) {
      continue;
    }

    return stripInlineMarkdown(candidate).slice(0, 120);
  }

  return "Comparativo";
}

export function inferChartSpecFromTableText(text: string): ChartSpecV1 | null {
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index] ?? "";
    const separatorLine = lines[index + 1] ?? "";

    if (
      !headerLine.includes("|") ||
      !isMarkdownTableSeparatorLine(separatorLine)
    ) {
      continue;
    }

    const headers = splitMarkdownTableRow(headerLine);
    if (headers.length < 2) {
      continue;
    }

    const tableRows: string[][] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex] ?? "";
      const trimmedRowLine = rowLine.trim();

      if (!trimmedRowLine || !trimmedRowLine.includes("|")) {
        break;
      }

      if (isMarkdownTableSeparatorLine(trimmedRowLine)) {
        continue;
      }

      const cells = splitMarkdownTableRow(trimmedRowLine);
      if (cells.length !== headers.length) {
        break;
      }

      tableRows.push(cells);
    }

    if (tableRows.length < 2) {
      continue;
    }

    let yIndex = -1;
    let bestNumericCount = 0;

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const numericCount = tableRows.reduce((count, row) => {
        return parseLocaleNumber(row[columnIndex] ?? "") === null
          ? count
          : count + 1;
      }, 0);

      if (
        numericCount >= Math.max(2, Math.ceil(tableRows.length * 0.6)) &&
        numericCount >= bestNumericCount
      ) {
        yIndex = columnIndex;
        bestNumericCount = numericCount;
      }
    }

    if (yIndex === -1) {
      continue;
    }

    const xIndex = yIndex === 0 ? 1 : 0;
    if (xIndex < 0 || xIndex >= headers.length) {
      continue;
    }

    const data = tableRows
      .map((row) => {
        const xRaw = row[xIndex] ?? "";
        const yRaw = row[yIndex] ?? "";
        const yNumeric = parseLocaleNumber(yRaw);

        if (!xRaw.trim() || yNumeric === null) {
          return null;
        }

        return {
          category: xRaw.trim(),
          value: yNumeric,
        };
      })
      .filter(
        (item): item is { category: string; value: number } => item !== null
      );

    if (data.length < 2) {
      continue;
    }

    const yHeader = headers[yIndex] ?? "Valor";
    const unitMatch = yHeader.match(/\(([^)]+)\)/);
    const unit = unitMatch?.[1]?.trim().slice(0, 24);
    const yLabel = stripInlineMarkdown(
      yHeader.replace(/\s*\([^)]+\)\s*/g, " ").trim()
    ).slice(0, 80);

    const inferredSpec: ChartSpecV1 = {
      version: "1.0",
      type: "bar",
      title: extractTableTitle(lines, index),
      subtitle: "Gerado automaticamente com base na tabela retornada.",
      data,
      xKey: "category",
      series: [{ key: "value", label: yLabel || "Valor", color: "#f97316" }],
      yLabel: yLabel || undefined,
      unit: unit || undefined,
    };

    const validation = chartSpecSchema.safeParse(inferredSpec);
    if (validation.success) {
      return validation.data;
    }
  }

  return null;
}

function unwrapCodeFence(payload: string): string {
  const trimmed = payload.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);

  if (!fenceMatch) {
    return trimmed;
  }

  return fenceMatch[1]?.trim() ?? trimmed;
}

function tryParseChartPayload(payload: string): unknown {
  const baseCandidate = payload.trim();
  const candidates = [baseCandidate, unwrapCodeFence(baseCandidate)];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }

    const sliceStrategies: Array<{ open: string; close: string }> = [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
    ];

    for (const { open, close } of sliceStrategies) {
      const firstIndex = candidate.indexOf(open);
      const lastIndex = candidate.lastIndexOf(close);

      if (firstIndex < 0 || lastIndex <= firstIndex) {
        continue;
      }

      const jsonSlice = candidate.slice(firstIndex, lastIndex + 1).trim();
      if (!jsonSlice) {
        continue;
      }

      try {
        return JSON.parse(jsonSlice);
      } catch {
        // Ignore and keep trying.
      }
    }
  }

  throw new Error("JSON invalido no bloco de grafico");
}

const GENERIC_CHART_WARNING =
  "Nao foi possivel montar o grafico desta resposta.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeChartSpecCandidate(value: Record<string, unknown>): boolean {
  const chartSpecHints = [
    "type",
    "data",
    "xKey",
    "yKey",
    "seriesKey",
    "series",
    "nameKey",
    "valueKey",
  ];

  return chartSpecHints.some((hint) => hint in value);
}

function collectChartSpecCandidates(root: unknown): unknown[] {
  const queue: unknown[] = [root];
  const visited = new Set<object>();
  const candidates: unknown[] = [];

  const wrapperKeys = [
    "chart",
    "chartSpec",
    "chart_spec",
    "spec",
    "charts",
    "chartSpecs",
    "chartContext",
    "chart_context",
    "payload",
    "result",
    "output",
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined) {
      continue;
    }

    if (typeof current === "string") {
      const trimmed = current.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          queue.push(JSON.parse(trimmed));
        } catch {
          // Ignore invalid JSON fragments.
        }
      }
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }

    visited.add(current);

    if (looksLikeChartSpecCandidate(current)) {
      candidates.push(current);
    }

    for (const key of wrapperKeys) {
      if (!(key in current)) {
        continue;
      }

      queue.push(current[key]);
    }
  }

  if (candidates.length === 0 && isRecord(root)) {
    candidates.push(root);
  }

  return candidates;
}

function dedupeChartSpecs(specs: ChartSpecV1[]): ChartSpecV1[] {
  const seen = new Set<string>();
  const deduped: ChartSpecV1[] = [];

  for (const spec of specs) {
    const key = JSON.stringify(spec);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(spec);
  }

  return deduped;
}

function parseChartSpecsFromPayload(payload: unknown): {
  chartSpecs: ChartSpecV1[];
  firstIssue: string | null;
} {
  const candidates = collectChartSpecCandidates(payload);
  const chartSpecs: ChartSpecV1[] = [];
  let firstIssue: string | null = null;

  for (const candidate of candidates) {
    const validation = chartSpecSchema.safeParse(candidate);

    if (validation.success) {
      chartSpecs.push(validation.data);
      continue;
    }

    if (!firstIssue) {
      firstIssue = validation.error.issues[0]?.message ?? "schema invalido";
    }
  }

  return {
    chartSpecs: dedupeChartSpecs(chartSpecs),
    firstIssue,
  };
}

export function parseChartContextFromText(text: string): ParsedChartContext {
  const chartContextExtraction = extractContextBlock(text, CHART_CONTEXT_TAG);
  const chartExtraction = extractContextBlock(
    chartContextExtraction.cleanedText,
    CHART_TAG
  );
  const hasTag = chartContextExtraction.hasTag || chartExtraction.hasTag;
  const payload = chartContextExtraction.payload ?? chartExtraction.payload;
  const cleanedText = chartExtraction.cleanedText;

  if (!hasTag) {
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartSpecs: [],
      chartError: null,
      chartErrorDetails: null,
      hasChartContext: false,
    };
  }

  if (!payload) {
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartSpecs: [],
      chartError: "Bloco de grafico incompleto.",
      chartErrorDetails: "Bloco de grafico incompleto.",
      hasChartContext: true,
    };
  }

  let parsedPayload: unknown;

  try {
    parsedPayload = tryParseChartPayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON invalido";
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartSpecs: [],
      chartError: GENERIC_CHART_WARNING,
      chartErrorDetails: `Nao foi possivel interpretar bloco de grafico: ${message}`,
      hasChartContext: true,
    };
  }

  const parsedSpecs = parseChartSpecsFromPayload(parsedPayload);
  if (parsedSpecs.chartSpecs.length === 0) {
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartSpecs: [],
      chartError: GENERIC_CHART_WARNING,
      chartErrorDetails: `CHART_CONTEXT invalido: ${parsedSpecs.firstIssue ?? "schema invalido"}`,
      hasChartContext: true,
    };
  }

  return {
    cleanText: cleanedText,
    chartSpec: parsedSpecs.chartSpecs[0] ?? null,
    chartSpecs: parsedSpecs.chartSpecs,
    chartError: null,
    chartErrorDetails: null,
    hasChartContext: true,
  };
}
