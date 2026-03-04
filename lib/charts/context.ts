import type { ExportContextSheet } from "../export-context";
import { type ChartSpecV1, chartSpecSchema } from "./schema";

const CHART_CONTEXT_TAG = "CHART_CONTEXT";
const CHART_TAG = "CHART";

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ContextPayloadMatch = {
  index: number;
  payload: string | null;
  isComplete: boolean;
};

function extractContextBlocks(
  text: string,
  tagName: string
): {
  hasTag: boolean;
  payloads: ContextPayloadMatch[];
  cleanedText: string;
} {
  const escapedTag = escapeForRegex(tagName);
  const completeRegex = new RegExp(
    `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])\\s*([\\s\\S]*?)\\s*\\[\\s*\\/\\s*${escapedTag}\\s*\\]`,
    "gi"
  );
  const openTagRegex = new RegExp(
    `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])`,
    "i"
  );
  const closingTagRegex = new RegExp(
    `\\[\\s*\\/\\s*${escapedTag}\\s*\\]`,
    "gi"
  );

  const payloads: ContextPayloadMatch[] = [];
  let completeMatch: RegExpExecArray | null;

  while ((completeMatch = completeRegex.exec(text)) !== null) {
    payloads.push({
      index: completeMatch.index,
      payload: completeMatch[1]?.trim() || null,
      isComplete: true,
    });
  }

  const withoutCompleteMatches = text.replace(completeRegex, "");
  const hasOpenTag = openTagRegex.test(withoutCompleteMatches);

  let cleanedText = withoutCompleteMatches;

  if (hasOpenTag) {
    const openTagIndexRegex = new RegExp(
      `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])`,
      "gi"
    );
    let lastOpenTagIndex = -1;
    let openTagMatch: RegExpExecArray | null;

    while ((openTagMatch = openTagIndexRegex.exec(cleanedText)) !== null) {
      lastOpenTagIndex = openTagMatch.index;
    }

    if (lastOpenTagIndex !== -1) {
      const danglingSource = cleanedText.slice(lastOpenTagIndex);
      const danglingPayloadMatch = danglingSource.match(
        new RegExp(
          `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])\\s*([\\s\\S]*)$`,
          "i"
        )
      );

      payloads.push({
        index: lastOpenTagIndex,
        payload: danglingPayloadMatch?.[1]?.trim() || null,
        isComplete: false,
      });

      cleanedText = cleanedText.slice(0, lastOpenTagIndex);
    }
  }

  return {
    hasTag: payloads.length > 0 || openTagRegex.test(text),
    payloads,
    cleanedText: cleanedText.replace(closingTagRegex, "").trim(),
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

function parseLocaleNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    return parseLocaleNumber(value);
  }

  return null;
}

function toNormalizedCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return stripInlineMarkdown(value).trim();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return stripInlineMarkdown(String(value)).trim();
}

function extractLabelAndUnit(value: string): { label: string; unit?: string } {
  const unitMatch = value.match(/\(([^)]+)\)/);
  const unit = unitMatch?.[1]?.trim().slice(0, 24);
  const label = stripInlineMarkdown(
    value.replace(/\s*\([^)]+\)\s*/g, " ").trim()
  ).slice(0, 80);

  return {
    label: label || "Valor",
    unit: unit || undefined,
  };
}

type ColumnStats = {
  column: string;
  index: number;
  nonEmptyCount: number;
  numericCount: number;
  uniqueCount: number;
  uniqueNumericCount: number;
};

function getColumnStats(
  rows: Record<string, unknown>[],
  columns: string[]
): ColumnStats[] {
  return columns.map((column, index) => {
    let nonEmptyCount = 0;
    let numericCount = 0;
    const unique = new Set<string>();
    const uniqueNumeric = new Set<number>();

    for (const row of rows) {
      const cellText = toNormalizedCellText(row[column]);
      if (!cellText) {
        continue;
      }

      nonEmptyCount += 1;
      unique.add(cellText.toLowerCase());

      const numericValue = parseLocaleNumberFromUnknown(row[column]);
      if (numericValue !== null) {
        numericCount += 1;
        uniqueNumeric.add(numericValue);
      }
    }

    return {
      column,
      index,
      nonEmptyCount,
      numericCount,
      uniqueCount: unique.size,
      uniqueNumericCount: uniqueNumeric.size,
    };
  });
}

function pickCategoryColumn(
  rows: Record<string, unknown>[],
  columns: string[]
): string | null {
  if (columns.length === 0) {
    return null;
  }

  const stats = getColumnStats(rows, columns);

  const preferredCandidates = stats
    .filter((column) => {
      if (column.nonEmptyCount < 2 || column.uniqueCount < 2) {
        return false;
      }

      return (
        column.numericCount <
        Math.max(1, Math.ceil(column.nonEmptyCount * 0.6))
      );
    })
    .sort((a, b) => {
      if (b.uniqueCount !== a.uniqueCount) {
        return b.uniqueCount - a.uniqueCount;
      }

      if (b.nonEmptyCount !== a.nonEmptyCount) {
        return b.nonEmptyCount - a.nonEmptyCount;
      }

      if (a.numericCount !== b.numericCount) {
        return a.numericCount - b.numericCount;
      }

      return a.index - b.index;
    });

  if (preferredCandidates.length > 0) {
    return preferredCandidates[0].column;
  }

  const fallbackCandidate = stats
    .filter((column) => column.nonEmptyCount >= 2)
    .sort((a, b) => {
      if (b.nonEmptyCount !== a.nonEmptyCount) {
        return b.nonEmptyCount - a.nonEmptyCount;
      }
      return a.index - b.index;
    })[0];

  return fallbackCandidate?.column ?? columns[0] ?? null;
}

function pickNumericColumns(
  rows: Record<string, unknown>[],
  columns: string[],
  excludedColumn: string
): string[] {
  return getColumnStats(rows, columns)
    .filter((column) => {
      if (column.column === excludedColumn || column.nonEmptyCount === 0) {
        return false;
      }

      if (column.numericCount < 2) {
        return false;
      }

      return (
        column.numericCount >=
        Math.max(2, Math.ceil(column.nonEmptyCount * 0.6))
      );
    })
    .sort((a, b) => {
      if (b.numericCount !== a.numericCount) {
        return b.numericCount - a.numericCount;
      }

      if (b.uniqueNumericCount !== a.uniqueNumericCount) {
        return b.uniqueNumericCount - a.uniqueNumericCount;
      }

      return a.index - b.index;
    })
    .map((column) => column.column)
    .slice(0, 4);
}

function normalizeChartTitle(rawTitle: string | null | undefined): string {
  const cleaned = stripInlineMarkdown(rawTitle ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•]+\s+/, "")
    .replace(/^[^A-Za-z0-9À-ÿ]+/, "")
    .trim();

  return (cleaned || "Comparativo").slice(0, 120);
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

export function inferChartSpecsFromTableText(text: string): ChartSpecV1[] {
  const lines = text.split(/\r?\n/);
  const inferredSpecs: ChartSpecV1[] = [];

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
      inferredSpecs.push(validation.data);
    }
  }

  return dedupeChartSpecs(inferredSpecs).slice(0, 6);
}

export function inferChartSpecFromTableText(text: string): ChartSpecV1 | null {
  return inferChartSpecsFromTableText(text)[0] ?? null;
}

function buildInferredSpecFromContextSheet(
  sheet: ExportContextSheet
): ChartSpecV1 | null {
  const rows = sheet.rows
    .filter((row): row is Record<string, unknown> => row !== null)
    .slice(0, 50);
  const columns = sheet.columns
    .map((column) => column.trim())
    .filter((column) => column.length > 0);

  if (rows.length < 2 || columns.length < 2) {
    return null;
  }

  const categoryColumn = pickCategoryColumn(rows, columns);
  if (!categoryColumn) {
    return null;
  }

  const numericColumns = pickNumericColumns(rows, columns, categoryColumn);
  if (numericColumns.length === 0) {
    return null;
  }

  const chartData = rows
    .map((row, index) => {
      const normalizedRow: Record<string, unknown> = {
        category:
          toNormalizedCellText(row[categoryColumn]) || `Item ${index + 1}`,
      };

      for (const numericColumn of numericColumns) {
        const numericValue = parseLocaleNumberFromUnknown(row[numericColumn]);
        if (numericValue !== null) {
          normalizedRow[numericColumn] = numericValue;
        }
      }

      return normalizedRow;
    })
    .filter((row) =>
      numericColumns.some((numericColumn) => typeof row[numericColumn] === "number")
    );

  if (chartData.length < 2) {
    return null;
  }

  const primaryAxisInfo = extractLabelAndUnit(numericColumns[0]);
  const inferredSpec: ChartSpecV1 = {
    version: "1.0",
    type: numericColumns.length > 1 ? "line" : "bar",
    title: normalizeChartTitle(sheet.name),
    subtitle: "Gerado automaticamente a partir do contexto de dados retornado.",
    data: chartData,
    xKey: "category",
    series: numericColumns.map((column, index) => {
      const axisInfo = extractLabelAndUnit(column);
      const colors = ["#22c55e", "#0ea5e9", "#f97316", "#eab308"];

      return {
        key: column,
        label: axisInfo.label,
        color: colors[index % colors.length],
      };
    }),
    yLabel: primaryAxisInfo.label || undefined,
    unit: primaryAxisInfo.unit,
  };

  const validation = chartSpecSchema.safeParse(inferredSpec);
  return validation.success ? validation.data : null;
}

export function inferChartSpecsFromContextSheets(
  contextSheets: ExportContextSheet[]
): ChartSpecV1[] {
  if (contextSheets.length === 0) {
    return [];
  }

  const inferredSpecs: ChartSpecV1[] = [];

  for (const sheet of contextSheets) {
    const inferredSpec = buildInferredSpecFromContextSheet(sheet);
    if (inferredSpec) {
      inferredSpecs.push(inferredSpec);
    }
  }

  return dedupeChartSpecs(inferredSpecs).slice(0, 6);
}

function looksLikeSectionTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes("|")) {
    return false;
  }

  if (/^#{1,6}\s+/.test(trimmed)) {
    return true;
  }

  const normalized = normalizeChartTitle(trimmed);
  if (!normalized || normalized === "Comparativo") {
    return false;
  }

  if (normalized.length < 3 || normalized.length > 120) {
    return false;
  }

  return /\b(grafico|gr[aá]fico|produtividade|comparativo|resultado|evolu[cç][aã]o)\b/i.test(
    normalized
  );
}

function extractPairsFromInlinePipeLine(
  line: string
): Array<{ category: string; value: number }> {
  const normalized = stripInlineMarkdown(line)
    .replace(/^[-*•]+\s*/, "")
    .replace(/\|\|+/g, "|")
    .trim();

  if (!normalized.includes("|") || isMarkdownTableSeparatorLine(normalized)) {
    return [];
  }

  const cells = normalized
    .split("|")
    .map((cell) => stripInlineMarkdown(cell).replace(/^[-*•]+\s*/, "").trim())
    .filter((cell) => cell.length > 0);

  if (cells.length < 4) {
    return [];
  }

  const pairs: Array<{ category: string; value: number }> = [];

  for (let index = 0; index < cells.length - 1; index += 1) {
    const category = cells[index];
    const value = parseLocaleNumber(cells[index + 1] ?? "");

    if (!category || value === null) {
      continue;
    }

    if (
      pairs.length === 0 &&
      cells.length > 4 &&
      /^(safra|ano[\s_-]?safra)\b/i.test(category)
    ) {
      index += 1;
      continue;
    }

    pairs.push({ category, value });
    index += 1;
  }

  return pairs;
}

function buildInlineSeriesChartSpec(
  title: string,
  pairs: Array<{ category: string; value: number }>
): ChartSpecV1 | null {
  if (pairs.length < 2) {
    return null;
  }

  const uniqueRows = Array.from(
    pairs.reduce((map, entry) => {
      const key = entry.category.toLowerCase();
      if (!map.has(key)) {
        map.set(key, entry);
      }
      return map;
    }, new Map<string, { category: string; value: number }>())
  )
    .map(([, entry]) => entry)
    .slice(0, 50)
    .map((entry) => ({
      category: entry.category,
      value: entry.value,
    }));

  if (uniqueRows.length < 2) {
    return null;
  }

  const inferredSpec: ChartSpecV1 = {
    version: "1.0",
    type: "bar",
    title: normalizeChartTitle(title),
    subtitle: "Gerado automaticamente a partir dos valores textuais retornados.",
    data: uniqueRows,
    xKey: "category",
    series: [{ key: "value", label: "Valor", color: "#f97316" }],
  };

  const validation = chartSpecSchema.safeParse(inferredSpec);
  return validation.success ? validation.data : null;
}

export function inferChartSpecsFromInlineSeriesText(
  text: string
): ChartSpecV1[] {
  const lines = text.split(/\r?\n/);
  const inferredSpecs: ChartSpecV1[] = [];
  let currentTitle = "Comparativo";
  let currentPairs: Array<{ category: string; value: number }> = [];

  const flushCurrentSeries = () => {
    if (currentPairs.length < 2) {
      currentPairs = [];
      return;
    }

    const inferredSpec = buildInlineSeriesChartSpec(currentTitle, currentPairs);
    if (inferredSpec) {
      inferredSpecs.push(inferredSpec);
    }

    currentPairs = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushCurrentSeries();
      continue;
    }

    if (looksLikeSectionTitleLine(line)) {
      flushCurrentSeries();
      currentTitle = line;
      continue;
    }

    const linePairs = extractPairsFromInlinePipeLine(line);
    if (linePairs.length > 0) {
      currentPairs.push(...linePairs);
    }
  }

  flushCurrentSeries();

  return dedupeChartSpecs(inferredSpecs).slice(0, 6);
}

function extractPairFromBulletLine(
  line: string
): { category: string; value: number; unit?: string } | null {
  const bulletPrefix = /^(?:[-*•]\s+|\d+[.)]\s+)/;
  if (!bulletPrefix.test(line)) {
    return null;
  }

  const withoutPrefix = line.replace(bulletPrefix, "");
  const stripped = stripInlineMarkdown(withoutPrefix);

  const colonIndex = stripped.indexOf(":");
  if (colonIndex < 1) {
    return null;
  }

  const category = stripped.slice(0, colonIndex).trim();
  const rest = stripped.slice(colonIndex + 1).trim();

  if (!category || !rest) {
    return null;
  }

  const numberMatch = rest.match(
    /^[^\d]*?([-+]?\d[\d.,]*)/
  );
  if (!numberMatch) {
    return null;
  }

  const numericValue = parseLocaleNumber(numberMatch[1]);
  if (numericValue === null) {
    return null;
  }

  const afterNumber = rest.slice(rest.indexOf(numberMatch[1]) + numberMatch[1].length).trim();
  const unitCandidate = afterNumber.replace(/^[,;.\s]+/, "").trim();
  const unit = unitCandidate && unitCandidate.length <= 24 ? unitCandidate : undefined;

  return { category, value: numericValue, unit };
}

function looksLikeBoldTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (/^\p{Emoji_Presentation}\s*\*\*/u.test(trimmed)) {
    return true;
  }

  if (/^\*\*[^*]+\*\*\s*$/.test(trimmed)) {
    return true;
  }

  return false;
}

function extractBulletListTitle(
  lines: string[],
  firstBulletIndex: number
): string {
  for (
    let lineIndex = firstBulletIndex - 1;
    lineIndex >= 0 && lineIndex >= firstBulletIndex - 6;
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

    if (looksLikeBoldTitleLine(candidate)) {
      return stripInlineMarkdown(candidate).slice(0, 120);
    }

    if (/^(?:[-*•]\s+|\d+[.)]\s+)/.test(candidate)) {
      continue;
    }

    return stripInlineMarkdown(candidate).slice(0, 120);
  }

  return "Comparativo";
}

function buildBulletListChartSpec(
  title: string,
  pairs: Array<{ category: string; value: number; unit?: string }>
): ChartSpecV1 | null {
  if (pairs.length < 2) {
    return null;
  }

  const uniqueRows = Array.from(
    pairs.reduce((map, entry) => {
      const key = entry.category.toLowerCase();
      if (!map.has(key)) {
        map.set(key, entry);
      }
      return map;
    }, new Map<string, { category: string; value: number; unit?: string }>())
  )
    .map(([, entry]) => entry)
    .slice(0, 50)
    .map((entry) => ({
      category: entry.category,
      value: entry.value,
    }));

  if (uniqueRows.length < 2) {
    return null;
  }

  const unit = pairs.find((p) => p.unit)?.unit;

  const inferredSpec: ChartSpecV1 = {
    version: "1.0",
    type: "bar",
    title: normalizeChartTitle(title),
    subtitle: "Gerado automaticamente a partir dos valores textuais retornados.",
    data: uniqueRows,
    xKey: "category",
    series: [{ key: "value", label: "Valor", color: "#f97316" }],
    unit: unit || undefined,
  };

  const validation = chartSpecSchema.safeParse(inferredSpec);
  return validation.success ? validation.data : null;
}

export function inferChartSpecsFromBulletListText(
  text: string
): ChartSpecV1[] {
  const lines = text.split(/\r?\n/);
  const inferredSpecs: ChartSpecV1[] = [];
  let currentTitle = "Comparativo";
  let currentPairs: Array<{ category: string; value: number; unit?: string }> = [];
  let firstBulletIndex = -1;

  const flushCurrentSeries = () => {
    if (currentPairs.length >= 2) {
      const title =
        firstBulletIndex >= 0
          ? extractBulletListTitle(lines, firstBulletIndex)
          : currentTitle;

      const inferredSpec = buildBulletListChartSpec(title, currentPairs);
      if (inferredSpec) {
        inferredSpecs.push(inferredSpec);
      }
    }

    currentPairs = [];
    firstBulletIndex = -1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";

    if (!line) {
      flushCurrentSeries();
      continue;
    }

    if (looksLikeBoldTitleLine(line) || looksLikeSectionTitleLine(line)) {
      flushCurrentSeries();
      currentTitle = line;
      continue;
    }

    const pair = extractPairFromBulletLine(line);
    if (pair) {
      if (firstBulletIndex < 0) {
        firstBulletIndex = index;
      }
      currentPairs.push(pair);
    }
  }

  flushCurrentSeries();

  return dedupeChartSpecs(inferredSpecs).slice(0, 6);
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
const INCOMPLETE_CHART_BLOCK_WARNING = "Bloco de grafico incompleto.";
const PARTIAL_CHART_WARNING =
  "Alguns graficos nao puderam ser montados automaticamente.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeChartSpecCandidate(value: Record<string, unknown>): boolean {
  const chartSpecHints = [
    "type",
    "chartType",
    "chart_type",
    "data",
    "rows",
    "labels",
    "datasets",
    "values",
    "x",
    "y",
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
    "graphs",
    "visualizations",
    "graficos",
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

function pickFirstPresentValue(
  value: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const key of keys) {
    if (key in value) {
      return value[key];
    }
  }

  return undefined;
}

function pickStringValue(
  value: Record<string, unknown>,
  keys: string[]
): string | undefined {
  const raw = pickFirstPresentValue(value, keys);
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = stripInlineMarkdown(raw).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNormalizedKey(raw: string, fallback: string): string {
  const normalized = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return normalized.length > 0 ? normalized.slice(0, 40) : fallback;
}

function toLooseChartType(value: unknown): ChartSpecV1["type"] | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized.includes("line") ||
    normalized.includes("linha") ||
    normalized.includes("spline")
  ) {
    return "line";
  }

  if (normalized.includes("area")) {
    return "area";
  }

  if (
    normalized.includes("pie") ||
    normalized.includes("donut") ||
    normalized.includes("pizza") ||
    normalized.includes("rosca")
  ) {
    return "pie";
  }

  if (
    normalized.includes("bar") ||
    normalized.includes("column") ||
    normalized.includes("coluna") ||
    normalized.includes("barras")
  ) {
    return "bar";
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => toNormalizedCellText(entry))
    .filter((entry) => entry.length > 0)
    .slice(0, 50);
}

function toNumericArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const numbers: number[] = [];

  for (const entry of value) {
    const parsed = parseLocaleNumberFromUnknown(entry);
    if (parsed === null) {
      continue;
    }
    numbers.push(parsed);
  }

  return numbers.slice(0, 50);
}

function inferSpecFromRecordRows(
  rows: Record<string, unknown>[],
  options: {
    chartType: ChartSpecV1["type"] | null;
    title?: string;
    subtitle?: string;
    xKeyHint?: string;
    yLabelHint?: string;
    unitHint?: string;
  }
): ChartSpecV1 | null {
  const normalizedRows = rows.filter((row) => row !== null).slice(0, 50);
  if (normalizedRows.length < 2) {
    return null;
  }

  const columns = Array.from(
    normalizedRows.reduce((set, row) => {
      for (const key of Object.keys(row)) {
        const trimmedKey = key.trim();
        if (trimmedKey) {
          set.add(trimmedKey);
        }
      }
      return set;
    }, new Set<string>())
  );

  if (columns.length < 2) {
    return null;
  }

  const hintedCategoryColumn =
    options.xKeyHint && columns.includes(options.xKeyHint)
      ? options.xKeyHint
      : null;
  const categoryColumn =
    hintedCategoryColumn ?? pickCategoryColumn(normalizedRows, columns);

  if (!categoryColumn) {
    return null;
  }

  const numericColumns = pickNumericColumns(normalizedRows, columns, categoryColumn);
  if (numericColumns.length === 0) {
    return null;
  }

  const normalizedData = normalizedRows
    .map((row, index) => {
      const normalizedRow: Record<string, unknown> = {
        category: toNormalizedCellText(row[categoryColumn]) || `Item ${index + 1}`,
      };

      for (const numericColumn of numericColumns) {
        const parsed = parseLocaleNumberFromUnknown(row[numericColumn]);
        if (parsed !== null) {
          normalizedRow[numericColumn] = parsed;
        }
      }

      return normalizedRow;
    })
    .filter((row) =>
      numericColumns.some((numericColumn) => typeof row[numericColumn] === "number")
    );

  if (normalizedData.length < 2) {
    return null;
  }

  const primaryAxisInfo = extractLabelAndUnit(numericColumns[0] ?? "Valor");

  const inferredSpec: ChartSpecV1 = {
    version: "1.0",
    type:
      options.chartType && options.chartType !== "pie"
        ? options.chartType
        : numericColumns.length > 1
          ? "line"
          : "bar",
    title: normalizeChartTitle(options.title),
    subtitle: options.subtitle?.slice(0, 220) || undefined,
    data: normalizedData,
    xKey: "category",
    series: numericColumns.map((column, index) => {
      const axisInfo = extractLabelAndUnit(column);
      const colors = ["#22c55e", "#0ea5e9", "#f97316", "#eab308"];

      return {
        key: column,
        label: axisInfo.label,
        color: colors[index % colors.length],
      };
    }),
    yLabel: options.yLabelHint || primaryAxisInfo.label || undefined,
    unit: options.unitHint || primaryAxisInfo.unit,
  };

  const validation = chartSpecSchema.safeParse(inferredSpec);
  return validation.success ? validation.data : null;
}

function inferSpecFromLoosePayload(value: unknown): ChartSpecV1 | null {
  if (!isRecord(value)) {
    return null;
  }

  const chartType =
    toLooseChartType(value.type) ??
    toLooseChartType(value.chartType) ??
    toLooseChartType(value.chart_type);
  const title = pickStringValue(value, ["title", "name", "chartTitle", "titulo"]);
  const subtitle = pickStringValue(value, [
    "subtitle",
    "description",
    "observations",
    "subtitulo",
  ]);
  const unit = pickStringValue(value, ["unit", "unidade"]);
  const yLabel = pickStringValue(value, [
    "yLabel",
    "y_axis_label",
    "metric",
    "medida",
  ]);
  const xKeyHint = pickStringValue(value, [
    "xKey",
    "x_key",
    "categoryKey",
    "labelKey",
  ]);

  const rowsCandidate = pickFirstPresentValue(value, [
    "data",
    "rows",
    "records",
    "items",
    "points",
  ]);

  if (Array.isArray(rowsCandidate)) {
    const recordRows = rowsCandidate.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry)
    );

    if (recordRows.length > 0) {
      if (chartType === "pie") {
        const columns = Array.from(
          recordRows.reduce((set, row) => {
            for (const key of Object.keys(row)) {
              const trimmedKey = key.trim();
              if (trimmedKey) {
                set.add(trimmedKey);
              }
            }
            return set;
          }, new Set<string>())
        );

        const nameKey =
          pickStringValue(value, ["nameKey", "name_key", "labelKey", "categoryKey"]) ??
          pickCategoryColumn(recordRows, columns) ??
          "category";
        const valueKey =
          pickStringValue(value, ["valueKey", "value_key", "yKey", "y_key"]) ??
          pickNumericColumns(recordRows, columns, nameKey)[0] ??
          "value";

        const normalizedData = recordRows
          .map((row, index) => {
            const name = toNormalizedCellText(row[nameKey]) || `Item ${index + 1}`;
            const numericValue = parseLocaleNumberFromUnknown(row[valueKey]);
            if (numericValue === null) {
              return null;
            }
            return { [nameKey]: name, [valueKey]: numericValue };
          })
          .filter(
            (row): row is Record<string, string | number> => row !== null
          )
          .slice(0, 50);

        if (normalizedData.length > 0) {
          const pieSpec: ChartSpecV1 = {
            version: "1.0",
            type: "pie",
            title: normalizeChartTitle(title),
            subtitle: subtitle?.slice(0, 220) || undefined,
            data: normalizedData,
            nameKey,
            valueKey,
            unit: unit || undefined,
          };

          const validation = chartSpecSchema.safeParse(pieSpec);
          if (validation.success) {
            return validation.data;
          }
        }
      } else {
        const fromRows = inferSpecFromRecordRows(recordRows, {
          chartType,
          title,
          subtitle,
          xKeyHint,
          yLabelHint: yLabel,
          unitHint: unit,
        });

        if (fromRows) {
          return fromRows;
        }
      }
    }
  }

  const dataContainer = isRecord(rowsCandidate) ? rowsCandidate : null;
  const labels = toStringArray(
    pickFirstPresentValue(value, ["labels", "categories", "x", "xValues"]) ??
      (dataContainer
        ? pickFirstPresentValue(dataContainer, [
            "labels",
            "categories",
            "x",
            "xValues",
          ])
        : undefined)
  );
  const plainValues = toNumericArray(
    pickFirstPresentValue(value, ["values", "y", "yValues", "dataPoints"]) ??
      (dataContainer
        ? pickFirstPresentValue(dataContainer, [
            "values",
            "y",
            "yValues",
            "dataPoints",
          ])
        : undefined)
  );
  const datasetsCandidate =
    pickFirstPresentValue(value, ["datasets", "series"]) ??
    (dataContainer
      ? pickFirstPresentValue(dataContainer, ["datasets", "series"])
      : undefined);

  if (chartType === "pie" && labels.length > 0 && plainValues.length > 0) {
    const rowCount = Math.min(labels.length, plainValues.length, 50);
    if (rowCount > 0) {
      const pieRows = Array.from({ length: rowCount }).map((_, index) => ({
        category: labels[index] ?? `Item ${index + 1}`,
        value: plainValues[index],
      }));

      const pieSpec: ChartSpecV1 = {
        version: "1.0",
        type: "pie",
        title: normalizeChartTitle(title),
        subtitle: subtitle?.slice(0, 220) || undefined,
        data: pieRows,
        nameKey: "category",
        valueKey: "value",
        unit: unit || undefined,
      };

      const validation = chartSpecSchema.safeParse(pieSpec);
      if (validation.success) {
        return validation.data;
      }
    }
  }

  if (Array.isArray(datasetsCandidate) && datasetsCandidate.length > 0) {
    const datasetSpecs = datasetsCandidate
      .map((entry, index) => {
        if (!isRecord(entry)) {
          return null;
        }

        const key = toNormalizedKey(
          pickStringValue(entry, ["key", "id", "field", "label", "name"]) ??
            `serie_${index + 1}`,
          `serie_${index + 1}`
        );
        const label = pickStringValue(entry, ["label", "name"]) ?? `Serie ${index + 1}`;
        const values = toNumericArray(
          pickFirstPresentValue(entry, ["data", "values", "points", "y"])
        );
        if (values.length === 0) {
          return null;
        }

        return {
          key,
          label,
          values,
        };
      })
      .filter(
        (
          entry
        ): entry is { key: string; label: string; values: number[] } => entry !== null
      );

    const maxRowCount = datasetSpecs.reduce((max, dataset) => {
      return Math.max(max, dataset.values.length);
    }, 0);
    const rowCount = Math.min(Math.max(labels.length, maxRowCount), 50);

    if (datasetSpecs.length > 0 && rowCount > 1) {
      const rows = Array.from({ length: rowCount }).map((_, index) => {
        const row: Record<string, unknown> = {
          category: labels[index] ?? `Item ${index + 1}`,
        };

        for (const dataset of datasetSpecs) {
          const numericValue = dataset.values[index];
          if (typeof numericValue === "number" && Number.isFinite(numericValue)) {
            row[dataset.key] = numericValue;
          }
        }

        return row;
      }).filter((row) =>
        datasetSpecs.some((dataset) => typeof row[dataset.key] === "number")
      );

      if (rows.length > 1) {
        const inferredSpec: ChartSpecV1 = {
          version: "1.0",
          type: chartType && chartType !== "pie" ? chartType : "line",
          title: normalizeChartTitle(title),
          subtitle: subtitle?.slice(0, 220) || undefined,
          data: rows,
          xKey: "category",
          series: datasetSpecs.map((dataset, index) => {
            const colors = ["#22c55e", "#0ea5e9", "#f97316", "#eab308"];
            return {
              key: dataset.key,
              label: dataset.label,
              color: colors[index % colors.length],
            };
          }),
          yLabel: yLabel || undefined,
          unit: unit || undefined,
        };

        const validation = chartSpecSchema.safeParse(inferredSpec);
        if (validation.success) {
          return validation.data;
        }
      }
    }
  }

  if (labels.length > 0 && plainValues.length > 1) {
    const rowCount = Math.min(labels.length, plainValues.length, 50);
    if (rowCount > 1) {
      const rows = Array.from({ length: rowCount }).map((_, index) => ({
        category: labels[index] ?? `Item ${index + 1}`,
        value: plainValues[index],
      }));

      const inferredSpec: ChartSpecV1 = {
        version: "1.0",
        type: chartType && chartType !== "pie" ? chartType : "bar",
        title: normalizeChartTitle(title),
        subtitle: subtitle?.slice(0, 220) || undefined,
        data: rows,
        xKey: "category",
        series: [{ key: "value", label: yLabel || "Valor" }],
        yLabel: yLabel || undefined,
        unit: unit || undefined,
      };

      const validation = chartSpecSchema.safeParse(inferredSpec);
      if (validation.success) {
        return validation.data;
      }
    }
  }

  return null;
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

    const inferredSpec = inferSpecFromLoosePayload(candidate);
    if (inferredSpec) {
      chartSpecs.push(inferredSpec);
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
  const chartContextExtraction = extractContextBlocks(text, CHART_CONTEXT_TAG);
  const chartExtraction = extractContextBlocks(text, CHART_TAG);
  const chartCleanTextExtraction = extractContextBlocks(
    chartContextExtraction.cleanedText,
    CHART_TAG
  );
  const hasTag = chartContextExtraction.hasTag || chartExtraction.hasTag;
  const cleanedText = chartCleanTextExtraction.cleanedText;

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

  const payloads = [...chartContextExtraction.payloads, ...chartExtraction.payloads]
    .sort((entryA, entryB) => {
      if (entryA.index !== entryB.index) {
        return entryA.index - entryB.index;
      }
      return Number(entryA.isComplete) - Number(entryB.isComplete);
    })
    .map((entry) => entry.payload?.trim() || null);

  if (payloads.length === 0 || payloads.every((payload) => !payload)) {
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartSpecs: [],
      chartError: INCOMPLETE_CHART_BLOCK_WARNING,
      chartErrorDetails: INCOMPLETE_CHART_BLOCK_WARNING,
      hasChartContext: true,
    };
  }

  const collectedSpecs: ChartSpecV1[] = [];
  const issues: string[] = [];
  let hasIncompletePayload = false;

  for (const payload of payloads) {
    if (!payload) {
      hasIncompletePayload = true;
      continue;
    }

    let parsedPayload: unknown;

    try {
      parsedPayload = tryParseChartPayload(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "JSON invalido";
      issues.push(`Nao foi possivel interpretar bloco de grafico: ${message}`);
      continue;
    }

    const parsedSpecs = parseChartSpecsFromPayload(parsedPayload);
    if (parsedSpecs.chartSpecs.length === 0) {
      issues.push(
        `CHART_CONTEXT invalido: ${parsedSpecs.firstIssue ?? "schema invalido"}`
      );
      continue;
    }

    collectedSpecs.push(...parsedSpecs.chartSpecs);
  }

  const chartSpecs = dedupeChartSpecs(collectedSpecs).slice(0, 6);
  const detailMessages = [...issues];

  if (hasIncompletePayload) {
    detailMessages.push(INCOMPLETE_CHART_BLOCK_WARNING);
  }

  if (chartSpecs.length === 0) {
    const onlyIncompleteBlockIssue =
      hasIncompletePayload && issues.length === 0
        ? INCOMPLETE_CHART_BLOCK_WARNING
        : detailMessages[0] ?? "CHART_CONTEXT invalido: schema invalido";

    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartSpecs: [],
      chartError:
        onlyIncompleteBlockIssue === INCOMPLETE_CHART_BLOCK_WARNING
          ? INCOMPLETE_CHART_BLOCK_WARNING
          : GENERIC_CHART_WARNING,
      chartErrorDetails: onlyIncompleteBlockIssue,
      hasChartContext: true,
    };
  }

  const hasPartialFailures = detailMessages.length > 0;

  return {
    cleanText: cleanedText,
    chartSpec: chartSpecs[0] ?? null,
    chartSpecs,
    chartError: hasPartialFailures ? PARTIAL_CHART_WARNING : null,
    chartErrorDetails: hasPartialFailures ? detailMessages.join(" | ") : null,
    hasChartContext: true,
  };
}

export function inferChartSpecsFromLooseJsonText(text: string): ChartSpecV1[] {
  const codeFenceRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  const candidatePayloads: string[] = [];

  while (true) {
    const match = codeFenceRegex.exec(text);
    if (!match) {
      break;
    }

    const payload = match[1]?.trim();
    if (payload) {
      candidatePayloads.push(payload);
    }
  }

  const trimmedText = text.trim();
  if (trimmedText) {
    candidatePayloads.push(trimmedText);
  }

  if (candidatePayloads.length === 0) {
    return [];
  }

  const uniquePayloads = [...new Set(candidatePayloads)];
  const inferredSpecs: ChartSpecV1[] = [];

  for (const payload of uniquePayloads) {
    let parsedPayload: unknown;

    try {
      parsedPayload = tryParseChartPayload(payload);
    } catch {
      continue;
    }

    const parsedSpecs = parseChartSpecsFromPayload(parsedPayload);
    if (parsedSpecs.chartSpecs.length > 0) {
      inferredSpecs.push(...parsedSpecs.chartSpecs);
    }
  }

  return dedupeChartSpecs(inferredSpecs).slice(0, 6);
}
