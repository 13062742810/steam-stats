import { NextRequest, NextResponse } from "next/server";

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

function preview(text: string | null | undefined, max = 500) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const appid = url.searchParams.get("appid");
    const type = url.searchParams.get("type") ?? "appdetails";
    const steamId = url.searchParams.get("steamId");

    if (!appid) return NextResponse.json({ error: "Missing 'appid' parameter" }, { status: 400 });

    if (type === "appdetails") {
      const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&l=english`;
      const res = await fetchWithTimeout(storeUrl, { method: "GET" }, 8000);
      if (!res) return NextResponse.json({ error: "Store API timeout" }, { status: 504 });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("[games] store non-OK", res.status, preview(text));
        return NextResponse.json({ error: "Store API error", status: res.status, bodyPreview: preview(text) }, { status: 502 });
      }
      const data = await res.json().catch(() => null);
      if (!data) return NextResponse.json({ error: "Invalid store JSON" }, { status: 502 });
      return NextResponse.json(data);
    }

    if (type === "userstats") {
      const STEAM_KEY = process.env.STEAM_API_KEY ?? process.env.STEAM_SECRET;
      if (!STEAM_KEY) {
        console.error("[games] missing STEAM key env");
        return NextResponse.json({ error: "Server misconfiguration: missing STEAM_API_KEY" }, { status: 500 });
      }
      if (!steamId) return NextResponse.json({ error: "Missing 'steamId' for userstats" }, { status: 400 });

      const statsUrl = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=${encodeURIComponent(
        STEAM_KEY
      )}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appid)}`;

      const res = await fetchWithTimeout(statsUrl, { method: "GET" }, 8000);
      if (!res) return NextResponse.json({ error: "Steam API timeout" }, { status: 504 });

      const bodyText = await res.text().catch(() => "");
      if (res.status === 401) {
        console.error("[games] Steam 401 userstats body:", preview(bodyText));
        return NextResponse.json(
          { error: "Unauthorized from Steam (401). Check STEAM_API_KEY, domain and key validity.", status: 401, bodyPreview: preview(bodyText) },
          { status: 401 }
        );
      }
      if (!res.ok) {
        console.error("[games] Steam non-OK userstats", res.status, preview(bodyText));
        return NextResponse.json({ error: "Steam API error", status: res.status, bodyPreview: preview(bodyText) }, { status: 502 });
      }
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch (e) {
        console.error("[games] failed parse userstats JSON:", e);
        return NextResponse.json({ error: "Invalid JSON from Steam userstats", bodyPreview: preview(bodyText) }, { status: 502 });
      }
      return NextResponse.json(data);
    }

    return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
  } catch (err) {
    console.error("[games] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
