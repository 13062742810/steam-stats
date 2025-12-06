import NextAuth from "next-auth/next";
import SteamProvider from "next-auth-steam";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> }
) {
  // 获取站点 origin（优先使用 NEXTAUTH_URL）
  const origin =
    (process.env.NEXTAUTH_URL && process.env.NEXTAUTH_URL.replace(/\/$/, "")) ||
    (req?.nextUrl?.origin ? String(req.nextUrl.origin).replace(/\/$/, "") : "");

  // 支持两个 ENV 名称，避免命名不一致的问题
  const steamKey = process.env.STEAM_SECRET ?? process.env.STEAM_API_KEY;
  const nextAuthSecret = process.env.NEXTAUTH_SECRET;

  const missing: string[] = [];
  if (!origin) missing.push("NEXTAUTH_URL");
  if (!nextAuthSecret) missing.push("NEXTAUTH_SECRET");
  if (!steamKey) missing.push("STEAM_SECRET or STEAM_API_KEY");

  if (missing.length > 0) {
    const msg = `Missing required environment variable(s): ${missing.join(
      ", "
    )}. Set them in Vercel Project Settings and redeploy.`;
    console.error(msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // 在日志中仅记录是否存在（不要打印密钥）
  console.log("NEXTAUTH_URL present:", !!origin);
  console.log("NEXTAUTH_SECRET present:", !!nextAuthSecret);
  console.log("STEAM key present:", !!steamKey);

  const callbackUrl = `${origin}/api/auth/callback`;

  return NextAuth(req, ctx, {
    providers: [
      // 已在上方运行时检查 steamKey 存在，使用非空断言告诉 TS 这是 string
      SteamProvider(req, {
        clientSecret: steamKey!,
        callbackUrl,
      }),
    ],
    pages: {
      error: "/auth/error",
    },
    secret: nextAuthSecret!,
    callbacks: {
      async session({ session, token }) {
        if (session?.user) {
          // @ts-expect-error - steamId is not in the default types
          session.user.steamId = token.sub?.split("/").pop() || token.sub;
        }
        return session;
      },
      async jwt({ token, account, profile }) {
        if (account?.provider === "steam" && profile) {
          // @ts-expect-error - steamid is in profile
          token.steamId = profile.steamid;
        }
        return token;
      },
    },
  });
}

export { handler as GET, handler as POST };
