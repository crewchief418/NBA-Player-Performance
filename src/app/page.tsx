"use client";

import { useEffect, useMemo, useState } from "react";

type Status = { connected: boolean; counts?: Record<string, number>; error?: string };
type Projection = {
  player_id: number; full_name: string; position: string | null; game_date: string;
  home_team: string; away_team: string; sample_size: number; avg_minutes: string;
  points: string; rebounds: string; assists: string; threes_made: string;
  steals: string; blocks: string; pra: string; pr: string; pa: string; ra: string;
};
const statOptions = [
  ["points","PTS"],["rebounds","REB"],["assists","AST"],["threes_made","3PM"],
  ["steals","STL"],["blocks","BLK"],["pra","PRA"],["pr","PR"],["pa","PA"],["ra","RA"]
] as const;

export default function Home() {
  const [status,setStatus] = useState<Status | null>(null);
  const [rows,setRows] = useState<Projection[]>([]);
  const [loading,setLoading] = useState(true);
  const [search,setSearch] = useState("");
  const [stat,setStat] = useState<string>("points");

  useEffect(() => {
    Promise.all([
      fetch("/api/status").then(r=>r.json()),
      fetch("/api/projections").then(r=>r.json())
    ]).then(([s,p]) => { setStatus(s); setRows(p.projections ?? []); })
      .catch(()=>setStatus({connected:false}))
      .finally(()=>setLoading(false));
  },[]);

  const filtered = useMemo(()=>rows.filter(r=>r.full_name.toLowerCase().includes(search.toLowerCase())),[rows,search]);
  const counts = status?.counts ?? {};
  const fmtDate = (d:string) => new Date(d+"T12:00:00").toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">N</div><div><strong>COURTSIDE</strong><span>PLAYER MODEL</span></div></div>
      <div className="nav-label">WORKSPACE</div>
      <a className="nav-item active">◫ <span>Projections</span></a>
      <a className="nav-item">▤ <span>Player Explorer</span></a>
      <a className="nav-item">◷ <span>Model Performance</span></a>
      <a className="nav-item">⌁ <span>Data & Imports</span></a>
      <div className="sidebar-bottom"><span className="status-dot"></span> Database {status?.connected ? "connected" : "connecting"}</div>
    </aside>
    <section className="main">
      <header className="topbar"><div><span className="eyebrow">NBA ANALYTICS / PLAYER MODEL</span><h1>Player projections</h1></div><div className="top-right"><span className="live-pill"><i/> MODEL WORKSPACE</span><div className="avatar">M</div></div></header>
      <div className="intro"><div><h2>Performance, not market lines.</h2><p>Independent statistical projections built from player game history, role, minutes and matchup context.</p></div><div className="date-chip">2026–27 SEASON</div></div>
      <div className="metric-grid">
        <Metric label="PLAYERS IN DATABASE" value={counts.players ?? "—"} note="Unique player records"/>
        <Metric label="GAMES LOADED" value={counts.games ?? "—"} note="Schedule and results"/>
        <Metric label="PLAYER GAME LOGS" value={counts.player_game_stats ?? "—"} note="Historical stat records"/>
        <Metric label="MODEL PROJECTIONS" value={counts.projections ?? "—"} note="Saved model outputs"/>
      </div>
      <div className="panel">
        <div className="panel-head"><div><span className="eyebrow">UPCOMING SLATE</span><h3>Player stat forecasts</h3><p>Initial baseline uses each player's most recent eight regular-season games.</p></div><span className="tag">BASELINE MODEL · V0.1</span></div>
        <div className="filters"><input aria-label="Search players" placeholder="Search player..." value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="Stat market" value={stat} onChange={e=>setStat(e.target.value)}>{statOptions.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
        {loading ? <div className="empty">Loading player data…</div> : filtered.length ? <div className="table-wrap"><table><thead><tr><th>PLAYER</th><th>GAME</th><th>DATE</th><th>MIN / AVG</th><th>PROJECTION</th><th>SAMPLE</th></tr></thead><tbody>{filtered.map((r,i)=><tr key={r.player_id+"-"+r.game_date+"-"+i}><td><strong>{r.full_name}</strong><small>{r.position ?? "—"}</small></td><td>{r.away_team} @ {r.home_team}</td><td>{fmtDate(r.game_date)}</td><td>{r.avg_minutes ?? "—"}</td><td className="projection">{r[stat as keyof Projection] ?? "—"} <small>{statOptions.find(x=>x[0]===stat)?.[1]}</small></td><td><span className="sample">{r.sample_size} G</span></td></tr>)}</tbody></table></div> : <div className="empty"><div className="empty-icon">◎</div><strong>{rows.length ? "No matching players" : "Your data pipeline is next"}</strong><p>{rows.length ? "Try another player name." : "The database is connected, but no player game logs or upcoming schedule have been imported yet. Next we'll build the historical Basketball Reference importer."}</p></div>}
      </div>
      <footer>COURTSIDE PLAYER MODEL <span>Independent projections · No sportsbook feeds</span></footer>
    </section>
  </main>;
}

function Metric({label,value,note}:{label:string;value:number|string;note:string}) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}