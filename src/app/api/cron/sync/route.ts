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
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(date));
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
function displayValue(value: any): unknown {
  if (value && typeof value === "object") return value.displayValue ?? value.value ?? value.text ?? null;
  return value;
}
function minutes(value: unknown): number | null {
  const raw = displayValue(value);
  if (raw === null || raw === undefined || raw === "" || raw === "--" || raw === "DNP") return null;
  const s = String(raw).trim();
  if (s.includes(":")) {
    const [m, sec] = s.split(":").map(Number);
    return Number.isFinite(m) && Number.isFinite(sec) ? m + sec/60 : null;
  }
  const n = numeric(s);
  return n !== null && n >= 0 && n <= 70 ? n : null;
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

function normalizeInjuryStatus(value: unknown): string {
  const s = String(value ?? "").trim().toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (/\b(OUT|INACTIVE|IR)\b|INJURED RESERVE/.test(s)) return "OUT";
  if (/\bDOUBTFUL\b/.test(s)) return "DOUBTFUL";
  if (/\bQUESTIONABLE\b/.test(s)) return "QUESTIONABLE";
  if (/\bPROBABLE\b/.test(s)) return "PROBABLE";
  if (/\bDAY TO DAY\b|\bDTD\b/.test(s)) return "DAY-TO-DAY";
  if (/\bAVAILABLE\b|\bACTIVE\b/.test(s)) return "AVAILABLE";
  return s || "UNKNOWN";
}

function collectDepthEntries(root: any) {
  const found: Array<{playerId:string; rank:number; position:string}> = [];
  const seen = new Set<string>();
  const walk = (node: any, inheritedPosition = "") => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, inheritedPosition); return; }
    const posValue = node.position?.displayName ?? node.position?.name ?? node.position?.abbreviation
      ?? (typeof node.position === "string" ? node.position : "")
      ?? node.positionName ?? node.abbreviation ?? "";
    const position = String(posValue || inheritedPosition || node.name || "");
    const athlete = node.athlete ?? node.player;
    const id = athlete?.id ?? node.athleteId ?? node.playerId;
    const rankValue = node.rank ?? node.depth ?? node.order;
    const rank = Number(rankValue);
    if (id !== undefined && Number.isFinite(rank) && rank > 0 && rank <= 20) {
      const key = String(id) + ":" + position;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({playerId:String(id),rank,position:position.slice(0,80)});
      }
    }
    for (const [key,value] of Object.entries(node)) {
      if (key === "athlete" || key === "player") continue;
      const nextPosition = /position|depthchart/i.test(key) ? position : (position || inheritedPosition);
      if (value && typeof value === "object") walk(value,nextPosition);
    }
  };
  walk(root?.depthchart ?? root?.depthChart ?? root);
  return found;
}

async function syncAvailabilityAndDepth(teamRows: Array<EspnTeam & {canonical:string}>, teamDb: Map<string,number>, includeDepth = true) {
  const failures: string[] = [];
  let injuryRows = 0, depthRows = 0;
  try {
    const payload = await espn("/injuries");
    const groups = Array.isArray(payload?.injuries) ? payload.injuries : null;
    if (!groups || payload?.status === "error") throw new Error("ESPN injury feed did not return a valid injuries array");
    const current = new Date();
    const reportDate = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Denver"}).format(current);
    const entries: any[] = [];
    let skippedMissingPlayerId = 0;
    const providerTeamIds = new Map(teamRows.map(team => [String(team.id), team.canonical]));
    for (const group of groups) {
      // ESPN's league injury feed uses {id, displayName, injuries}; it does not
      // include group.team.abbreviation. Resolve the group's ESPN team id instead.
      const teamAbbr = providerTeamIds.get(String(group.id ?? ""));
      const teamId = teamAbbr ? teamDb.get(teamAbbr) ?? null : null;
      for (const item of (group.injuries ?? [])) {
        const athlete = item.athlete ?? {};
        // The injury feed omits athlete.id. The ESPN player-card URL contains
        // the same provider ID used by the roster and box-score feeds.
        const playerHref = (athlete.links ?? []).find((link: any) =>
          Array.isArray(link.rel) && link.rel.includes("playercard")
        )?.href ?? (athlete.links ?? []).find((link: any) =>
          /\/player\//i.test(String(link.href ?? ""))
        )?.href ?? "";
        const playerProviderId = String(athlete.id ?? String(playerHref).match(/\/id\/(\d+)/)?.[1] ?? "");
        if (!playerProviderId) { skippedMissingPlayerId++; continue; }
        entries.push({playerProviderId,teamId,status:normalizeInjuryStatus(`${item.status ?? item.type?.name ?? ""} ${item.shortComment ?? item.longComment ?? item.details ?? item.detail ?? ""}`),
          injury:String(item.shortComment ?? item.longComment ?? item.details ?? item.detail ?? item.type?.description ?? item.type?.name ?? "Injury report"),
          raw:item});
      }
    }
    if (groups.length === 0) throw new Error("ESPN injury feed contained no team groups; existing reports preserved");
    if (entries.length === 0) throw new Error(`ESPN injury feed had ${groups.length} groups but no resolvable player IDs; existing reports preserved`);
    let unmatchedPlayers = 0;
    const resolved: Array<{playerId:number;teamId:number|null;status:string;injury:string;raw:any}> = [];
    for (const item of entries) {
      const player = await pool.query(
        "SELECT id FROM players WHERE provider='espn' AND provider_player_id=$1 LIMIT 1",
        [item.playerProviderId]
      );
      if (!player.rowCount) { unmatchedPlayers++; continue; }
      resolved.push({...item,playerId:Number(player.rows[0].id)});
    }
    if (resolved.length === 0) throw new Error(`ESPN returned ${entries.length} injuries, but none matched the ESPN player IDs in the database; existing reports preserved`);
    // Only clear stale statuses after a non-empty, player-resolved league snapshot is confirmed.
    await pool.query(
      "UPDATE injury_reports SET status='AVAILABLE',injury=NULL,captured_at=now() WHERE report_date=$1 AND source='espn'",
      [reportDate]
    );
    for (const item of resolved) {
      await pool.query(
        `INSERT INTO injury_reports(player_id,team_id,report_date,status,injury,source,captured_at,raw_report)
         VALUES($1,$2,$3,$4,$5,'espn',now(),$6::jsonb)
         ON CONFLICT(player_id,report_date,source) DO UPDATE SET
           team_id=EXCLUDED.team_id,status=EXCLUDED.status,injury=EXCLUDED.injury,
           captured_at=now(),raw_report=EXCLUDED.raw_report`,
        [item.playerId,item.teamId,reportDate,item.status,item.injury,JSON.stringify(item.raw)]
      );
      injuryRows++;
    }
    console.log("ESPN injury snapshot imported", {groups:groups.length,feedEntries:entries.length,
      matchedPlayers:resolved.length,unmatchedPlayers,skippedMissingPlayerId});
  } catch (error) {
    failures.push("Injuries: " + (error instanceof Error ? error.message : String(error)));
  }

  if (includeDepth) {
    try {
      const charts = await mapLimit(teamRows,5,async team => ({
        team,
        payload: await espn(`/teams/${team.id}/depthcharts`)
      }));
      const allEntries = charts.flatMap(({team,payload}) =>
        collectDepthEntries(payload).map(entry => ({...entry,team}))
      );
      if (charts.length !== 30 || allEntries.length < 60) {
        throw new Error(`Depth chart feed incomplete (${allEntries.length} player-position entries); existing roles preserved`);
      }
      // Replace only after all 30 team charts produced a meaningful combined snapshot.
      await pool.query(
        `UPDATE players SET metadata=metadata-'depth_chart_rank'-'depth_chart_position'-'depth_chart_updated_at'-'depth_chart_source'
         WHERE provider='espn'`
      );
      for (const entry of allEntries) {
        const team = entry.team;
        await pool.query(
          `UPDATE players SET metadata=metadata || $1::jsonb,updated_at=now()
           WHERE provider='espn' AND provider_player_id=$2`,
          [JSON.stringify({depth_chart_rank:String(entry.rank),depth_chart_position:entry.position,
            depth_chart_updated_at:new Date().toISOString(),depth_chart_source:"espn"}),entry.playerId]
        );
        depthRows++;
      }
    } catch (error) {
      failures.push("Depth charts: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return {injuryRows,depthRows,failures};
}


export async function forceAvailabilityRefresh() {
  const teamPayload = await espn("/teams");
  const teams: EspnTeam[] = (teamPayload.sports?.[0]?.leagues?.[0]?.teams ?? [])
    .map(asTeam).filter((t: EspnTeam) => CANON[t.abbreviation]);
  if (teams.length !== 30) throw new Error(`Expected 30 NBA teams; received ${teams.length}`);
  const teamRows = teams.map(team => ({...team,canonical:CANON[team.abbreviation]}));
  const teamDbResult = await pool.query("SELECT id,abbreviation FROM teams");
  const teamDb = new Map<string,number>(teamDbResult.rows.map((r:any) => [r.abbreviation, Number(r.id)]));
  const result = await syncAvailabilityAndDepth(teamRows,teamDb,false);
  await pool.query(
    `INSERT INTO ingestion_runs(provider,dataset,started_at,completed_at,status,records_received,records_written,error_message,metadata)
     VALUES('espn','nba_manual_availability_refresh',now(),now(),$1,30,$2,$3,$4::jsonb)`,
    [result.failures.length ? "completed_with_errors" : "completed",
     result.injuryRows+result.depthRows,result.failures.length ? result.failures.join("\\n") : null,
     JSON.stringify({injury_rows:result.injuryRows,depth_chart_entries:result.depthRows,failures:result.failures})]
  );
  return result;
}


async function nbaJson(url: string) {
  const response = await fetch(url, {headers:{"User-Agent":"CourtsidePlayerModel/1.0","Accept":"application/json"},cache:"no-store",signal:AbortSignal.timeout(25000)});
  if (!response.ok) throw new Error(`NBA feed ${response.status} at ${url}`);
  return response.json();
}
type NbaScheduleGame = {gameId:string;gameDateUTC?:string;gameDate?:string;homeTeam?:{teamTricode?:string};awayTeam?:{teamTricode?:string}};
async function loadNbaSchedule(): Promise<NbaScheduleGame[]> {
  const payload = await nbaJson("https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json");
  const games = (payload?.leagueSchedule?.gameDates ?? []).flatMap((d:any)=>Array.isArray(d.games)?d.games:[]);
  const valid = games.filter((g:any)=>/^\\d{10}$/.test(String(g.gameId??"")));
  if (!valid.length) throw new Error("NBA official schedule returned no games");
  return valid;
}
function findNbaGame(event:EspnEvent,schedule:NbaScheduleGame[]) {
  const home=event.competitors.find(x=>x.homeAway==="home"), away=event.competitors.find(x=>x.homeAway==="away");
  if(!home||!away) return undefined;
  const h=CANON[home.abbr]??home.abbr, a=CANON[away.abbr]??away.abbr;
  return schedule.find(g=>{
    const gh=String(g.homeTeam?.teamTricode??""), ga=String(g.awayTeam?.teamTricode??"");
    const gd=g.gameDateUTC??g.gameDate??"";
    return (CANON[gh]??gh)===h && (CANON[ga]??ga)===a && gd && gameDate(gd)===gameDate(event.date);
  });
}
function nbaMinutes(value:unknown):number|null {
  if(value===null||value===undefined||value==="") return null;
  const s=String(displayValue(value)??value).trim();
  const m=s.match(/^PT(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?$/i);
  if(m){const n=Number(m[1]??0)+Number(m[2]??0)/60;return n>0&&Number.isFinite(n)?n:null;}
  return minutes(s);
}
async function importNbaBoxscore(event:EspnEvent,nbaGame:NbaScheduleGame,teamDb:Map<string,number>,gameDb:Map<string,number>){
  const payload=await nbaJson(`https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${nbaGame.gameId}.json`);
  const game=payload?.game??payload?.boxscore??payload, gameId=gameDb.get(event.id);
  if(!gameId) throw new Error(`Missing database game ${event.id}`);
  const sides=[{side:game.awayTeam,opponent:game.homeTeam},{side:game.homeTeam,opponent:game.awayTeam}];
  let written=0; const client=await pool.connect();
  try{
    await client.query("BEGIN");
    for(const {side,opponent} of sides){
      const raw=String(side?.teamTricode??side?.teamAbbreviation??"");
      const oppRaw=String(opponent?.teamTricode??opponent?.teamAbbreviation??"");
      const teamId=teamDb.get(CANON[raw]??raw), opponentId=teamDb.get(CANON[oppRaw]??oppRaw);
      if(!teamId||!opponentId) throw new Error(`NBA team mapping failed for ${raw}/${oppRaw}`);
      const players=Array.isArray(side.players)?side.players:[];
      if(!players.length) throw new Error(`NBA boxscore has no players for ${raw}`);
      for(const player of players){
        if(player.played===false||player.status==="INACTIVE") continue;
        const st=player.statistics??{}, min=nbaMinutes(st.minutes??st.minutesCalculated??player.minutes);
        const nbaId=String(player.personId??player.playerId??"");
        if(min===null||!nbaId) continue;
        const name=String(player.name??[player.firstName,player.familyName].filter(Boolean).join(" ")??"Unknown").trim();
        const first=player.firstName??name.split(/\\s+/)[0]??null, last=player.familyName??name.split(/\\s+/).slice(1).join(" ")??null;
        const found=await client.query(`SELECT id FROM players WHERE metadata->>'nba_player_id'=$1 OR (provider='espn' AND lower(full_name)=lower($2)) ORDER BY CASE WHEN metadata->>'nba_player_id'=$1 THEN 0 ELSE 1 END LIMIT 1`,[nbaId,name]);
        let playerId:number;
        if(found.rowCount){
          playerId=Number(found.rows[0].id);
          await client.query("UPDATE players SET metadata=metadata || $1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify({nba_player_id:nbaId,nba_player_name:name}),playerId]);
        }else{
          const ins=await client.query(`INSERT INTO players(provider,provider_player_id,full_name,first_name,last_name,position,active,metadata)
            VALUES('nba',$1,$2,$3,$4,$5,true,$6::jsonb)
            ON CONFLICT(provider,provider_player_id) DO UPDATE SET full_name=EXCLUDED.full_name,updated_at=now() RETURNING id`,
            [nbaId,name,first,last,player.position??null,JSON.stringify({nba_player_id:nbaId})]);
          playerId=Number(ins.rows[0].id);
        }
        await client.query(`INSERT INTO player_game_stats
          (game_id,player_id,team_id,opponent_team_id,started,minutes,points,rebounds,assists,threes_made,steals,blocks,turnovers,
           field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,source,raw_stats)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'nba',$18::jsonb)
          ON CONFLICT(game_id,player_id) DO UPDATE SET team_id=EXCLUDED.team_id,opponent_team_id=EXCLUDED.opponent_team_id,
          started=EXCLUDED.started,minutes=EXCLUDED.minutes,points=EXCLUDED.points,rebounds=EXCLUDED.rebounds,assists=EXCLUDED.assists,
          threes_made=EXCLUDED.threes_made,steals=EXCLUDED.steals,blocks=EXCLUDED.blocks,turnovers=EXCLUDED.turnovers,
          field_goals_made=EXCLUDED.field_goals_made,field_goals_attempted=EXCLUDED.field_goals_attempted,
          free_throws_made=EXCLUDED.free_throws_made,free_throws_attempted=EXCLUDED.free_throws_attempted,
          source='nba',raw_stats=EXCLUDED.raw_stats,updated_at=now()`,
          [gameId,playerId,teamId,opponentId,Boolean(player.starter),min,numeric(st.points),numeric(st.reboundsTotal??st.rebounds),
           numeric(st.assists),numeric(st.threePointersMade),numeric(st.steals),numeric(st.blocks),numeric(st.turnovers),
           numeric(st.fieldGoalsMade),numeric(st.fieldGoalsAttempted),numeric(st.freeThrowsMade),numeric(st.freeThrowsAttempted),JSON.stringify(st)]);
        written++;
      }
    }
    if(written<10) throw new Error(`NBA boxscore only mapped ${written} player rows; refusing incomplete import`);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  return written;
}

async function espnCdnBoxscore(eventId: string) {
  const url = new URL("https://cdn.espn.com/core/nba/boxscore");
  url.searchParams.set("xhr", "1");
  url.searchParams.set("gameId", eventId);
  const response = await fetch(url, {
    headers: { "User-Agent": "CourtsidePlayerModel/1.0", "Accept": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`ESPN CDN boxscore ${response.status} for game ${eventId}`);
  return response.json();
}

function findBoxscorePlayers(payload: any): any[] {
  const seen = new Set<any>();
  const walk = (node: any, depth = 0): any[] | null => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return null;
    seen.add(node);
    if (!Array.isArray(node)) {
      const players = node.boxscore?.players;
      if (Array.isArray(players) && players.length) return players;
      for (const value of Object.values(node)) {
        const result = walk(value, depth + 1);
        if (result?.length) return result;
      }
    } else {
      for (const value of node) {
        const result = walk(value, depth + 1);
        if (result?.length) return result;
      }
    }
    return null;
  };
  return walk(payload) ?? [];
}

async function importBoxscore(event: EspnEvent, teamDb: Map<string, number>, gameDb: Map<string, number>) {
  let summary: any = await espn("/summary", { event: event.id });
  let boxTeams = findBoxscorePlayers(summary);
  let boxscoreSource = "site-summary";
  if (boxTeams.length === 0) {
    // ESPN's Site v2 summary occasionally omits the player boxscore even when
    // the game is final. Retry through ESPN's CDN boxscore package before
    // treating the game as unavailable.
    const cdnPayload = await espnCdnBoxscore(event.id);
    boxTeams = findBoxscorePlayers(cdnPayload);
    if (boxTeams.length > 0) {
      summary = cdnPayload.gamepackageJSON ?? cdnPayload.content?.gamepackageJSON ?? cdnPayload;
      boxscoreSource = "cdn-boxscore";
    }
  }
  if (boxTeams.length === 0) {
    const responseKeys = Object.keys(summary ?? {}).slice(0, 20).join(", ") || "none";
    throw new Error(`ESPN summary and CDN boxscore both returned no player rows (summary keys: ${responseKeys})`);
  }
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
  // CDN player-boxscore team objects sometimes contain only the ESPN team ID,
  // not an abbreviation. Resolve both forms so those rows are not silently skipped.
  const providerTeamIdToDb = new Map<string, number>([
    [String(home.team_id), homeDb],
    [String(away.team_id), awayDb]
  ]);

  // boxTeams was extracted from either the Site API summary or CDN payload above.
  let written = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const side of boxTeams) {
      const rawAbbr = String(side.team?.abbreviation ?? side.abbreviation ?? side.teamAbbreviation ?? "");
      const sideAbbr = CANON[rawAbbr] ?? rawAbbr;
      const providerTeamId = String(side.team?.id ?? side.teamId ?? side.id ?? "");
      const teamName = String(side.team?.displayName ?? side.team?.name ?? side.displayName ?? "");
      const nameMatch = [home, away].find(x => {
        const abbr = CANON[x.abbr] ?? x.abbr;
        return abbr === sideAbbr || String(x.team_id) === providerTeamId ||
          teamName.toLowerCase().includes(abbr.toLowerCase());
      });
      const teamId = teamDb.get(sideAbbr) ?? providerTeamIdToDb.get(providerTeamId) ??
        (nameMatch ? teamDb.get(CANON[nameMatch.abbr] ?? nameMatch.abbr) : undefined);
      const opponentId = teamId === homeDb ? awayDb : homeDb;
      if (!teamId) continue;
      const categories = Array.isArray(side.statistics) ? side.statistics
        : Array.isArray(side.statistics?.categories) ? side.statistics.categories
        : Array.isArray(side.stats) ? side.stats : [];
      for (const category of categories) {
        const rawLabels = category.labels ?? category.keys ?? category.names ?? category.displayNames ?? [];
        const labels: string[] = Array.isArray(rawLabels)
          ? rawLabels.map((x: any) => String(displayValue(x) ?? x))
          : Object.keys(rawLabels ?? {});
        const athleteRows = category.athletes ?? category.players ?? category.entries ?? [];
        for (const athleteRow of athleteRows) {
          const athlete = athleteRow.athlete ?? athleteRow.player ?? athleteRow;
          const playerProviderId = String(athlete.id ?? athleteRow.athleteId ?? athleteRow.playerId ?? "");
          if (!playerProviderId || athleteRow.didNotPlay || athleteRow.reason || athleteRow.didNotPlayReason) continue;
          const stats: Record<string,string> = {};
          const rawStats = athleteRow.stats ?? athleteRow.statistics ?? athleteRow.values ?? {};
          if (Array.isArray(rawStats)) {
            rawStats.forEach((value: unknown, i: number) => {
              const key = labels[i] ?? (i === 0 ? "MIN" : "");
              if (key) stats[String(key).toUpperCase()] = String(displayValue(value) ?? "");
            });
          } else if (rawStats && typeof rawStats === "object") {
            for (const [key, value] of Object.entries(rawStats)) {
              stats[String(key).toUpperCase()] = String(displayValue(value) ?? "");
            }
          }
          const min = minutes(stats.MIN ?? stats.MINS ?? stats.MINUTES ??
            athleteRow.minutes ?? athleteRow.min ?? athlete.minutes);
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
      const status = event.completed ? "final"
        : event.status_name === "STATUS_SCHEDULED" ? "scheduled"
        : event.status_name?.includes("POSTPONED") ? "postponed"
        : event.status_name?.includes("CANCEL") ? "cancelled"
        : "in_progress";
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
    let nbaSchedule:NbaScheduleGame[]=[];
    try{nbaSchedule=await loadNbaSchedule();}catch(error){failures.push("NBA schedule unavailable: "+(error instanceof Error?error.message:String(error)));}
    const boxResults = await mapLimit(recentFinals, 3, async event => {
      const nbaGame=findNbaGame(event,nbaSchedule);
      try{
        if(!nbaGame) throw new Error("No matching NBA game ID in official schedule");
        const count=await importNbaBoxscore(event,nbaGame,teamDb,gameDb);
        return {ok:true,count};
      }catch(nbaError){
        try{
          const count=await importBoxscore(event,teamDb,gameDb);
          if(count===0) throw new Error("ESPN fallback returned no mapped player rows");
          return {ok:true,count};
        }catch(espnError){
          failures.push(`Game ${event.id}: NBA: ${nbaError instanceof Error?nbaError.message:String(nbaError)} | ESPN fallback: ${espnError instanceof Error?espnError.message:String(espnError)}`);
          return {ok:false,count:0};
        }
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

    const availability = await syncAvailabilityAndDepth(teamRows,teamDb);
    failures.push(...availability.failures);

    // Settle saved forecasts against ESPN box scores so real model performance is tracked.
    await pool.query(`
      WITH actuals AS (
        SELECT pgs.game_id,pgs.player_id,v.market_key,v.actual_value
        FROM player_game_stats pgs
        JOIN games g ON g.id=pgs.game_id
        CROSS JOIN LATERAL (VALUES
          ('player_points',pgs.points),('player_rebounds',pgs.rebounds),('player_assists',pgs.assists),
          ('player_threes',pgs.threes_made),('player_steals',pgs.steals),('player_blocks',pgs.blocks),
          ('player_points_rebounds_assists',pgs.points+pgs.rebounds+pgs.assists),('player_points_rebounds',pgs.points+pgs.rebounds),
          ('player_points_assists',pgs.points+pgs.assists),('player_rebounds_assists',pgs.rebounds+pgs.assists)
        ) v(market_key,actual_value)
        WHERE g.status='final' AND g.game_date>=CURRENT_DATE-INTERVAL '30 days'
          AND v.actual_value IS NOT NULL
      )
      INSERT INTO prop_results(game_id,player_id,market_id,actual_value,source)
      SELECT a.game_id,a.player_id,m.id,a.actual_value,'nba'
      FROM actuals a JOIN prop_markets m ON m.market_key=a.market_key AND m.active=true
      ON CONFLICT(game_id,player_id,market_id) DO UPDATE
      SET actual_value=EXCLUDED.actual_value,settled_at=now(),source='nba'
    `);
    await pool.query(`
      WITH latest_projections AS (
        SELECT DISTINCT ON(p.game_id,p.player_id,p.market_id) p.*
        FROM projections p
        JOIN games g ON g.id=p.game_id AND g.status='final'
        JOIN model_versions mv ON mv.id=p.model_version_id AND mv.model_key='courtside_player_performance'
        WHERE g.game_date>=CURRENT_DATE-INTERVAL '30 days'
        ORDER BY p.game_id,p.player_id,p.market_id,p.generated_at DESC
      )
      INSERT INTO prediction_grades(projection_id,prop_line_id,result,actual_value,absolute_error,squared_error,graded_at)
      SELECT p.id,NULL,'graded',r.actual_value,abs(p.projected_mean-r.actual_value),
        power(p.projected_mean-r.actual_value,2),now()
      FROM latest_projections p
      JOIN prop_results r ON r.game_id=p.game_id AND r.player_id=p.player_id AND r.market_id=p.market_id
      WHERE NOT EXISTS(SELECT 1 FROM prediction_grades pg WHERE pg.projection_id=p.id AND pg.prop_line_id IS NULL)
    `);

    const recordsReceived = events.length;
    const recordsWritten = gamesWritten + playerRowsWritten + rosterPlayers + availability.injuryRows + availability.depthRows;
    await pool.query(
      `INSERT INTO ingestion_runs(provider,dataset,started_at,completed_at,status,records_received,
         records_written,error_message,metadata)
       VALUES('espn','nba_2026_27_nightly_sync',$1,now(),$2,$3,$4,$5,$6::jsonb)`,
      [startedAt, failures.length ? "completed_with_errors" : "completed",
       recordsReceived, recordsWritten, failures.length ? failures.slice(0,20).join("\n") : null,
       JSON.stringify({season:SEASON,games:gamesWritten,boxscores_imported:boxscoresImported,
         player_game_rows:playerRowsWritten,roster_players:rosterPlayers,injury_rows:availability.injuryRows,depth_chart_entries:availability.depthRows,failures:failures.length})]
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


export async function POST(request: NextRequest) {
  // The app has no user sign-in. Limit manual refreshes server-side so the public
  // button cannot repeatedly trigger a full ESPN/roster sync.
  try {
    const recent = await pool.query(
      `SELECT started_at FROM ingestion_runs
       WHERE provider='espn' AND dataset='nba_2026_27_nightly_sync'
         AND started_at > now() - interval '10 minutes'
       ORDER BY started_at DESC LIMIT 1`
    );
    if (recent.rowCount) {
      return NextResponse.json({
        error: "A data sync ran recently. Please wait up to 10 minutes before trying again."
      }, { status:429 });
    }
    const secret = process.env.CRON_SECRET;
    if (!secret) return NextResponse.json({error:"Server sync authorization is not configured."},{status:503});
    const internalRequest = new NextRequest(request.url, {
      method:"GET",
      headers:{authorization:`Bearer ${secret}`}
    });
    return GET(internalRequest);
  } catch (error) {
    console.error("Manual game-results refresh failed",error);
    return NextResponse.json({error:"Could not start the game-results update."},{status:500});
  }
}
