import { auth } from "@/app/(auth)/auth";
import {
  type AgentEngineErrorAnalysis,
  agentEngineErrorAnalysisSchema,
  agentEngineErrorAnalysisResponseSchema,
  type AgentEngineErrorAnalysisRequest,
} from "@/lib/agent-engine/error-analysis";
import { sanitizeAgentEngineErrorMessage } from "@/lib/agent-engine/error-envelope";
import { ChatSDKError } from "@/lib/errors";
import { agentEngineErrorAnalysisRequestSchema } from "./schema";

const DEFAULT_GEMINI_ERROR_ANALYSIS_MODEL = "gemini-3.1-pro-preview";

function extractGeminiText(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const record = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const firstCandidate = record.candidates?.[0];
  const parts = firstCandidate?.content?.parts;

  if (!Array.isArray(parts) || parts.length === 0) {
    return "";
  }

  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function unwrapCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (!fenceMatch?.[1]) {
    return trimmed;
  }

  return fenceMatch[1].trim();
}

function parseJsonObjectFromText(text: string): unknown {
  const directCandidate = unwrapCodeFence(text);

  try {
    return JSON.parse(directCandidate);
  } catch {
    // Try extracting first JSON object.
  }

  const firstBrace = directCandidate.indexOf("{");
  const lastBrace = directCandidate.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const jsonSlice = directCandidate.slice(firstBrace, lastBrace + 1).trim();
    return JSON.parse(jsonSlice);
  }

  throw new Error("Gemini nao retornou JSON valido para analise.");
}

function buildFallbackAnalysis(
  payload: AgentEngineErrorAnalysisRequest
): AgentEngineErrorAnalysis {
  return {
    diagnosisSummary:
      `Falha classificada como "${payload.reasonLabel}". A causa exata ` +
      "nao pode ser inferida automaticamente com confianca.",
    likelyCauses: [
      payload.reasonLabel,
      "Inconsistencia temporaria no stream do Vertex AI.",
      "Erro de configuracao/sessao entre frontend e Agent Engine.",
    ],
    recommendedActions: [
      `Correlacione o request_id "${payload.requestId}" nos logs do Agent Engine.`,
      "Verifique se o session_id do Vertex esta valido e consistente no fluxo.",
      "Execute novamente a consulta para confirmar se o erro e intermitente.",
    ],
    checksToRun: [
      "Conferir erros 4xx/5xx no streamQuery/query do Vertex.",
      "Validar se houve troca/expiracao de sessao durante a requisicao.",
      "Checar se houve resposta sem texto util (empty response).",
    ],
    confidence: "low",
  };
}

async function requestGeminiErrorAnalysis(
  payload: AgentEngineErrorAnalysisRequest
) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new ChatSDKError(
      "bad_request:agent_engine",
      "GOOGLE_GENERATIVE_AI_API_KEY is not configured."
    );
  }

  const model =
    process.env.GEMINI_ERROR_ANALYSIS_MODEL ||
    DEFAULT_GEMINI_ERROR_ANALYSIS_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = [
    "Voce e um engenheiro SRE especialista em Vertex AI Agent Engine.",
    "Analise o erro recebido e responda SOMENTE em JSON valido com este formato exato:",
    '{ "diagnosisSummary": string, "likelyCauses": string[], "recommendedActions": string[], "checksToRun": string[], "confidence": "low" | "medium" | "high" }',
    "Seja objetivo e tecnico. Nao inclua markdown.",
    "Contexto do erro (sanitizado):",
    JSON.stringify(payload),
  ].join("\n");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorText = sanitizeAgentEngineErrorMessage(await response.text(), 800);
    throw new ChatSDKError(
      "bad_request:agent_engine",
      `Gemini analysis request failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as unknown;
  const text = extractGeminiText(data);

  if (!text) {
    return buildFallbackAnalysis(payload);
  }

  try {
    const parsed = parseJsonObjectFromText(text);
    const validated = agentEngineErrorAnalysisSchema.safeParse(parsed);

    if (validated.success) {
      return validated.data;
    }
  } catch {
    // Keep fallback below.
  }

  return buildFallbackAnalysis(payload);
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    const requestBody = (await request.json()) as unknown;
    const parsedPayload =
      agentEngineErrorAnalysisRequestSchema.safeParse(requestBody);

    if (!parsedPayload.success) {
      const firstIssue = parsedPayload.error.issues[0]?.message ?? "Invalid request payload.";
      return new ChatSDKError("bad_request:api", firstIssue).toResponse();
    }

    const sanitizedPayload: AgentEngineErrorAnalysisRequest = {
      ...parsedPayload.data,
      message: sanitizeAgentEngineErrorMessage(parsedPayload.data.message),
    };

    const analysis = await requestGeminiErrorAnalysis(sanitizedPayload);
    const responsePayload = {
      model:
        process.env.GEMINI_ERROR_ANALYSIS_MODEL ||
        DEFAULT_GEMINI_ERROR_ANALYSIS_MODEL,
      analysis,
    };

    const validatedResponse =
      agentEngineErrorAnalysisResponseSchema.parse(responsePayload);

    return Response.json(validatedResponse, { status: 200 });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    return new ChatSDKError(
      "bad_request:agent_engine",
      sanitizeAgentEngineErrorMessage(
        error instanceof Error ? error.message : String(error),
        800
      )
    ).toResponse();
  }
}
