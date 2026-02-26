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
  chartError: string | null;
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

    const firstBraceIndex = candidate.indexOf("{");
    const lastBraceIndex = candidate.lastIndexOf("}");

    if (
      firstBraceIndex >= 0 &&
      lastBraceIndex > firstBraceIndex &&
      lastBraceIndex < candidate.length
    ) {
      const jsonSlice = candidate
        .slice(firstBraceIndex, lastBraceIndex + 1)
        .trim();

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
      chartError: null,
      hasChartContext: false,
    };
  }

  if (!payload) {
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartError: "Bloco de grafico incompleto.",
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
      chartError: `Nao foi possivel interpretar bloco de grafico: ${message}`,
      hasChartContext: true,
    };
  }

  const validation = chartSpecSchema.safeParse(parsedPayload);

  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartError: `CHART_CONTEXT invalido: ${firstIssue?.message ?? "schema invalido"}`,
      hasChartContext: true,
    };
  }

  return {
    cleanText: cleanedText,
    chartSpec: validation.data,
    chartError: null,
    hasChartContext: true,
  };
}
