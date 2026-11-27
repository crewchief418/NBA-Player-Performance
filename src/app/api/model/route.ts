import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await pool.query(`
      WITH history AS (
        SELECT pgs.game_id,pgs.player_id,pgs.team_id,pgs.opponent_team_id,pgs.started,
          pgs.minutes,pgs.points,pgs.rebounds,pgs.assists,pgs.threes_made,pgs.steals,pgs.blocks,
          pgs.field_goals_attempted,pgs.free_throws_attempted,pgs.turnovers,
          g.game_date,g.season,(pgs.team_id=g.home_team_id) is_home,
          g.home_team_id,g.away_team_id
        FROM player_game_stats pgs JOIN games g ON g.id=pgs.game_id
        WHERE g.status='final' AND g.season_type='regular' AND g.season>=2023 AND pgs.minutes>0
      ),
      player_roll AS (
        SELECT *,
          count(*) OVER w sample_size,
          avg(minutes) OVER w avg_minutes,
          avg(minutes) OVER w3 last3_minutes,
          avg(points) OVER w baseline_points,avg(rebounds) OVER w baseline_rebounds,
          avg(assists) OVER w baseline_assists,avg(threes_made) OVER w baseline_threes,
          avg(steals) OVER w baseline_steals,avg(blocks) OVER w baseline_blocks,
          avg(points/nullif(minutes,0)*36) OVER w points_rate,
          avg(rebounds/nullif(minutes,0)*36) OVER w rebounds_rate,
          avg(assists/nullif(minutes,0)*36) OVER w assists_rate,
          avg(threes_made/nullif(minutes,0)*36) OVER w threes_rate,
          avg(steals/nullif(minutes,0)*36) OVER w steals_rate,
          avg(blocks/nullif(minutes,0)*36) OVER w blocks_rate,
          avg(started::int) OVER w starter_rate,
          avg(points/nullif(minutes,0)*36) FILTER(WHERE is_home) OVER w home_points_rate,
          avg(points/nullif(minutes,0)*36) FILTER(WHERE NOT is_home) OVER w away_points_rate,
          avg(rebounds/nullif(minutes,0)*36) FILTER(WHERE is_home) OVER w home_rebounds_rate,
          avg(rebounds/nullif(minutes,0)*36) FILTER(WHERE NOT is_home) OVER w away_rebounds_rate,
          avg(assists/nullif(minutes,0)*36) FILTER(WHERE is_home) OVER w home_assists_rate,
          avg(assists/nullif(minutes,0)*36) FILTER(WHERE NOT is_home) OVER w away_assists_rate,
          avg(threes_made/nullif(minutes,0)*36) FILTER(WHERE is_home) OVER w home_threes_rate,
          avg(threes_made/nullif(minutes,0)*36) FILTER(WHERE NOT is_home) OVER w away_threes_rate,
          avg(steals/nullif(minutes,0)*36) FILTER(WHERE is_home) OVER w home_steals_rate,
          avg(steals/nullif(minutes,0)*36) FILTER(WHERE NOT is_home) OVER w away_steals_rate,
          avg(blocks/nullif(minutes,0)*36) FILTER(WHERE is_home) OVER w home_blocks_rate,
          avg(blocks/nullif(minutes,0)*36) FILTER(WHERE NOT is_home) OVER w away_blocks_rate,
          lag(game_date) OVER(PARTITION BY player_id ORDER BY game_date,game_id) previous_game_date
        FROM history
        WINDOW w AS(PARTITION BY player_id ORDER BY game_date,game_id ROWS BETWEEN 8 PRECEDING AND 1 PRECEDING),
               w3 AS(PARTITION BY player_id ORDER BY game_date,game_id ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING)
      ),
      team_game AS (
        SELECT g.id game_id,g.game_date,pgs.opponent_team_id defense_team_id,
          sum(pgs.points) points_allowed,sum(pgs.rebounds) rebounds_allowed,
          sum(pgs.assists) assists_allowed,sum(pgs.threes_made) threes_allowed,
          sum(pgs.steals) steals_allowed,sum(pgs.blocks) blocks_allowed
        FROM player_game_stats pgs JOIN games g ON g.id=pgs.game_id
        WHERE g.status='final' AND g.season_type='regular' AND g.season>=2023
        GROUP BY g.id,g.game_date,pgs.opponent_team_id
      ),
      defense_roll AS (
        SELECT *,avg(points_allowed) OVER w p_def_avg,avg(rebounds_allowed) OVER w r_def_avg,
          avg(assists_allowed) OVER w a_def_avg,avg(threes_allowed) OVER w t_def_avg,
          avg(steals_allowed) OVER w s_def_avg,avg(blocks_allowed) OVER w b_def_avg
        FROM team_game
        WINDOW w AS(PARTITION BY defense_team_id ORDER BY game_date,game_id ROWS BETWEEN 8 PRECEDING AND 1 PRECEDING)
      ),
      league_defense AS (
        SELECT avg(points_allowed) p,avg(rebounds_allowed) r,avg(assists_allowed) a,
          avg(threes_allowed) t,avg(steals_allowed) s,avg(blocks_allowed) b FROM team_game
      ),
      team_pace AS (
        SELECT g.id game_id,g.game_date,pgs.team_id,
          sum(coalesce(pgs.field_goals_attempted,0)+0.44*coalesce(pgs.free_throws_attempted,0)+coalesce(pgs.turnovers,0)) possessions
        FROM player_game_stats pgs JOIN games g ON g.id=pgs.game_id
        WHERE g.status='final' AND g.season_type='regular' AND g.season>=2023
        GROUP BY g.id,g.game_date,pgs.team_id
      ),
      pace_roll AS (
        SELECT *,avg(possessions) OVER(PARTITION BY team_id ORDER BY game_date,game_id ROWS BETWEEN 8 PRECEDING AND 1 PRECEDING) pace_avg
        FROM team_pace
      ),
      league_pace AS(SELECT avg(possessions) pace FROM team_pace),
      scored AS (
        SELECT h.*,
          greatest(6,least(40,avg_minutes+greatest(-3,least(3,(last3_minutes-avg_minutes)*0.25))
            +CASE WHEN starter_rate>=0.60 THEN 0.5 ELSE 0 END
            +CASE WHEN avg_minutes>=36 THEN -0.6 ELSE 0 END
            +CASE WHEN h.game_date-h.previous_game_date<=1 THEN -1.2 ELSE 0 END)) expected_minutes,
          greatest(0.88,least(1.12,1+0.45*(coalesce(d.p_def_avg,ld.p)/nullif(ld.p,0)-1))) p_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(d.r_def_avg,ld.r)/nullif(ld.r,0)-1))) r_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(d.a_def_avg,ld.a)/nullif(ld.a,0)-1))) a_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(d.t_def_avg,ld.t)/nullif(ld.t,0)-1))) t_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(d.s_def_avg,ld.s)/nullif(ld.s,0)-1))) s_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(d.b_def_avg,ld.b)/nullif(ld.b,0)-1))) b_def,
          greatest(0.94,least(1.06,((coalesce(ph.pace_avg,lp.pace)+coalesce(pa.pace_avg,lp.pace))/2)/nullif(lp.pace,0))) pace_factor,
          CASE WHEN is_home AND home_points_rate IS NOT NULL AND points_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*home_points_rate/points_rate))
               WHEN NOT is_home AND away_points_rate IS NOT NULL AND points_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*away_points_rate/points_rate)) ELSE 1 END p_venue,
          CASE WHEN is_home AND home_rebounds_rate IS NOT NULL AND rebounds_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*home_rebounds_rate/rebounds_rate))
               WHEN NOT is_home AND away_rebounds_rate IS NOT NULL AND rebounds_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*away_rebounds_rate/rebounds_rate)) ELSE 1 END r_venue,
          CASE WHEN is_home AND home_assists_rate IS NOT NULL AND assists_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*home_assists_rate/assists_rate))
               WHEN NOT is_home AND away_assists_rate IS NOT NULL AND assists_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*away_assists_rate/assists_rate)) ELSE 1 END a_venue,
          CASE WHEN is_home AND home_threes_rate IS NOT NULL AND threes_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*home_threes_rate/threes_rate))
               WHEN NOT is_home AND away_threes_rate IS NOT NULL AND threes_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*away_threes_rate/threes_rate)) ELSE 1 END t_venue,
          CASE WHEN is_home AND home_steals_rate IS NOT NULL AND steals_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*home_steals_rate/steals_rate))
               WHEN NOT is_home AND away_steals_rate IS NOT NULL AND steals_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*away_steals_rate/steals_rate)) ELSE 1 END s_venue,
          CASE WHEN is_home AND home_blocks_rate IS NOT NULL AND blocks_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*home_blocks_rate/blocks_rate))
               WHEN NOT is_home AND away_blocks_rate IS NOT NULL AND blocks_rate>0 THEN greatest(0.90,least(1.10,0.5+0.5*away_blocks_rate/blocks_rate)) ELSE 1 END b_venue
        FROM player_roll h
        LEFT JOIN defense_roll d ON d.game_id=h.game_id AND d.defense_team_id=h.opponent_team_id
        LEFT JOIN pace_roll ph ON ph.game_id=h.game_id AND ph.team_id=h.team_id
        LEFT JOIN pace_roll pa ON pa.game_id=h.game_id AND pa.team_id=h.opponent_team_id
        CROSS JOIN league_defense ld CROSS JOIN league_pace lp
        WHERE h.sample_size>=3
      ),
      predictions AS (
        SELECT *,
          points_rate*expected_minutes/36*p_def*p_venue*pace_factor pred_points,
          rebounds_rate*expected_minutes/36*r_def*r_venue*pace_factor pred_rebounds,
          assists_rate*expected_minutes/36*a_def*a_venue*pace_factor pred_assists,
          threes_rate*expected_minutes/36*t_def*t_venue*pace_factor pred_threes,
          steals_rate*expected_minutes/36*s_def*s_venue*pace_factor pred_steals,
          blocks_rate*expected_minutes/36*b_def*b_venue*pace_factor pred_blocks
        FROM scored
      ),
      all_stats AS (
        SELECT 'points' stat,points actual,baseline_points baseline,pred_points prediction FROM predictions
        UNION ALL SELECT 'rebounds',rebounds,baseline_rebounds,pred_rebounds FROM predictions
        UNION ALL SELECT 'assists',assists,baseline_assists,pred_assists FROM predictions
        UNION ALL SELECT 'threes_made',threes_made,baseline_threes,pred_threes FROM predictions
        UNION ALL SELECT 'steals',steals,baseline_steals,pred_steals FROM predictions
        UNION ALL SELECT 'blocks',blocks,baseline_blocks,pred_blocks FROM predictions
        UNION ALL SELECT 'pra',points+rebounds+assists,baseline_points+baseline_rebounds+baseline_assists,pred_points+pred_rebounds+pred_assists FROM predictions
        UNION ALL SELECT 'pr',points+rebounds,baseline_points+baseline_rebounds,pred_points+pred_rebounds FROM predictions
        UNION ALL SELECT 'pa',points+assists,baseline_points+baseline_assists,pred_points+pred_assists FROM predictions
        UNION ALL SELECT 'ra',rebounds+assists,baseline_rebounds+baseline_assists,pred_rebounds+pred_assists FROM predictions
      )
      SELECT stat,count(*)::int sample_size,
        round(avg(abs(actual-baseline))::numeric,2) baseline_mae,
        round(avg(abs(actual-(0.80*baseline+0.20*prediction)))::numeric,2) model_mae,
        round(avg((actual-(0.80*baseline+0.20*prediction)))::numeric,2) model_bias,
        round((100*(avg(abs(actual-baseline))-avg(abs(actual-(0.80*baseline+0.20*prediction))))/nullif(avg(abs(actual-baseline)),0))::numeric,1) improvement_pct
      FROM all_stats GROUP BY stat ORDER BY CASE stat WHEN 'points' THEN 1 WHEN 'rebounds' THEN 2 WHEN 'assists' THEN 3 WHEN 'threes_made' THEN 4 WHEN 'steals' THEN 5 WHEN 'blocks' THEN 6 WHEN 'pra' THEN 7 WHEN 'pr' THEN 8 WHEN 'pa' THEN 9 ELSE 10 END
    `);

    const coverage = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM injury_reports WHERE report_date>=CURRENT_DATE-1) injury_rows,
        (SELECT count(DISTINCT player_id)::int FROM injury_reports WHERE report_date>=CURRENT_DATE-1) injured_players,
        (SELECT count(*)::int FROM projections p JOIN model_versions m ON m.id=p.model_version_id WHERE m.model_key='courtside_player_performance') saved_projection_rows
    `);
    const gradedForecasts = await pool.query(`
      SELECT pm.market_key,count(*)::int sample_size,
        round(avg(pg.absolute_error)::numeric,2) mae,
        round(avg(p.projected_mean-pg.actual_value)::numeric,2) bias
      FROM prediction_grades pg
      JOIN projections p ON p.id=pg.projection_id
      JOIN prop_markets pm ON pm.id=p.market_id
      JOIN model_versions mv ON mv.id=p.model_version_id
      WHERE mv.model_key='courtside_player_performance' AND pg.prop_line_id IS NULL
      GROUP BY pm.market_key ORDER BY pm.market_key
    `);
    return NextResponse.json({
      model:{name:"COURTSIDE performance model",version:"2.0.0"},
      backtest:{method:"Walk-forward: each game is predicted using only the player's previous eight regular-season appearances and the opponent's previous eight team games.",metrics:result.rows},
      data:{...coverage.rows[0],injury_history_available:false},\n      savedForecasts:gradedForecasts.rows,
      features:[
        {name:"Recent form",status:"active",detail:"Recency-weighted last-eight per-minute production blended with current-season rates."},
        {name:"Minutes and role",status:"active",detail:"Recent minutes, last-three trend, starter frequency and workload adjustments."},
        {name:"Opponent defense",status:"active",detail:"Opponent's previous eight games, compared with league averages for each stat."},
        {name:"Game environment",status:"active",detail:"Estimated pace from FGA + 0.44 × FTA + turnovers; home/away history and rest."},
        {name:"Availability and lineup",status:Number(coverage.rows[0].injury_rows)>0?"active":"waiting",detail:"Current ESPN injury statuses and depth-chart roles, plus a conservative redistribution of minutes from unavailable rotation players. Historical injury snapshots are not available yet."},
        {name:"Backtesting",status:"active",detail:"Walk-forward out-of-sample MAE plus saved forecasts graded against completed ESPN box scores."}
      ]
    });
  } catch (error) {
    console.error("Model lab failed",error);
    return NextResponse.json({error:"Model diagnostics are temporarily unavailable."},{status:503});
  }
}
