import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const steamId = searchParams.get("steamId");

  if (!steamId) {
    return NextResponse.json({ error: "Missing steamId" }, { status: 400 });
  }

  try {
    const response = await axios.get(
      `http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_SECRET}&steamid=${steamId}&format=json&include_appinfo=1&include_played_free_games=1`
    );
    return NextResponse.json(response.data);
  } catch (error) {
    console.error("Error fetching games:", error);
    return NextResponse.json({ error: "Failed to fetch games" }, { status: 500 });
  }
}
