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

let cachedToken: AccessTokenCache | null = null;
let pendingTokenRequest: Promise<string> | null = null;

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

async function loadServiceAccountKey(): Promise<ServiceAccountKey> {
  const configuredPath = getServiceAccountKeyPath();
  const filePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(process.cwd(), configuredPath);

  const fileContent = await readFile(filePath, "utf-8");
  const parsedKey = JSON.parse(fileContent) as Partial<ServiceAccountKey>;

  if (!parsedKey.client_email || !parsedKey.private_key) {
    throw new Error(
      "Service account key is missing client_email or private_key."
    );
  }

  return {
    client_email: parsedKey.client_email,
    private_key: parsedKey.private_key,
    token_uri: parsedKey.token_uri || DEFAULT_TOKEN_URI,
  };
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

async function requestAccessToken(): Promise<AccessTokenCache> {
  const key = await loadServiceAccountKey();
  const assertion = buildSignedJwt({
    clientEmail: key.client_email,
    privateKey: key.private_key,
    tokenUri: key.token_uri || DEFAULT_TOKEN_URI,
  });

  const response = await fetch(key.token_uri || DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch service-account access token: ${response.status} - ${errorText}`
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

export async function getServiceAccountAccessToken(): Promise<string> {
  if (
    cachedToken &&
    Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedToken.token;
  }

  if (!pendingTokenRequest) {
    pendingTokenRequest = requestAccessToken()
      .then((freshToken) => {
        cachedToken = freshToken;
        return freshToken.token;
      })
      .finally(() => {
        pendingTokenRequest = null;
      });
  }

  return await pendingTokenRequest;
}
