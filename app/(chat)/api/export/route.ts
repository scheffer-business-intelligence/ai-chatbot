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

  const filename = asNonEmptyString(requestBody.filename) ?? "export";
  const normalizedSheets = extractContextSheets(requestBody.contextSheets).map(
    (sheet) => ({
      ...sheet,
      rows: sheet.rows.slice(0, MAX_ROWS_PER_SHEET),
    })
  );

  if (normalizedSheets.length === 0) {
    return NextResponse.json(
      { detail: "Nao encontrei dados de contexto para exportar." },
      { status: 400 }
    );
  }

  try {
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
