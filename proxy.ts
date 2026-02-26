import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isDevelopmentEnvironment } from "./lib/constants";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthPage = ["/login", "/register"].includes(pathname);
  const isPublicAssetRequest =
    pathname.startsWith("/images/") ||
    (!pathname.startsWith("/api/") && /\.[^/]+$/.test(pathname));

  /*
   * Playwright starts the dev server and requires a 200 status to
   * begin the tests, so this ensures that the tests can start
   */
  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  if (isPublicAssetRequest) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const rawToken = token as { type?: unknown; email?: unknown } | null;
  const tokenType = typeof rawToken?.type === "string" ? rawToken.type : null;
  const tokenEmail = typeof rawToken?.email === "string" ? rawToken.email : "";
  const isLegacyGuestSession =
    tokenType === "guest" || /^guest-\d+$/.test(tokenEmail);

  if (!token || isLegacyGuestSession) {
    if (pathname.startsWith("/api/")) {
      return Response.json(
        {
          code: "unauthorized:auth",
          message: "You need to sign in before continuing.",
        },
        { status: 401 }
      );
    }

    if (isAuthPage) {
      return NextResponse.next();
    }

    const loginUrl = new URL("/login", request.url);
    const callbackPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    loginUrl.searchParams.set("callbackUrl", callbackPath || "/");

    return NextResponse.redirect(loginUrl);
  }

  if (isAuthPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - images (public assets)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    "/((?!_next/static|_next/image|images/|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
