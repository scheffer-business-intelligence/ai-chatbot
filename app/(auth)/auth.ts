import NextAuth, { customFetch, type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import { authConfig } from "./auth.config";

export type UserType = "regular";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
    } & DefaultSession["user"];
  }

  interface User {
    id?: string;
    email?: string | null;
    type?: UserType;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id: string;
    type: UserType;
  }
}

const allowedGoogleDomain =
  process.env.AUTH_GOOGLE_ALLOWED_DOMAIN?.trim().toLowerCase();

const RETRYABLE_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

function toPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

const GOOGLE_FETCH_TIMEOUT_MS = toPositiveInt(
  process.env.AUTH_GOOGLE_FETCH_TIMEOUT_MS,
  15_000
);
const GOOGLE_FETCH_MAX_ATTEMPTS = toPositiveInt(
  process.env.AUTH_GOOGLE_FETCH_RETRIES,
  2
);

function extractErrorCode(error: unknown) {
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

function isRetryableNetworkError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  const code = extractErrorCode(error);
  if (!code) {
    return false;
  }

  return RETRYABLE_NETWORK_CODES.has(code);
}

function resolveGoogleFallbackUrl(url: URL) {
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return "https://www.googleapis.com/oauth2/v4/token";
  }

  if (
    url.hostname === "openidconnect.googleapis.com" &&
    url.pathname === "/v1/userinfo"
  ) {
    return "https://www.googleapis.com/oauth2/v3/userinfo";
  }

  return null;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const googleFetchWithRetry: typeof fetch = async (input, init) => {
  const baseRequest = new Request(input, init);
  const originalUrl = new URL(baseRequest.url);
  const fallbackUrl = resolveGoogleFallbackUrl(originalUrl);
  const urlsToTry = fallbackUrl
    ? [originalUrl.toString(), fallbackUrl]
    : [originalUrl.toString()];

  let lastError: unknown;

  for (const url of urlsToTry) {
    for (let attempt = 1; attempt <= GOOGLE_FETCH_MAX_ATTEMPTS; attempt++) {
      try {
        const request = new Request(url, baseRequest.clone());
        const requestInit: RequestInit = {};

        if (!init?.signal && typeof AbortSignal.timeout === "function") {
          requestInit.signal = AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS);
        }

        return await fetch(request, requestInit);
      } catch (error) {
        lastError = error;

        if (!isRetryableNetworkError(error)) {
          throw error;
        }

        if (attempt < GOOGLE_FETCH_MAX_ATTEMPTS) {
          await delay(attempt * 300);
        }
      }
    }
  }

  throw lastError;
};

const googleProvider = {
  ...Google({
    clientId: process.env.AUTH_GOOGLE_ID,
    clientSecret: process.env.AUTH_GOOGLE_SECRET,
    authorization: {
      url: "https://accounts.google.com/o/oauth2/v2/auth",
      params: {
        scope: "openid email profile",
        prompt: "select_account",
        ...(allowedGoogleDomain ? { hd: allowedGoogleDomain } : {}),
      },
    },
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    [customFetch]: googleFetchWithRetry,
  }),
  type: "oauth" as const,
  checks: ["pkce", "state"],
} as Provider;

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  providers: [googleProvider],
  callbacks: {
    signIn({ user, account }) {
      if (account?.provider !== "google" || !allowedGoogleDomain) {
        return true;
      }

      const email = user.email?.toLowerCase() ?? "";
      const domain = email.split("@")[1];

      return domain === allowedGoogleDomain;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = (user.id as string | undefined) ?? token.sub ?? "";
        token.type = user.type ?? "regular";
      }

      if (!token.id && token.sub) {
        token.id = token.sub;
      }

      if (!token.type) {
        token.type = "regular";
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id || token.sub || "";
        session.user.type = token.type ?? "regular";
      }

      return session;
    },
  },
});
