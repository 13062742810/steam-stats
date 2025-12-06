import { NextRequest, NextResponse } from "next/server";

/**
 * API: GET /api/steam/library?steamId=...&limit=50&offset=0&includeAppInfo=0
 *
 * Behavior:
 * - default includeAppInfo=0 (faster). If includeAppInfo=1, the route will only fetch detailed appinfo for the first `limit` games.
 * - supports limit/offset for pagination to avoid returning the whole library at once.
 * - has a 10s timeout for Steam requests and simple in-memory TTL cache (ephemeral).
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

    const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 50)); // cap 100
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    const includeAppInfo = url.searchParams.get("includeAppInfo") === "1" ? 1 : 0;

    const cacheKey = `owned:${steamId}:limit=${limit}:off=${offset}:info=${includeAppInfo}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      console.log(`[library] cache hit ${cacheKey} (${Date.now() - start} ms)`);
      return NextResponse.json(cached);
    }

    // Step 1: request owned games with include_appinfo=0 (much smaller)
    const apiBase = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
    const qs = `?key=${encodeURIComponent(STEAM_KEY)}&steamid=${encodeURIComponent(
      steamId
    )}&include_appinfo=0&include_played_free_games=1`;
    const apiUrl = apiBase + qs;

    console.log(`[library] calling Steam GetOwnedGames (no appinfo) for ${steamId}`);
    const res = await fetchWithTimeout(apiUrl, { method: "GET" }, 10000).catch((e) => {
      if ((e as any).name === "AbortError") {
        return null;
      }
      throw e;
    });

    if (!res) {
      return NextResponse.json({ error: "Steam API request timed out" }, { status: 504 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[library] Steam API non-OK:", res.status, text.slice(0, 500));
      return NextResponse.json({ error: "Steam API error", status: res.status, body: text }, { status: 502 });
    }

    const data = await res.json().catch(() => null);
    if (!data || !data.response) {
      return NextResponse.json({ error: "Unexpected Steam response" }, { status: 502 });
    }

    const totalCount = data.response.game_count ?? (data.response.games?.length ?? 0);
    const allGames = Array.isArray(data.response.games) ? data.response.games : [];

    // apply offset/limit in-memory (Steam doesn't support offset param)
    const pageGames = allGames.slice(offset, offset + limit);

    // If includeAppInfo requested, fetch appinfo only for the pageGames (to reduce bandwidth)
    let detailed: any[] | undefined = undefined;
    if (includeAppInfo && pageGames.length > 0) {
      // Fetch app details via Steam Store API (one request per app could be heavy).
      // We'll fetch limited appinfo by calling store API per app but only for pageGames (limit capped).
      detailed = [];
      const promises = pageGames.map(async (g: any) => {
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
      });
      const results = await Promise.all(promises);
      detailed = results;
    }

    const out = {
      totalCount,
      games: includeAppInfo ? detailed ?? pageGames : pageGames,
      offset,
      limit,
    };

    // cache short-lived
    cacheSet(cacheKey, out);

    console.log(`[library] completed in ${Date.now() - start} ms totalCount=${totalCount} page=${pageGames.length}`);
    return NextResponse.json(out);
  } catch (err) {
    console.error("[library] unexpected error", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}