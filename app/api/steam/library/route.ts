import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight paginated Steam library API
 *
 * - default limit reduced (10) to minimize payload and parsing time
 * - default includeAppInfo=0 (only minimal fields). If includeAppInfo=1 it fetches store appdetails
 *   for the page with controlled concurrency (concurrency default 3).
 * - Cache-Control header and short in-memory TTL cache (ephemeral on serverless).
 *
 * Production recommendations (outside this file):
 * - Use Vercel KV / Redis for persistent cache across instances.
 * - Consider background prefetch (cron) to warm cache for active users.
 * - Use client-side virtualized list (react-window) and incremental loading.
 */

type CacheEntry = { ts: number; value: any };
const CACHE_TTL = 60 * 5 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// limited concurrency mapper
async function mapWithConcurrency<T, R>(items: T[], fn: (t: T) => Promise<R>, concurrency = 3) {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        results[idx] = null as any;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function cacheGet(key: string) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.ts > CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return e.value;
}
function cacheSet(key: string, value: any) {
  cache.set(key, { ts: Date.now(), value });
}

export async function GET(req: NextRequest) {
  const start = Date.now();
  try {
    const STEAM_KEY = process.env.STEAM_API_KEY ?? process.env.STEAM_SECRET;
    if (!STEAM_KEY) {
      return NextResponse.json({ error: "Server misconfiguration: missing STEAM_API_KEY" }, { status: 500 });
    }

    const url = new URL(req.url);
    const steamId = url.searchParams.get("steamId");
    if (!steamId) {
      return NextResponse.json({ error: "Missing steamId parameter" }, { status: 400 });
    }

    // defaults: much smaller page to reduce payload and parsing time
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 10))); // default 10
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    const includeAppInfo = url.searchParams.get("includeAppInfo") === "1" ? 1 : 0;
    const mode = url.searchParams.get("mode") ?? "list"; // list or top

    const cacheKey = `owned:${steamId}:limit=${limit}:off=${offset}:info=${includeAppInfo}:mode=${mode}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      console.log(`[library] cache hit ${cacheKey} (${Date.now() - start} ms)`);
      return NextResponse.json(cached, { headers: { "Cache-Control": "public, max-age=60" } });
    }

    const apiBase = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
    const qs = `?key=${encodeURIComponent(STEAM_KEY)}&steamid=${encodeURIComponent(
      steamId
    )}&include_appinfo=0&include_played_free_games=1`;
    const apiUrl = apiBase + qs;

    console.log(`[library] calling Steam GetOwnedGames (no appinfo) for ${steamId}`);
    const res = await fetchWithTimeout(apiUrl, { method: "GET" }, 10000).catch((e) => {
      if ((e as any).name === "AbortError") return null;
      throw e;
    });

    if (!res) return NextResponse.json({ error: "Steam API request timed out" }, { status: 504 });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[library] Steam API non-OK:", res.status, text.slice(0, 500));
      return NextResponse.json({ error: "Steam API error", status: res.status, body: text }, { status: 502 });
    }

    const data = await res.json().catch(() => null);
    if (!data || !data.response) return NextResponse.json({ error: "Unexpected Steam response" }, { status: 502 });

    const allGames = Array.isArray(data.response.games) ? data.response.games : [];

    // transform to minimal fields for speed (only fields frontend needs for summary)
    const minimal = allGames.map((g: any) => ({
      appid: g.appid,
      playtime_forever: g.playtime_forever ?? 0,
      rtime_last_played: g.rtime_last_played ?? 0,
    }));

    // optionally sort for top mode
    if (mode === "top") {
      minimal.sort((a: any, b: any) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
    }

    const pageGames = minimal.slice(offset, offset + limit);

    // when includeAppInfo requested, fetch details for only the page with controlled concurrency
    let detailed: any[] | undefined = undefined;
    if (includeAppInfo && pageGames.length > 0) {
      const fetchApp = async (g: any) => {
        const appid = g.appid;
        try {
          const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
          const r = await fetchWithTimeout(storeUrl, { method: "GET" }, 8000);
          if (!r || !r.ok) return { ...g };
          const j = await r.json();
          const info = j?.[String(appid)]?.data ?? null;
          return { ...g, appinfo: info };
        } catch (err) {
          console.warn("[library] appinfo fetch error for", appid, err);
          return { ...g };
        }
      };

      // controlled concurrency = 3 by default (adjust if you need faster but risk rate-limit)
      detailed = await mapWithConcurrency(pageGames, fetchApp, 3);
    }

    const out = {
      totalCount: data.response.game_count ?? minimal.length,
      games: includeAppInfo ? detailed ?? pageGames : pageGames,
      offset,
      limit,
      mode,
    };

    // short in-memory cache
    cacheSet(cacheKey, out);

    console.log(`[library] completed in ${Date.now() - start} ms totalCount=${out.totalCount} page=${out.games.length}`);

    return NextResponse.json(out, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (err) {
    console.error("[library] unexpected error", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
