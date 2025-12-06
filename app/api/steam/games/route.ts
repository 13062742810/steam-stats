import { NextRequest, NextResponse } from "next/server";

/**
 * Safe proxy for a few Steam endpoints used by the frontend.
 * - GET /api/steam/games?appid=570                -> calls Store API appdetails (no key)
 * - GET /api/steam/games?appid=570&type=userstats&steamId=... 
 *     -> calls ISteamUserStats/GetUserStatsForGame/v1 (requires STEAM_API_KEY)
 *
 * This route:
 * - validates input
 * - requires STEAM_API_KEY for endpoints that need it
 * - uses fetchWithTimeout and logs HTTP status + brief body preview on error
 * - returns sanitized JSON to the client (never reveals API keys)
 */

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

function previewText(text: string | null | undefined, max = 500) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const appid = url.searchParams.get("appid");
  const type = url.searchParams.get("type") ?? "appdetails"; // default to store appdetails
  const steamId = url.searchParams.get("steamId");

  if (!appid) {
    return NextResponse.json({ error: "Missing 'appid' query parameter" }, { status: 400 });
  }

  try {
    if (type === "appdetails") {
      // Steam store app details (no key required)
      const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&l=english`;
      console.log(`[games] calling store API for appid=${appid}`);
      const res = await fetchWithTimeout(storeUrl, { method: "GET" }, 8000);
      if (!res) {
        console.error("[games] store API request timed out for appid=", appid);
        return NextResponse.json({ error: "Store API request timed out" }, { status: 504 });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("[games] store API non-OK", res.status, previewText(text));
        return NextResponse.json({ error: "Store API error", status: res.status, bodyPreview: previewText(text) }, { status: 502 });
      }
      const data = await res.json().catch((e) => {
        console.error("[games] failed to parse store JSON", e);
        return null;
      });
      if (!data) {
        return NextResponse.json({ error: "Invalid JSON from store API" }, { status: 502 });
      }
      // Return the app details object (the Store API returns { "<appid>": { success: true, data: {...} } })
      return NextResponse.json(data);
    } else if (type === "userstats") {
      // Requires STEAM_API_KEY and steamId
      const STEAM_KEY = process.env.STEAM_API_KEY ?? process.env.STEAM_SECRET;
      if (!STEAM_KEY) {
        console.error("[games] missing STEAM_API_KEY / STEAM_SECRET for userstats");
        return NextResponse.json({ error: "Server misconfiguration: missing STEAM_API_KEY" }, { status: 500 });
      }
      if (!steamId) {
        return NextResponse.json({ error: "Missing 'steamId' query parameter for userstats" }, { status: 400 });
      }
      const statsUrl = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${encodeURIComponent(
        STEAM_KEY
      )}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appid)}`;

      console.log(`[games] calling GetUserStatsForGame for steamId=${steamId} appid=${appid}`);
      const res = await fetchWithTimeout(statsUrl, { method: "GET" }, 8000);
      if (!res) {
        console.error("[games] userstats request timed out for", appid, steamId);
        return NextResponse.json({ error: "Steam API request timed out" }, { status: 504 });
      }

      if (res.status === 401) {
        // Provide actionable log without returning the key
        const text = await res.text().catch(() => "");
        console.error("[games] Steam returned 401 for userstats. Body preview:", previewText(text));
        return NextResponse.json(
          { error: "Unauthorized from Steam API (401). Check your STEAM_API_KEY and that it is valid for your domain.", bodyPreview: previewText(text) },
          { status: 401 }
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("[games] userstats non-OK", res.status, previewText(text));
        return NextResponse.json({ error: "Steam API error", status: res.status, bodyPreview: previewText(text) }, { status: 502 });
      }

      const data = await res.json().catch(() => null);
      if (!data) {
        console.error("[games] failed to parse userstats JSON");
        return NextResponse.json({ error: "Invalid JSON from Steam userstats" }, { status: 502 });
      }
      return NextResponse.json(data);
    } else {
      return NextResponse.json({ error: `Unsupported type param: ${type}` }, { status: 400 });
    }
  } catch (err) {
    console.error("[games] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
