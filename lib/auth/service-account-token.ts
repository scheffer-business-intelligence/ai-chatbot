import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type AccessTokenCache = {
  token: string;
  expiresAtMs: number;
};

const TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_EXPIRY_SECONDS = 3600;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REQUEST_MAX_ATTEMPTS = 4;
const TOKEN_REQUEST_BASE_DELAY_MS = 250;
const TOKEN_REQUEST_MAX_DELAY_MS = 2000;
const RETRYABLE_TOKEN_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

let cachedToken: AccessTokenCache | null = null;
let pendingTokenRequest: Promise<string> | null = null;

class ServiceAccountTokenRequestError extends Error {
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ServiceAccountTokenRequestError";
    this.retryable = retryable;
  }
}

function delay(ms: number) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function computeBackoffDelayMs(attempt: number) {
  const exponential = TOKEN_REQUEST_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * TOKEN_REQUEST_BASE_DELAY_MS);
  return Math.min(exponential + jitter, TOKEN_REQUEST_MAX_DELAY_MS);
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const typedError = error as {
    code?: unknown;
    cause?: { code?: unknown };
  };

  if (typeof typedError.code === "string") {
    return typedError.code;
  }

  if (typedError.cause && typeof typedError.cause.code === "string") {
    return typedError.cause.code;
  }

  return undefined;
}

function isRetryableTokenStatus(status: number): boolean {
  if (status === 408 || status === 429) {
    return true;
  }

  return status >= 500;
}

function isRetryableTokenNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  const code = extractErrorCode(error);
  if (code && RETRYABLE_TOKEN_NETWORK_CODES.has(code)) {
    return true;
  }

  const reason =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  return (
    reason.includes("fetch failed") ||
    reason.includes("socket hang up") ||
    reason.includes("network") ||
    reason.includes("econnreset") ||
    reason.includes("timeout")
  );
}

function toBase64Url(input: Buffer | string) {
  const base64 =
    typeof input === "string"
      ? Buffer.from(input, "utf-8").toString("base64")
      : input.toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getServiceAccountKeyPath() {
  return process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || "bi-scheffer.json";
}

function normalizePrivateKey(privateKey: string) {
  if (!privateKey) {
    return privateKey;
  }

  return privateKey.includes("\\n")
    ? privateKey.replace(/\\n/g, "\n")
    : privateKey;
}

function parseServiceAccountKey(rawContent: string): ServiceAccountKey {
  const parsedKey = JSON.parse(rawContent) as Partial<ServiceAccountKey>;

  if (!parsedKey.client_email || !parsedKey.private_key) {
    throw new Error(
      "Service account key is missing client_email or private_key."
    );
  }

  return {
    client_email: parsedKey.client_email,
    private_key: normalizePrivateKey(parsedKey.private_key),
    token_uri: parsedKey.token_uri || DEFAULT_TOKEN_URI,
  };
}

async function loadServiceAccountKey(): Promise<ServiceAccountKey> {
  const configuredPath = getServiceAccountKeyPath().trim();
  const looksLikeInlineJson =
    configuredPath.startsWith("{") && configuredPath.endsWith("}");

  if (looksLikeInlineJson) {
    return parseServiceAccountKey(configuredPath);
  }

  const filePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(process.cwd(), configuredPath);

  const fileContent = await readFile(filePath, "utf-8");
  return parseServiceAccountKey(fileContent);
}

function buildSignedJwt({
  clientEmail,
  privateKey,
  tokenUri,
}: {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}) {
  const nowInSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: TOKEN_SCOPE,
    aud: tokenUri,
    iat: nowInSeconds,
    exp: nowInSeconds + TOKEN_EXPIRY_SECONDS,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedJwt = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();

  const signature = toBase64Url(signer.sign(privateKey));

  return `${unsignedJwt}.${signature}`;
}

async function requestAccessTokenOnce(): Promise<AccessTokenCache> {
  const key = await loadServiceAccountKey();
  const tokenUri = key.token_uri || DEFAULT_TOKEN_URI;
  const assertion = buildSignedJwt({
    clientEmail: key.client_email,
    privateKey: key.private_key,
    tokenUri,
  });

  let response: Response;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    TOKEN_REQUEST_TIMEOUT_MS
  );

  try {
    response = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch (error) {
    const retryable = isRetryableTokenNetworkError(error);
    const reason = error instanceof Error ? error.message : "Unknown error";
    throw new ServiceAccountTokenRequestError(
      `Failed to reach service-account token endpoint (${tokenUri}): ${reason}`,
      retryable
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new ServiceAccountTokenRequestError(
      `Failed to fetch service-account access token: ${response.status} - ${errorText}`,
      isRetryableTokenStatus(response.status)
    );
  }

  const tokenResponse = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!tokenResponse.access_token || !tokenResponse.expires_in) {
    throw new Error("Service-account token response is missing access_token.");
  }

  return {
    token: tokenResponse.access_token,
    expiresAtMs: Date.now() + tokenResponse.expires_in * 1000,
  };
}

async function requestAccessToken(): Promise<AccessTokenCache> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TOKEN_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestAccessTokenOnce();
    } catch (error) {
      lastError = error;

      const retryable =
        (error instanceof ServiceAccountTokenRequestError && error.retryable) ||
        isRetryableTokenNetworkError(error);

      if (!retryable || attempt >= TOKEN_REQUEST_MAX_ATTEMPTS) {
        throw error;
      }

      await delay(computeBackoffDelayMs(attempt));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Unable to fetch service-account access token.");
}

export async function getServiceAccountAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < cachedToken.expiresAtMs - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.token;
  }

  const previousToken = cachedToken;

  if (!pendingTokenRequest) {
    pendingTokenRequest = requestAccessToken()
      .then((freshToken) => {
        cachedToken = freshToken;
        return freshToken.token;
      })
      .catch((error) => {
        if (previousToken && Date.now() < previousToken.expiresAtMs) {
          return previousToken.token;
        }

        throw error;
      })
      .finally(() => {
        pendingTokenRequest = null;
      });
  }

  return await pendingTokenRequest;
}
