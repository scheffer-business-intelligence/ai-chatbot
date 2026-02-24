import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { getBigQueryAccessToken, insertFileMetadata } from "@/lib/gcp/bigquery";
import { generateSignedUrl, uploadToGCS } from "@/lib/gcp/storage";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MIME_TYPE = "application/pdf";
const MAX_TOTAL_SIZE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  PDF_MIME_TYPE,
  XLSX_MIME_TYPE,
];
const FILE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": PDF_MIME_TYPE,
  ".xlsx": XLSX_MIME_TYPE,
};
const MAX_SIZE_BY_MIME_TYPE: Record<string, number> = {
  "image/jpeg": 5 * 1024 * 1024,
  "image/png": 5 * 1024 * 1024,
  [PDF_MIME_TYPE]: 10 * 1024 * 1024,
  [XLSX_MIME_TYPE]: 5 * 1024 * 1024,
};

function getFileExtension(filename: string) {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) {
    return "";
  }
  return filename.slice(dotIndex).toLowerCase();
}

function resolveSupportedMediaType(file: Blob, filename: string) {
  const mediaType = file.type.toLowerCase();
  if (ALLOWED_MIME_TYPES.includes(mediaType)) {
    return mediaType;
  }

  const extension = getFileExtension(filename);
  return FILE_EXTENSION_TO_MIME_TYPE[extension] ?? null;
}

function extractSessionId(formData: FormData) {
  const value = formData.get("sessionId") ?? formData.get("chatId");
  return typeof value === "string" ? value.trim() : "";
}

function collectFilesFromFormData(formData: FormData) {
  const files: File[] = [];

  for (const [key, value] of formData.entries()) {
    if ((key === "file" || key === "files") && value instanceof File) {
      files.push(value);
    }
  }

  return files;
}

type FileValidationResult =
  | { valid: true; mediaType: string }
  | { valid: false; error: string };

function validateFile(
  file: File,
  resolvedMediaType: string | null
): FileValidationResult {
  if (!resolvedMediaType) {
    return {
      valid: false,
      error: "O tipo de arquivo deve ser JPEG, PNG, PDF ou XLSX.",
    };
  }

  const maxSize = MAX_SIZE_BY_MIME_TYPE[resolvedMediaType];

  if (!maxSize) {
    return {
      valid: false,
      error: `Tipo de arquivo não suportado: ${resolvedMediaType}`,
    };
  }

  if (file.size > maxSize) {
    const maxSizeMb = Math.round(maxSize / (1024 * 1024));
    return {
      valid: false,
      error: `Arquivo muito grande: ${file.name} (máximo ${maxSizeMb}MB).`,
    };
  }

  return { valid: true, mediaType: resolvedMediaType };
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const sessionId = extractSessionId(formData);

    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId é obrigatório para upload." },
        { status: 400 }
      );
    }

    const files = collectFilesFromFormData(formData);

    if (files.length === 0) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Tamanho total excede o limite de 25MB." },
        { status: 400 }
      );
    }

    const userId = session.user.id;
    const accessToken = await getBigQueryAccessToken();
    const uploadedFiles: Array<{
      url: string;
      pathname: string;
      contentType: string;
      fileId: string;
      gcsUrl: string;
      objectPath: string;
      size: number;
    }> = [];

    for (const file of files) {
      const originalFilename = file.name || `upload-${Date.now()}`;
      const resolvedMediaType = resolveSupportedMediaType(
        file,
        originalFilename
      );
      const validation = validateFile(file, resolvedMediaType);

      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const uploaded = await uploadToGCS(
        fileBuffer,
        originalFilename,
        validation.mediaType,
        userId,
        sessionId
      );
      const signedUrl = await generateSignedUrl(uploaded.gcsUrl);

      await insertFileMetadata(accessToken, {
        file_id: uploaded.fileId,
        session_id: sessionId,
        user_id: userId,
        chat_id: sessionId,
        message_id: null,
        filename: uploaded.filename,
        content_type: uploaded.contentType,
        file_size: uploaded.fileSize,
        gcs_url: uploaded.gcsUrl,
        object_path: uploaded.objectPath,
        created_at: new Date().toISOString(),
        is_deleted: false,
      });

      uploadedFiles.push({
        url: signedUrl,
        pathname: uploaded.filename,
        contentType: uploaded.contentType,
        fileId: uploaded.fileId,
        gcsUrl: uploaded.gcsUrl,
        objectPath: uploaded.objectPath,
        size: uploaded.fileSize,
      });
    }

    if (uploadedFiles.length === 1) {
      return NextResponse.json(uploadedFiles[0]);
    }

    return NextResponse.json({ files: uploadedFiles });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Failed to process request";
    return NextResponse.json(
      { error: `Upload failed: ${reason}` },
      { status: 500 }
    );
  }
}
