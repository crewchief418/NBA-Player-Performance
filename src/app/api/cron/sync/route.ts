import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const SEASON = 2027;
const CANON: Record<string, string> = {
  ATL:"ATL", BOS:"BOS", BKN:"BRK", CHA:"CHO", CHI:"CHI", CLE:"CLE",
  DAL:"DAL", DEN:"DEN", DET:"DET", GS:"GSW", HOU:"HOU", IND:"IND",
  LAC:"LAC", LAL:"LAL", MEM:"MEM", MIA:"MIA", MIL:"MIL", MIN:"MIN",
  NO:"NOP", NY:"NYK", OKC:"OKC", ORL:"ORL", PHI:"PHI", PHX:"PHO",
  POR:"POR", SAC:"SAC", SA:"SAS", TOR:"TOR", UTAH:"UTA", WSH:"WAS"
};

type EspnTeam = { id: string; abbreviation: string; displayName: string };
type EspnEvent = {
  id: string; date: string; name?: string; competitors: Array<{
    homeAway: string; team_id: string; abbr: string; score?: string;
  }>;
  completed: boolean; status_name?: string; status_detail?: string;
  neutralSite?: boolean;
};

async function espn(path: string, params?: Record<string, string>) {
  const url = new URL(ESPN + path);
  Object.entries(params ?? {}).forEach(([k,v]) => url.searchParams.set(k,v));
  let lastError: unknown;
  for (let attempt=0; attempt<4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "CourtsidePlayerModel/1.0" },
        cache: "no-store",
        signal: AbortSignal.timeout(25000)
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) { await new Promise(r => setTimeout(r, (attempt+1)*1500)); continue; }
      }
      if (!response.ok) throw new Error(`ESPN ${response.status} at ${path}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(r => setTimeout(r, (attempt+1)*1000));
    }
  }
  throw lastError ?? new Error("ESPN request failed");
}

function gameDate(date: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(date));
}
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "--") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function made(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).split("-")[0]);
  return Number.isFinite(n) ? n : null;
}
function minutes(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "--") return null;
  const s = String(value);
  if (s.includes(":")) {
    const [m, sec] = s.split(":").map(Number);
    return Number.isFinite(m) && Number.isFinite(sec) ? m + sec/60 : null;
  }
  return numeric(s);
}

function asTeam(item: any): EspnTeam {
  const t = item.team ?? item;
  return { id: String(t.id), abbreviation: String(t.abbreviation), displayName: String(t.displayName ?? t.name) };
}

function asEvent(event: any): EspnEvent | null {
  const competition = event.competitions?.[0];
  if (!event.id || !event.date || !competition) return null;
  const status = competition.status?.type ?? {};
  const competitors = (competition.competitors ?? []).map((x: any) => ({
    homeAway: x.homeAway,
    team_id: String(x.team?.id ?? ""),
    abbr: String(x.team?.abbreviation ?? ""),
    score: x.score
  }));
  if (competitors.length !== 2) return null;
  return {
    id: String(event.id), date: event.date, name: event.name,
    competitors, completed: Boolean(status.completed),
    status_name: status.name, status_detail: status.detail,
    neutralSite: Boolean(competition.neutralSite)
  };
}

async function mapLimit<T,U>(items: T[], limit: number, fn: (item:T)=>Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function importBoxscore(event: EspnEvent, teamDb: Map<string, number>, gameDb: Map<string, number>) {
  const summary = await espn("/summary", { event: event.id });
  const gameId = gameDb.get(event.id);
  if (!gameId) throw new Error(`Missing database game ${event.id}`);
  const sides = event.competitors;
  const home = sides.find(x => x.homeAway === "home");
  const away = sides.find(x => x.homeAway === "away");
  if (!home || !away) throw new Error(`Missing home/away for ${event.id}`);
  const homeAbbr = CANON[home.abbr] ?? home.abbr;
  const awayAbbr = CANON[away.abbr] ?? away.abbr;
  const homeDb = teamDb.get(homeAbbr);
  const awayDb = teamDb.get(awayAbbr);
  if (!homeDb || !awayDb) throw new Error(`Unknown team for ${event.id}`);

  const boxTeams = summary.boxscore?.players ?? [];
  let written = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const side of boxTeams) {
      const sideAbbr = CANON[String(side.team?.abbreviation ?? "")] ?? String(side.team?.abbreviation ?? "");
      const teamId = teamDb.get(sideAbbr);
      const opponentId = teamId === homeDb ? awayDb : homeDb;
      if (!teamId) continue;
      for (const category of (side.statistics ?? [])) {
        const labels: string[] = category.labels ?? category.keys ?? [];
        for (const athleteRow of (category.athletes ?? [])) {
          const athlete = athleteRow.athlete ?? {};
          const playerProviderId = String(athlete.id ?? "");
          if (!playerProviderId || athleteRow.didNotPlay || athleteRow.reason) continue;
          const stats: Record<string,string> = {};
          (athleteRow.stats ?? []).forEach((value: unknown, i: number) => {
            if (labels[i]) stats[String(labels[i]).toUpperCase()] = String(value);
          });
          const min = minutes(stats.MIN ?? stats.MINS);
          if (min === null) continue;
          const playerName = athlete.fullName ?? athlete.displayName ?? "Unknown";
          const parts = String(playerName).trim().split(/\s+/);
          const firstName = athlete.firstName ?? parts[0] ?? null;
          const lastName = athlete.lastName ?? parts.slice(1).join(" ") ?? null;
          const pos = athlete.position?.abbreviation ?? athlete.position ?? null;
          const playerResult = await client.query(
            `INSERT INTO players(provider,provider_player_id,full_name,first_name,last_name,position,active,metadata)
             VALUES('espn',$1,$2,$3,$4,$5,true,$6::jsonb)
             ON CONFLICT(provider,provider_player_id) DO UPDATE SET
               full_name=EXCLUDED.full_name, first_name=COALESCE(EXCLUDED.first_name,players.first_name),
               last_name=COALESCE(EXCLUDED.last_name,players.last_name),
               position=COALESCE(EXCLUDED.position,players.position), updated_at=now()
             RETURNING id`,
            [playerProviderId, playerName, firstName, lastName, pos, JSON.stringify({espn_id:playerProviderId})]
          );
          const playerId = Number(playerResult.rows[0].id);
          const fg = stats.FG ?? null;
          const three = stats["3PT"] ?? stats["3P"] ?? null;
          const ft = stats.FT ?? null;
          await client.query(
            `INSERT INTO player_game_stats
              (game_id,player_id,team_id,opponent_team_id,started,minutes,points,rebounds,assists,
               threes_made,steals,blocks,turnovers,field_goals_made,field_goals_attempted,
               free_throws_made,free_throws_attempted,source,raw_stats)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'espn',$18::jsonb)
             ON CONFLICT(game_id,player_id) DO UPDATE SET
               team_id=EXCLUDED.team_id,opponent_team_id=EXCLUDED.opponent_team_id,
               started=EXCLUDED.started,minutes=EXCLUDED.minutes,points=EXCLUDED.points,
               rebounds=EXCLUDED.rebounds,assists=EXCLUDED.assists,threes_made=EXCLUDED.threes_made,
               steals=EXCLUDED.steals,blocks=EXCLUDED.blocks,turnovers=EXCLUDED.turnovers,
               field_goals_made=EXCLUDED.field_goals_made,field_goals_attempted=EXCLUDED.field_goals_attempted,
               free_throws_made=EXCLUDED.free_throws_made,free_throws_attempted=EXCLUDED.free_throws_attempted,
               raw_stats=EXCLUDED.raw_stats,updated_at=now()`,
            [gameId, playerId, teamId, opponentId, Boolean(athleteRow.starter),
             min, numeric(stats.PTS), numeric(stats.REB), numeric(stats.AST), made(three),
             numeric(stats.STL), numeric(stats.BLK), numeric(stats.TO),
             made(fg), numeric(String(fg ?? "").split("-")[1]),
             made(ft), numeric(String(ft ?? "").split("-")[1]), JSON.stringify(stats)]
          );
          written++;
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return written;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  let gamesWritten = 0, boxscoresImported = 0, playerRowsWritten = 0, rosterPlayers = 0;
  const failures: string[] = [];
  try {
    const teamPayload = await espn("/teams");
    const teams: EspnTeam[] = (teamPayload.sports?.[0]?.leagues?.[0]?.teams ?? [])
      .map(asTeam).filter((t: EspnTeam) => CANON[t.abbreviation]);
    if (teams.length !== 30) throw new Error(`Expected 30 NBA teams; received ${teams.length}`);

    const teamRows = await mapLimit(teams, 6, async team => {
      const canonical = CANON[team.abbreviation];
      await pool.query(
        `UPDATE teams SET provider='espn',provider_team_id=$1,name=$2,updated_at=now() WHERE abbreviation=$3`,
        [team.id, team.displayName, canonical]
      );
      return { ...team, canonical };
    });
    const teamDbResult = await pool.query("SELECT id,abbreviation FROM teams");
    const teamDb = new Map<string,number>(teamDbResult.rows.map((r:any) => [r.abbreviation, Number(r.id)]));

    const scheduleBatches = await mapLimit(teamRows, 6, team =>
      espn(`/teams/${team.id}/schedule`, { season: String(SEASON), seasontype: "2" })
    );
    const eventMap = new Map<string,EspnEvent>();
    for (const payload of scheduleBatches) {
      for (const raw of (payload.events ?? [])) {
        const event = asEvent(raw);
        if (event) eventMap.set(event.id, event);
      }
    }
    const events = [...eventMap.values()];
    const gameDb = new Map<string,number>();
    for (const event of events) {
      const home = event.competitors.find(x => x.homeAway === "home");
      const away = event.competitors.find(x => x.homeAway === "away");
      if (!home || !away) continue;
      const homeAbbr = CANON[home.abbr] ?? home.abbr;
      const awayAbbr = CANON[away.abbr] ?? away.abbr;
      const homeId = teamDb.get(homeAbbr), awayId = teamDb.get(awayAbbr);
      if (!homeId || !awayId) { failures.push(`Unknown teams for game ${event.id}`); continue; }
      const start = new Date(event.date);
      const status = event.completed ? "final" : "scheduled";
      const homeScore = event.completed ? numeric(home.score) : null;
      const awayScore = event.completed ? numeric(away.score) : null;
      const metadata = {
        source:"ESPN", event_name:event.name, neutral_site:event.neutralSite ?? false,
        season_label:"2026-27", espn_status:event.status_name, status_detail:event.status_detail
      };
      const saved = await pool.query(
        `INSERT INTO games(provider,provider_game_id,season,season_type,game_date,scheduled_start,
          home_team_id,away_team_id,status,home_score,away_score,metadata)
         VALUES('espn',$1,$2,'regular',$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT(provider,provider_game_id) DO UPDATE SET
          season=EXCLUDED.season,season_type=EXCLUDED.season_type,game_date=EXCLUDED.game_date,
          scheduled_start=EXCLUDED.scheduled_start,home_team_id=EXCLUDED.home_team_id,
          away_team_id=EXCLUDED.away_team_id,status=EXCLUDED.status,home_score=EXCLUDED.home_score,
          away_score=EXCLUDED.away_score,metadata=EXCLUDED.metadata,updated_at=now()
         RETURNING id`,
        [event.id, SEASON, gameDate(event.date), start, homeId, awayId, status,
         homeScore, awayScore, JSON.stringify(metadata)]
      );
      gameDb.set(event.id, Number(saved.rows[0].id));
      gamesWritten++;
    }

    // Recheck only recent final games that still lack a complete player log.
    // This keeps the nightly run small while retrying games whose ESPN box score was delayed.
    const cutoff = new Date(Date.now() - 5*24*60*60*1000);
    const recentFinalEvents = events.filter(e => e.completed && new Date(e.date) >= cutoff);
    const existingLogs = await pool.query(
      `SELECT g.provider_game_id, COUNT(pgs.id)::int AS stat_count
       FROM games g LEFT JOIN player_game_stats pgs ON pgs.game_id=g.id
       WHERE g.provider='espn' AND g.season=$1 AND g.status='final'
         AND g.game_date >= CURRENT_DATE - INTERVAL '5 days'
       GROUP BY g.provider_game_id`,
      [SEASON]
    );
    const statCounts = new Map<string,number>(
      existingLogs.rows.map((r:any) => [String(r.provider_game_id), Number(r.stat_count)])
    );
    const recentFinals = recentFinalEvents.filter(e => (statCounts.get(e.id) ?? 0) < 15);
    const boxResults = await mapLimit(recentFinals, 3, async event => {
      try {
        const count = await importBoxscore(event, teamDb, gameDb);
        return { ok:true, count };
      } catch (error) {
        failures.push(`Game ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { ok:false, count:0 };
      }
    });
    for (const result of boxResults) if (result.ok) {
      boxscoresImported++;
      playerRowsWritten += result.count;
    }

    // Refresh the active player pool only if every team roster request succeeds.
    const rosterData = await mapLimit(teamRows, 6, async team => {
      const payload = await espn(`/teams/${team.id}/roster`, { season: String(SEASON) });
      return { team, athletes: payload.athletes ?? [] };
    });
    if (rosterData.length !== 30 || rosterData.some(x => x.athletes.length === 0)) {
      throw new Error("Roster refresh incomplete; active flags were not changed");
    }
    const rosterIds: string[] = [];
    for (const {team, athletes} of rosterData) {
      for (const athlete of athletes) {
        const id = String(athlete.id ?? "");
        if (!id) continue;
        const name = athlete.fullName ?? athlete.displayName ?? "Unknown";
        const parts = String(name).trim().split(/\s+/);
        const position = athlete.position?.abbreviation ?? athlete.position ?? null;
        await pool.query(
          `INSERT INTO players(provider,provider_player_id,full_name,first_name,last_name,position,
             jersey_number,active,metadata)
           VALUES('espn',$1,$2,$3,$4,$5,$6,true,$7::jsonb)
           ON CONFLICT(provider,provider_player_id) DO UPDATE SET
             full_name=EXCLUDED.full_name,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
             position=EXCLUDED.position,jersey_number=EXCLUDED.jersey_number,active=true,
             metadata=players.metadata || EXCLUDED.metadata,updated_at=now()`,
          [id,name,athlete.firstName ?? parts[0] ?? null,athlete.lastName ?? parts.slice(1).join(" ") ?? null,
           position,athlete.jersey ?? null,
           JSON.stringify({espn_id:id,roster_season:SEASON,roster_team_id:team.id,roster_team:team.canonical})]
        );
        rosterIds.push(id);
        rosterPlayers++;
      }
    }
    await pool.query(
      "UPDATE players SET active=(provider_player_id = ANY($1::text[])) WHERE provider='espn'",
      [rosterIds]
    );

    const recordsReceived = events.length;
    const recordsWritten = gamesWritten + playerRowsWritten + rosterPlayers;
    await pool.query(
      `INSERT INTO ingestion_runs(provider,dataset,started_at,completed_at,status,records_received,
         records_written,error_message,metadata)
       VALUES('espn','nba_2026_27_nightly_sync',$1,now(),$2,$3,$4,$5,$6::jsonb)`,
      [startedAt, failures.length ? "completed_with_errors" : "completed",
       recordsReceived, recordsWritten, failures.length ? failures.slice(0,20).join("\n") : null,
       JSON.stringify({season:SEASON,games:gamesWritten,boxscores_imported:boxscoresImported,
         player_game_rows:playerRowsWritten,roster_players:rosterPlayers,failures:failures.length})]
    );

    return NextResponse.json({
      success: failures.length === 0, season:"2026-27", games:gamesWritten,
      completed_games_checked:recentFinals.length, boxscores_imported:boxscoresImported,
      player_game_rows:playerRowsWritten, roster_players:rosterPlayers,
      failures:failures.slice(0,20), started_at:startedAt.toISOString()
    }, { status: failures.length ? 207 : 200 });
  } catch (error) {
    console.error("Nightly ESPN sync failed", error);
    try {
      await pool.query(
        `INSERT INTO ingestion_runs(provider,dataset,started_at,completed_at,status,error_message,metadata)
         VALUES('espn','nba_2026_27_nightly_sync',$1,now(),'failed',$2,$3::jsonb)`,
        [startedAt, error instanceof Error ? error.message : String(error),
         JSON.stringify({games:gamesWritten,boxscores_imported:boxscoresImported,
           player_game_rows:playerRowsWritten,roster_players:rosterPlayers})]
      );
    } catch (logError) { console.error("Could not record failed sync", logError); }
    return NextResponse.json({ error:"Nightly sync failed" }, { status:500 });
  }
}
