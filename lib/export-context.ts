const DATA_FROM_CONTEXT_MARKER = "DATA_FROM_CONTEXT";
const EXPORT_DATA_TAG = "EXPORT_DATA";
const BQ_CONTEXT_TAG = "BQ_CONTEXT";

export type ExportContextSheet = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

export type ParsedExportData = {
  query: string;
  filename: string;
  description: string;
};

type ParsedBqContext = {
  cleanText: string;
  contextSheets: ExportContextSheet[];
};

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractContextBlock(
  text: string,
  tagName: string
): {
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
      payload: completeMatch[1].trim(),
      cleanedText: text.replace(completeRegex, "").trim(),
    };
  }

  if (openTagRegex.test(text)) {
    const danglingPayloadMatch = text.match(
      new RegExp(
        `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])\\s*([\\s\\S]*)$`,
        "i"
      )
    );
    const withoutDangling = text.replace(
      new RegExp(
        `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])[\\s\\S]*$`,
        "i"
      ),
      ""
    );

    return {
      payload: asNonEmptyString(danglingPayloadMatch?.[1] ?? null),
      cleanedText: withoutDangling.replace(closingTagRegex, "").trim(),
    };
  }

  return {
    payload: null,
    cleanedText: text.replace(closingTagRegex, "").trim(),
  };
}

function parseExportTaggedFields(
  payload: string
): Partial<Record<"query" | "filename" | "description", string>> {
  const markerRegex = /\b(query|filename|description)\s*:/gi;
  const markers: Array<{
    key: "query" | "filename" | "description";
    start: number;
    valueStart: number;
  }> = [];

  for (const match of payload.matchAll(markerRegex)) {
    const rawKey = match[1]?.toLowerCase();
    if (
      rawKey !== "query" &&
      rawKey !== "filename" &&
      rawKey !== "description"
    ) {
      continue;
    }

    markers.push({
      key: rawKey,
      start: match.index ?? 0,
      valueStart: (match.index ?? 0) + match[0].length,
    });
  }

  if (markers.length === 0) {
    return {};
  }

  const fields: Partial<Record<"query" | "filename" | "description", string>> =
    {};

  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index];
    const next = markers[index + 1];
    const value = asNonEmptyString(
      payload.slice(current.valueStart, next?.start ?? payload.length)
    );

    if (!value || fields[current.key]) {
      continue;
    }

    fields[current.key] = value;
  }

  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      columns.push(key);
    }
  }

  return columns;
}

function extractRecordRows(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.filter(isRecord);
}

function unwrapCodeFence(payload: string): string {
  const trimmed = payload.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);

  if (!fenceMatch) {
    return trimmed;
  }

  return fenceMatch[1]?.trim() ?? trimmed;
}

function tryParseJsonPayload(payload: string): unknown {
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

  throw new Error("JSON invalido no bloco BQ_CONTEXT");
}

function normalizeColumnName(rawValue: unknown, index: number): string {
  if (typeof rawValue === "string" && rawValue.trim()) {
    return rawValue.trim();
  }

  return `coluna_${index + 1}`;
}

function normalizeColumns(rawColumns: unknown): string[] {
  if (!Array.isArray(rawColumns)) {
    return [];
  }

  return rawColumns
    .map((column, index) => normalizeColumnName(column, index))
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

function buildRowsFromTupleRows(
  tupleRows: unknown[][],
  columnsFromSheet: string[]
): {
  columns: string[];
  rows: Record<string, unknown>[];
} {
  if (tupleRows.length === 0) {
    return { columns: [], rows: [] };
  }

  let columns = [...columnsFromSheet];
  let dataRows = tupleRows;

  if (columns.length === 0) {
    const headerRow = tupleRows[0] ?? [];
    const normalizedFromHeader = headerRow.map((cell, index) =>
      normalizeColumnName(cell, index)
    );

    if (normalizedFromHeader.length > 0) {
      columns = normalizedFromHeader;
      dataRows = tupleRows.slice(1);
    }
  }

  if (columns.length === 0) {
    const maxLength = tupleRows.reduce(
      (currentMax, currentRow) => Math.max(currentMax, currentRow.length),
      0
    );

    columns = Array.from({ length: maxLength }).map((_, index) =>
      normalizeColumnName("", index)
    );
  }

  if (columns.length === 0 || dataRows.length === 0) {
    return { columns: [], rows: [] };
  }

  const rows = dataRows
    .map((row) => {
      const record: Record<string, unknown> = {};

      columns.forEach((column, index) => {
        record[column] = row[index] ?? "";
      });

      return record;
    })
    .filter((row) =>
      Object.values(row).some((value) => {
        if (value === null || value === undefined) {
          return false;
        }

        if (typeof value === "string") {
          return value.trim().length > 0;
        }

        return true;
      })
    );

  return {
    columns,
    rows,
  };
}

export function normalizeExportFilename(filename: string): string {
  const withoutKnownExtensions = filename
    .trim()
    .replace(/(?:\.(?:xlsx|xls|csv|tsv))+$/i, "");
  const sanitized = withoutKnownExtensions
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "export";
}

export function ensureXlsxFilename(filename: string): string {
  return `${normalizeExportFilename(filename)}.xlsx`;
}

export function isDataFromContextQuery(query: string): boolean {
  const normalized = query.trim().toUpperCase();
  return (
    normalized === DATA_FROM_CONTEXT_MARKER ||
    normalized.includes(DATA_FROM_CONTEXT_MARKER)
  );
}

export function parseExportDataFromText(text: string): {
  cleanText: string;
  exportData: ParsedExportData | null;
} {
  const exportBlock = extractContextBlock(text, EXPORT_DATA_TAG);
  if (!exportBlock.payload) {
    return {
      cleanText: exportBlock.cleanedText,
      exportData: null,
    };
  }

  const { query, filename, description } = parseExportTaggedFields(
    exportBlock.payload
  );

  if (!query || !filename || !description) {
    return {
      cleanText: exportBlock.cleanedText,
      exportData: null,
    };
  }

  return {
    cleanText: exportBlock.cleanedText,
    exportData: {
      query,
      filename,
      description,
    },
  };
}

export function extractContextSheets(rawSheets: unknown): ExportContextSheet[] {
  if (typeof rawSheets === "string" && rawSheets.trim()) {
    try {
      const parsedSheets = tryParseJsonPayload(rawSheets);
      return extractContextSheets(parsedSheets);
    } catch {
      return [];
    }
  }

  if (isRecord(rawSheets)) {
    const candidateValues: unknown[] = [
      rawSheets.contextSheets,
      rawSheets.sheets,
      rawSheets.tables,
      rawSheets.datasets,
      rawSheets.results,
      rawSheets.result,
      rawSheets.data,
      rawSheets.rows,
    ];

    for (const candidate of candidateValues) {
      if (candidate === rawSheets) {
        continue;
      }

      const sheetsFromCandidate = extractContextSheets(candidate);
      if (sheetsFromCandidate.length > 0) {
        return sheetsFromCandidate;
      }
    }

    return extractContextSheets([rawSheets]);
  }

  if (!Array.isArray(rawSheets)) {
    return [];
  }

  const sheets: ExportContextSheet[] = [];

  rawSheets.forEach((sheet, index) => {
    if (!isRecord(sheet)) {
      return;
    }

    const rowsCandidate =
      sheet.rows ?? sheet.data ?? sheet.values ?? sheet.records ?? sheet.items;
    const columnsFromSheet = normalizeColumns(
      sheet.columns ?? sheet.headers ?? sheet.header
    );
    const recordRows = extractRecordRows(rowsCandidate);
    const tupleRows = Array.isArray(rowsCandidate)
      ? rowsCandidate.filter(
          (row): row is unknown[] => Array.isArray(row) && row.length > 0
        )
      : [];
    const tupleResolution =
      recordRows.length === 0 && tupleRows.length > 0
        ? buildRowsFromTupleRows(tupleRows, columnsFromSheet)
        : null;
    const rows =
      recordRows.length > 0 ? recordRows : (tupleResolution?.rows ?? []);

    if (rows.length === 0) {
      return;
    }

    const columns =
      tupleResolution && tupleResolution.columns.length > 0
        ? tupleResolution.columns
        : columnsFromSheet.length > 0
          ? columnsFromSheet
          : deriveColumns(rows);

    if (columns.length === 0) {
      return;
    }

    const name =
      asNonEmptyString(sheet.name) ??
      asNonEmptyString(sheet.title) ??
      (index === 0 ? "Dados" : `Tabela ${index + 1}`);

    sheets.push({
      name,
      columns,
      rows,
    });
  });

  return sheets;
}

function buildFallbackSheetsFromRows(rows: unknown): ExportContextSheet[] {
  const recordRows = extractRecordRows(rows);
  if (recordRows.length === 0) {
    return [];
  }

  const columns = deriveColumns(recordRows);
  if (columns.length === 0) {
    return [];
  }

  return [
    {
      name: "Dados",
      columns,
      rows: recordRows,
    },
  ];
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/g)
    .map((cell) => stripInlineMarkdown(cell.replace(/\\\|/g, "|").trim()));
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function reconstructCollapsedTableLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  const rawCells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);

  if (rawCells.length < 6) {
    return null;
  }

  let separatorStart = -1;
  let separatorLength = 0;

  for (let index = 0; index < rawCells.length; index += 1) {
    if (!isSeparatorCell(rawCells[index])) {
      continue;
    }

    let runLength = 1;
    while (
      index + runLength < rawCells.length &&
      isSeparatorCell(rawCells[index + runLength])
    ) {
      runLength += 1;
    }

    if (runLength >= 2) {
      separatorStart = index;
      separatorLength = runLength;
      break;
    }
  }

  if (separatorStart < 2 || separatorLength < 2) {
    return null;
  }

  const headerStart = separatorStart - separatorLength;
  if (headerStart !== 0) {
    return null;
  }

  const headerCells = rawCells.slice(headerStart, separatorStart);
  const separatorCells = rawCells.slice(
    separatorStart,
    separatorStart + separatorLength
  );
  const bodyCells = rawCells.slice(separatorStart + separatorLength);

  if (
    bodyCells.length < separatorLength ||
    bodyCells.length % separatorLength !== 0
  ) {
    return null;
  }

  const normalizedLines: string[] = [];
  normalizedLines.push(`| ${headerCells.join(" | ")} |`);
  normalizedLines.push(`| ${separatorCells.join(" | ")} |`);

  for (let index = 0; index < bodyCells.length; index += separatorLength) {
    normalizedLines.push(
      `| ${bodyCells.slice(index, index + separatorLength).join(" | ")} |`
    );
  }

  return normalizedLines.join("\n");
}

function normalizeCollapsedTables(lines: string[]): string[] {
  const normalized: string[] = [];

  for (const line of lines) {
    const reconstructed = reconstructCollapsedTableLine(line);
    if (!reconstructed) {
      normalized.push(line);
      continue;
    }

    normalized.push(...reconstructed.split("\n"));
  }

  return normalized;
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }

  const cells = splitMarkdownTableRow(line);
  if (cells.length < 2) {
    return false;
  }

  return cells.every((cell) => isSeparatorCell(cell.replace(/\s+/g, "")));
}

function buildUniqueHeaderNames(headers: string[]): string[] {
  const used = new Map<string, number>();

  return headers.map((header, index) => {
    const base = header.trim() || `coluna_${index + 1}`;
    const currentCount = used.get(base) ?? 0;
    used.set(base, currentCount + 1);

    if (currentCount === 0) {
      return base;
    }

    return `${base}_${currentCount + 1}`;
  });
}

function extractMarkdownTableSheetFromText(
  text: string
): ExportContextSheet | null {
  const lines = normalizeCollapsedTables(text.split(/\r?\n/));

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index]?.trim() ?? "";
    const separatorLine = lines[index + 1]?.trim() ?? "";

    if (
      !headerLine.includes("|") ||
      !isMarkdownTableSeparatorLine(separatorLine)
    ) {
      continue;
    }

    const rawHeaders = splitMarkdownTableRow(headerLine);
    if (rawHeaders.length < 2) {
      continue;
    }

    const columns = buildUniqueHeaderNames(rawHeaders);
    const rows: Record<string, unknown>[] = [];

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex]?.trim() ?? "";
      if (!rowLine || !rowLine.includes("|")) {
        break;
      }

      if (isMarkdownTableSeparatorLine(rowLine)) {
        continue;
      }

      const rowCells = splitMarkdownTableRow(rowLine);
      if (rowCells.length === 0) {
        continue;
      }

      while (rowCells.length < columns.length) {
        rowCells.push("");
      }

      const normalizedCells = rowCells.slice(0, columns.length);
      if (normalizedCells.every((cell) => !String(cell).trim())) {
        continue;
      }

      const rowRecord: Record<string, unknown> = {};
      columns.forEach((column, columnIndex) => {
        rowRecord[column] = normalizedCells[columnIndex] ?? "";
      });
      rows.push(rowRecord);
    }

    if (rows.length === 0) {
      continue;
    }

    return {
      name: "Tabela",
      columns,
      rows,
    };
  }

  return null;
}

function extractListRowsFromText(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const unordered = trimmed.match(/^[-*•]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const content = unordered?.[1] ?? ordered?.[1];

    if (!content) {
      continue;
    }

    const normalized = stripInlineMarkdown(content);
    if (!normalized) {
      continue;
    }

    const separatorIndex = normalized.indexOf(":");
    if (separatorIndex > 0 && separatorIndex < normalized.length - 1) {
      rows.push({
        item: normalized.slice(0, separatorIndex).trim(),
        valor: normalized.slice(separatorIndex + 1).trim(),
      });
      continue;
    }

    rows.push({ item: normalized });
  }

  return rows;
}

function buildFallbackSheetsFromText(text: string): ExportContextSheet[] {
  const tableSheet = extractMarkdownTableSheetFromText(text);
  if (tableSheet) {
    return [tableSheet];
  }

  const listRows = extractListRowsFromText(text);
  if (listRows.length === 0) {
    return [];
  }

  const columns = deriveColumns(listRows);
  if (columns.length === 0) {
    return [];
  }

  return [
    {
      name: "Dados",
      columns,
      rows: listRows,
    },
  ];
}

export function parseBqContextFromText(text: string): ParsedBqContext {
  const bqBlock = extractContextBlock(text, BQ_CONTEXT_TAG);
  if (!bqBlock.payload) {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: [],
    };
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = tryParseJsonPayload(bqBlock.payload);
  } catch {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: [],
    };
  }

  const parseFromRecord = (record: Record<string, unknown>) => {
    const candidateSheetsValues: unknown[] = [
      record.contextSheets,
      record.sheets,
      record.tables,
      record.datasets,
      record.results,
      record.result,
      record.data,
    ];

    for (const candidate of candidateSheetsValues) {
      const sheetsFromCandidate = extractContextSheets(candidate);
      if (sheetsFromCandidate.length > 0) {
        return sheetsFromCandidate;
      }
    }

    const directSheet = extractContextSheets([record]);
    if (directSheet.length > 0) {
      return directSheet;
    }

    const rowCandidates: unknown[] = [
      record.rows,
      record.records,
      record.items,
      record.values,
      record.data,
      record.result,
      record.results,
    ];

    for (const rowsCandidate of rowCandidates) {
      const fallbackFromRows = buildFallbackSheetsFromRows(rowsCandidate);
      if (fallbackFromRows.length > 0) {
        return fallbackFromRows;
      }
    }

    return [];
  };

  if (Array.isArray(parsedPayload)) {
    const directSheets = extractContextSheets(parsedPayload);
    if (directSheets.length > 0) {
      return {
        cleanText: bqBlock.cleanedText,
        contextSheets: directSheets,
      };
    }

    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: buildFallbackSheetsFromRows(parsedPayload),
    };
  }

  if (!isRecord(parsedPayload)) {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: [],
    };
  }

  const sheetsFromContext = parseFromRecord(parsedPayload);
  if (sheetsFromContext.length > 0) {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: sheetsFromContext,
    };
  }

  return {
    cleanText: bqBlock.cleanedText,
    contextSheets: [],
  };
}

export function getTotalRowsFromSheets(sheets: ExportContextSheet[]): number {
  return sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
}

export function parseExportAwareText(text: string): {
  cleanText: string;
  exportData: ParsedExportData | null;
  contextSheets: ExportContextSheet[];
} {
  const parsedBqContext = parseBqContextFromText(text);
  const parsedExportData = parseExportDataFromText(parsedBqContext.cleanText);
  const fallbackSheets =
    parsedBqContext.contextSheets.length > 0
      ? parsedBqContext.contextSheets
      : buildFallbackSheetsFromText(parsedExportData.cleanText);

  return {
    cleanText: parsedExportData.cleanText,
    exportData: parsedExportData.exportData,
    contextSheets: fallbackSheets,
  };
}

export { DATA_FROM_CONTEXT_MARKER };
