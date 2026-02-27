import "server-only";

import type { ArtifactKind } from "@/components/artifact";
import { getServiceAccountAccessToken } from "@/lib/auth/service-account-token";
import type { BigQueryChatMessageRow } from "@/lib/gcp/bigquery";
import { upsertChatMessageRow } from "@/lib/gcp/bigquery";
import { ChatSDKError } from "../errors";
import { generateUUID } from "../utils";
import type {
  Chat,
  ChatProviderSession,
  DBMessage,
  Document,
  User,
  Vote,
} from "./schema";
import { generateHashedPassword } from "./utils";

const BQ_PROJECT_ID =
  process.env.BQ_PROJECT_ID || process.env.PROJECT_ID || "bi-scheffer";
const BQ_DATASET = process.env.BQ_DATASET || "scheffer_agente";
const BQ_BASE_URL = "https://bigquery.googleapis.com/bigquery/v2";
const BQ_MESSAGES_TABLE = process.env.BQ_MESSAGES_TABLE || "chat_messages";
const BQ_FILES_TABLE = process.env.BQ_FILES_TABLE || "chat_files";
const BQ_AUTO_CREATE_TABLES = process.env.BQ_AUTO_CREATE_TABLES === "true";
const BQ_REQUEST_MAX_ATTEMPTS = toPositiveInt(
  process.env.BQ_REQUEST_MAX_ATTEMPTS,
  3
);
const BQ_REQUEST_BASE_DELAY_MS = toPositiveInt(
  process.env.BQ_REQUEST_BASE_DELAY_MS,
  300
);
const BQ_REQUEST_MAX_DELAY_MS = toPositiveInt(
  process.env.BQ_REQUEST_MAX_DELAY_MS,
  3000
);
const BQ_RATE_LIMIT_COOLDOWN_MS = toPositiveInt(
  process.env.BQ_RATE_LIMIT_COOLDOWN_MS,
  30_000
);
const BQ_RATE_LIMIT_LOG_INTERVAL_MS = toPositiveInt(
  process.env.BQ_RATE_LIMIT_LOG_INTERVAL_MS,
  30_000
);

const RETRYABLE_BIGQUERY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_BIGQUERY_REASONS = new Set([
  "backenderror",
  "internalerror",
  "jobratelimitexceeded",
  "ratelimitexceeded",
  "resourcesexhausted",
  "timeout",
]);
const RATE_LIMIT_BIGQUERY_REASONS = new Set([
  "jobratelimitexceeded",
  "ratelimitexceeded",
  "resourcesexhausted",
]);
const RETRYABLE_BIGQUERY_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

const MESSAGES_TABLE_REF = `${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_MESSAGES_TABLE}`;
const FILES_TABLE_REF = `${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_FILES_TABLE}`;

const META_SESSION_PREFIX = "__meta__";
const META_USERS_SESSION = `${META_SESSION_PREFIX}users`;
const META_CHATS_SESSION = `${META_SESSION_PREFIX}chats`;
const META_PROVIDER_SESSION = `${META_SESSION_PREFIX}providers`;
const META_DOCUMENTS_SESSION = `${META_SESSION_PREFIX}documents`;
const CHAT_META_MESSAGE_PREFIX = "chat:";

export type VisibilityType = "private" | "public";

type BigQueryParameterType = "STRING" | "INT64" | "BOOL";

type BigQueryQueryParameter = {
  name: string;
  parameterType: { type: BigQueryParameterType };
  parameterValue: { value: string };
};

type BigQuerySchema = {
  fields: Array<{ name: string }>;
};

type BigQueryRow = {
  f: Array<{ v: string | null }>;
};

type GenericBigQueryRow = Record<string, string | null>;

type QueryParameter = {
  name: string;
  type: BigQueryParameterType;
  value: string | number | boolean;
};

type MetaChatPayload = {
  chatId: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
  createdAt: string;
  updatedAt: string;
};

type MetaProviderPayload = {
  chatId: string;
  provider: string;
  sessionId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

type MetaDocumentPayload = {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
  createdAt: string;
};

const TABLE_DDL_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS \`${MESSAGES_TABLE_REF}\` (
      message_id STRING,
      session_id STRING,
      chat_id STRING,
      user_id STRING,
      role STRING,
      content STRING,
      created_at STRING,
      updated_at STRING,
      parts_json STRING,
      attachments_json STRING,
      chart_spec_json STRING,
      chart_error STRING,
      answered_in INT64,
      visibility STRING,
      is_deleted BOOL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS \`${FILES_TABLE_REF}\` (
      file_id STRING,
      session_id STRING,
      user_id STRING,
      chat_id STRING,
      message_id STRING,
      filename STRING,
      content_type STRING,
      file_size INT64,
      gcs_url STRING,
      object_path STRING,
      created_at STRING,
      is_deleted BOOL
    )
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS message_id STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS session_id STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS chat_id STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS user_id STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS role STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS content STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS created_at STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS updated_at STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS parts_json STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS attachments_json STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS chart_spec_json STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS chart_error STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS answered_in INT64
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS visibility STRING
  `,
  `
    ALTER TABLE \`${MESSAGES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS is_deleted BOOL
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS file_id STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS session_id STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS user_id STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS chat_id STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS message_id STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS filename STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS content_type STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS file_size INT64
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS gcs_url STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS object_path STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS created_at STRING
  `,
  `
    ALTER TABLE \`${FILES_TABLE_REF}\`
    ADD COLUMN IF NOT EXISTS is_deleted BOOL
  `,
];

let ensureTablesPromise: Promise<void> | null = null;
let tablesEnsured = false;
let autoCreateDisabled = false;
let bqRateLimitCooldownUntilMs = 0;
let bqRateLimitLastLoggedAtMs = 0;
const CHATS_QUERY_FALLBACK_LOG_COOLDOWN_MS = 5 * 60_000;
let lastChatsQueryFallbackLogAtMs = 0;
const CHAT_BY_ID_ERROR_LOG_COOLDOWN_MS = 60_000;
let lastChatByIdErrorLogAtMs = 0;
const MESSAGE_BY_ID_ERROR_LOG_COOLDOWN_MS = 60_000;
let lastMessageByIdErrorLogAtMs = 0;

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number) {
  const exponential = BQ_REQUEST_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * BQ_REQUEST_BASE_DELAY_MS);
  return Math.min(exponential + jitter, BQ_REQUEST_MAX_DELAY_MS);
}

function extractBigQueryErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const typedError = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof typedError.code === "string") {
    return typedError.code;
  }

  if (typedError.cause && typeof typedError.cause.code === "string") {
    return typedError.cause.code;
  }

  return undefined;
}

function isRetryableBigQueryNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  const code = extractBigQueryErrorCode(error);
  return Boolean(code && RETRYABLE_BIGQUERY_NETWORK_CODES.has(code));
}

function normalizeBigQueryReason(value: string | undefined): string {
  return (value ?? "unknown").trim().toLowerCase();
}

function parseBigQueryErrorResponse(status: number, errorText: string) {
  let message = errorText;
  let reason = "unknown";

  try {
    const parsed = JSON.parse(errorText) as {
      error?: {
        message?: unknown;
        status?: unknown;
        errors?: Array<{ reason?: unknown }>;
      };
    };

    if (typeof parsed.error?.message === "string" && parsed.error.message) {
      message = parsed.error.message;
    }

    const firstReason = parsed.error?.errors?.[0]?.reason;
    if (typeof firstReason === "string" && firstReason) {
      reason = firstReason;
    } else if (
      typeof parsed.error?.status === "string" &&
      parsed.error.status
    ) {
      reason = parsed.error.status;
    }
  } catch {
    // Keep raw text when payload is not JSON.
  }

  return {
    status,
    reason: normalizeBigQueryReason(reason),
    message,
  };
}

function isRetryableBigQueryError(status: number, reason: string): boolean {
  if (RETRYABLE_BIGQUERY_STATUSES.has(status)) {
    return true;
  }

  return RETRYABLE_BIGQUERY_REASONS.has(normalizeBigQueryReason(reason));
}

function isBigQueryRateLimitReason(reason: string): boolean {
  return RATE_LIMIT_BIGQUERY_REASONS.has(normalizeBigQueryReason(reason));
}

class BigQueryRequestError extends Error {
  statusCode: number;
  reason: string;
  retryable: boolean;

  constructor({
    statusCode,
    reason,
    message,
    retryable,
  }: {
    statusCode: number;
    reason: string;
    message: string;
    retryable: boolean;
  }) {
    super(message);
    this.name = "BigQueryRequestError";
    this.statusCode = statusCode;
    this.reason = reason;
    this.retryable = retryable;
  }
}

function buildQueryParameters(
  params: QueryParameter[]
): BigQueryQueryParameter[] {
  return params.map((param) => ({
    name: param.name,
    parameterType: { type: param.type },
    parameterValue: { value: String(param.value) },
  }));
}

function mapRows(
  rows: BigQueryRow[] | undefined,
  schema: BigQuerySchema | undefined
): GenericBigQueryRow[] {
  if (!rows || !schema) {
    return [];
  }

  return rows.map((row) => {
    const mapped: GenericBigQueryRow = {};

    row.f.forEach((cell, index) => {
      const fieldName = schema.fields[index]?.name;
      if (fieldName) {
        mapped[fieldName] = cell.v ?? null;
      }
    });

    return mapped;
  });
}

function mapResponseRows(
  response: Record<string, unknown>
): GenericBigQueryRow[] {
  return mapRows(
    response.rows as BigQueryRow[] | undefined,
    response.schema as BigQuerySchema | undefined
  );
}

function parseIntOrZero(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value: string | null | undefined): Date {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function toIsoString(date: Date | string): string {
  if (date instanceof Date) {
    return Number.isNaN(date.getTime())
      ? new Date().toISOString()
      : date.toISOString();
  }

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function normalizeVisibility(value: string | null | undefined): VisibilityType {
  return value === "public" ? "public" : "private";
}

function parseJsonOrFallback<T>(
  value: string | null | undefined,
  fallback: T
): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMetaSessionId(sessionId: string | null | undefined): boolean {
  return (sessionId ?? "").startsWith(META_SESSION_PREFIX);
}

function extractTextFromParts(parts: DBMessage["parts"]): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .filter((part): part is { type?: unknown; text?: unknown } =>
      Boolean(part && typeof part === "object")
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
    .filter((part) => part.length > 0)
    .join("\n");
}

function stripPrefix(value: string | null | undefined, prefix: string): string {
  if (!value) {
    return "";
  }

  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function buildMetaRow({
  messageId,
  sessionId,
  userId,
  content,
  payload,
  createdAt,
  updatedAt,
  visibility,
}: {
  messageId: string;
  sessionId: string;
  userId: string;
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  visibility?: VisibilityType | null;
}): BigQueryChatMessageRow {
  return {
    message_id: messageId,
    session_id: sessionId,
    chat_id: sessionId,
    user_id: userId,
    role: "system",
    content,
    created_at: createdAt,
    updated_at: updatedAt ?? new Date().toISOString(),
    parts_json: JSON.stringify(payload),
    attachments_json: "[]",
    chart_spec_json: null,
    chart_error: null,
    answered_in: null,
    visibility: visibility ?? null,
    is_deleted: false,
  };
}

function mapMessageRowToDbMessage(row: GenericBigQueryRow): DBMessage {
  const fallbackParts = row.content
    ? ([{ type: "text", text: row.content }] as DBMessage["parts"])
    : ([] as DBMessage["parts"]);

  const parts = parseJsonOrFallback<DBMessage["parts"]>(
    row.parts_json,
    fallbackParts
  );

  return {
    id: row.message_id ?? "",
    chatId: row.chat_id ?? row.session_id ?? "",
    role: (row.role ?? "assistant") as DBMessage["role"],
    parts,
    attachments: parseJsonOrFallback<DBMessage["attachments"]>(
      row.attachments_json,
      [] as DBMessage["attachments"]
    ),
    chartSpec: parseJsonOrFallback<DBMessage["chartSpec"]>(
      row.chart_spec_json,
      null as DBMessage["chartSpec"]
    ),
    chartError: row.chart_error,
    createdAt: parseDate(row.created_at),
  };
}

function toBigQueryMessageRow({
  message,
  userId,
  sessionId,
  visibility,
}: {
  message: DBMessage;
  userId: string;
  sessionId: string;
  visibility: VisibilityType;
}): BigQueryChatMessageRow {
  const createdAt = toIsoString(message.createdAt);

  return {
    message_id: message.id,
    session_id: sessionId,
    chat_id: message.chatId,
    user_id: userId,
    role: message.role,
    content: extractTextFromParts(message.parts),
    created_at: createdAt,
    updated_at: new Date().toISOString(),
    parts_json: JSON.stringify(message.parts ?? []),
    attachments_json: JSON.stringify(message.attachments ?? []),
    chart_spec_json:
      message.chartSpec === null || message.chartSpec === undefined
        ? null
        : JSON.stringify(message.chartSpec),
    chart_error: message.chartError ?? null,
    answered_in: null,
    visibility,
    is_deleted: false,
  };
}

function mapChatMetaRowToChat(row: GenericBigQueryRow): Chat | null {
  const rawPayload = parseJsonOrFallback<unknown>(row.parts_json, {});
  const payload = isRecord(rawPayload)
    ? (rawPayload as Partial<MetaChatPayload>)
    : {};

  const id =
    (typeof payload.chatId === "string" && payload.chatId) ||
    stripPrefix(row.message_id, "chat:");
  const userId =
    (typeof payload.userId === "string" && payload.userId) || row.user_id || "";

  if (!id || !userId) {
    return null;
  }

  const title =
    (typeof payload.title === "string" && payload.title) ||
    row.content ||
    "Nova Conversa";
  const visibility =
    typeof payload.visibility === "string"
      ? normalizeVisibility(payload.visibility)
      : normalizeVisibility(row.visibility);
  const createdAt =
    typeof payload.createdAt === "string"
      ? parseDate(payload.createdAt)
      : parseDate(row.created_at);

  return {
    id,
    userId,
    title,
    visibility,
    createdAt,
  };
}

async function bigQueryRequest(
  accessToken: string,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const now = Date.now();

  if (now < bqRateLimitCooldownUntilMs) {
    const remainingMs = bqRateLimitCooldownUntilMs - now;

    if (now - bqRateLimitLastLoggedAtMs >= BQ_RATE_LIMIT_LOG_INTERVAL_MS) {
      bqRateLimitLastLoggedAtMs = now;
      console.warn(
        `BigQuery rate-limit cooldown active for ${remainingMs}ms. Skipping request.`
      );
    }

    throw new BigQueryRequestError({
      statusCode: 429,
      reason: "jobratelimitexceeded",
      message: `BigQuery rate-limit cooldown active (${remainingMs}ms remaining).`,
      retryable: true,
    });
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= BQ_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    let shouldRetry = false;

    try {
      const response = await fetch(`${BQ_BASE_URL}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }

      const errorText = await response.text();
      const parsedError = parseBigQueryErrorResponse(
        response.status,
        errorText
      );
      const retryable = isRetryableBigQueryError(
        parsedError.status,
        parsedError.reason
      );

      if (isBigQueryRateLimitReason(parsedError.reason)) {
        bqRateLimitCooldownUntilMs = Date.now() + BQ_RATE_LIMIT_COOLDOWN_MS;

        const logNow = Date.now();
        if (
          logNow - bqRateLimitLastLoggedAtMs >=
          BQ_RATE_LIMIT_LOG_INTERVAL_MS
        ) {
          bqRateLimitLastLoggedAtMs = logNow;
          console.warn(
            "BigQuery rate limit detected. Entering cooldown window.",
            {
              reason: parsedError.reason,
              cooldownMs: BQ_RATE_LIMIT_COOLDOWN_MS,
            }
          );
        }
      }

      const requestError = new BigQueryRequestError({
        statusCode: parsedError.status,
        reason: parsedError.reason,
        message: `BigQuery error: ${parsedError.status} - ${parsedError.message}`,
        retryable,
      });

      lastError = requestError;
      shouldRetry = requestError.retryable && attempt < BQ_REQUEST_MAX_ATTEMPTS;

      if (!shouldRetry) {
        throw requestError;
      }
    } catch (error) {
      if (error instanceof BigQueryRequestError) {
        if (error.retryable && attempt < BQ_REQUEST_MAX_ATTEMPTS) {
          lastError = error;
          shouldRetry = true;
        } else {
          throw error;
        }
      } else if (isRetryableBigQueryNetworkError(error)) {
        lastError = error;
        shouldRetry = attempt < BQ_REQUEST_MAX_ATTEMPTS;
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`BigQuery request failed: ${reason}`);
      }
    }

    if (shouldRetry) {
      await delay(computeBackoffDelayMs(attempt));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("BigQuery request failed after retries.");
}

async function runQueryRaw(
  accessToken: string,
  query: string,
  params: QueryParameter[] = []
): Promise<Record<string, unknown>> {
  return await bigQueryRequest(
    accessToken,
    `projects/${BQ_PROJECT_ID}/queries`,
    {
      query,
      useLegacySql: false,
      ...(params.length > 0
        ? {
            parameterMode: "NAMED",
            queryParameters: buildQueryParameters(params),
          }
        : {}),
    }
  );
}

export async function ensureBigQueryTables(accessToken?: string) {
  if (!BQ_AUTO_CREATE_TABLES || tablesEnsured || autoCreateDisabled) {
    return;
  }

  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      const token = accessToken ?? (await getServiceAccountAccessToken());

      for (const ddl of TABLE_DDL_STATEMENTS) {
        await runQueryRaw(token, ddl);
      }

      tablesEnsured = true;
    })();
  }

  try {
    await ensureTablesPromise;
  } catch (error) {
    autoCreateDisabled = true;
    console.warn(
      "BigQuery auto-create tables disabled after failure. Ensure tables exist manually.",
      error
    );
  } finally {
    ensureTablesPromise = null;
  }
}

async function runQuery(
  query: string,
  params: QueryParameter[] = []
): Promise<Record<string, unknown>> {
  const accessToken = await getServiceAccountAccessToken();
  return await runQueryRaw(accessToken, query, params);
}

async function queryRows(
  query: string,
  params: QueryParameter[] = [],
  fallbackQuery?: string
): Promise<GenericBigQueryRow[]> {
  try {
    const response = await runQuery(query, params);
    return mapResponseRows(response);
  } catch (error) {
    const shouldSkipFallback =
      error instanceof BigQueryRequestError &&
      (isBigQueryRateLimitReason(error.reason) || error.statusCode === 429);

    if (!fallbackQuery || shouldSkipFallback) {
      throw error;
    }

    const response = await runQuery(fallbackQuery, params);
    return mapResponseRows(response);
  }
}

async function upsertMetaMessage(row: BigQueryChatMessageRow) {
  const accessToken = await getServiceAccountAccessToken();
  await upsertChatMessageRow(accessToken, row);
}

async function getChatMetaById(chatId: string): Promise<Chat | null> {
  const rows = await queryRows(
    `
      SELECT
        message_id,
        user_id,
        content,
        parts_json,
        visibility,
        created_at
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE message_id = @message_id
        AND role = 'system'
        AND (session_id = @chat_session_id OR session_id = @legacy_session_id)
        AND (is_deleted IS NULL OR is_deleted = FALSE)
      LIMIT 1
    `,
    [
      { name: "chat_session_id", type: "STRING", value: chatId },
      { name: "legacy_session_id", type: "STRING", value: META_CHATS_SESSION },
      { name: "message_id", type: "STRING", value: `chat:${chatId}` },
    ],
    `
      SELECT
        message_id,
        user_id,
        content,
        parts_json,
        NULL AS visibility,
        created_at
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE message_id = @message_id
        AND role = 'system'
        AND (session_id = @chat_session_id OR session_id = @legacy_session_id)
      LIMIT 1
    `
  );

  const mapped = rows[0] ? mapChatMetaRowToChat(rows[0]) : null;
  return mapped;
}

async function getFallbackChatFromMessages(
  chatId: string
): Promise<Chat | null> {
  const rows = await queryRows(
    `
      SELECT
        COALESCE(chat_id, session_id) AS chat_id,
        ANY_VALUE(user_id) AS user_id,
        MIN(created_at) AS created_at,
        ANY_VALUE(visibility) AS visibility,
        ARRAY_AGG(
          IF(role = 'user', content, NULL)
          IGNORE NULLS
          ORDER BY SAFE_CAST(created_at AS TIMESTAMP)
          LIMIT 1
        )[SAFE_OFFSET(0)] AS title
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE (chat_id = @chat_id OR (chat_id IS NULL AND session_id = @chat_id))
        AND (is_deleted IS NULL OR is_deleted = FALSE)
      GROUP BY COALESCE(chat_id, session_id)
      LIMIT 1
    `,
    [{ name: "chat_id", type: "STRING", value: chatId }],
    `
      SELECT
        session_id AS chat_id,
        ANY_VALUE(user_id) AS user_id,
        MIN(created_at) AS created_at,
        NULL AS visibility,
        ARRAY_AGG(
          IF(role = 'user', content, NULL)
          IGNORE NULLS
          ORDER BY created_at
          LIMIT 1
        )[SAFE_OFFSET(0)] AS title
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE session_id = @chat_id
      GROUP BY session_id
      LIMIT 1
    `
  );

  const row = rows[0];

  if (!row?.chat_id || isMetaSessionId(row.chat_id)) {
    return null;
  }

  return {
    id: row.chat_id,
    userId: row.user_id ?? "",
    title: row.title ?? "Nova Conversa",
    visibility: normalizeVisibility(row.visibility),
    createdAt: parseDate(row.created_at),
  };
}

async function getSessionMetadata(chatId: string) {
  const chat = await getChatById({ id: chatId });

  if (chat) {
    return {
      userId: chat.userId,
      visibility: chat.visibility,
    };
  }

  const rows = await queryRows(
    `
      SELECT
        user_id,
        visibility
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE (chat_id = @chat_id OR (chat_id IS NULL AND session_id = @chat_id))
        AND (is_deleted IS NULL OR is_deleted = FALSE)
      ORDER BY SAFE_CAST(created_at AS TIMESTAMP) DESC
      LIMIT 1
    `,
    [{ name: "chat_id", type: "STRING", value: chatId }],
    `
      SELECT
        user_id,
        NULL AS visibility
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE session_id = @chat_id
      ORDER BY created_at DESC
      LIMIT 1
    `
  );

  const row = rows[0];
  if (!row?.user_id) {
    return null;
  }

  return {
    userId: row.user_id,
    visibility: normalizeVisibility(row.visibility),
  };
}

function mapDocumentRow(row: GenericBigQueryRow): Document | null {
  const rawPayload = parseJsonOrFallback<unknown>(row.parts_json, {});
  const payload = isRecord(rawPayload)
    ? (rawPayload as Partial<MetaDocumentPayload>)
    : {};

  const id =
    (typeof payload.id === "string" && payload.id) ||
    stripPrefix(row.message_id, "doc:").split(":")[0] ||
    "";
  const userId =
    (typeof payload.userId === "string" && payload.userId) || row.user_id || "";

  if (!id || !userId) {
    return null;
  }

  const title =
    (typeof payload.title === "string" && payload.title) ||
    row.content ||
    "Documento";
  const kind = (typeof payload.kind === "string" && payload.kind) || "text";
  const content =
    (typeof payload.content === "string" && payload.content) || "";
  const createdAt =
    typeof payload.createdAt === "string"
      ? parseDate(payload.createdAt)
      : parseDate(row.created_at);

  return {
    id,
    createdAt,
    title,
    content,
    kind: kind as ArtifactKind,
    userId,
  };
}

export async function getUser(email: string): Promise<User[]> {
  try {
    const rows = await queryRows(
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND role = 'system'
          AND content = @email
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        ORDER BY SAFE_CAST(created_at AS TIMESTAMP) DESC
      `,
      [
        { name: "session_id", type: "STRING", value: META_USERS_SESSION },
        { name: "email", type: "STRING", value: email },
      ],
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND role = 'system'
          AND content = @email
        ORDER BY created_at DESC
      `
    );

    const users: User[] = [];

    for (const row of rows) {
      const payload = parseJsonOrFallback<Record<string, unknown>>(
        row.parts_json,
        {}
      );

      const id =
        row.user_id ||
        (typeof payload.userId === "string" ? payload.userId : "") ||
        stripPrefix(row.message_id, "user:");

      if (!id || !row.content) {
        continue;
      }

      users.push({
        id,
        email: row.content,
        password:
          typeof payload.password === "string" ? payload.password : null,
      });
    }

    return users;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const userId = generateUUID();
  const now = new Date().toISOString();
  const hashedPassword = generateHashedPassword(password);

  try {
    await upsertMetaMessage(
      buildMetaRow({
        messageId: `user:${userId}`,
        sessionId: META_USERS_SESSION,
        userId,
        content: email,
        payload: {
          userId,
          email,
          password: hashedPassword,
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
      })
    );

    return [{ id: userId, email }];
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to create user");
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  const now = new Date().toISOString();

  try {
    const existingChat = await getChatMetaById(id);

    const payload: MetaChatPayload = {
      chatId: id,
      userId,
      title,
      visibility,
      createdAt: existingChat ? toIsoString(existingChat.createdAt) : now,
      updatedAt: now,
    };

    await upsertMetaMessage(
      buildMetaRow({
        messageId: `chat:${id}`,
        sessionId: id,
        userId,
        content: title,
        payload,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        visibility,
      })
    );
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save chat");
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    const chat = await getChatById({ id });

    try {
      await runQuery(
        `
          DELETE FROM \`${MESSAGES_TABLE_REF}\`
          WHERE (chat_id = @chat_id OR (chat_id IS NULL AND session_id = @chat_id))
        `,
        [{ name: "chat_id", type: "STRING", value: id }]
      );
    } catch {
      await runQuery(
        `
          DELETE FROM \`${MESSAGES_TABLE_REF}\`
          WHERE session_id = @chat_id
        `,
        [{ name: "chat_id", type: "STRING", value: id }]
      );
    }

    await runQuery(
      `
        DELETE FROM \`${MESSAGES_TABLE_REF}\`
        WHERE STARTS_WITH(message_id, @provider_prefix)
          AND (session_id = @chat_id OR session_id = @provider_session)
      `,
      [
        {
          name: "provider_prefix",
          type: "STRING",
          value: `provider:${id}:`,
        },
        { name: "chat_id", type: "STRING", value: id },
        {
          name: "provider_session",
          type: "STRING",
          value: META_PROVIDER_SESSION,
        },
      ]
    );

    await runQuery(
      `
        DELETE FROM \`${MESSAGES_TABLE_REF}\`
        WHERE message_id = @message_id
          AND role = 'system'
          AND (session_id = @chat_id OR session_id = @chats_session)
      `,
      [
        { name: "chat_id", type: "STRING", value: id },
        { name: "chats_session", type: "STRING", value: META_CHATS_SESSION },
        { name: "message_id", type: "STRING", value: `chat:${id}` },
      ]
    );

    return chat;
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  const rows = await queryRows(
    `
      SELECT
        message_id
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE STARTS_WITH(message_id, @chat_prefix)
        AND role = 'system'
        AND user_id = @user_id
        AND (is_deleted IS NULL OR is_deleted = FALSE)
    `,
    [
      { name: "chat_prefix", type: "STRING", value: CHAT_META_MESSAGE_PREFIX },
      { name: "user_id", type: "STRING", value: userId },
    ],
    `
      SELECT
        message_id
      FROM \`${MESSAGES_TABLE_REF}\`
      WHERE STARTS_WITH(message_id, @chat_prefix)
        AND role = 'system'
        AND user_id = @user_id
    `
  );

  const chatIds = rows
    .map((row) => stripPrefix(row.message_id, "chat:"))
    .filter((chatId) => chatId.length > 0);

  if (chatIds.length === 0) {
    return { deletedCount: 0 };
  }

  let deletedCount = 0;
  const failedChatIds: string[] = [];

  for (const chatId of chatIds) {
    try {
      await deleteChatById({ id: chatId });
      deletedCount += 1;
    } catch (error) {
      failedChatIds.push(chatId);
      console.warn(
        "Failed to delete chat while deleting all chats by user id.",
        {
          userId,
          chatId,
          error,
        }
      );
    }
  }

  if (deletedCount === 0 && failedChatIds.length > 0) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }

  return { deletedCount };
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    let cursorCreatedAt: string | null = null;
    let cursorOperator: ">" | "<" | null = null;

    if (startingAfter || endingBefore) {
      const cursorId = startingAfter ?? endingBefore;
      const cursorChat = await getChatById({ id: cursorId ?? "" });

      if (!cursorChat) {
        throw new ChatSDKError(
          "not_found:database",
          `Chat with id ${cursorId} not found`
        );
      }

      cursorCreatedAt = cursorChat.createdAt.toISOString();
      cursorOperator = startingAfter ? ">" : "<";
    }

    const metaRows = await queryRows(
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          visibility,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE STARTS_WITH(message_id, @chat_prefix)
          AND role = 'system'
          AND user_id = @user_id
          AND (is_deleted IS NULL OR is_deleted = FALSE)
          ${cursorOperator ? `AND SAFE_CAST(created_at AS TIMESTAMP) ${cursorOperator} SAFE_CAST(@cursor_created_at AS TIMESTAMP)` : ""}
        ORDER BY SAFE_CAST(created_at AS TIMESTAMP) DESC
        LIMIT @limit
      `,
      [
        {
          name: "chat_prefix",
          type: "STRING",
          value: CHAT_META_MESSAGE_PREFIX,
        },
        { name: "user_id", type: "STRING", value: id },
        ...(cursorCreatedAt
          ? [
              {
                name: "cursor_created_at",
                type: "STRING" as const,
                value: cursorCreatedAt,
              },
            ]
          : []),
        { name: "limit", type: "INT64", value: extendedLimit },
      ],
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          NULL AS visibility,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE STARTS_WITH(message_id, @chat_prefix)
          AND role = 'system'
          AND user_id = @user_id
          ${cursorOperator ? `AND created_at ${cursorOperator} @cursor_created_at` : ""}
        ORDER BY created_at DESC
        LIMIT @limit
      `
    );

    const mappedMetaChats = metaRows
      .map(mapChatMetaRowToChat)
      .filter((chat): chat is Chat => Boolean(chat));

    if (mappedMetaChats.length > 0) {
      const hasMore = mappedMetaChats.length > limit;
      return {
        chats: hasMore ? mappedMetaChats.slice(0, limit) : mappedMetaChats,
        hasMore,
      };
    }

    const derivedRows = await queryRows(
      `
        SELECT
          COALESCE(chat_id, session_id) AS id,
          ANY_VALUE(user_id) AS user_id,
          MIN(created_at) AS created_at,
          NULL AS visibility,
          ARRAY_AGG(
            IF(role = 'user', content, NULL)
            IGNORE NULLS
            ORDER BY SAFE_CAST(created_at AS TIMESTAMP)
            LIMIT 1
          )[SAFE_OFFSET(0)] AS title
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE user_id = @user_id
          AND NOT STARTS_WITH(COALESCE(chat_id, session_id), @meta_prefix)
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        GROUP BY COALESCE(chat_id, session_id)
        ${cursorOperator ? `HAVING MIN(SAFE_CAST(created_at AS TIMESTAMP)) ${cursorOperator} SAFE_CAST(@cursor_created_at AS TIMESTAMP)` : ""}
        ORDER BY MIN(SAFE_CAST(created_at AS TIMESTAMP)) DESC
        LIMIT @limit
      `,
      [
        { name: "user_id", type: "STRING", value: id },
        { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
        ...(cursorCreatedAt
          ? [
              {
                name: "cursor_created_at",
                type: "STRING" as const,
                value: cursorCreatedAt,
              },
            ]
          : []),
        { name: "limit", type: "INT64", value: extendedLimit },
      ],
      `
        SELECT
          session_id AS id,
          ANY_VALUE(user_id) AS user_id,
          MIN(created_at) AS created_at,
          NULL AS visibility,
          ARRAY_AGG(
            IF(role = 'user', content, NULL)
            IGNORE NULLS
            ORDER BY created_at
            LIMIT 1
          )[SAFE_OFFSET(0)] AS title
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE user_id = @user_id
          AND NOT STARTS_WITH(session_id, @meta_prefix)
        GROUP BY session_id
        ${cursorOperator ? `HAVING MIN(created_at) ${cursorOperator} @cursor_created_at` : ""}
        ORDER BY MIN(created_at) DESC
        LIMIT @limit
      `
    );

    const derivedChats = derivedRows
      .map((row) => {
        if (!row.id || isMetaSessionId(row.id)) {
          return null;
        }

        return {
          id: row.id,
          userId: row.user_id ?? "",
          title: row.title ?? "Nova Conversa",
          visibility: normalizeVisibility(row.visibility),
          createdAt: parseDate(row.created_at),
        } satisfies Chat;
      })
      .filter((chat): chat is Chat => Boolean(chat));

    const hasMore = derivedChats.length > limit;

    return {
      chats: hasMore ? derivedChats.slice(0, limit) : derivedChats,
      hasMore,
    };
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }

    const now = Date.now();
    if (
      process.env.NODE_ENV === "production" &&
      now - lastChatsQueryFallbackLogAtMs >=
        CHATS_QUERY_FALLBACK_LOG_COOLDOWN_MS
    ) {
      lastChatsQueryFallbackLogAtMs = now;
      console.warn(
        "Failed to get chats by user id from BigQuery. Returning empty history list.",
        error
      );
    }

    return {
      chats: [],
      hasMore: false,
    };
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const metaChat = await getChatMetaById(id);
    if (metaChat) {
      return metaChat;
    }

    return await getFallbackChatFromMessages(id);
  } catch (error) {
    const now = Date.now();
    if (now - lastChatByIdErrorLogAtMs >= CHAT_BY_ID_ERROR_LOG_COOLDOWN_MS) {
      lastChatByIdErrorLogAtMs = now;
      console.warn("Failed to get chat by id from BigQuery.", { id, error });
    }
    return null;
  }
}

export async function getProviderSessionByChatId({
  chatId,
  provider,
}: {
  chatId: string;
  provider: string;
}): Promise<ChatProviderSession | null> {
  try {
    const messageId = `provider:${chatId}:${encodeURIComponent(provider)}`;

    const rows = await queryRows(
      `
        SELECT
          message_id,
          user_id,
          content,
          '{}' AS parts_json,
          created_at,
          updated_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE (session_id = @chat_session_id OR session_id = @legacy_session_id)
          AND message_id = @message_id
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        LIMIT 1
      `,
      [
        { name: "chat_session_id", type: "STRING", value: chatId },
        {
          name: "legacy_session_id",
          type: "STRING",
          value: META_PROVIDER_SESSION,
        },
        { name: "message_id", type: "STRING", value: messageId },
      ],
      `
        SELECT
          message_id,
          user_id,
          content,
          '{}' AS parts_json,
          created_at,
          updated_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE (session_id = @chat_session_id OR session_id = @legacy_session_id)
          AND message_id = @message_id
        LIMIT 1
      `
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    const rawPayload = parseJsonOrFallback<unknown>(row.parts_json, {});
    const payload = isRecord(rawPayload)
      ? (rawPayload as Partial<MetaProviderPayload>)
      : {};

    const sessionId =
      (typeof payload.sessionId === "string" && payload.sessionId) ||
      row.content ||
      "";
    const userId =
      (typeof payload.userId === "string" && payload.userId) ||
      row.user_id ||
      "";

    if (!sessionId || !userId) {
      return null;
    }

    return {
      chatId,
      provider,
      sessionId,
      userId,
      createdAt:
        typeof payload.createdAt === "string"
          ? parseDate(payload.createdAt)
          : parseDate(row.created_at),
      updatedAt:
        typeof payload.updatedAt === "string"
          ? parseDate(payload.updatedAt)
          : parseDate(row.updated_at ?? row.created_at),
    };
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get provider session by chat id"
    );
  }
}

export async function upsertProviderSession({
  chatId,
  provider,
  sessionId,
  userId,
}: {
  chatId: string;
  provider: string;
  sessionId: string;
  userId: string;
}) {
  try {
    const now = new Date().toISOString();
    const existing = await getProviderSessionByChatId({ chatId, provider });

    const payload: MetaProviderPayload = {
      chatId,
      provider,
      sessionId,
      userId,
      createdAt: existing ? toIsoString(existing.createdAt) : now,
      updatedAt: now,
    };

    await upsertMetaMessage(
      buildMetaRow({
        messageId: `provider:${chatId}:${encodeURIComponent(provider)}`,
        sessionId: chatId,
        userId,
        content: sessionId,
        payload,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      })
    );
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to upsert provider session"
    );
  }
}

export async function saveMessages({
  messages,
  sessionId,
}: {
  messages: DBMessage[];
  sessionId: string;
}) {
  try {
    if (!sessionId.trim()) {
      throw new ChatSDKError(
        "bad_request:database",
        "Missing session id for message persistence"
      );
    }

    const dedupedMessages = Array.from(
      new Map(
        messages.map((currentMessage) => [currentMessage.id, currentMessage])
      ).values()
    );

    const accessToken = await getServiceAccountAccessToken();

    const metadataCache = new Map<
      string,
      Promise<{ userId: string; visibility: VisibilityType } | null>
    >();

    for (const message of dedupedMessages) {
      if (!metadataCache.has(message.chatId)) {
        metadataCache.set(message.chatId, getSessionMetadata(message.chatId));
      }

      const metadata = await metadataCache.get(message.chatId);

      if (!metadata?.userId) {
        throw new ChatSDKError(
          "bad_request:database",
          `Failed to resolve chat owner for chat ${message.chatId}`
        );
      }

      const row = toBigQueryMessageRow({
        message,
        userId: metadata.userId,
        sessionId,
        visibility: metadata.visibility,
      });

      await upsertChatMessageRow(accessToken, row);
    }
  } catch (error) {
    console.error("saveMessages error:", error);

    if (error instanceof ChatSDKError) {
      throw error;
    }

    throw new ChatSDKError("bad_request:database", "Failed to save messages");
  }
}

export async function updateMessage({
  id,
  parts,
  chartSpec,
  chartError,
}: {
  id: string;
  parts: DBMessage["parts"];
  chartSpec?: DBMessage["chartSpec"];
  chartError?: DBMessage["chartError"];
}) {
  const partsJson = JSON.stringify(parts ?? []);
  const content = extractTextFromParts(parts);
  const now = new Date().toISOString();

  try {
    await runQuery(
      `
        UPDATE \`${MESSAGES_TABLE_REF}\`
        SET
          parts_json = @parts_json,
          content = @content,
          updated_at = @updated_at,
          chart_spec_json = IF(@set_chart_spec, NULLIF(@chart_spec_json, ''), chart_spec_json),
          chart_error = IF(@set_chart_error, NULLIF(@chart_error, ''), chart_error)
        WHERE message_id = @message_id
      `,
      [
        { name: "parts_json", type: "STRING", value: partsJson },
        { name: "content", type: "STRING", value: content },
        { name: "updated_at", type: "STRING", value: now },
        {
          name: "set_chart_spec",
          type: "BOOL",
          value: chartSpec !== undefined,
        },
        {
          name: "chart_spec_json",
          type: "STRING",
          value:
            chartSpec === undefined
              ? ""
              : chartSpec === null
                ? ""
                : JSON.stringify(chartSpec),
        },
        {
          name: "set_chart_error",
          type: "BOOL",
          value: chartError !== undefined,
        },
        {
          name: "chart_error",
          type: "STRING",
          value:
            chartError === undefined || chartError === null ? "" : chartError,
        },
        { name: "message_id", type: "STRING", value: id },
      ]
    );
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to update message");
  }
}

export async function updateMessageAnsweredIn({
  id,
  answeredIn,
}: {
  id: string;
  answeredIn: number;
}) {
  const now = new Date().toISOString();

  try {
    await runQuery(
      `
        UPDATE \`${MESSAGES_TABLE_REF}\`
        SET
          answered_in = @answered_in,
          updated_at = @updated_at
        WHERE message_id = @message_id
      `,
      [
        { name: "answered_in", type: "INT64", value: answeredIn },
        { name: "updated_at", type: "STRING", value: now },
        { name: "message_id", type: "STRING", value: id },
      ]
    );
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to update message answered_in"
    );
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    const rows = await queryRows(
      `
        SELECT
          message_id,
          session_id,
          chat_id,
          role,
          content,
          created_at,
          parts_json,
          attachments_json,
          chart_spec_json,
          chart_error
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE (chat_id = @chat_id OR (chat_id IS NULL AND session_id = @chat_id))
          AND NOT STARTS_WITH(session_id, @meta_prefix)
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        ORDER BY SAFE_CAST(created_at AS TIMESTAMP) ASC
      `,
      [
        { name: "chat_id", type: "STRING", value: id },
        { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
      ],
      `
        SELECT
          message_id,
          session_id,
          NULL AS chat_id,
          role,
          content,
          created_at,
          NULL AS parts_json,
          '[]' AS attachments_json,
          NULL AS chart_spec_json,
          NULL AS chart_error
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @chat_id
          AND NOT STARTS_WITH(session_id, @meta_prefix)
        ORDER BY created_at ASC
      `
    );

    return rows.map(mapMessageRowToDbMessage);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

export async function voteMessage({
  chatId: _chatId,
  messageId: _messageId,
  type: _type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  await Promise.resolve();
  return;
}

export async function getVotesByChatId({
  id: _id,
}: {
  id: string;
}): Promise<Vote[]> {
  await Promise.resolve();
  return [];
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  const now = new Date().toISOString();
  const messageId = `doc:${id}:${Date.now()}:${generateUUID().slice(0, 8)}`;

  try {
    const payload: MetaDocumentPayload = {
      id,
      title,
      kind,
      content,
      userId,
      createdAt: now,
    };

    await upsertMetaMessage(
      buildMetaRow({
        messageId,
        sessionId: META_DOCUMENTS_SESSION,
        userId,
        content: title,
        payload,
        createdAt: now,
      })
    );

    return [
      {
        id,
        createdAt: parseDate(now),
        title,
        content,
        kind,
        userId,
      } as Document,
    ];
  } catch (_error) {
    throw new ChatSDKError("bad_request:database", "Failed to save document");
  }
}

export async function getDocumentsById({
  id,
}: {
  id: string;
}): Promise<Document[]> {
  try {
    const rows = await queryRows(
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        ORDER BY SAFE_CAST(created_at AS TIMESTAMP) ASC
      `,
      [
        { name: "session_id", type: "STRING", value: META_DOCUMENTS_SESSION },
        { name: "document_id", type: "STRING", value: id },
      ],
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
        ORDER BY created_at ASC
      `
    );

    return rows
      .map(mapDocumentRow)
      .filter((document): document is Document => Boolean(document));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const rows = await queryRows(
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        ORDER BY SAFE_CAST(created_at AS TIMESTAMP) DESC
        LIMIT 1
      `,
      [
        { name: "session_id", type: "STRING", value: META_DOCUMENTS_SESSION },
        { name: "document_id", type: "STRING", value: id },
      ],
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
        ORDER BY created_at DESC
        LIMIT 1
      `
    );

    if (!rows[0]) {
      return null;
    }

    return mapDocumentRow(rows[0]);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    const threshold = toIsoString(timestamp);

    const rowsToDelete = await queryRows(
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
          AND SAFE_CAST(created_at AS TIMESTAMP) > SAFE_CAST(@threshold AS TIMESTAMP)
          AND (is_deleted IS NULL OR is_deleted = FALSE)
      `,
      [
        { name: "session_id", type: "STRING", value: META_DOCUMENTS_SESSION },
        { name: "document_id", type: "STRING", value: id },
        { name: "threshold", type: "STRING", value: threshold },
      ],
      `
        SELECT
          message_id,
          user_id,
          content,
          parts_json,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
          AND created_at > @threshold
      `
    );

    await runQuery(
      `
        DELETE FROM \`${MESSAGES_TABLE_REF}\`
        WHERE session_id = @session_id
          AND JSON_VALUE(parts_json, '$.id') = @document_id
          AND SAFE_CAST(created_at AS TIMESTAMP) > SAFE_CAST(@threshold AS TIMESTAMP)
      `,
      [
        { name: "session_id", type: "STRING", value: META_DOCUMENTS_SESSION },
        { name: "document_id", type: "STRING", value: id },
        { name: "threshold", type: "STRING", value: threshold },
      ]
    );

    return rowsToDelete
      .map(mapDocumentRow)
      .filter((document): document is Document => Boolean(document));
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    const rows = await queryRows(
      `
        SELECT
          message_id,
          session_id,
          chat_id,
          role,
          content,
          created_at,
          parts_json,
          attachments_json,
          chart_spec_json,
          chart_error
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE message_id = @message_id
          AND (is_deleted IS NULL OR is_deleted = FALSE)
        ORDER BY SAFE_CAST(created_at AS TIMESTAMP) ASC
      `,
      [{ name: "message_id", type: "STRING", value: id }],
      `
        SELECT
          message_id,
          session_id,
          NULL AS chat_id,
          role,
          content,
          created_at
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE message_id = @message_id
        ORDER BY created_at ASC
      `
    );

    return rows.map(mapMessageRowToDbMessage);
  } catch (error) {
    const now = Date.now();
    if (
      now - lastMessageByIdErrorLogAtMs >=
      MESSAGE_BY_ID_ERROR_LOG_COOLDOWN_MS
    ) {
      lastMessageByIdErrorLogAtMs = now;
      console.warn("Failed to get message by id from BigQuery.", { id, error });
    }

    return [];
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const threshold = toIsoString(timestamp);

    try {
      await runQuery(
        `
          DELETE FROM \`${MESSAGES_TABLE_REF}\`
          WHERE (chat_id = @chat_id OR (chat_id IS NULL AND session_id = @chat_id))
            AND NOT STARTS_WITH(session_id, @meta_prefix)
            AND SAFE_CAST(created_at AS TIMESTAMP) >= SAFE_CAST(@threshold AS TIMESTAMP)
        `,
        [
          { name: "chat_id", type: "STRING", value: chatId },
          { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
          { name: "threshold", type: "STRING", value: threshold },
        ]
      );
    } catch {
      await runQuery(
        `
          DELETE FROM \`${MESSAGES_TABLE_REF}\`
          WHERE session_id = @chat_id
            AND NOT STARTS_WITH(session_id, @meta_prefix)
            AND SAFE_CAST(created_at AS TIMESTAMP) >= SAFE_CAST(@threshold AS TIMESTAMP)
        `,
        [
          { name: "chat_id", type: "STRING", value: chatId },
          { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
          { name: "threshold", type: "STRING", value: threshold },
        ]
      );
    }
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  try {
    const chat = await getChatById({ id: chatId });

    if (!chat) {
      return;
    }

    const now = new Date().toISOString();
    const payload: MetaChatPayload = {
      chatId: chat.id,
      userId: chat.userId,
      title: chat.title,
      visibility,
      createdAt: toIsoString(chat.createdAt),
      updatedAt: now,
    };

    await upsertMetaMessage(
      buildMetaRow({
        messageId: `chat:${chatId}`,
        sessionId: chatId,
        userId: chat.userId,
        content: chat.title,
        payload,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        visibility,
      })
    );

    try {
      try {
        await runQuery(
          `
            UPDATE \`${MESSAGES_TABLE_REF}\`
            SET
              visibility = @visibility
            WHERE (chat_id = @chat_id OR (chat_id IS NULL AND session_id = @chat_id))
              AND NOT STARTS_WITH(session_id, @meta_prefix)
          `,
          [
            { name: "visibility", type: "STRING", value: visibility },
            { name: "chat_id", type: "STRING", value: chatId },
            { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
          ]
        );
      } catch {
        await runQuery(
          `
            UPDATE \`${MESSAGES_TABLE_REF}\`
            SET
              visibility = @visibility
            WHERE session_id = @chat_id
              AND NOT STARTS_WITH(session_id, @meta_prefix)
          `,
          [
            { name: "visibility", type: "STRING", value: visibility },
            { name: "chat_id", type: "STRING", value: chatId },
            { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
          ]
        );
      }
    } catch (error) {
      // Share relies on chat metadata visibility; message-row visibility is best-effort.
      console.warn(
        "Failed to backfill message visibility. Keeping metadata visibility update only.",
        { chatId, error }
      );
    }
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatTitleById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}) {
  try {
    const chat = await getChatById({ id: chatId });

    if (!chat) {
      return;
    }

    const now = new Date().toISOString();
    const payload: MetaChatPayload = {
      chatId: chat.id,
      userId: chat.userId,
      title,
      visibility: chat.visibility,
      createdAt: toIsoString(chat.createdAt),
      updatedAt: now,
    };

    await upsertMetaMessage(
      buildMetaRow({
        messageId: `chat:${chatId}`,
        sessionId: chatId,
        userId: chat.userId,
        content: title,
        payload,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        visibility: chat.visibility,
      })
    );
  } catch (error) {
    console.warn("Failed to update title for chat", chatId, error);
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  try {
    const threshold = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    ).toISOString();

    const rows = await queryRows(
      `
        SELECT COUNT(1) AS total
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE user_id = @user_id
          AND role = 'user'
          AND NOT STARTS_WITH(session_id, @meta_prefix)
          AND (is_deleted IS NULL OR is_deleted = FALSE)
          AND SAFE_CAST(created_at AS TIMESTAMP) >= SAFE_CAST(@threshold AS TIMESTAMP)
      `,
      [
        { name: "user_id", type: "STRING", value: id },
        { name: "meta_prefix", type: "STRING", value: META_SESSION_PREFIX },
        { name: "threshold", type: "STRING", value: threshold },
      ],
      `
        SELECT COUNT(1) AS total
        FROM \`${MESSAGES_TABLE_REF}\`
        WHERE user_id = @user_id
          AND role = 'user'
          AND NOT STARTS_WITH(session_id, @meta_prefix)
          AND created_at >= @threshold
      `
    );

    return parseIntOrZero(rows[0]?.total);
  } catch (_error) {
    throw new ChatSDKError(
      "bad_request:database",
      "Failed to get message count by user id"
    );
  }
}
