import { NextResponse } from "next/server";

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const callbackUrl = searchParams.get("redirectUrl") || "/";
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("callbackUrl", callbackUrl);

  return NextResponse.redirect(loginUrl);
}
