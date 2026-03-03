import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {
  type ExportContextSheet,
  extractContextSheets,
  normalizeExportFilename,
} from "@/lib/export-context";

const MAX_ROWS_PER_SHEET = 10_000;
const MAX_SHEET_NAME_LENGTH = 31;

type ExportRequestBody = {
  filename?: unknown;
  contextSheets?: unknown;
  tableRows?: unknown;
  tableTitle?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeSheetName(
  rawName: string,
  index: number,
  usedNames: Set<string>
): string {
  const fallbackName = `Tabela ${index}`;
  const cleaned = rawName
    .replace(/[[\]:*?/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const baseName = (cleaned || fallbackName).slice(0, MAX_SHEET_NAME_LENGTH);

  let candidate = baseName || fallbackName;
  let suffixIndex = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` (${suffixIndex})`;
    const maxBaseLength = Math.max(MAX_SHEET_NAME_LENGTH - suffix.length, 1);
    const shortBase = (baseName || fallbackName).slice(0, maxBaseLength).trim();
    candidate = `${shortBase || fallbackName.slice(0, maxBaseLength)}${suffix}`;
    suffixIndex += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function normalizeCellValue(value: unknown): string | number | boolean | Date {
  if (value === null || value === undefined) {
    return "";
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeTableRows(rawRows: unknown): string[][] {
  if (!Array.isArray(rawRows)) {
    return [];
  }

  const rows: string[][] = [];

  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow)) {
      continue;
    }

    const normalizedRow = rawRow
      .map((cell) => normalizeCellValue(cell))
      .map((value) =>
        typeof value === "string" ? value.trim() : String(value)
      );

    if (normalizedRow.every((cell) => cell.length === 0)) {
      continue;
    }

    rows.push(normalizedRow);
  }

  return rows;
}

function buildUniqueColumnNames(
  header: string[],
  columnCount: number
): string[] {
  const used = new Map<string, number>();
  const columns: string[] = [];

  for (let index = 0; index < columnCount; index += 1) {
    const baseName = header[index]?.trim() || `coluna_${index + 1}`;
    const key = baseName.toLowerCase();
    const seenCount = used.get(key) ?? 0;
    used.set(key, seenCount + 1);

    if (seenCount === 0) {
      columns.push(baseName);
      continue;
    }

    columns.push(`${baseName}_${seenCount + 1}`);
  }

  return columns;
}

function applyRowsToWorksheet(
  worksheet: ExcelJS.Worksheet,
  columns: string[],
  rows: Record<string, unknown>[]
) {
  worksheet.columns = columns.map((name) => ({
    header: name,
    key: name,
    width: Math.min(Math.max(name.length + 5, 12), 40),
  }));

  for (const row of rows) {
    const normalizedRow: Record<string, string | number | boolean | Date> = {};

    for (const column of columns) {
      normalizedRow[column] = normalizeCellValue(row[column]);
    }

    worksheet.addRow(normalizedRow);
  }
}

async function buildWorkbookBuffer(sheets: ExportContextSheet[]) {
  const workbook = new ExcelJS.Workbook();
  const usedSheetNames = new Set<string>();

  sheets.forEach((sheet, index) => {
    const worksheetName = sanitizeSheetName(
      sheet.name,
      index + 1,
      usedSheetNames
    );
    const worksheet = workbook.addWorksheet(worksheetName);
    applyRowsToWorksheet(worksheet, sheet.columns, sheet.rows);
  });

  const rawBuffer: unknown = await workbook.xlsx.writeBuffer();
  return toArrayBuffer(rawBuffer);
}

function toArrayBuffer(rawBuffer: unknown) {
  if (rawBuffer instanceof ArrayBuffer) {
    return rawBuffer;
  }

  const source =
    rawBuffer instanceof Uint8Array
      ? rawBuffer
      : new Uint8Array(rawBuffer as ArrayBuffer);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

async function buildTableWorkbookBuffer(title: string, rows: string[][]) {
  const workbook = new ExcelJS.Workbook();
  const usedSheetNames = new Set<string>();
  const worksheet = workbook.addWorksheet(
    sanitizeSheetName(title, 1, usedSheetNames)
  );

  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const header = rows[0] ?? [];
  const columns = buildUniqueColumnNames(header, columnCount);
  const dataRows = rows.slice(1);

  worksheet.addRow(columns);

  for (const row of dataRows) {
    const normalizedRow = columns.map((_, index) => row[index] ?? "");
    worksheet.addRow(normalizedRow);
  }

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };

  for (let index = 1; index <= columnCount; index += 1) {
    const cell = headerRow.getCell(index);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F7A3E" },
    };
  }

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  for (let index = 0; index < columnCount; index += 1) {
    let maxLength = Math.max(columns[index]?.length ?? 0, 12);

    for (const row of dataRows) {
      const value = row[index] ?? "";
      maxLength = Math.max(maxLength, value.length + 2);
    }

    worksheet.getColumn(index + 1).width = Math.min(maxLength, 50);
  }

  const rawBuffer: unknown = await workbook.xlsx.writeBuffer();
  return toArrayBuffer(rawBuffer);
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }

  let requestBody: ExportRequestBody = {};
  try {
    requestBody = (await request.json()) as ExportRequestBody;
  } catch {
    requestBody = {};
  }

  const contextSheets = extractContextSheets(requestBody.contextSheets);
  const tableRows = normalizeTableRows(requestBody.tableRows);
  const tableTitle = asNonEmptyString(requestBody.tableTitle) ?? "Tabela";
  const filename =
    asNonEmptyString(requestBody.filename) ??
    asNonEmptyString(requestBody.tableTitle) ??
    "export";

  if (contextSheets.length === 0 && tableRows.length === 0) {
    return NextResponse.json(
      { detail: "Nao encontrei dados para exportar." },
      { status: 400 }
    );
  }

  try {
    if (contextSheets.length === 0) {
      const buffer = await buildTableWorkbookBuffer(tableTitle, tableRows);
      const safeFilename = normalizeExportFilename(filename);

      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeFilename}.xlsx"`,
        },
      });
    }

    const normalizedSheets = contextSheets.map((sheet) => ({
      ...sheet,
      rows: sheet.rows.slice(0, MAX_ROWS_PER_SHEET),
    }));
    const buffer = await buildWorkbookBuffer(normalizedSheets);
    const safeFilename = normalizeExportFilename(filename);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeFilename}.xlsx"`,
      },
    });
  } catch (error) {
    console.error("Export error:", error);
    const detail =
      error instanceof Error ? error.message : "Failed to export context data";

    return NextResponse.json({ detail }, { status: 500 });
  }
}
