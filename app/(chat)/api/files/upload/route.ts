import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
  XLSX_MIME_TYPE,
];
const PLACEHOLDER_BLOB_TOKEN = "****";
const FILE_EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".xlsx": XLSX_MIME_TYPE,
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

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z.instanceof(Blob),
  mediaType: z
    .string()
    .refine((mediaType) => ALLOWED_MIME_TYPES.includes(mediaType), {
      message: "O tipo de arquivo deve ser JPEG, PNG, PDF ou XLSX",
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();

    if (blobToken === PLACEHOLDER_BLOB_TOKEN) {
      return NextResponse.json(
        {
          error:
            "BLOB_READ_WRITE_TOKEN is using a placeholder value in .env.local. Configure a real Vercel Blob read/write token.",
        },
        { status: 500 }
      );
    }

    const formData = await request.formData();
    const fileFromFormData = formData.get("file");

    if (!(fileFromFormData instanceof Blob)) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const file = fileFromFormData;
    const originalFilename =
      fileFromFormData instanceof File
        ? fileFromFormData.name
        : `upload-${Date.now()}`;
    const resolvedMediaType = resolveSupportedMediaType(file, originalFilename);

    const validatedFile = FileSchema.safeParse({
      file,
      mediaType: resolvedMediaType ?? "",
    });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    try {
      const data = await put(originalFilename, file, {
        access: "public",
        addRandomSuffix: true,
        contentType: resolvedMediaType || undefined,
        token: blobToken,
      });

      return NextResponse.json(data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json(
        { error: `Upload failed: ${reason}` },
        { status: 500 }
      );
    }
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
