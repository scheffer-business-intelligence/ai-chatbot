import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getBigQueryUserIdCandidates } from "@/lib/auth/user-id";
import { getChatById } from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import { getBigQueryAccessToken, getSessionFileById } from "@/lib/gcp/bigquery";
import { fetchGcsObject } from "@/lib/gcp/storage";

function buildInlineDisposition(filename: string) {
  const safeFilename = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();

  if (!safeFilename) {
    return 'inline; filename="arquivo"';
  }

  return `inline; filename="${safeFilename}"`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId")?.trim() ?? "";
  const fileId = searchParams.get("fileId")?.trim() ?? "";

  if (!chatId || !fileId) {
    return NextResponse.json(
      { error: "chatId e fileId sao obrigatorios." },
      { status: 400 }
    );
  }

  const chat = await getChatById({ id: chatId });
  if (!chat) {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  const session = await auth();
  const [bigQueryUserId, fallbackBigQueryUserId] = session?.user
    ? getBigQueryUserIdCandidates(session.user)
    : [null, null];
  const requesterIds = new Set(
    [session?.user?.id, bigQueryUserId, fallbackBigQueryUserId].filter(
      Boolean
    ) as string[]
  );
  const isOwner = requesterIds.has(chat.userId);

  if (!isOwner && chat.visibility !== "public") {
    if (!session?.user) {
      return new ChatSDKError("unauthorized:chat").toResponse();
    }

    return new ChatSDKError("forbidden:chat").toResponse();
  }

  try {
    const accessToken = await getBigQueryAccessToken();
    const file = await getSessionFileById(
      accessToken,
      chat.userId,
      chatId,
      fileId
    );

    if (!file?.gcs_url) {
      return NextResponse.json(
        { error: "Arquivo nao encontrado para este chat." },
        { status: 404 }
      );
    }

    const objectResponse = await fetchGcsObject(file.gcs_url, request.signal);

    const headers = new Headers();
    headers.set(
      "Content-Type",
      file.content_type || "application/octet-stream"
    );
    headers.set("Content-Disposition", buildInlineDisposition(file.filename));
    headers.set(
      "Cache-Control",
      chat.visibility === "public"
        ? "private, max-age=300"
        : "private, no-store"
    );

    const contentLength = objectResponse.headers.get("content-length");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new NextResponse(objectResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Falha ao ler arquivo.";
    return NextResponse.json(
      { error: `Nao foi possivel carregar o arquivo: ${reason}` },
      { status: 500 }
    );
  }
}
