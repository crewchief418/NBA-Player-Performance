import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { forceAvailabilityRefresh } from "@/app/api/cron/sync/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const recent = await pool.query(
    `SELECT started_at FROM ingestion_runs
     WHERE dataset='nba_manual_availability_refresh'
       AND started_at > now() - interval '5 minutes'
     ORDER BY started_at DESC LIMIT 1`
  );
  if (recent.rowCount) {
    return NextResponse.json({
      error: "An injury refresh was run recently. Please wait five minutes before trying again.",
      retry_after: new Date(new Date(recent.rows[0].started_at).getTime() + 5 * 60 * 1000).toISOString()
    }, { status: 429 });
  }

  try {
    const result = await forceAvailabilityRefresh();
    return NextResponse.json({
      success: result.failures.length === 0,
      injury_rows: result.injuryRows,
      depth_chart_entries: result.depthRows,
      failures: result.failures
    }, { status: result.failures.length ? 207 : 200 });
  } catch (error) {
    console.error("Manual injury refresh failed", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Injury refresh failed"
    }, { status: 500 });
  }
}
