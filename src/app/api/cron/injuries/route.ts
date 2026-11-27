import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ESPN_INJURIES = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries";
const TEAM_CANON: Record<string,string> = {GS:"GSW",NO:"NOP",NY:"NYK",PHX:"PHO",SA:"SAS",UTAH:"UTA",WSH:"WAS",BRK:"BKN",CHO:"CHA"};


function collectDepthPlayers(node: any, inheritedPosition = "", inheritedRank = 0, key = "", output: Array<{id:string;position:string;rank:number}> = []) {
  if (Array.isArray(node)) {
    node.forEach((item,index) => collectDepthPlayers(item,inheritedPosition,
      inheritedRank || (["athletes","players","items","depths","entries"].includes(key.toLowerCase()) ? index+1 : 0),key,output));
    return output;
  }
  if (!node || typeof node !== "object") return output;
  const position=String(node.position?.abbreviation ?? node.position?.name ?? inheritedPosition ?? "");
  const rankValue=Number(node.rank ?? node.depth ?? node.order ?? node.sequence ?? inheritedRank);
  const athlete=node.athlete ?? node.player ?? ((node.id && (node.displayName || node.fullName)) ? node : null);
  const id=String(athlete?.id ?? athlete?.uid ?? "").replace(/^.*?athlete[:/]/,"");
  if(id && Number.isFinite(rankValue) && rankValue>0) output.push({id,position,rank:rankValue});
  for(const [childKey,value] of Object.entries(node)) {
    if(["athlete","player"].includes(childKey)) continue;
    collectDepthPlayers(value,position,0,childKey,output);
  }
  return output;
}

function reportDate() {
  return new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date());
}
function normalizeStatus(value: unknown) {
  const status=String(value ?? "QUESTIONABLE").toLowerCase();
  if(status.includes("out") || status.includes("inactive") || status.includes("injured reserve") || status === "ir") return "OUT";
  if(status.includes("doubt")) return "DOUBTFUL";
  if(status.includes("question")) return "QUESTIONABLE";
  if(status.includes("day")) return "DAY-TO-DAY";
  if(status.includes("prob")) return "PROBABLE";
  return status.toUpperCase().replace(/[^A-Z -]/g,"").slice(0,40) || "QUESTIONABLE";
}

export async function GET(request: NextRequest) {
  const secret=process.env.CRON_SECRET;
  if(!secret || request.headers.get("authorization")!==`Bearer ${secret}`) {
    return NextResponse.json({error:"Unauthorized"},{status:401});
  }
  const startedAt=new Date();
  try {
    const response=await fetch(ESPN_INJURIES,{
      headers:{"User-Agent":"CourtsidePlayerModel/1.0"},
      cache:"no-store",signal:AbortSignal.timeout(20000)
    });
    if(!response.ok) throw new Error(`ESPN injuries returned HTTP ${response.status}`);
    const payload:any=await response.json();
    const teamEntries=Array.isArray(payload)?payload:(payload.injuries ?? []);
    if(!Array.isArray(teamEntries) || teamEntries.length===0) {
      throw new Error("ESPN injury feed returned an unexpected or empty response; existing reports were preserved.");
    }
    const teams=await pool.query("SELECT id,abbreviation FROM teams");
    const teamIds=new Map<string,number>(teams.rows.map((t:any)=>[String(t.abbreviation),Number(t.id)]));
    let saved=0,unmatched=0,depthPlayers=0,depthTeams=0;
    const date=reportDate();
    // ESPN returns a league-wide snapshot; clear earlier same-day statuses before applying it.
    // This prevents a player who was upgraded to available from remaining questionable/out.
    await pool.query("UPDATE injury_reports SET status='AVAILABLE',injury=NULL,captured_at=now() WHERE report_date=$1 AND source='espn'",[date]);
    for(const teamEntry of teamEntries) {
      const teamAbbr=String(teamEntry.team?.abbreviation ?? teamEntry.abbreviation ?? "");
      const teamId=teamIds.get(TEAM_CANON[teamAbbr] ?? teamAbbr) ?? null;
      const injuries=teamEntry.injuries ?? [];
      for(const item of injuries) {
        const athlete=item.athlete ?? item.player ?? {};
        const espnId=String(athlete.id ?? athlete.uid ?? "").replace(/^.*?athlete[:/]/,"");
        if(!espnId) { unmatched++; continue; }
        const player=await pool.query(
          "SELECT id FROM players WHERE provider='espn' AND provider_player_id=$1 LIMIT 1",
          [espnId]
        );
        if(!player.rowCount) { unmatched++; continue; }
        const status=normalizeStatus(item.status?.name ?? item.status ?? item.fantasy?.status);
        const injury=String(item.longComment ?? item.shortComment ?? item.detail ?? item.details?.type ?? item.type?.description ?? item.type?.name ?? "Undisclosed").slice(0,500);
        const returnDate=item.details?.returnDate ?? item.expectedReturnDate ?? item.expectedReturn ?? null;
        await pool.query(
          `INSERT INTO injury_reports(player_id,team_id,report_date,status,injury,expected_return,source,raw_report,captured_at)
           VALUES($1,$2,$3,$4,$5,$6,'espn',$7::jsonb,now())
           ON CONFLICT(player_id,report_date,source) DO UPDATE SET
             team_id=EXCLUDED.team_id,status=EXCLUDED.status,injury=EXCLUDED.injury,
             expected_return=EXCLUDED.expected_return,raw_report=EXCLUDED.raw_report,captured_at=now()`,
          [Number(player.rows[0].id),teamId,date,status,injury,returnDate,JSON.stringify(item)]
        );
        saved++;
      }
    }
    // Current depth charts add a lineup-role signal; actual recent starts remain the primary evidence.
    await pool.query("UPDATE players SET metadata=metadata-'depth_chart_rank'-'depth_chart_position'-'depth_chart_updated_at' WHERE provider='espn'");
    const teamRecords=await pool.query("SELECT provider_team_id FROM teams WHERE provider='espn'");
    const teamIdsToCheck=teamRecords.rows.map((row:any)=>String(row.provider_team_id)).filter(Boolean);
    for(let offset=0;offset<teamIdsToCheck.length;offset+=6) {
      const batch=teamIdsToCheck.slice(offset,offset+6);
      const batchResults=await Promise.all(batch.map(async teamEspnId=>{
        try {
          const depthResponse=await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamEspnId}/depthcharts`,{
            headers:{"User-Agent":"CourtsidePlayerModel/1.0"},cache:"no-store",signal:AbortSignal.timeout(10000)
          });
          if(!depthResponse.ok) return [];
          const depthPayload=await depthResponse.json();
          return collectDepthPlayers(depthPayload);
        } catch { return []; }
      }));
      for(const entries of batchResults) {
        if(entries.length) depthTeams++;
        for(const entry of entries) {
          await pool.query(
            `UPDATE players SET metadata=metadata || $2::jsonb,updated_at=now()
             WHERE provider='espn' AND provider_player_id=$1`,
            [entry.id,JSON.stringify({depth_chart_rank:entry.rank,depth_chart_position:entry.position,depth_chart_updated_at:new Date().toISOString()})]
          );
          depthPlayers++;
        }
      }
    }
    await pool.query(
      `INSERT INTO ingestion_runs(provider,dataset,started_at,completed_at,status,records_received,records_written,metadata)
       VALUES('espn','nba_current_injury_reports',$1,now(),'completed',$2,$3,$4::jsonb)`,
      [startedAt,saved+unmatched+depthPlayers,saved+depthPlayers,JSON.stringify({report_date:date,unmatched,depth_teams:depthTeams,depth_chart_players:depthPlayers})]
    );
    return NextResponse.json({success:true,report_date:date,injury_reports:saved,unmatched_players:unmatched,depth_chart_teams:depthTeams,depth_chart_players:depthPlayers});
  } catch(error) {
    console.error("ESPN injury sync failed",error);
    try {
      await pool.query(
        `INSERT INTO ingestion_runs(provider,dataset,started_at,completed_at,status,error_message)
         VALUES('espn','nba_current_injury_reports',$1,now(),'failed',$2)`,
        [startedAt,error instanceof Error?error.message:String(error)]
      );
    } catch {}
    return NextResponse.json({error:"Injury sync failed; existing reports were preserved."},{status:502});
  }
}
