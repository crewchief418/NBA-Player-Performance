import { NextRequest, NextResponse } from "next/server";

type Event = {
  id?: string;
  date?: string;
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string }; period?: number; displayClock?: string };
  competitions?: Array<{ competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }> }>;
};

export async function GET(request: NextRequest) {
  const dates = (request.nextUrl.searchParams.get("dates") ?? "").split(",").filter(value => /^\d{8}$/.test(value)).slice(0,14);
  if (!dates.length) return NextResponse.json({ games: [] });
  const results = await Promise.all(dates.map(async date => {
    try {
      const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`, { next: { revalidate: 15 } });
      if (!response.ok) return [];
      const data = await response.json() as { events?: Event[] };
      const games = await Promise.all((data.events ?? []).map(async event => {
        const competitors = event.competitions?.[0]?.competitors ?? [];
        const home = competitors.find(team => team.homeAway === "home")?.team?.abbreviation;
        const away = competitors.find(team => team.homeAway === "away")?.team?.abbreviation;
        if (!home || !away || !event.id) return null;
        const normalize = (team: string) => ({ PHX: "PHO", GS: "GSW", NO: "NOP", SA: "SAS", NY: "NYK" } as Record<string,string>)[team] ?? team;
        const status = event.status;
        const state = status?.type?.completed || status?.type?.state === "post" ? "final" : status?.type?.state === "in" ? "live" : "scheduled";
        let total: number | null = null;
        let spread: number | null = null;
        try {
          const oddsResponse = await fetch(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${event.id}/competitions/${event.id}/odds`, { next: { revalidate: 300 } });
          if (oddsResponse.ok) {
            const odds = await oddsResponse.json() as { items?: Array<{ overUnder?: number; spread?: number; provider?: { priority?: number } }> };
            const available = (odds.items ?? []).filter(item => typeof item.overUnder === "number");
            available.sort((a,b) => (a.provider?.priority ?? 999) - (b.provider?.priority ?? 999));
            total = available[0]?.overUnder ?? null;
            spread = available[0]?.spread ?? null;
          }
        } catch { /* Odds may not be posted for every game. */ }
        const eventDate = event.date ? new Date(event.date) : null;
        const dateParts = eventDate && !Number.isNaN(eventDate.getTime())
          ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(eventDate)
          : [];
        const localDate = dateParts.length
          ? `${dateParts.find(part => part.type === "year")?.value}-${dateParts.find(part => part.type === "month")?.value}-${dateParts.find(part => part.type === "day")?.value}`
          : "";
        return { date: localDate, home: normalize(home), away: normalize(away), state, displayClock: status?.displayClock, period: status?.period, total, spread };
      }));
      return games.filter((game): game is NonNullable<typeof game> => game !== null);
    } catch { return []; }
  }));
  return NextResponse.json({ games: results.flat() }, { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } });
}
