function isFenceDelimiter(line: string): boolean {
  return /^```/.test(line.trim());
}

function countPipes(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

function normalizeEscapedPipesInTableLine(line: string): string {
  if (!line.includes("\\|")) {
    return line;
  }

  const looksLikeTableLine =
    countPipes(line) >= 2 ||
    line.includes("---") ||
    line.includes(":--") ||
    line.includes("--:");

  if (!looksLikeTableLine) {
    return line;
  }

  return line.replace(/\\\|/g, "|");
}

function isLikelyTableHeader(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }

  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);

  return cells.length >= 2;
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) {
    return false;
  }

  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);

  if (cells.length < 2) {
    return false;
  }

  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function shouldInsertBlankLineBeforeTable(previousLine: string): boolean {
  const trimmed = previousLine.trim();
  if (!trimmed) {
    return false;
  }

  if (/^[-*+]\s/.test(trimmed)) {
    return false;
  }

  if (/^\d+[.)]\s/.test(trimmed)) {
    return false;
  }

  if (/^>\s?/.test(trimmed)) {
    return false;
  }

  return true;
}

function stripDanglingTrailingEmphasisMarker(line: string): string {
  const trimmedRight = line.replace(/\s+$/, "");
  if (!trimmedRight.endsWith("*") && !trimmedRight.endsWith("_")) {
    return line;
  }

  const marker = trimmedRight.endsWith("*") ? "*" : "_";
  const trailingMarkerRegex = new RegExp(`\\${marker}$`);
  if (!trailingMarkerRegex.test(trimmedRight)) {
    return line;
  }

  const markerRegex = new RegExp(`(?<!\\\\)\\${marker}`, "g");
  const markerCount = (trimmedRight.match(markerRegex) ?? []).length;

  if (markerCount % 2 === 0) {
    return line;
  }

  const withoutTrailingMarker = trimmedRight.slice(0, -1);
  const trailingWhitespace = line.slice(trimmedRight.length);
  return `${withoutTrailingMarker}${trailingWhitespace}`;
}

export function normalizeMarkdownForRender(text: string): string {
  if (!text) {
    return text;
  }

  // Fix common stream artifacts where newline tokens are emitted as literal "\n".
  let normalizedText = text
    .replace(/\|\\n/g, "|\n")
    .replace(/\\n(?=\s*\|)/g, "\n");

  const rawLines = normalizedText.split(/\r?\n/);
  const result: string[] = [];
  let inFence = false;

  for (let index = 0; index < rawLines.length; index += 1) {
    const currentRaw = rawLines[index] ?? "";

    if (isFenceDelimiter(currentRaw)) {
      inFence = !inFence;
      result.push(currentRaw);
      continue;
    }

    if (inFence) {
      result.push(currentRaw);
      continue;
    }

    const currentLine = stripDanglingTrailingEmphasisMarker(
      normalizeEscapedPipesInTableLine(currentRaw)
    );
    const nextLine = normalizeEscapedPipesInTableLine(rawLines[index + 1] ?? "");
    const previousLine = result[result.length - 1] ?? "";

    if (
      isLikelyTableHeader(currentLine) &&
      isTableSeparator(nextLine) &&
      shouldInsertBlankLineBeforeTable(previousLine)
    ) {
      result.push("");
    }

    result.push(currentLine);
  }

  normalizedText = result.join("\n");
  return normalizedText;
}
