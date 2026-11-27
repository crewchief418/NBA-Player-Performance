import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

const markets = [
  ["points", "Points"], ["rebounds", "Rebounds"], ["assists", "Assists"],
  ["threes_made", "3-pointers"], ["steals", "Steals"], ["blocks", "Blocks"],
  ["pra", "PRA"], ["pr", "Points + Rebounds"], ["pa", "Points + Assists"], ["ra", "Rebounds + Assists"]
] as const;

export async function GET() {
  try {
    const result = await pool.query(`
      WITH latest_games AS (
        SELECT g.id, g.game_date, g.scheduled_start, g.season_type, g.home_team_id, g.away_team_id
        FROM games g
        WHERE g.season = 2027
          AND g.status IN ('scheduled','pre-game','pregame')
          AND g.game_date >= CURRENT_DATE
        ORDER BY g.game_date, g.scheduled_start
        LIMIT 30
      ),
      recent AS (
        SELECT pgs.*, g.game_date, g.season_type,
          row_number() OVER (PARTITION BY pgs.player_id ORDER BY g.game_date DESC) AS rn
        FROM player_game_stats pgs
        JOIN games g ON g.id = pgs.game_id
        WHERE g.status = 'final' AND g.season_type = 'regular'
      ),
      avgs AS (
        SELECT player_id, count(*) AS sample_size,
          avg(minutes) AS avg_minutes,
          avg(points) AS points, avg(rebounds) AS rebounds, avg(assists) AS assists,
          avg(threes_made) AS threes_made, avg(steals) AS steals, avg(blocks) AS blocks,
          avg(points + rebounds + assists) AS pra,
          avg(points + rebounds) AS pr,
          avg(points + assists) AS pa,
          avg(rebounds + assists) AS ra
        FROM recent WHERE rn <= 8
        GROUP BY player_id HAVING count(*) >= 3
      )
      SELECT p.id AS player_id, p.full_name, p.position, p.active,
        lg.id AS game_id, lg.game_date, lg.scheduled_start, p.metadata->>'espn_id' AS espn_id,
        ht.abbreviation AS home_team, at.abbreviation AS away_team,
        a.sample_size, round(a.avg_minutes::numeric,1) AS avg_minutes,
        round(a.points::numeric,1) AS points, round(a.rebounds::numeric,1) AS rebounds,
        round(a.assists::numeric,1) AS assists, round(a.threes_made::numeric,1) AS threes_made,
        round(a.steals::numeric,1) AS steals, round(a.blocks::numeric,1) AS blocks,
        round(a.pra::numeric,1) AS pra, round(a.pr::numeric,1) AS pr,
        round(a.pa::numeric,1) AS pa, round(a.ra::numeric,1) AS ra
      FROM latest_games lg
      JOIN teams ht ON ht.id = lg.home_team_id
      JOIN teams at ON at.id = lg.away_team_id
      JOIN avgs a ON true
      JOIN players p ON p.id = a.player_id
        AND p.active = true
        AND p.metadata->>'roster_team' IN (ht.abbreviation, at.abbreviation)
      ORDER BY lg.game_date, lg.scheduled_start, p.full_name
      LIMIT 1200
    `);
    return NextResponse.json({ projections: result.rows, markets });
  } catch (error) {
    console.error("Projection query failed", error);
    return NextResponse.json({ projections: [], markets, error: "Projection data is not ready yet." }, { status: 503 });
  }
}