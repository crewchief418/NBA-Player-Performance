import { NextRequest, NextResponse } from "next/server";

type Event = {
  date?: string;
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string }; period?: number; displayClock?: string };
  competitions?: Array<{ competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }> }>;
};

export async function GET(request: NextRequest) {
  const dates = (request.nextUrl.searchParams.get("dates") ?? "").split(",").filter(value => /^\\d{8}$/.test(value)).slice(0,14);
  if (!dates.length) return NextResponse.json({ games: [] });
  const results = await Promise.all(dates.map(async date => {
    try {
      const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`, { next: { revalidate: 15 } });
      if (!response.ok) return [];
      const data = await response.json() as { events?: Event[] };
      return (data.events ?? []).flatMap(event => {
        const competitors = event.competitions?.[0]?.competitors ?? [];
        const home = competitors.find(team => team.homeAway === "home")?.team?.abbreviation;
        const away = competitors.find(team => team.homeAway === "away")?.team?.abbreviation;
        if (!home || !away) return [];
        const normalize = (team: string) => ({ PHX: "PHO", GS: "GSW", NO: "NOP", SA: "SAS", NY: "NYK" } as Record<string,string>)[team] ?? team;
        const status = event.status;
        const state = status?.type?.completed || status?.type?.state === "post" ? "final" : status?.type?.state === "in" ? "live" : "scheduled";
        return [{ date: (event.date ?? "").slice(0,10), home: normalize(home), away: normalize(away), state, displayClock: status?.displayClock, period: status?.period }];
      });
    } catch { return []; }
  }));
  return NextResponse.json({ games: results.flat() }, { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } });
}
