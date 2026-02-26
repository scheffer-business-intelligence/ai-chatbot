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

  const lineForMarkerCount =
    marker === "*" ? trimmedRight.replace(/^(\s*)\*\s+/, "$1") : trimmedRight;
  const markerRegex = new RegExp(`(?<!\\\\)\\${marker}`, "g");
  const markerCount = (lineForMarkerCount.match(markerRegex) ?? []).length;

  if (markerCount % 2 === 0) {
    return line;
  }

  const withoutTrailingMarker = trimmedRight.slice(0, -1);
  const trailingWhitespace = line.slice(trimmedRight.length);
  return `${withoutTrailingMarker}${trailingWhitespace}`;
}

function normalizeDanglingLabelEmphasis(line: string): string {
  const match = line.match(
    /^(\s*(?:(?:[-*+•▪])\s+|\d+[.)]\s+)?)(?:\*)([^*].*?)\s*$/
  );
  if (!match) {
    return line;
  }

  const [fullMatch, prefix, content] = match;
  const trimmedStart = line.trimStart();

  // Preserve regular unordered-list markdown lines (e.g. "* item").
  if (!prefix.trim() && /^\*\s+/.test(trimmedStart)) {
    return line;
  }

  // Apply only for label-style lines that usually come malformed from stream.
  if (!content.trim().endsWith(":")) {
    return line;
  }

  const trailingSegment = fullMatch.slice(prefix.length + 1);
  if (/(?<!\\)\*/.test(trailingSegment)) {
    return line;
  }

  return `${prefix}**${content.trim()}**`;
}

function escapeMarkdownInlineText(value: string): string {
  return value.replace(/([\\`*_[\]()])/g, "\\$1");
}

function isHorizontalRuleLine(line: string): boolean {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function getLastNonEmptyLineIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      return index;
    }
  }

  return -1;
}

function extractSourceText(line: string): string | null {
  const sourceMatch = line
    .trim()
    .match(
      /^(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__|\*|_)?\s*['"`]*\s*fonte\s*[:：]\s*(?:\*\*|__|\*|_)?\s*(.+)$/i
    );

  if (!sourceMatch) {
    return null;
  }

  const normalizedSourceText = sourceMatch[1]
    .replace(/^\d+\s*['.)-]\s*/, "")
    .replace(/^['"`]+/, "")
    .replace(/[*_`]+$/, "")
    .trim();

  return normalizedSourceText.length > 0 ? normalizedSourceText : null;
}

function normalizeTrailingSourceSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const lastNonEmptyIndex = getLastNonEmptyLineIndex(lines);

  if (lastNonEmptyIndex < 0) {
    return markdown;
  }

  const sourceText = extractSourceText(lines[lastNonEmptyIndex] ?? "");
  if (!sourceText) {
    return markdown;
  }

  const contentBeforeSource = lines.slice(0, lastNonEmptyIndex);
  const trailingLines = lines.slice(lastNonEmptyIndex + 1);
  const bodyLines = [...contentBeforeSource];

  while (bodyLines.length > 0 && !bodyLines.at(-1)?.trim()) {
    bodyLines.pop();
  }

  const lastBodyNonEmptyIndex = getLastNonEmptyLineIndex(bodyLines);
  const hasSeparator =
    lastBodyNonEmptyIndex >= 0 &&
    isHorizontalRuleLine(bodyLines[lastBodyNonEmptyIndex] ?? "");

  if (!hasSeparator && bodyLines.length > 0) {
    bodyLines.push("");
    bodyLines.push("---");
  }

  if (bodyLines.length > 0) {
    bodyLines.push("");
  }

  const escapedSourceText = escapeMarkdownInlineText(sourceText);

  return [...bodyLines, `*Fonte: ${escapedSourceText}*`, ...trailingLines].join(
    "\n"
  );
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
      normalizeDanglingLabelEmphasis(
        normalizeEscapedPipesInTableLine(currentRaw)
      )
    );
    const nextLine = normalizeEscapedPipesInTableLine(
      rawLines[index + 1] ?? ""
    );
    const previousLine = result.at(-1) ?? "";

    if (
      isLikelyTableHeader(currentLine) &&
      isTableSeparator(nextLine) &&
      shouldInsertBlankLineBeforeTable(previousLine)
    ) {
      result.push("");
    }

    result.push(currentLine);
  }

  normalizedText = normalizeTrailingSourceSection(result.join("\n"));
  return normalizedText;
}
