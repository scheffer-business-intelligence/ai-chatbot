import "server-only";

import { getServiceAccountAccessToken } from "@/lib/auth/service-account-token";

const BQ_PROJECT_ID =
  process.env.BQ_PROJECT_ID || process.env.PROJECT_ID || "bi-scheffer";
const BQ_DATASET = process.env.BQ_DATASET || "scheffer_agente";
const BQ_MESSAGES_TABLE = process.env.BQ_MESSAGES_TABLE || "chat_messages";
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

export async function upsertChatMessageRow(
  accessToken: string,
  row: BigQueryChatMessageRow
) {
  const messagesTable = getMessagesTableRef();
  const query = `
    MERGE \`${messagesTable}\` AS target
    USING (
      SELECT
        @message_id AS message_id,
        @session_id AS session_id,
        @user_id AS user_id,
        @role AS role,
        @content AS content,
        @created_at AS created_at,
        @updated_at AS updated_at,
        @parts_json AS parts_json,
        @attachments_json AS attachments_json,
        NULLIF(@chart_spec_json, '') AS chart_spec_json,
        NULLIF(@chart_error, '') AS chart_error,
        SAFE_CAST(NULLIF(@answered_in, '') AS INT64) AS answered_in,
        NULLIF(@visibility, '') AS visibility,
        @is_deleted AS is_deleted
    ) AS source
    ON target.message_id = source.message_id
    WHEN MATCHED THEN UPDATE SET
      session_id = source.session_id,
      user_id = source.user_id,
      role = source.role,
      content = source.content,
      created_at = source.created_at,
      updated_at = source.updated_at,
      parts_json = source.parts_json,
      attachments_json = source.attachments_json,
      chart_spec_json = source.chart_spec_json,
      chart_error = source.chart_error,
      answered_in = source.answered_in,
      visibility = source.visibility,
      is_deleted = source.is_deleted
    WHEN NOT MATCHED THEN
      INSERT (
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
        answered_in,
        visibility,
        is_deleted
      )
      VALUES (
        source.message_id,
        source.session_id,
        source.user_id,
        source.role,
        source.content,
        source.created_at,
        source.updated_at,
        source.parts_json,
        source.attachments_json,
        source.chart_spec_json,
        source.chart_error,
        source.answered_in,
        source.visibility,
        source.is_deleted
      )
  `;

  try {
    await runQuery(accessToken, query, [
      { name: "message_id", type: "STRING", value: row.message_id },
      { name: "session_id", type: "STRING", value: row.session_id },
      { name: "user_id", type: "STRING", value: row.user_id },
      { name: "role", type: "STRING", value: row.role },
      { name: "content", type: "STRING", value: row.content },
      { name: "created_at", type: "STRING", value: row.created_at },
      { name: "updated_at", type: "STRING", value: row.updated_at },
      { name: "parts_json", type: "STRING", value: row.parts_json },
      {
        name: "attachments_json",
        type: "STRING",
        value: row.attachments_json,
      },
      {
        name: "chart_spec_json",
        type: "STRING",
        value: row.chart_spec_json ?? "",
      },
      { name: "chart_error", type: "STRING", value: row.chart_error ?? "" },
      {
        name: "answered_in",
        type: "STRING",
        value: row.answered_in === null ? "" : String(row.answered_in),
      },
      { name: "visibility", type: "STRING", value: row.visibility ?? "" },
      { name: "is_deleted", type: "BOOL", value: row.is_deleted },
    ]);
  } catch (error) {
    console.warn(
      "BigQuery MERGE failed for chat message, using insertAll fallback:",
      error
    );
    await insertChatMessageRow(accessToken, row);
  }
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
      AND TIMESTAMP(created_at) >= TIMESTAMP(@created_at)
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
      AND TIMESTAMP(created_at) >= TIMESTAMP(@threshold_iso)
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
