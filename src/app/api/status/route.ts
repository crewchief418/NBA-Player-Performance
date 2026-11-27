import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM players) AS players,
        (SELECT count(*)::int FROM games) AS games,
        (SELECT count(*)::int FROM player_game_stats) AS player_game_stats,
        (SELECT count(*)::int FROM projections) AS projections,
        (SELECT count(*)::int FROM injury_reports) AS injury_reports
    `);
    return NextResponse.json({ connected: true, counts: result.rows[0] });
  } catch (error) {
    console.error("Database status check failed", error);
    return NextResponse.json({ connected: false, error: "Database connection failed" }, { status: 503 });
  }
}