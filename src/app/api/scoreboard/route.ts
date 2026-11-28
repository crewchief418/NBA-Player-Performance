import { NextRequest, NextResponse } from "next/server";

type Event = {
  id?: string;
  date?: string;
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string }; period?: number; displayClock?: string };
  competitions?: Array<{ competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>; odds?: Array<any> }>;
};

async function loadOdds(eventId: string, embedded: any[] = []) {
  const candidates: any[] = [];
  const collect = async (items: any[]) => {
    for (const item of items ?? []) {
      if (item && typeof item.overUnder === "number") {
        candidates.push(item);
        continue;
      }
      const ref = item?.$ref ?? item?.ref ?? item?.href;
      if (typeof ref === "string" && ref.startsWith("https://sports.core.api.espn.com/")) {
        try {
          const response = await fetch(ref, { next: { revalidate: 300 }, signal: AbortSignal.timeout(10000) });
          if (response.ok) {
            const value = await response.json();
            if (typeof value?.overUnder === "number") candidates.push(value);
          }
        } catch { /* Keep trying other provider odds references. */ }
      }
    }
  };
  await collect(embedded);
  try {
    const url = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${eventId}/competitions/${eventId}/odds?limit=100`;
    const response = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(12000) });
    if (response.ok) {
      const payload = await response.json();
      if (Array.isArray(payload)) await collect(payload);
      else await collect(payload?.items ?? []);
      if (typeof payload?.overUnder === "number") candidates.push(payload);
    }
  } catch { /* Odds may not be posted for every game. */ }
  candidates.sort((a,b) => (a.provider?.priority ?? 999) - (b.provider?.priority ?? 999));
  const best = candidates[0];
  return {
    total: typeof best?.overUnder === "number" ? best.overUnder : null,
    spread: typeof best?.spread === "number" ? best.spread : null
  };
}

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
        const gameOdds = await loadOdds(event.id, event.competitions?.[0]?.odds ?? []);
        const total = gameOdds.total;
        const spread = gameOdds.spread;
        const eventDate = event.date ? new Date(event.date) : null;
        const dateParts = eventDate && !Number.isNaN(eventDate.getTime())
          ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(eventDate)
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
