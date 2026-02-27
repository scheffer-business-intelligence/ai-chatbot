export const AGENT_ENGINE_ERROR_ENVELOPE_PREFIX = "AGENT_ENGINE_ERROR::";

export type AgentEngineErrorReasonCode =
  | "empty_vertex_response"
  | "vertex_http_error"
  | "vertex_connect_error"
  | "vertex_invalid_session"
  | "stream_parse_error"
  | "unknown_agent_engine_error";

export type AgentEngineErrorStage =
  | "request_setup"
  | "stream_open"
  | "stream_runtime"
  | "post_stream_empty"
  | "session_recovery"
  | "unknown";

export type AgentEngineErrorEnvelope = {
  provider: "google-agent-engine";
  requestId: string;
  reasonCode: AgentEngineErrorReasonCode;
  reasonLabel: string;
  message: string;
  modelId: string;
  sessionId?: string | null;
  stage: AgentEngineErrorStage;
  timestamp: string;
};

const INVALID_SESSION_STATE_MARKERS = [
  "invalid session",
  "session invalid",
  "session expired",
  "session not found",
  "session does not exist",
  "unknown session",
  "invalid_argument",
  "not_found",
  "failed_precondition",
];

const INVALID_SESSION_SCOPE_MARKERS = [
  "session_id",
  "session id",
  "\"session\"",
  "session",
];

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (!error || typeof error !== "object") {
    return "";
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function redactSensitiveData(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /AIza[0-9A-Za-z\-_]{20,}/g,
      "[REDACTED_GOOGLE_API_KEY]"
    )
    .replace(
      /\b(sk-[A-Za-z0-9]{12,}|rk-[A-Za-z0-9]{12,})\b/g,
      "[REDACTED_API_KEY]"
    )
    .replace(
      /("?(?:access_token|refresh_token|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^",\s}]+/gi,
      "$1[REDACTED]"
    );
}

export function sanitizeAgentEngineErrorMessage(
  rawMessage: string,
  maxLength = 1200
): string {
  const normalized = normalizeWhitespace(redactSensitiveData(rawMessage));

  if (!normalized) {
    return "Erro nao identificado no Agent Engine.";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function inferReasonFromText(errorText: string): {
  reasonCode: AgentEngineErrorReasonCode;
  reasonLabel: string;
  stage: AgentEngineErrorStage;
} {
  const normalized = errorText.toLowerCase();

  const hasSessionScope = INVALID_SESSION_SCOPE_MARKERS.some((marker) =>
    normalized.includes(marker)
  );
  const hasSessionState = INVALID_SESSION_STATE_MARKERS.some((marker) =>
    normalized.includes(marker)
  );

  if (hasSessionScope && hasSessionState) {
    return {
      reasonCode: "vertex_invalid_session",
      reasonLabel: "Sessao do Vertex invalida ou expirada",
      stage: "session_recovery",
    };
  }

  if (
    normalized.includes("returned an empty response") ||
    normalized.includes("retornou resposta vazia") ||
    normalized.includes("produced no text")
  ) {
    return {
      reasonCode: "empty_vertex_response",
      reasonLabel: "Vertex retornou resposta vazia",
      stage: "post_stream_empty",
    };
  }

  if (
    normalized.includes("vertex ai error:") ||
    normalized.includes("failed to create session:") ||
    normalized.includes("\"code\":400") ||
    normalized.includes("\"code\":404")
  ) {
    return {
      reasonCode: "vertex_http_error",
      reasonLabel: "Erro HTTP retornado pelo Vertex AI",
      stage: "stream_runtime",
    };
  }

  if (
    normalized.includes("failed to reach vertex") ||
    normalized.includes("econnreset") ||
    normalized.includes("fetch failed") ||
    normalized.includes("networkerror") ||
    normalized.includes("timed out")
  ) {
    return {
      reasonCode: "vertex_connect_error",
      reasonLabel: "Falha de conectividade com Vertex AI",
      stage: "stream_open",
    };
  }

  if (
    normalized.includes("no json parsed") ||
    normalized.includes("malformed") ||
    normalized.includes("parse")
  ) {
    return {
      reasonCode: "stream_parse_error",
      reasonLabel: "Falha ao interpretar stream de resposta",
      stage: "stream_runtime",
    };
  }

  return {
    reasonCode: "unknown_agent_engine_error",
    reasonLabel: "Erro desconhecido no Agent Engine",
    stage: "unknown",
  };
}

function normalizeStage(
  preferredStage: AgentEngineErrorStage | undefined,
  inferredStage: AgentEngineErrorStage
): AgentEngineErrorStage {
  if (
    preferredStage &&
    preferredStage !== "unknown" &&
    inferredStage !== "post_stream_empty"
  ) {
    return preferredStage;
  }

  return inferredStage;
}

export function buildAgentEngineErrorEnvelope({
  requestId,
  modelId,
  error,
  sessionId,
  stage,
}: {
  requestId: string;
  modelId: string;
  error: unknown;
  sessionId?: string | null;
  stage?: AgentEngineErrorStage;
}): string {
  const rawText = toErrorText(error);
  const inferred = inferReasonFromText(rawText);

  const envelope: AgentEngineErrorEnvelope = {
    provider: "google-agent-engine",
    requestId: requestId.trim() || "unknown-request-id",
    reasonCode: inferred.reasonCode,
    reasonLabel: inferred.reasonLabel,
    message: sanitizeAgentEngineErrorMessage(rawText),
    modelId: modelId.trim() || "unknown-model",
    sessionId: sessionId?.trim() || null,
    stage: normalizeStage(stage, inferred.stage),
    timestamp: new Date().toISOString(),
  };

  return `${AGENT_ENGINE_ERROR_ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
}

export function parseAgentEngineErrorEnvelope(
  value: unknown
): AgentEngineErrorEnvelope | null {
  if (typeof value !== "string") {
    return null;
  }

  if (!value.startsWith(AGENT_ENGINE_ERROR_ENVELOPE_PREFIX)) {
    return null;
  }

  const payload = value.slice(AGENT_ENGINE_ERROR_ENVELOPE_PREFIX.length).trim();
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<AgentEngineErrorEnvelope>;

    if (
      parsed.provider !== "google-agent-engine" ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.reasonCode !== "string" ||
      typeof parsed.reasonLabel !== "string" ||
      typeof parsed.message !== "string" ||
      typeof parsed.modelId !== "string" ||
      typeof parsed.stage !== "string" ||
      typeof parsed.timestamp !== "string"
    ) {
      return null;
    }

    return {
      provider: parsed.provider,
      requestId: parsed.requestId,
      reasonCode: parsed.reasonCode as AgentEngineErrorReasonCode,
      reasonLabel: parsed.reasonLabel,
      message: parsed.message,
      modelId: parsed.modelId,
      sessionId:
        typeof parsed.sessionId === "string" ? parsed.sessionId : parsed.sessionId ?? null,
      stage: parsed.stage as AgentEngineErrorStage,
      timestamp: parsed.timestamp,
    };
  } catch {
    return null;
  }
}

export function parseAgentEngineErrorFromUnknown(
  error: unknown
): AgentEngineErrorEnvelope | null {
  if (typeof error === "string") {
    return parseAgentEngineErrorEnvelope(error);
  }

  if (error instanceof Error) {
    const fromMessage = parseAgentEngineErrorEnvelope(error.message);
    if (fromMessage) {
      return fromMessage;
    }

    const fromCause = parseAgentEngineErrorEnvelope(
      (error as Error & { cause?: unknown }).cause
    );
    if (fromCause) {
      return fromCause;
    }
  }

  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeRecord = error as {
    cause?: unknown;
    message?: unknown;
    error?: unknown;
  };

  return (
    parseAgentEngineErrorEnvelope(maybeRecord.cause) ||
    parseAgentEngineErrorEnvelope(maybeRecord.message) ||
    parseAgentEngineErrorEnvelope(maybeRecord.error) ||
    null
  );
}
