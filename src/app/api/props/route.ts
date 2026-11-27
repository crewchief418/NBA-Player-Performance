import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SPORT = "basketball_nba";
const MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_threes",
  "player_steals",
  "player_blocks",
  "player_points_rebounds_assists"
];
const BOOKMAKERS = [
  "draftkings", "fanduel", "bovada", "betmgm", "betrivers", "unibet", "pinnacle"
];

function normalized(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
function easternDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}
const TEAM_ABBREVIATIONS: Record<string,string> = {
  "atlanta hawks":"ATL","boston celtics":"BOS","brooklyn nets":"BRK","new jersey nets":"BRK",
  "charlotte hornets":"CHO","chicago bulls":"CHI","cleveland cavaliers":"CLE",
  "dallas mavericks":"DAL","denver nuggets":"DEN","detroit pistons":"DET",
  "golden state warriors":"GSW","houston rockets":"HOU","indiana pacers":"IND",
  "la clippers":"LAC","los angeles clippers":"LAC","los angeles lakers":"LAL",
  "memphis grizzlies":"MEM","miami heat":"MIA","milwaukee bucks":"MIL",
  "minnesota timberwolves":"MIN","new orleans pelicans":"NOP","new york knicks":"NYK",
  "oklahoma city thunder":"OKC","orlando magic":"ORL","philadelphia 76ers":"PHI",
  "phoenix suns":"PHO","portland trail blazers":"POR","sacramento kings":"SAC",
  "san antonio spurs":"SAS","toronto raptors":"TOR","utah jazz":"UTA",
  "washington wizards":"WAS"
};

type Outcome = { name?: string; description?: string; price?: number; point?: number; player_id?: string | null };
type PropMarket = { key?: string; last_update?: string; line_type?: string; outcomes?: Outcome[] };
type Book = { key?: string; title?: string; markets?: PropMarket[] };
type Event = { id?: string; home_team?: string; away_team?: string; commence_time?: string; bookmakers?: Book[] };
type InjuryPlayer = { player_name?: string; player_id?: string; espn_athlete_id?: string; team_abbr?: string; status?: string; status_code?: string; injury_type?: string; detail?: string; expected_return?: string };
function injuryStatus(value: unknown) {
  const s=String(value ?? "").toLowerCase().replace(/[_-]+/g," ");
  if(s==="out" || s==="injured list" || s==="suspended" || s==="out first half") return "OUT";
  if(s.includes("doubt")) return "DOUBTFUL";
  if(s.includes("question") || s==="game time decision") return "QUESTIONABLE";
  if(s.includes("day to day")) return "DAY-TO-DAY";
  if(s.includes("prob")) return "PROBABLE";
  if(s==="available" || s==="cleared" || s==="active") return "AVAILABLE";
  return "OTHER";
}
async function loadInjuries(apiKey: string) {
  const response=await fetch("https://api.prop-line.com/v1/sports/basketball_nba/injuries",{
    headers:{"X-API-Key":apiKey,"Accept":"application/json"},cache:"no-store",signal:AbortSignal.timeout(20000)
  });
  if(!response.ok) throw new Error(`PropLine injuries returned HTTP ${response.status}`);
  const body=await response.json();
  if(!Array.isArray(body?.players)) throw new Error("PropLine returned an unexpected injury response.");
  return body.players as InjuryPlayer[];
}

async function loadBoard() {
  const apiKey = process.env.PROPLINE_API_KEY;
  if (!apiKey) throw new Error("PROPLINE_API_KEY is missing from this Vercel environment.");
  const url = new URL(`https://api.prop-line.com/v1/sports/${SPORT}/odds`);
  url.searchParams.set("markets", MARKETS.join(","));
  url.searchParams.set("bookmakers", BOOKMAKERS.join(","));
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey, "Accept": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(45000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.detail?.message || body?.message || body?.error || `PropLine returned HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  if (!Array.isArray(body)) throw new Error("PropLine returned an unexpected odds response.");
  return { events: body as Event[], headers: response.headers };
}

export async function GET() {
  try {
    const result = await pool.query(`
      SELECT pl.id,pl.line,pl.over_odds,pl.under_odds,pl.captured_at,
        pl.scheduled_start,pl.raw_line->>'line_type' line_type,
        pl.raw_line->>'provider_event_id' provider_event_id,
        pl.raw_line->>'market_key' provider_market_key,
        pl.raw_line->>'player_name' provider_player_name,
        pl.raw_line->>'bookmaker_key' bookmaker_key,
        pl.raw_line->>'bookmaker_title' bookmaker_title,
        pl.raw_line->>'last_update' odds_updated_at,
        plr.full_name, g.game_date, ht.abbreviation home_team, at.abbreviation away_team,
        pm.display_name market_name, sb.name sportsbook_name,
        forecast.projected_mean,
        coalesce(injury.status,'UNREPORTED') injury_status,
        injury.injury injury_detail,
        round((forecast.projected_mean-pl.line)::numeric,1) edge
      FROM prop_lines pl
      JOIN games g ON g.id=pl.game_id
      JOIN teams ht ON ht.id=g.home_team_id
      JOIN teams at ON at.id=g.away_team_id
      JOIN players plr ON plr.id=pl.player_id
      JOIN prop_markets pm ON pm.id=pl.market_id
      JOIN sportsbooks sb ON sb.id=pl.sportsbook_id
      JOIN LATERAL (
        SELECT p.projected_mean
        FROM projections p
        JOIN model_versions mv ON mv.id=p.model_version_id
        WHERE p.game_id=pl.game_id AND p.player_id=pl.player_id
          AND p.market_id=pl.market_id
          AND mv.model_key='courtside_player_performance'
          AND p.generated_at<=pl.captured_at
          AND p.generated_at<coalesce(g.scheduled_start,now())
        ORDER BY p.generated_at DESC
        LIMIT 1
      ) forecast ON true
      LEFT JOIN LATERAL (
        SELECT ir.status,ir.injury
        FROM injury_reports ir
        WHERE ir.player_id=pl.player_id AND ir.report_date>=CURRENT_DATE-1
        ORDER BY ir.captured_at DESC
        LIMIT 1
      ) injury ON true
      WHERE pl.source='propline'
        AND pl.captured_at>=now()-interval '72 hours'
        AND g.game_date>=CURRENT_DATE
        AND g.game_date<=CURRENT_DATE+3
        AND coalesce(pl.raw_line->>'line_type','main')='main'
        AND forecast.projected_mean>0
      ORDER BY abs(forecast.projected_mean-pl.line) DESC, pl.captured_at DESC
      LIMIT 300
    `);
    const lastRun = await pool.query(`
      SELECT completed_at,records_received,records_written
      FROM ingestion_runs
      WHERE provider='propline' AND dataset='nba_player_props' AND status='completed'
      ORDER BY completed_at DESC LIMIT 1
    `);
    return NextResponse.json({
      lines: result.rows,
      lastFetchedAt: lastRun.rows[0]?.completed_at ?? null,
      recordsReceived: lastRun.rows[0]?.records_received ?? 0,
      recordsWritten: lastRun.rows[0]?.records_written ?? 0
    });
  } catch (error) {
    console.error("Vegas prop board failed", error);
    return NextResponse.json({ lines: [], error: "Vegas prop comparisons are temporarily unavailable." }, { status: 503 });
  }
}

export async function POST() {
  let runId: number | null = null;
  try {
    const recent = await pool.query(`
      SELECT id,started_at,status,completed_at,records_written
      FROM ingestion_runs
      WHERE provider='propline' AND dataset='nba_player_props'
        AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ORDER BY started_at DESC LIMIT 1
    `);
    const previous = recent.rows[0];
    if (previous?.status === "completed") {
      return NextResponse.json({
        already_fetched: true,
        completed_at: previous.completed_at,
        records_written: previous.records_written
      });
    }
    if (previous?.status === "running") {
      return NextResponse.json({ error: "A Vegas props update is already running." }, { status: 409 });
    }

    const run = await pool.query(`
      INSERT INTO ingestion_runs(provider,dataset,status)
      VALUES('propline','nba_player_props','running') RETURNING id
    `);
    runId = Number(run.rows[0].id);

    const { events, headers } = await loadBoard();
    const injuryPlayers = await loadInjuries(process.env.PROPLINE_API_KEY!);
    const [gameResult, playerResult, marketResult] = await Promise.all([
      pool.query(`
        SELECT g.id,g.game_date::text,ht.abbreviation home,at.abbreviation away,
          g.scheduled_start
        FROM games g
        JOIN teams ht ON ht.id=g.home_team_id
        JOIN teams at ON at.id=g.away_team_id
        WHERE g.game_date BETWEEN CURRENT_DATE-1 AND CURRENT_DATE+7
          AND g.status IN ('scheduled','in_progress')
      `),
      pool.query("SELECT id,full_name,provider_player_id FROM players"),
      pool.query("SELECT id,market_key FROM prop_markets")
    ]);

    const gameMap = new Map<string, any>();
    for (const game of gameResult.rows) gameMap.set(`${game.game_date}| ${game.home}| ${game.away}`.replace(/\s/g,""), game);
    const playerMap = new Map<string, number>();
    for (const player of playerResult.rows) {
      playerMap.set(normalized(player.full_name), Number(player.id));
      const numericId = String(player.provider_player_id ?? "").replace(/^nba:/,"");
      if (numericId) playerMap.set(`id:${numericId}`, Number(player.id));
    }
    const reportDate = easternDate(new Date().toISOString());
    let injuryReportsSaved=0,injuryPlayersUnmatched=0;
    for(const item of injuryPlayers) {
      const espnId=String(item.espn_athlete_id ?? item.player_id ?? "").replace(/^espn:/,"");
      const player=espnId
        ? await pool.query("SELECT id FROM players WHERE provider='espn' AND provider_player_id=$1 LIMIT 1",[espnId])
        : await pool.query("SELECT id FROM players WHERE lower(full_name)=lower($1) LIMIT 1",[item.player_name ?? ""]);
      if(!player.rowCount) { injuryPlayersUnmatched++; continue; }
      const status=injuryStatus(item.status_code ?? item.status);
      const detail=[item.injury_type,item.detail].filter(Boolean).join(" — ") || null;
      await pool.query(`
        INSERT INTO injury_reports(player_id,report_date,status,injury,expected_return,source,raw_report,captured_at)
        VALUES($1,$2,$3,$4,$5,'propline',$6::jsonb,now())
        ON CONFLICT(player_id,report_date,source) DO UPDATE SET
          status=EXCLUDED.status,injury=EXCLUDED.injury,expected_return=EXCLUDED.expected_return,
          raw_report=EXCLUDED.raw_report,captured_at=now()
      `,[Number(player.rows[0].id),reportDate,status,detail,item.expected_return ?? null,JSON.stringify(item)]);
      injuryReportsSaved++;
    }

    const marketMap = new Map<string, number>();
    for (const market of marketResult.rows) marketMap.set(String(market.market_key), Number(market.id));
    const bookIds = new Map<string, number>();
    const rows: any[] = [];
    let outcomesReceived = 0;
    const matchedPlayerIds = new Set<number>();
    const unmatchedPlayerNames = new Set<string>();
    let unmatchedEvents = 0;
    const capturedAt = new Date().toISOString();

    for (const event of events) {
      if (!event.commence_time || !event.home_team || !event.away_team) continue;
      const date = easternDate(event.commence_time);
      const home = TEAM_ABBREVIATIONS[normalized(event.home_team)] ?? "";
      const away = TEAM_ABBREVIATIONS[normalized(event.away_team)] ?? "";
      const gameKey = `${date}|${home}|${away}`;
      const game = gameMap.get(gameKey);
      if (!game) { unmatchedEvents++; continue; }

      for (const book of event.bookmakers ?? []) {
        if (!book.key) continue;
        const bookKey = book.key;
        if (!bookIds.has(bookKey)) {
          const saved = await pool.query(`
            INSERT INTO sportsbooks(provider,provider_book_key,name)
            VALUES('propline',$1,$2)
            ON CONFLICT(provider,provider_book_key)
            DO UPDATE SET name=EXCLUDED.name,active=true
            RETURNING id
          `, [bookKey, book.title ?? bookKey]);
          bookIds.set(bookKey, Number(saved.rows[0].id));
        }
        const sportsbookId = bookIds.get(bookKey)!;

        for (const market of book.markets ?? []) {
          if (!market.key || !marketMap.has(market.key)) continue;
          const grouped = new Map<string, any>();
          for (const outcome of market.outcomes ?? []) {
            outcomesReceived++;
            const rawName = outcome.description ?? "";
            const playerId = (outcome.player_id ? playerMap.get(`id:${String(outcome.player_id).replace(/^nba:/,"")}`) : undefined)
              ?? playerMap.get(normalized(rawName));
            if (!playerId) { if (rawName) unmatchedPlayerNames.add(normalized(rawName)); continue; }
            const point = Number(outcome.point);
            if (!Number.isFinite(point)) continue;
            const key = `${playerId}|${point}`;
            if (!grouped.has(key)) grouped.set(key, {
              playerId, point, overOdds: null, underOdds: null, playerName: rawName,
              providerPlayerId: outcome.player_id ?? null, outcomes: []
            });
            const line = grouped.get(key);
            line.outcomes.push(outcome);
            const side = String(outcome.name ?? "").toLowerCase();
            const price = Number(outcome.price);
            if (Number.isFinite(price) && side.startsWith("over")) line.overOdds = price;
            if (Number.isFinite(price) && side.startsWith("under")) line.underOdds = price;
          }

          for (const line of grouped.values()) {
            if (line.overOdds === null && line.underOdds === null) continue;
            matchedPlayerIds.add(line.playerId);
            rows.push({
              game_id: Number(game.id),
              player_id: line.playerId,
              sportsbook_id: sportsbookId,
              market_id: marketMap.get(market.key),
              line: line.point,
              over_odds: line.overOdds,
              under_odds: line.underOdds,
              captured_at: capturedAt,
              scheduled_start: event.commence_time,
              raw_line: {
                provider: "propline",
                provider_event_id: event.id ?? null,
                provider_player_id: line.providerPlayerId,
                player_name: line.playerName,
                market_key: market.key,
                bookmaker_key: bookKey,
                bookmaker_title: book.title ?? bookKey,
                last_update: market.last_update ?? null,
                line_type: market.line_type ?? "main",
                outcomes: line.outcomes
              }
            });
          }
        }
      }
    }

    const playersMatched = matchedPlayerIds.size;
    const unmatchedPlayers = unmatchedPlayerNames.size;

    if (rows.length) {
      await pool.query(`
        INSERT INTO prop_lines(
          game_id,player_id,sportsbook_id,market_id,line,over_odds,under_odds,
          snapshot_type,captured_at,scheduled_start,source,raw_line
        )
        SELECT x.game_id,x.player_id,x.sportsbook_id,x.market_id,x.line,x.over_odds,x.under_odds,
          'current',x.captured_at,x.scheduled_start,'propline',x.raw_line
        FROM jsonb_to_recordset($1::jsonb) AS x(
          game_id bigint,player_id bigint,sportsbook_id bigint,market_id bigint,line numeric,
          over_odds integer,under_odds integer,captured_at timestamptz,scheduled_start timestamptz,raw_line jsonb
        )
        ON CONFLICT(game_id,player_id,sportsbook_id,market_id,line,captured_at,source)
        DO UPDATE SET over_odds=EXCLUDED.over_odds,under_odds=EXCLUDED.under_odds,raw_line=EXCLUDED.raw_line
      `, [JSON.stringify(rows)]);
    }

    await pool.query(`
      UPDATE ingestion_runs
      SET status='completed',completed_at=now(),records_received=$2,records_written=$3,
        metadata=$4::jsonb
      WHERE id=$1
    `, [runId, outcomesReceived, rows.length, JSON.stringify({
      events_received: events.length, players_matched: playersMatched,
      unmatched_players: unmatchedPlayers, unmatched_events: unmatchedEvents,
      injury_reports_saved: injuryReportsSaved, injury_players_unmatched: injuryPlayersUnmatched,
      daily_limit: headers.get("x-daily-limit"), daily_remaining: headers.get("x-daily-remaining"),
      missing_markets: headers.get("x-propline-missing-markets")
    })]);

    return NextResponse.json({
      success: true, events_received: events.length, outcomes_received: outcomesReceived,
      records_written: rows.length, players_matched: playersMatched,
      unmatched_players: unmatchedPlayers, unmatched_events: unmatchedEvents,
      injury_reports_saved: injuryReportsSaved, injury_players_unmatched: injuryPlayersUnmatched,
      daily_limit: headers.get("x-daily-limit"),
      daily_remaining: headers.get("x-daily-remaining"),
      fetched_at: capturedAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vegas props update failed.";
    if (runId !== null) {
      await pool.query(`
        UPDATE ingestion_runs SET status='failed',completed_at=now(),error_message=$2
        WHERE id=$1
      `, [runId, message]).catch(() => {});
    }
    console.error("PropLine import failed", error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
