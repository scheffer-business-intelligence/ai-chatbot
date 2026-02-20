import { type ChartSpecV1, chartSpecSchema } from "./schema";

const CHART_CONTEXT_TAG = "CHART_CONTEXT";

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
    const withoutDangling = text.replace(
      new RegExp(
        `(?:\\[\\s*${escapedTag}\\s*\\]|${escapedTag}\\])[\\s\\S]*$`,
        "i"
      ),
      ""
    );
    return {
      hasTag: true,
      payload: null,
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

export function parseChartContextFromText(text: string): ParsedChartContext {
  const { hasTag, payload, cleanedText } = extractContextBlock(
    text,
    CHART_CONTEXT_TAG
  );

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
      chartError: "Bloco CHART_CONTEXT incompleto.",
      hasChartContext: true,
    };
  }

  let parsedPayload: unknown;

  try {
    parsedPayload = JSON.parse(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "JSON invalido no CHART_CONTEXT";
    return {
      cleanText: cleanedText,
      chartSpec: null,
      chartError: `Nao foi possivel interpretar CHART_CONTEXT: ${message}`,
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
