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
    const withoutDangling = text.replace(
      new RegExp(
        `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])[\\s\\S]*$`,
        "i"
      ),
      ""
    );

    return {
      payload: null,
      cleanedText: withoutDangling.replace(closingTagRegex, "").trim(),
    };
  }

  return {
    payload: null,
    cleanedText: text.replace(closingTagRegex, "").trim(),
  };
}

function getTaggedField(payload: string, key: string): string | null {
  const escapedKey = escapeForRegex(key);
  const fieldRegex = new RegExp(
    `${escapedKey}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*[a-zA-Z_]+\\s*:|$)`,
    "i"
  );
  const match = payload.match(fieldRegex);
  if (!match) {
    return null;
  }

  return asNonEmptyString(match[1]);
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

  const query = getTaggedField(exportBlock.payload, "query");
  const filename = getTaggedField(exportBlock.payload, "filename");
  const description = getTaggedField(exportBlock.payload, "description");

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
  if (!Array.isArray(rawSheets)) {
    return [];
  }

  const sheets: ExportContextSheet[] = [];

  rawSheets.forEach((sheet, index) => {
    if (!isRecord(sheet)) {
      return;
    }

    const rows = extractRecordRows(sheet.rows);
    if (rows.length === 0) {
      return;
    }

    const columnsFromSheet = Array.isArray(sheet.columns)
      ? sheet.columns
          .filter((column): column is string => typeof column === "string")
          .map((column) => column.trim())
          .filter((column) => column.length > 0)
      : [];
    const columns =
      columnsFromSheet.length > 0 ? columnsFromSheet : deriveColumns(rows);

    if (columns.length === 0) {
      return;
    }

    const name =
      asNonEmptyString(sheet.name) ??
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
    parsedPayload = JSON.parse(bqBlock.payload);
  } catch {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: [],
    };
  }

  if (!isRecord(parsedPayload)) {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: [],
    };
  }

  const sheetsFromContext = extractContextSheets(parsedPayload.contextSheets);
  if (sheetsFromContext.length > 0) {
    return {
      cleanText: bqBlock.cleanedText,
      contextSheets: sheetsFromContext,
    };
  }

  return {
    cleanText: bqBlock.cleanedText,
    contextSheets: buildFallbackSheetsFromRows(parsedPayload.rows),
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
