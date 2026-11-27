import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

const markets = [
  ["points", "Points"], ["rebounds", "Rebounds"], ["assists", "Assists"],
  ["threes_made", "3-pointers"], ["steals", "Steals"], ["blocks", "Blocks"],
  ["pra", "PRA"], ["pr", "Points + Rebounds"], ["pa", "Points + Assists"], ["ra", "Rebounds + Assists"]
] as const;

const MODEL_KEY = "courtside_player_performance";
const MODEL_VERSION = "2.0.0";

export async function GET() {
  try {
    const model = await pool.query(
      `INSERT INTO model_versions(model_key,version,description,config)
       VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(model_key,version) DO UPDATE SET description=EXCLUDED.description,config=EXCLUDED.config
       RETURNING id`,
      [MODEL_KEY, MODEL_VERSION,
       "Minutes-first, recency-weighted player performance model with opponent defense, pace, venue, rest and current injury context.",
       JSON.stringify({recent_window:8,minimum_sample:3,recency_decay:0.82,features:["minutes","weighted_form","season_blend","starter_role","opponent_defense","pace","home_away","rest","workload","injury_availability","teammate_absences"]})]
    );
    const modelVersionId = Number(model.rows[0].id);

    const result = await pool.query(`
      WITH latest_games AS (
        SELECT g.id,g.game_date,g.scheduled_start,g.home_team_id,g.away_team_id
        FROM games g
        WHERE g.season=2027 AND g.season_type='regular'
          AND g.status IN ('scheduled','pre-game','pregame')
          AND g.game_date >= CURRENT_DATE
        ORDER BY g.game_date,g.scheduled_start LIMIT 30
      ),
      history AS (
        SELECT pgs.*,g.game_date,g.season,g.home_team_id,g.away_team_id,
          (pgs.team_id=g.home_team_id) AS is_home,
          row_number() OVER(PARTITION BY pgs.player_id ORDER BY g.game_date DESC,g.id DESC) rn
        FROM player_game_stats pgs JOIN games g ON g.id=pgs.game_id
        WHERE g.status='final' AND g.season_type='regular' AND pgs.minutes>0
      ),
      player_avgs AS (
        SELECT player_id,
          count(*) FILTER(WHERE rn<=8)::int sample_size,
          avg(minutes) FILTER(WHERE rn<=8) recent_minutes,
          avg(minutes) FILTER(WHERE rn<=3) last3_minutes,
          avg(minutes) FILTER(WHERE season=2027) season_minutes,
          avg(started::int) FILTER(WHERE rn<=8) starter_rate,
          max(game_date) FILTER(WHERE rn=1) last_game_date,
          avg(points) FILTER(WHERE rn<=8) baseline_points,
          avg(rebounds) FILTER(WHERE rn<=8) baseline_rebounds,
          avg(assists) FILTER(WHERE rn<=8) baseline_assists,
          avg(threes_made) FILTER(WHERE rn<=8) baseline_threes,
          avg(steals) FILTER(WHERE rn<=8) baseline_steals,
          avg(blocks) FILTER(WHERE rn<=8) baseline_blocks,
          count(*) FILTER(WHERE rn<=20 AND is_home)::int home_sample,
          count(*) FILTER(WHERE rn<=20 AND NOT is_home)::int away_sample,
          sum(power(0.82,rn-1)*points/nullif(minutes,0)*36) FILTER(WHERE rn<=8)
            / nullif(sum(power(0.82,rn-1)) FILTER(WHERE rn<=8),0) points_rate,
          sum(power(0.82,rn-1)*rebounds/nullif(minutes,0)*36) FILTER(WHERE rn<=8)
            / nullif(sum(power(0.82,rn-1)) FILTER(WHERE rn<=8),0) rebounds_rate,
          sum(power(0.82,rn-1)*assists/nullif(minutes,0)*36) FILTER(WHERE rn<=8)
            / nullif(sum(power(0.82,rn-1)) FILTER(WHERE rn<=8),0) assists_rate,
          sum(power(0.82,rn-1)*threes_made/nullif(minutes,0)*36) FILTER(WHERE rn<=8)
            / nullif(sum(power(0.82,rn-1)) FILTER(WHERE rn<=8),0) threes_rate,
          sum(power(0.82,rn-1)*steals/nullif(minutes,0)*36) FILTER(WHERE rn<=8)
            / nullif(sum(power(0.82,rn-1)) FILTER(WHERE rn<=8),0) steals_rate,
          sum(power(0.82,rn-1)*blocks/nullif(minutes,0)*36) FILTER(WHERE rn<=8)
            / nullif(sum(power(0.82,rn-1)) FILTER(WHERE rn<=8),0) blocks_rate,
          avg(points/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND is_home) home_points_rate,
          avg(points/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND NOT is_home) away_points_rate,
          avg(rebounds/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND is_home) home_rebounds_rate,
          avg(rebounds/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND NOT is_home) away_rebounds_rate,
          avg(assists/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND is_home) home_assists_rate,
          avg(assists/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND NOT is_home) away_assists_rate,
          avg(threes_made/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND is_home) home_threes_rate,
          avg(threes_made/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND NOT is_home) away_threes_rate,
          avg(steals/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND is_home) home_steals_rate,
          avg(steals/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND NOT is_home) away_steals_rate,
          avg(blocks/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND is_home) home_blocks_rate,
          avg(blocks/nullif(minutes,0)*36) FILTER(WHERE rn<=20 AND NOT is_home) away_blocks_rate,
          avg(points/nullif(minutes,0)*36) FILTER(WHERE season=2027) season_points_rate,
          avg(rebounds/nullif(minutes,0)*36) FILTER(WHERE season=2027) season_rebounds_rate,
          avg(assists/nullif(minutes,0)*36) FILTER(WHERE season=2027) season_assists_rate,
          avg(threes_made/nullif(minutes,0)*36) FILTER(WHERE season=2027) season_threes_rate,
          avg(steals/nullif(minutes,0)*36) FILTER(WHERE season=2027) season_steals_rate,
          avg(blocks/nullif(minutes,0)*36) FILTER(WHERE season=2027) season_blocks_rate
        FROM history GROUP BY player_id HAVING count(*) FILTER(WHERE rn<=8)>=3
      ),
      rates AS (
        SELECT a.*,
          coalesce(0.72*points_rate+0.28*season_points_rate,points_rate) p_rate,
          coalesce(0.72*rebounds_rate+0.28*season_rebounds_rate,rebounds_rate) r_rate,
          coalesce(0.72*assists_rate+0.28*season_assists_rate,assists_rate) a_rate,
          coalesce(0.72*threes_rate+0.28*season_threes_rate,threes_rate) t_rate,
          coalesce(0.72*steals_rate+0.28*season_steals_rate,steals_rate) s_rate,
          coalesce(0.72*blocks_rate+0.28*season_blocks_rate,blocks_rate) b_rate
        FROM player_avgs a
      ),
      team_game_allowed AS (
        SELECT g.id game_id,g.game_date,pgs.opponent_team_id defense_team_id,
          sum(pgs.points) points_allowed,sum(pgs.rebounds) rebounds_allowed,
          sum(pgs.assists) assists_allowed,sum(pgs.threes_made) threes_allowed,
          sum(pgs.steals) steals_allowed,sum(pgs.blocks) blocks_allowed
        FROM player_game_stats pgs JOIN games g ON g.id=pgs.game_id
        WHERE g.status='final' AND g.season_type='regular' AND pgs.opponent_team_id IS NOT NULL
        GROUP BY g.id,g.game_date,pgs.opponent_team_id
      ),
      defense_ranked AS (
        SELECT *,row_number() OVER(PARTITION BY defense_team_id ORDER BY game_date DESC,game_id DESC) rn
        FROM team_game_allowed
      ),
      defense_avg AS (
        SELECT defense_team_id,
          avg(points_allowed) points_allowed,avg(rebounds_allowed) rebounds_allowed,
          avg(assists_allowed) assists_allowed,avg(threes_allowed) threes_allowed,
          avg(steals_allowed) steals_allowed,avg(blocks_allowed) blocks_allowed
        FROM defense_ranked WHERE rn<=8 GROUP BY defense_team_id
      ),
      league_defense AS (
        SELECT avg(points_allowed) points_allowed,avg(rebounds_allowed) rebounds_allowed,
          avg(assists_allowed) assists_allowed,avg(threes_allowed) threes_allowed,
          avg(steals_allowed) steals_allowed,avg(blocks_allowed) blocks_allowed
        FROM team_game_allowed
      ),
      team_game_pace AS (
        SELECT g.id game_id,g.game_date,pgs.team_id,
          sum(coalesce(pgs.field_goals_attempted,0)+0.44*coalesce(pgs.free_throws_attempted,0)+coalesce(pgs.turnovers,0)) possessions
        FROM player_game_stats pgs JOIN games g ON g.id=pgs.game_id
        WHERE g.status='final' AND g.season_type='regular' AND pgs.team_id IS NOT NULL
        GROUP BY g.id,g.game_date,pgs.team_id
      ),
      pace_ranked AS (
        SELECT *,row_number() OVER(PARTITION BY team_id ORDER BY game_date DESC,game_id DESC) rn
        FROM team_game_pace
      ),
      pace_avg AS (
        SELECT team_id,avg(possessions) possessions FROM pace_ranked WHERE rn<=8 GROUP BY team_id
      ),
      league_pace AS (SELECT avg(possessions) possessions FROM team_game_pace),
      injury_latest AS (
        SELECT DISTINCT ON(player_id) player_id,status,injury
        FROM injury_reports WHERE report_date>=CURRENT_DATE-1
        ORDER BY player_id,report_date DESC,captured_at DESC
      ),
      team_rotation AS (
        SELECT p.metadata->>'roster_team' team_abbr,
          sum(r.recent_minutes) FILTER(WHERE coalesce(i.status,'') NOT IN ('OUT','DOUBTFUL')) active_minutes
        FROM players p JOIN rates r ON r.player_id=p.id
        LEFT JOIN injury_latest i ON i.player_id=p.id
        WHERE p.active=true GROUP BY p.metadata->>'roster_team'
      ),
      team_missing AS (
        SELECT p.metadata->>'roster_team' team_abbr,
          sum(r.recent_minutes * CASE i.status WHEN 'OUT' THEN 1.0 WHEN 'DOUBTFUL' THEN 0.5 WHEN 'QUESTIONABLE' THEN 0.25 ELSE 0 END) missing_minutes
        FROM players p JOIN rates r ON r.player_id=p.id
        JOIN injury_latest i ON i.player_id=p.id
        WHERE p.active=true AND i.status IN ('OUT','DOUBTFUL','QUESTIONABLE')
        GROUP BY p.metadata->>'roster_team'
      ),
      candidates AS (
        SELECT p.full_name,p.position,p.metadata->>'espn_id' espn_id,
          lg.id game_id,lg.game_date,lg.scheduled_start,
          ht.abbreviation home_team,at.abbreviation away_team,
          (p.metadata->>'roster_team'=ht.abbreviation) is_home,
          CASE WHEN p.metadata->>'roster_team'=ht.abbreviation THEN lg.away_team_id ELSE lg.home_team_id END opponent_team_id,
          p.metadata->>'roster_team' roster_team,p.metadata->>'depth_chart_rank' depth_chart_rank,p.metadata->>'depth_chart_position' depth_chart_position,r.*,
          coalesce(i.status,'') injury_status,coalesce(i.injury,'') injury_detail,
          coalesce(tm.missing_minutes,0) missing_minutes,coalesce(tr.active_minutes,0) active_rotation_minutes,
          coalesce(pa.possessions,lp.possessions) home_pace,
          coalesce(pb.possessions,lp.possessions) away_pace,
          da.points_allowed,da.rebounds_allowed,da.assists_allowed,da.threes_allowed,da.steals_allowed,da.blocks_allowed,
          ld.points_allowed league_points_allowed,ld.rebounds_allowed league_rebounds_allowed,
          ld.assists_allowed league_assists_allowed,ld.threes_allowed league_threes_allowed,
          ld.steals_allowed league_steals_allowed,ld.blocks_allowed league_blocks_allowed,
          (lg.game_date-r.last_game_date) rest_days
        FROM latest_games lg JOIN teams ht ON ht.id=lg.home_team_id JOIN teams at ON at.id=lg.away_team_id
        JOIN players p ON p.active=true AND p.metadata->>'roster_team' IN (ht.abbreviation,at.abbreviation)
        JOIN rates r ON r.player_id=p.id
        LEFT JOIN injury_latest i ON i.player_id=p.id
        LEFT JOIN team_missing tm ON tm.team_abbr=p.metadata->>'roster_team'
        LEFT JOIN team_rotation tr ON tr.team_abbr=p.metadata->>'roster_team'
        LEFT JOIN defense_avg da ON da.defense_team_id=CASE WHEN p.metadata->>'roster_team'=ht.abbreviation THEN lg.away_team_id ELSE lg.home_team_id END
        CROSS JOIN league_defense ld CROSS JOIN league_pace lp
        LEFT JOIN pace_avg pa ON pa.team_id=lg.home_team_id
        LEFT JOIN pace_avg pb ON pb.team_id=lg.away_team_id
        WHERE coalesce(i.status,'')<>'OUT'
      ),
      minutes_calc AS (
        SELECT *,
          greatest(6,least(40,
            (coalesce(0.65*recent_minutes+0.35*season_minutes,recent_minutes)
              + greatest(-3,least(3,coalesce((last3_minutes-recent_minutes)*0.25,0)))
              + CASE WHEN starter_rate>=0.60 THEN 0.5 ELSE 0 END
              + CASE WHEN depth_chart_rank='1' THEN 1.0 WHEN depth_chart_rank='2' THEN 0.3 ELSE 0 END
              + CASE WHEN rest_days<=1 THEN -1.2 WHEN rest_days>=3 THEN 0.3 ELSE 0 END
              + CASE WHEN recent_minutes>=36 THEN -0.6 ELSE 0 END
              + CASE WHEN active_rotation_minutes>0 THEN least(3,missing_minutes*0.50*recent_minutes/active_rotation_minutes) ELSE 0 END
            ) * CASE WHEN injury_status='DOUBTFUL' THEN 0.65 WHEN injury_status='QUESTIONABLE' THEN 0.88 WHEN injury_status IN ('DAY-TO-DAY','DAY TO DAY') THEN 0.93 ELSE 1 END
          )) expected_minutes,
          greatest(0.94,least(1.06,((coalesce(home_pace,0)+coalesce(away_pace,0))/2)/nullif( (SELECT possessions FROM league_pace),0))) pace_factor
        FROM candidates
      ),
      projected AS (
        SELECT *,
          greatest(0.88,least(1.12,1+0.45*(coalesce(points_allowed,league_points_allowed)/nullif(league_points_allowed,0)-1))) p_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(rebounds_allowed,league_rebounds_allowed)/nullif(league_rebounds_allowed,0)-1))) r_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(assists_allowed,league_assists_allowed)/nullif(league_assists_allowed,0)-1))) a_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(threes_allowed,league_threes_allowed)/nullif(league_threes_allowed,0)-1))) t_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(steals_allowed,league_steals_allowed)/nullif(league_steals_allowed,0)-1))) s_def,
          greatest(0.88,least(1.12,1+0.45*(coalesce(blocks_allowed,league_blocks_allowed)/nullif(league_blocks_allowed,0)-1))) b_def,
          CASE WHEN is_home AND home_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*home_points_rate/nullif(p_rate,0)))
               WHEN NOT is_home AND away_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*away_points_rate/nullif(p_rate,0))) ELSE 1 END p_venue,
          CASE WHEN is_home AND home_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*home_rebounds_rate/nullif(r_rate,0)))
               WHEN NOT is_home AND away_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*away_rebounds_rate/nullif(r_rate,0))) ELSE 1 END r_venue,
          CASE WHEN is_home AND home_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*home_assists_rate/nullif(a_rate,0)))
               WHEN NOT is_home AND away_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*away_assists_rate/nullif(a_rate,0))) ELSE 1 END a_venue,
          CASE WHEN is_home AND home_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*home_threes_rate/nullif(t_rate,0)))
               WHEN NOT is_home AND away_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*away_threes_rate/nullif(t_rate,0))) ELSE 1 END t_venue,
          CASE WHEN is_home AND home_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*home_steals_rate/nullif(s_rate,0)))
               WHEN NOT is_home AND away_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*away_steals_rate/nullif(s_rate,0))) ELSE 1 END s_venue,
          CASE WHEN is_home AND home_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*home_blocks_rate/nullif(b_rate,0)))
               WHEN NOT is_home AND away_sample>=3 THEN greatest(0.90,least(1.10,0.5+0.5*away_blocks_rate/nullif(b_rate,0))) ELSE 1 END b_venue
        FROM minutes_calc
      )
      SELECT player_id,full_name,position,espn_id,game_id,game_date,scheduled_start,home_team,away_team,
        sample_size,round(expected_minutes::numeric,1) avg_minutes,
        round((0.80*baseline_points+0.20*(p_rate*expected_minutes/36*p_def*p_venue*pace_factor))::numeric,1) points,
        round((0.80*baseline_rebounds+0.20*(r_rate*expected_minutes/36*r_def*r_venue*pace_factor))::numeric,1) rebounds,
        round((0.80*baseline_assists+0.20*(a_rate*expected_minutes/36*a_def*a_venue*pace_factor))::numeric,1) assists,
        round((0.80*baseline_threes+0.20*(t_rate*expected_minutes/36*t_def*t_venue*pace_factor))::numeric,1) threes_made,
        round((0.80*baseline_steals+0.20*(s_rate*expected_minutes/36*s_def*s_venue*pace_factor))::numeric,1) steals,
        round((0.80*baseline_blocks+0.20*(b_rate*expected_minutes/36*b_def*b_venue*pace_factor))::numeric,1) blocks,
        round((0.80*(baseline_points+baseline_rebounds+baseline_assists)+0.20*((p_rate*expected_minutes/36*p_def*p_venue*pace_factor)+(r_rate*expected_minutes/36*r_def*r_venue*pace_factor)+(a_rate*expected_minutes/36*a_def*a_venue*pace_factor)))::numeric,1) pra,
        round((0.80*(baseline_points+baseline_rebounds)+0.20*((p_rate*expected_minutes/36*p_def*p_venue*pace_factor)+(r_rate*expected_minutes/36*r_def*r_venue*pace_factor)))::numeric,1) pr,
        round((0.80*(baseline_points+baseline_assists)+0.20*((p_rate*expected_minutes/36*p_def*p_venue*pace_factor)+(a_rate*expected_minutes/36*a_def*a_venue*pace_factor)))::numeric,1) pa,
        round((0.80*(baseline_rebounds+baseline_assists)+0.20*((r_rate*expected_minutes/36*r_def*r_venue*pace_factor)+(a_rate*expected_minutes/36*a_def*a_venue*pace_factor)))::numeric,1) ra,
        round((greatest(starter_rate,CASE WHEN depth_chart_rank='1' THEN 0.75 WHEN depth_chart_rank='2' THEN 0.45 ELSE 0 END)*100)::numeric,0) starter_probability,
        injury_status,injury_detail,rest_days,
        jsonb_build_object('sample_size',sample_size,'weighted_recent_per36',jsonb_build_object('points',p_rate,'rebounds',r_rate,'assists',a_rate,'threes',t_rate,'steals',s_rate,'blocks',b_rate),
          'opponent_defense',jsonb_build_object('points',p_def,'rebounds',r_def,'assists',a_def,'threes',t_def,'steals',s_def,'blocks',b_def),
          'pace_factor',pace_factor,'home_away',is_home,'rest_days',rest_days,'starter_rate',starter_rate,'depth_chart_rank',depth_chart_rank,'depth_chart_position',depth_chart_position,
          'injury_status',injury_status,'teammate_missing_minutes',missing_minutes) feature_snapshot
      FROM projected ORDER BY game_date,scheduled_start,full_name LIMIT 1200
    `);

    // Save every forecast as a reproducible model snapshot. Repeated refreshes in the same minute update it.
    const marketRows = await pool.query("SELECT id,market_key FROM prop_markets WHERE active=true");
    const marketIds = new Map<string,number>(marketRows.rows.map((r:any)=>[String(r.market_key),Number(r.id)]));
    const snapshotRows: any[] = [];
    for (const p of result.rows) {
      const values: Record<string,number> = {
        points:Number(p.points),rebounds:Number(p.rebounds),assists:Number(p.assists),
        threes_made:Number(p.threes_made),steals:Number(p.steals),blocks:Number(p.blocks),
        pra:Number(p.pra),pr:Number(p.pr),pa:Number(p.pa),ra:Number(p.ra)
      };
      for (const [key] of markets) {
        const marketId=marketIds.get(key);
        if (marketId) snapshotRows.push({
          game_id:p.game_id,player_id:p.player_id,market_id:marketId,model_version_id:modelVersionId,
          projected_mean:values[key],expected_minutes:Number(p.avg_minutes),
          feature_snapshot:p.feature_snapshot
        });
      }
    }
    if (snapshotRows.length) {
      await pool.query(
        `INSERT INTO projections(game_id,player_id,market_id,model_version_id,projected_mean,expected_minutes,feature_snapshot,generated_at)
         SELECT x.game_id,x.player_id,x.market_id,x.model_version_id,x.projected_mean,x.expected_minutes,x.feature_snapshot,date_trunc('minute',now())
         FROM jsonb_to_recordset($1::jsonb) AS x(game_id bigint,player_id bigint,market_id bigint,model_version_id bigint,projected_mean numeric,expected_minutes numeric,feature_snapshot jsonb)
         ON CONFLICT(game_id,player_id,market_id,model_version_id,generated_at)
         DO UPDATE SET projected_mean=EXCLUDED.projected_mean,expected_minutes=EXCLUDED.expected_minutes,feature_snapshot=EXCLUDED.feature_snapshot`,
        [JSON.stringify(snapshotRows)]
      );
    }
    return NextResponse.json({projections:result.rows,markets,model:{version:MODEL_VERSION,saved:snapshotRows.length}});
  } catch (error) {
    console.error("Projection query failed",error);
    return NextResponse.json({projections:[],markets,error:"Projection data is not ready yet."},{status:503});
  }
}
