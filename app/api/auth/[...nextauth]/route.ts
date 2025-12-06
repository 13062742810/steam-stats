import NextAuth from "next-auth/next";
import SteamProvider from "next-auth-steam";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> }
) {
  // 优先使用 NEXTAUTH_URL 环境变量（生产环境应设置）
  const origin =
    (process.env.NEXTAUTH_URL && process.env.NEXTAUTH_URL.replace(/\/$/, "")) ||
    // NextRequest.nextUrl?.origin 在 edge 环境或本地 dev 中可能存在
    (req?.nextUrl?.origin ? String(req.nextUrl.origin).replace(/\/$/, "") : "");

  if (!origin) {
    // 更友好的错误信息写入日志并返回 500，便于在 Vercel Logs 中定位问题
    console.error(
      "Missing NEXTAUTH_URL environment variable. Set NEXTAUTH_URL to your site origin, e.g. https://steam-stats-zeta.vercel.app"
    );
    return NextResponse.json(
      {
        error:
          "Missing NEXTAUTH_URL environment variable. Set NEXTAUTH_URL to your site origin (e.g. https://steam-stats-zeta.vercel.app)",
      },
      { status: 500 }
    );
  }

  // 构造绝对回调 URL，避免 provider 内部使用相对路径时报错
  const callbackUrl = `${origin}/api/auth/callback`;

  return NextAuth(req, ctx, {
    providers: [
      // next-auth-steam 接受 req 作为第一个参数（你的原实现方式），这里我们显式传入 callbackUrl
      SteamProvider(req, {
        clientSecret: process.env.STEAM_SECRET!,
        // 一些实现会识别 callbackUrl / returnURL 等字段 —— 显式传入可以避免 provider 内部使用相对路径
        callbackUrl,
      }),
    ],
    pages: {
      error: "/auth/error",
    },
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
