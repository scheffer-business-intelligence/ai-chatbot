import "server-only";

import { getServiceAccountAccessToken } from "@/lib/auth/service-account-token";

const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "bi-scheffer-chat-files";
const GCS_BASE_URL = "https://storage.googleapis.com";

export type GcsUploadResult = {
  fileId: string;
  filename: string;
  contentType: string;
  fileSize: number;
  gcsUrl: string;
  objectPath: string;
};

function parseGcsUrl(gcsUrl: string) {
  const match = gcsUrl.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid GCS URL: ${gcsUrl}`);
  }

  return {
    bucket: match[1],
    objectPath: match[2],
  };
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function uploadToGCS(
  buffer: Buffer,
  filename: string,
  contentType: string,
  userId: string,
  sessionId: string
): Promise<GcsUploadResult> {
  const accessToken = await getServiceAccountAccessToken();
  const fileId = crypto.randomUUID();
  const sanitizedFilename = sanitizeFilename(filename);
  const objectPath = `${userId}/${sessionId}/${fileId}_${sanitizedFilename}`;

  const uploadUrl = `${GCS_BASE_URL}/upload/storage/v1/b/${GCS_BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": contentType,
      "Content-Length": buffer.length.toString(),
    },
    body: new Uint8Array(buffer),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GCS upload failed: ${response.status} - ${errorText}`);
  }

  const gcsUrl = `gs://${GCS_BUCKET_NAME}/${objectPath}`;

  return {
    fileId,
    filename: sanitizedFilename,
    contentType,
    fileSize: buffer.length,
    gcsUrl,
    objectPath,
  };
}

export async function generateSignedUrl(gcsUrl: string) {
  const accessToken = await getServiceAccountAccessToken();
  const { bucket, objectPath } = parseGcsUrl(gcsUrl);

  const mediaUrl = `${GCS_BASE_URL}/storage/v1/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
  return `${mediaUrl}&access_token=${accessToken}`;
}

export async function deleteFromGCS(gcsUrl: string) {
  const accessToken = await getServiceAccountAccessToken();
  const { bucket, objectPath } = parseGcsUrl(gcsUrl);

  const deleteUrl = `${GCS_BASE_URL}/storage/v1/b/${bucket}/o/${encodeURIComponent(objectPath)}`;
  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    throw new Error(`GCS delete failed: ${response.status} - ${errorText}`);
  }
}
