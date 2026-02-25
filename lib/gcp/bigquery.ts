import "server-only";

import { getServiceAccountAccessToken } from "@/lib/auth/service-account-token";

const BQ_PROJECT_ID =
  process.env.BQ_PROJECT_ID || process.env.PROJECT_ID || "bi-scheffer";
const BQ_DATASET = process.env.BQ_DATASET || "scheffer_agente";
const BQ_MESSAGES_TABLE = process.env.BQ_MESSAGES_TABLE || "chat_messages";
const BQ_FEEDBACKS_TABLE = process.env.BQ_FEEDBACKS_TABLE || "feedbacks";
const BQ_FILES_TABLE = process.env.BQ_FILES_TABLE || "chat_files";
const BQ_BASE_URL = "https://bigquery.googleapis.com/bigquery/v2";

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

export type BigQueryChatMessageRow = {
  message_id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: string;
  updated_at: string;
  parts_json: string;
  attachments_json: string;
  chart_spec_json: string | null;
  chart_error: string | null;
  answered_in: number | null;
  visibility: string | null;
  is_deleted: boolean;
};

export type BigQueryChatFileRow = {
  file_id: string;
  session_id: string;
  user_id: string;
  chat_id: string;
  message_id: string | null;
  filename: string;
  content_type: string;
  file_size: number;
  gcs_url: string;
  object_path: string;
  created_at: string;
  is_deleted: boolean;
};

export type BigQueryFeedbackRow = {
  message_id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: string;
  feedback_message: string;
};

function getMessagesTableRef() {
  return `${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_MESSAGES_TABLE}`;
}

function getFilesTableRef() {
  return `${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_FILES_TABLE}`;
}

function buildQueryParameters(
  params: Array<{
    name: string;
    type: BigQueryParameterType;
    value: string | number | boolean;
  }>
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

async function bigQueryRequest(
  accessToken: string,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${BQ_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`BigQuery error: ${response.status} - ${errorText}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

async function runQuery(
  accessToken: string,
  query: string,
  params?: Array<{
    name: string;
    type: BigQueryParameterType;
    value: string | number | boolean;
  }>
) {
  return await bigQueryRequest(
    accessToken,
    `projects/${BQ_PROJECT_ID}/queries`,
    {
      query,
      useLegacySql: false,
      ...(params && params.length > 0
        ? {
            parameterMode: "NAMED",
            queryParameters: buildQueryParameters(params),
          }
        : {}),
    }
  );
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBool(value: string | null): boolean {
  return value === "true" || value === "1";
}

function mapRowToChatMessage(row: GenericBigQueryRow): BigQueryChatMessageRow {
  return {
    message_id: row.message_id ?? "",
    session_id: row.session_id ?? "",
    user_id: row.user_id ?? "",
    role: row.role ?? "",
    content: row.content ?? "",
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? row.created_at ?? "",
    parts_json: row.parts_json ?? "",
    attachments_json: row.attachments_json ?? "[]",
    chart_spec_json: row.chart_spec_json,
    chart_error: row.chart_error,
    answered_in: parseIntOrNull(row.answered_in),
    visibility: row.visibility,
    is_deleted: parseBool(row.is_deleted),
  };
}

async function insertChatMessageRow(
  accessToken: string,
  row: BigQueryChatMessageRow
) {
  const messagesTable = getMessagesTableRef();
  const existing = await runQuery(
    accessToken,
    `
      SELECT 1 AS found
      FROM \`${messagesTable}\`
      WHERE message_id = @message_id
      LIMIT 1
    `,
    [{ name: "message_id", type: "STRING", value: row.message_id }]
  );
  const existingRows = mapRows(
    existing.rows as BigQueryRow[] | undefined,
    existing.schema as BigQuerySchema | undefined
  );

  if (existingRows.length > 0) {
    return;
  }

  const path = `projects/${BQ_PROJECT_ID}/datasets/${BQ_DATASET}/tables/${BQ_MESSAGES_TABLE}/insertAll`;
  const response = await bigQueryRequest(accessToken, path, {
    ignoreUnknownValues: true,
    rows: [
      {
        insertId: row.message_id,
        json: {
          message_id: row.message_id,
          session_id: row.session_id,
          user_id: row.user_id,
          role: row.role,
          content: row.content,
          created_at: row.created_at,
          updated_at: row.updated_at,
          parts_json: row.parts_json,
          attachments_json: row.attachments_json,
          chart_spec_json: row.chart_spec_json,
          chart_error: row.chart_error,
          answered_in: row.answered_in,
          visibility: row.visibility,
          is_deleted: row.is_deleted,
        },
      },
    ],
  });

  const insertErrors = response.insertErrors as
    | Array<{ index?: number; errors?: Array<{ message?: string }> }>
    | undefined;

  if (insertErrors && insertErrors.length > 0) {
    throw new Error(`BigQuery insert errors: ${JSON.stringify(insertErrors)}`);
  }
}

function isTimestampColumnAssignmentError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();

  return (
    normalized.includes("cannot be assigned to created_at") ||
    normalized.includes("cannot be assigned to updated_at")
  );
}

type TemporalColumn = "created_at" | "updated_at";
type ChatMessageTemporalCastMode =
  | "none"
  | "created_at"
  | "updated_at"
  | "both";
type ChatMessageMergeColumn =
  | "session_id"
  | "user_id"
  | "role"
  | "content"
  | "created_at"
  | "updated_at"
  | "parts_json"
  | "attachments_json"
  | "chart_spec_json"
  | "chart_error"
  | "answered_in"
  | "visibility"
  | "is_deleted";

const CHAT_MESSAGE_MERGE_COLUMNS: ChatMessageMergeColumn[] = [
  "session_id",
  "user_id",
  "role",
  "content",
  "created_at",
  "updated_at",
  "parts_json",
  "attachments_json",
  "chart_spec_json",
  "chart_error",
  "answered_in",
  "visibility",
  "is_deleted",
];

const CHAT_MESSAGE_TEMPORAL_CAST_MODES: ChatMessageTemporalCastMode[] = [
  "none",
  "created_at",
  "updated_at",
  "both",
];

const TEMPORAL_CAST_MODE_CONFIG: Record<
  ChatMessageTemporalCastMode,
  Record<TemporalColumn, boolean>
> = {
  none: { created_at: false, updated_at: false },
  created_at: { created_at: true, updated_at: false },
  updated_at: { created_at: false, updated_at: true },
  both: { created_at: true, updated_at: true },
};

let preferredTemporalCastMode: ChatMessageTemporalCastMode = "none";
const unsupportedMessageMergeColumns = new Set<ChatMessageMergeColumn>();

function isChatMessageMergeColumn(
  value: string
): value is ChatMessageMergeColumn {
  return CHAT_MESSAGE_MERGE_COLUMNS.includes(value as ChatMessageMergeColumn);
}

function getUnrecognizedNameFromError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = /unrecognized name:\s*([a-z0-9_]+)/i.exec(error.message);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseTemporalCastRequirements(
  error: unknown
): Partial<Record<TemporalColumn, boolean>> {
  if (!(error instanceof Error)) {
    return {};
  }

  const normalized = error.message.toLowerCase();
  const requirements: Partial<Record<TemporalColumn, boolean>> = {};
  const assignmentPattern =
    /value of type\s+([a-z0-9_]+)\s+cannot be assigned to\s+(created_at|updated_at),\s+which has type\s+([a-z0-9_]+)/g;

  let match = assignmentPattern.exec(normalized);
  while (match) {
    const sourceType = match[1];
    const column = match[2] as TemporalColumn;
    const targetType = match[3];

    if (sourceType === "string" && targetType === "timestamp") {
      requirements[column] = true;
    } else if (sourceType === "timestamp" && targetType === "string") {
      requirements[column] = false;
    }

    match = assignmentPattern.exec(normalized);
  }

  return requirements;
}

function getTemporalCastRetryModes(
  error: unknown,
  attemptedModes: ReadonlySet<ChatMessageTemporalCastMode>
) {
  const requirements = parseTemporalCastRequirements(error);
  const hasRequirements = Object.keys(requirements).length > 0;

  const getModeScore = (mode: ChatMessageTemporalCastMode) => {
    const config = TEMPORAL_CAST_MODE_CONFIG[mode];
    let mismatches = 0;

    for (const column of ["created_at", "updated_at"] as const) {
      const requirement = requirements[column];
      if (typeof requirement === "boolean" && config[column] !== requirement) {
        mismatches += 1;
      }
    }

    const castCount =
      Number(config.created_at === true) + Number(config.updated_at === true);

    return { mismatches, castCount };
  };

  return CHAT_MESSAGE_TEMPORAL_CAST_MODES.filter(
    (mode) => !attemptedModes.has(mode)
  ).sort((modeA, modeB) => {
    if (hasRequirements) {
      const scoreA = getModeScore(modeA);
      const scoreB = getModeScore(modeB);

      if (scoreA.mismatches !== scoreB.mismatches) {
        return scoreA.mismatches - scoreB.mismatches;
      }

      if (scoreA.castCount !== scoreB.castCount) {
        return scoreA.castCount - scoreB.castCount;
      }
    }

    return (
      CHAT_MESSAGE_TEMPORAL_CAST_MODES.indexOf(modeA) -
      CHAT_MESSAGE_TEMPORAL_CAST_MODES.indexOf(modeB)
    );
  });
}

function buildChatMessageMergeQuery(
  messagesTable: string,
  temporalCastMode: ChatMessageTemporalCastMode,
  disabledColumns: ReadonlySet<ChatMessageMergeColumn>
) {
  const modeConfig = TEMPORAL_CAST_MODE_CONFIG[temporalCastMode];
  const enabledColumns = CHAT_MESSAGE_MERGE_COLUMNS.filter(
    (column) => !disabledColumns.has(column)
  );

  const getSourceExpression = (column: ChatMessageMergeColumn) => {
    if (column === "created_at") {
      return modeConfig.created_at
        ? "SAFE_CAST(@created_at AS TIMESTAMP)"
        : "@created_at";
    }

    if (column === "updated_at") {
      return modeConfig.updated_at
        ? "SAFE_CAST(@updated_at AS TIMESTAMP)"
        : "@updated_at";
    }

    if (column === "chart_spec_json") {
      return "NULLIF(@chart_spec_json, '')";
    }

    if (column === "chart_error") {
      return "NULLIF(@chart_error, '')";
    }

    if (column === "answered_in") {
      return "SAFE_CAST(NULLIF(@answered_in, '') AS INT64)";
    }

    if (column === "visibility") {
      return "NULLIF(@visibility, '')";
    }

    return `@${column}`;
  };

  const sourceSelect = enabledColumns
    .map((column) => `${getSourceExpression(column)} AS ${column}`)
    .join(",\n        ");
  const updateSet = enabledColumns
    .map((column) => `${column} = source.${column}`)
    .join(",\n      ");
  const insertColumns = ["message_id", ...enabledColumns].join(",\n        ");
  const insertValues = [
    "source.message_id",
    ...enabledColumns.map((column) => `source.${column}`),
  ].join(",\n        ");
  const paramNames = new Set(["message_id", ...enabledColumns]);

  return {
    query: `
    MERGE \`${messagesTable}\` AS target
    USING (
      SELECT
        @message_id AS message_id,
        ${sourceSelect}
    ) AS source
    ON target.message_id = source.message_id
    WHEN MATCHED THEN UPDATE SET
      ${updateSet}
    WHEN NOT MATCHED THEN
      INSERT (
        ${insertColumns}
      )
      VALUES (
        ${insertValues}
      )
  `,
    paramNames,
  };
}

export async function upsertChatMessageRow(
  accessToken: string,
  row: BigQueryChatMessageRow
) {
  const messagesTable = getMessagesTableRef();
  const allParamsByName = new Map<
    string,
    {
      name: string;
      type: BigQueryParameterType;
      value: string | number | boolean;
    }
  >([
    [
      "message_id",
      { name: "message_id", type: "STRING", value: row.message_id },
    ],
    [
      "session_id",
      { name: "session_id", type: "STRING", value: row.session_id },
    ],
    ["user_id", { name: "user_id", type: "STRING", value: row.user_id }],
    ["role", { name: "role", type: "STRING", value: row.role }],
    ["content", { name: "content", type: "STRING", value: row.content }],
    [
      "created_at",
      { name: "created_at", type: "STRING", value: row.created_at },
    ],
    [
      "updated_at",
      { name: "updated_at", type: "STRING", value: row.updated_at },
    ],
    [
      "parts_json",
      { name: "parts_json", type: "STRING", value: row.parts_json },
    ],
    [
      "attachments_json",
      {
        name: "attachments_json",
        type: "STRING",
        value: row.attachments_json,
      },
    ],
    [
      "chart_spec_json",
      {
        name: "chart_spec_json",
        type: "STRING",
        value: row.chart_spec_json ?? "",
      },
    ],
    [
      "chart_error",
      { name: "chart_error", type: "STRING", value: row.chart_error ?? "" },
    ],
    [
      "answered_in",
      {
        name: "answered_in",
        type: "STRING",
        value: row.answered_in === null ? "" : String(row.answered_in),
      },
    ],
    [
      "visibility",
      { name: "visibility", type: "STRING", value: row.visibility ?? "" },
    ],
    ["is_deleted", { name: "is_deleted", type: "BOOL", value: row.is_deleted }],
  ]);

  const buildMergeParams = (paramNames: ReadonlySet<string>) =>
    [...paramNames]
      .map((paramName) => allParamsByName.get(paramName))
      .filter((param): param is NonNullable<typeof param> => Boolean(param));

  const attemptedModes = new Set<ChatMessageTemporalCastMode>();
  const modesToTry: ChatMessageTemporalCastMode[] = [preferredTemporalCastMode];
  const activeDisabledColumns = new Set(unsupportedMessageMergeColumns);
  let lastMergeError: unknown = null;

  while (modesToTry.length > 0) {
    const mode = modesToTry.shift();
    if (!mode || attemptedModes.has(mode)) {
      continue;
    }

    attemptedModes.add(mode);

    let retryCurrentMode = true;

    while (retryCurrentMode) {
      retryCurrentMode = false;

      try {
        const mergePayload = buildChatMessageMergeQuery(
          messagesTable,
          mode,
          activeDisabledColumns
        );
        const params = buildMergeParams(mergePayload.paramNames);

        await runQuery(accessToken, mergePayload.query, params);
        preferredTemporalCastMode = mode;
        unsupportedMessageMergeColumns.clear();
        for (const column of activeDisabledColumns) {
          unsupportedMessageMergeColumns.add(column);
        }
        return;
      } catch (error) {
        lastMergeError = error;

        const unrecognizedName = getUnrecognizedNameFromError(error);
        if (
          unrecognizedName &&
          isChatMessageMergeColumn(unrecognizedName) &&
          !activeDisabledColumns.has(unrecognizedName)
        ) {
          activeDisabledColumns.add(unrecognizedName);
          retryCurrentMode = true;
          continue;
        }

        if (!isTimestampColumnAssignmentError(error)) {
          break;
        }

        const retryModes = getTemporalCastRetryModes(error, attemptedModes);
        modesToTry.push(...retryModes);
      }
    }
  }

  unsupportedMessageMergeColumns.clear();
  for (const column of activeDisabledColumns) {
    unsupportedMessageMergeColumns.add(column);
  }

  console.warn(
    "BigQuery MERGE failed for chat message, using insertAll fallback:",
    lastMergeError
  );
  await insertChatMessageRow(accessToken, row);
}

export async function querySessionMessages(
  accessToken: string,
  userId: string,
  sessionId: string
): Promise<BigQueryChatMessageRow[]> {
  const messagesTable = getMessagesTableRef();
  const fullQuery = `
    SELECT
      message_id,
      session_id,
      user_id,
      role,
      content,
      created_at,
      updated_at,
      parts_json,
      attachments_json,
      chart_spec_json,
      chart_error,
      CAST(answered_in AS STRING) AS answered_in,
      visibility,
      CAST(is_deleted AS STRING) AS is_deleted
    FROM \`${messagesTable}\`
    WHERE user_id = @user_id
      AND session_id = @session_id
      AND role IN ('user', 'assistant')
      AND (is_deleted IS NULL OR is_deleted = FALSE)
    ORDER BY created_at
  `;

  try {
    const response = await runQuery(accessToken, fullQuery, [
      { name: "user_id", type: "STRING", value: userId },
      { name: "session_id", type: "STRING", value: sessionId },
    ]);
    const rows = mapRows(
      response.rows as BigQueryRow[] | undefined,
      response.schema as BigQuerySchema | undefined
    );
    return rows.map(mapRowToChatMessage);
  } catch {
    const fallbackQuery = `
      SELECT
        message_id,
        session_id,
        user_id,
        role,
        content,
        created_at
      FROM \`${messagesTable}\`
      WHERE user_id = @user_id
        AND session_id = @session_id
        AND role IN ('user', 'assistant')
      ORDER BY created_at
    `;
    const response = await runQuery(accessToken, fallbackQuery, [
      { name: "user_id", type: "STRING", value: userId },
      { name: "session_id", type: "STRING", value: sessionId },
    ]);
    const rows = mapRows(
      response.rows as BigQueryRow[] | undefined,
      response.schema as BigQuerySchema | undefined
    );
    return rows.map(mapRowToChatMessage);
  }
}

export async function getChatMessageById(
  accessToken: string,
  userId: string,
  messageId: string
): Promise<BigQueryChatMessageRow | null> {
  const messagesTable = getMessagesTableRef();
  const fullQuery = `
    SELECT
      message_id,
      session_id,
      user_id,
      role,
      content,
      created_at,
      updated_at,
      parts_json,
      attachments_json,
      chart_spec_json,
      chart_error,
      CAST(answered_in AS STRING) AS answered_in,
      visibility,
      CAST(is_deleted AS STRING) AS is_deleted
    FROM \`${messagesTable}\`
    WHERE user_id = @user_id
      AND message_id = @message_id
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;

  let row: GenericBigQueryRow | undefined;

  try {
    const response = await runQuery(accessToken, fullQuery, [
      { name: "user_id", type: "STRING", value: userId },
      { name: "message_id", type: "STRING", value: messageId },
    ]);
    const rows = mapRows(
      response.rows as BigQueryRow[] | undefined,
      response.schema as BigQuerySchema | undefined
    );
    row = rows[0];
  } catch {
    const fallbackQuery = `
      SELECT
        message_id,
        session_id,
        user_id,
        role,
        content,
        created_at
      FROM \`${messagesTable}\`
      WHERE user_id = @user_id
        AND message_id = @message_id
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const response = await runQuery(accessToken, fallbackQuery, [
      { name: "user_id", type: "STRING", value: userId },
      { name: "message_id", type: "STRING", value: messageId },
    ]);
    const rows = mapRows(
      response.rows as BigQueryRow[] | undefined,
      response.schema as BigQuerySchema | undefined
    );
    row = rows[0];
  }

  if (!row) {
    return null;
  }

  return mapRowToChatMessage(row);
}

export async function softDeleteMessagesAfterTimestamp(
  accessToken: string,
  userId: string,
  sessionId: string,
  createdAtIso: string
) {
  const messagesTable = getMessagesTableRef();
  const query = `
    UPDATE \`${messagesTable}\`
    SET
      is_deleted = TRUE,
      updated_at = @updated_at
    WHERE user_id = @user_id
      AND session_id = @session_id
      AND SAFE_CAST(created_at AS TIMESTAMP) >= SAFE_CAST(@created_at AS TIMESTAMP)
      AND (is_deleted IS NULL OR is_deleted = FALSE)
  `;

  await runQuery(accessToken, query, [
    { name: "updated_at", type: "STRING", value: new Date().toISOString() },
    { name: "user_id", type: "STRING", value: userId },
    { name: "session_id", type: "STRING", value: sessionId },
    { name: "created_at", type: "STRING", value: createdAtIso },
  ]);
}

export async function softDeleteSessionMessages(
  accessToken: string,
  userId: string,
  sessionId: string
) {
  const messagesTable = getMessagesTableRef();
  const query = `
    UPDATE \`${messagesTable}\`
    SET
      is_deleted = TRUE,
      updated_at = @updated_at
    WHERE user_id = @user_id
      AND session_id = @session_id
      AND (is_deleted IS NULL OR is_deleted = FALSE)
  `;

  await runQuery(accessToken, query, [
    { name: "updated_at", type: "STRING", value: new Date().toISOString() },
    { name: "user_id", type: "STRING", value: userId },
    { name: "session_id", type: "STRING", value: sessionId },
  ]);
}

export async function countUserMessagesSince(
  accessToken: string,
  userId: string,
  thresholdIso: string
): Promise<number> {
  const messagesTable = getMessagesTableRef();
  const query = `
    SELECT COUNT(1) AS total
    FROM \`${messagesTable}\`
    WHERE user_id = @user_id
      AND role = 'user'
      AND (is_deleted IS NULL OR is_deleted = FALSE)
      AND SAFE_CAST(created_at AS TIMESTAMP) >= SAFE_CAST(@threshold_iso AS TIMESTAMP)
  `;

  const response = await runQuery(accessToken, query, [
    { name: "user_id", type: "STRING", value: userId },
    { name: "threshold_iso", type: "STRING", value: thresholdIso },
  ]);
  const rows = mapRows(
    response.rows as BigQueryRow[] | undefined,
    response.schema as BigQuerySchema | undefined
  );

  return parseIntOrNull(rows[0]?.total ?? null) ?? 0;
}

export async function insertFileMetadata(
  accessToken: string,
  row: BigQueryChatFileRow
) {
  const path = `projects/${BQ_PROJECT_ID}/datasets/${BQ_DATASET}/tables/${BQ_FILES_TABLE}/insertAll`;
  const response = await bigQueryRequest(accessToken, path, {
    ignoreUnknownValues: true,
    rows: [
      {
        insertId: row.file_id,
        json: row,
      },
    ],
  });

  const insertErrors = response.insertErrors as
    | Array<{ index?: number; errors?: Array<{ message?: string }> }>
    | undefined;

  if (insertErrors && insertErrors.length > 0) {
    throw new Error(`BigQuery insert errors: ${JSON.stringify(insertErrors)}`);
  }
}

function validateAndNormalizeFeedbackRow(
  row: BigQueryFeedbackRow
): BigQueryFeedbackRow {
  const requiredFields: Array<keyof BigQueryFeedbackRow> = [
    "message_id",
    "session_id",
    "user_id",
    "role",
    "content",
    "feedback_message",
  ];

  for (const field of requiredFields) {
    const value = row[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `Invalid feedback payload: "${field}" is required and must be a non-empty string.`
      );
    }
  }

  const sanitizedFeedback = row.feedback_message.trim();
  const maxLength = 5000;
  if (sanitizedFeedback.length > maxLength) {
    throw new Error(
      `Invalid feedback payload: "feedback_message" exceeds ${maxLength} characters.`
    );
  }

  return {
    ...row,
    feedback_message: sanitizedFeedback,
    created_at: row.created_at || new Date().toISOString(),
  };
}

export async function insertFeedbackRow(
  accessToken: string,
  row: BigQueryFeedbackRow
) {
  const payload = validateAndNormalizeFeedbackRow(row);
  const path = `projects/${BQ_PROJECT_ID}/datasets/${BQ_DATASET}/tables/${BQ_FEEDBACKS_TABLE}/insertAll`;
  const response = await bigQueryRequest(accessToken, path, {
    ignoreUnknownValues: true,
    rows: [
      {
        insertId: `${payload.message_id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        json: payload,
      },
    ],
  });

  const insertErrors = response.insertErrors as
    | Array<{ index?: number; errors?: Array<{ message?: string }> }>
    | undefined;

  if (insertErrors && insertErrors.length > 0) {
    throw new Error(`BigQuery insert errors: ${JSON.stringify(insertErrors)}`);
  }
}

export async function querySessionFiles(
  accessToken: string,
  userId: string,
  sessionId: string
): Promise<BigQueryChatFileRow[]> {
  const filesTable = getFilesTableRef();
  const fullQuery = `
    SELECT
      file_id,
      session_id,
      user_id,
      chat_id,
      message_id,
      filename,
      content_type,
      CAST(file_size AS STRING) AS file_size,
      gcs_url,
      object_path,
      created_at,
      CAST(is_deleted AS STRING) AS is_deleted
    FROM \`${filesTable}\`
    WHERE user_id = @user_id
      AND session_id = @session_id
      AND (is_deleted IS NULL OR is_deleted = FALSE)
    ORDER BY created_at
  `;

  try {
    const response = await runQuery(accessToken, fullQuery, [
      { name: "user_id", type: "STRING", value: userId },
      { name: "session_id", type: "STRING", value: sessionId },
    ]);
    const rows = mapRows(
      response.rows as BigQueryRow[] | undefined,
      response.schema as BigQuerySchema | undefined
    );

    return rows.map((row) => ({
      file_id: row.file_id ?? "",
      session_id: row.session_id ?? "",
      user_id: row.user_id ?? "",
      chat_id: row.chat_id ?? "",
      message_id: row.message_id,
      filename: row.filename ?? "",
      content_type: row.content_type ?? "",
      file_size: parseIntOrNull(row.file_size) ?? 0,
      gcs_url: row.gcs_url ?? "",
      object_path: row.object_path ?? "",
      created_at: row.created_at ?? "",
      is_deleted: parseBool(row.is_deleted),
    }));
  } catch {
    const fallbackQuery = `
      SELECT
        file_id,
        session_id,
        user_id,
        filename,
        content_type,
        CAST(file_size AS STRING) AS file_size,
        gcs_url,
        created_at
      FROM \`${filesTable}\`
      WHERE user_id = @user_id
        AND session_id = @session_id
      ORDER BY created_at
    `;
    const response = await runQuery(accessToken, fallbackQuery, [
      { name: "user_id", type: "STRING", value: userId },
      { name: "session_id", type: "STRING", value: sessionId },
    ]);
    const rows = mapRows(
      response.rows as BigQueryRow[] | undefined,
      response.schema as BigQuerySchema | undefined
    );

    return rows.map((row) => ({
      file_id: row.file_id ?? "",
      session_id: row.session_id ?? "",
      user_id: row.user_id ?? "",
      chat_id: row.session_id ?? "",
      message_id: null,
      filename: row.filename ?? "",
      content_type: row.content_type ?? "",
      file_size: parseIntOrNull(row.file_size) ?? 0,
      gcs_url: row.gcs_url ?? "",
      object_path: "",
      created_at: row.created_at ?? "",
      is_deleted: false,
    }));
  }
}

export async function getBigQueryAccessToken() {
  return await getServiceAccountAccessToken();
}
