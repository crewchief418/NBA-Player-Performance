"use client";

import { useEffect, useMemo, useState } from "react";

type Status = { connected: boolean; counts?: Record<string, number>; error?: string };
type ModelDiagnostics = { model?: {version:string}; backtest?: {method:string;metrics:Array<{stat:string;sample_size:number;baseline_mae:string;model_mae:string;model_bias:string;improvement_pct:string}>}; data?: {injury_rows:number;injured_players:number;depth_chart_players:number;saved_projection_rows:number;injury_history_available:boolean}; features?: Array<{name:string;status:string;detail:string}>; savedForecasts?: Array<{market_key:string;sample_size:number;mae:string;bias:string}>; gradedDetails?: Array<{projection_id:number;game_date:string;full_name:string;home_team:string;away_team:string;market_key:string;market_name:string;projected_mean:string;actual_value:string;absolute_error:string;signed_error:string}> };
type Projection = {
  player_id: number; game_id: number; espn_id?: string | null; full_name: string; roster_team?: string | null;
  position: string | null; game_date: string; scheduled_start?: string | null;
  home_team: string; away_team: string; sample_size: number; avg_minutes: string;
  points: string; rebounds: string; assists: string; threes_made: string;
  steals: string; blocks: string; pra: string; pr: string; pa: string; ra: string;
  starter_probability?: string; depth_chart_rank?: string | null; depth_chart_position?: string | null; injury_status?: string; injury_designator?: string | null; injury_detail?: string; rest_days?: number;
};
type GameGroup = { gameId: number; date: string; tipoff?: string | null; home: string; away: string; players: Projection[] };
type ScoreboardGame = { date: string; home: string; away: string; state: "live" | "final" | "scheduled"; displayClock?: string; period?: number; total?: number | null; spread?: number | null };
type VegasLine = {
  player_id: number; game_id: number; full_name: string; game_date: string; home_team: string; away_team: string;
  market_name: string; line: string; over_odds: number | null; under_odds: number | null;
  sportsbook_name: string; projected_mean: string; edge: string; captured_at: string;
  injury_status?: string; injury_detail?: string | null;
};

const stats = [
  ["points","PTS"],["rebounds","REB"],["assists","AST"],
  ["threes_made","3PM"],["steals","STL"],["blocks","BLK"]
] as const;
const combos = [["pra","PRA"],["pr","P+R"],["pa","P+A"],["ra","R+A"]] as const;
const EDGE_THRESHOLDS: Record<string,number> = {
  "points":2.5,
  "rebounds":1.0,
  "assists":1.0,
  "3-pointers made":0.5,
  "steals":0.5,
  "blocks":0.5,
  "points + rebounds + assists":3.5
};
const teamNames: Record<string,string> = {
  ATL:"Atlanta Hawks",BOS:"Boston Celtics",BKN:"Brooklyn Nets",CHA:"Charlotte Hornets",
  CHI:"Chicago Bulls",CLE:"Cleveland Cavaliers",DAL:"Dallas Mavericks",DEN:"Denver Nuggets",
  DET:"Detroit Pistons",GSW:"Golden State Warriors",HOU:"Houston Rockets",IND:"Indiana Pacers",
  LAC:"LA Clippers",LAL:"Los Angeles Lakers",MEM:"Memphis Grizzlies",MIA:"Miami Heat",
  MIL:"Milwaukee Bucks",MIN:"Minnesota Timberwolves",NOP:"New Orleans Pelicans",NYK:"New York Knicks",
  OKC:"Oklahoma City Thunder",ORL:"Orlando Magic",PHI:"Philadelphia 76ers",PHO:"Phoenix Suns",
  POR:"Portland Trail Blazers",SAC:"Sacramento Kings",SAS:"San Antonio Spurs",TOR:"Toronto Raptors",
  UTA:"Utah Jazz",WAS:"Washington Wizards"
};
const logoCode: Record<string,string> = {GSW:"gs",NOP:"no",NYK:"ny",PHO:"phx",SAS:"sa",UTA:"utah",WAS:"wsh",BKN:"bkn",BRK:"bkn",CHA:"cha",CHO:"cha",LAC:"lac"};

function safeDate(value: string) {
  if (!value) return null;
  const dateOnly = value.slice(0,10);
  const parsed = new Date(dateOnly + "T12:00:00");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function dateLabel(value: string, options: Intl.DateTimeFormatOptions) {
  const date = safeDate(value);
  return date ? new Intl.DateTimeFormat("en-US", { timeZone:"America/Denver", ...options }).format(date) : "Date TBA";
}
function tipoffLabel(value?: string | null) {
  if (!value) return "TIME TBA";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "TIME TBA" : new Intl.DateTimeFormat("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Denver"}).format(date);
}
function TeamMark({abbr,large=false}:{abbr:string;large?:boolean}) {
  const [failed,setFailed] = useState(false);
  const code = logoCode[abbr] ?? abbr.toLowerCase();
  return <div className={large ? "team-mark large" : "team-mark"}>
    {!failed ? <img src={`https://a.espncdn.com/i/teamlogos/nba/500/${code}.png`} alt="" onError={()=>setFailed(true)}/> : <span>{abbr}</span>}
  </div>;
}
function PlayerCard({player,vegasLines}:{player:Projection;vegasLines:VegasLine[]}) {
  const [expanded,setExpanded] = useState(false);
  const [headshotFailed,setHeadshotFailed] = useState(false);
  const playerLines = vegasLines.filter(line =>
    line.player_id != null && line.game_id != null
      ? Number(line.player_id) === Number(player.player_id) && Number(line.game_id) === Number(player.game_id)
      : line.full_name.trim().toLowerCase() === player.full_name.trim().toLowerCase()
        && String(line.game_date).slice(0,10) === String(player.game_date).slice(0,10)
  );
  const marketGroups = [...new Set(playerLines.map(line=>line.market_name))];
  const hasQualifiedEdge = playerLines.some(line => {
    const threshold=EDGE_THRESHOLDS[line.market_name.trim().toLowerCase()];
    const edge=Math.abs(Number(line.edge));
    return threshold !== undefined && Number.isFinite(edge) && edge >= threshold;
  });
  return <article className={expanded ? "player-card expanded" : "player-card"}>
    <button className="player-main" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>
      <div className="player-identity">
        <div className="headshot">
          {player.espn_id && !headshotFailed
            ? <img src={`https://a.espncdn.com/i/headshots/nba/players/full/${player.espn_id}.png`} alt="" onError={()=>setHeadshotFailed(true)}/>
            : <span>{player.full_name.split(" ").map(x=>x[0]).slice(0,2).join("")}</span>}
        </div>
        <div className={hasQualifiedEdge ? "player-name threshold-hit" : "player-name"}><strong>{player.full_name} {player.injury_designator && <em className={`injury-tag injury-${player.injury_designator.toLowerCase()}`} title={`${player.injury_status}${player.injury_detail ? ` — ${player.injury_detail}` : ""}`}>{player.injury_designator}</em>}</strong><span>{player.position || "PLAYER"} <i/> {player.avg_minutes || "—"} MIN AVG</span><small className="player-team"><TeamMark abbr={player.roster_team || "NBA"}/> <b>{teamNames[player.roster_team || ""] || player.roster_team || "TEAM TBD"}</b></small></div>
      </div>
      <div className="primary-stat"><strong>{player.points}</strong><span>PTS</span></div>
      <div className="primary-stat"><strong>{player.rebounds}</strong><span>REB</span></div>
      <div className="primary-stat"><strong>{player.assists}</strong><span>AST</span></div>
      <div className="primary-stat secondary"><strong>{player.pra}</strong><span>PRA</span></div>
      <div className="expand-indicator">{expanded ? "−" : "+"}</div>
    </button>
    {expanded && <div className="player-details">
      <div className="detail-heading"><span>MODEL-ADJUSTED FORECAST</span><b>{player.sample_size} GAME SAMPLE</b></div>
      <div className="stat-grid">{stats.map(([key,label])=><div className="stat-tile" key={key}><span>{label}</span><strong>{player[key]}</strong></div>)}</div>
      <div className="combo-row">{combos.map(([key,label])=><div key={key}><span>{label}</span><strong>{player[key]}</strong></div>)}</div>
      <div className="player-context"><span>PROJECTED MINUTES <b>{player.avg_minutes}</b></span><span>STARTER RATE <b>{player.starter_probability ?? "—"}%</b></span><span>DEPTH <b>{player.depth_chart_rank ? `#${player.depth_chart_rank} ${player.depth_chart_position ?? ""}` : "—"}</b></span><span>REST <b>{player.rest_days == null ? "—" : `${player.rest_days}D`}</b></span>{player.injury_status && <span>AVAILABILITY <b>{player.injury_status}</b></span>}</div>
      <div className="player-vegas">
        <div className="player-vegas-heading"><div><span className="kicker">MARKET COMPARISON</span><h3>Sportsbook lines</h3></div><span>{playerLines.length} LINES</span></div>
        {playerLines.length ? marketGroups.map(market=>{
          const marketLines=playerLines.filter(line=>line.market_name===market);
          const modelValue=Number(marketLines[0].projected_mean);
          const marketThreshold=EDGE_THRESHOLDS[market.trim().toLowerCase()];
          const thresholdHit=marketThreshold !== undefined && marketLines.some(line => {
            const edge=Math.abs(Number(line.edge));
            return Number.isFinite(edge) && edge >= marketThreshold;
          });
          return <section className="player-market-group" key={market}>
            <div className={thresholdHit ? "player-market-title threshold-hit" : "player-market-title"}><strong>{market}</strong>{marketThreshold !== undefined && <em className={thresholdHit ? "threshold-indicator active" : "threshold-indicator"}>{thresholdHit ? "THRESHOLD HIT" : `±${marketThreshold.toFixed(1)} REQUIRED`}</em>}<span>COURTSIDE <b>{modelValue.toFixed(1)}</b></span></div>
            <div className="player-book-list">{marketLines.map((line,index)=><div className="player-book-line" key={line.sportsbook_name+"-"+line.line+"-"+index}>
              <div className="book-name">{line.sportsbook_name}<small>{line.injury_status ?? "UNREPORTED"}{line.injury_detail ? " · "+line.injury_detail : ""}</small></div>
              <div className="book-number"><span>LINE</span><strong>{Number(line.line).toFixed(1)}</strong><small>O {line.over_odds ?? "—"} / U {line.under_odds ?? "—"}</small></div>
              <div className={"book-edge "+(Number(line.edge)>0?"positive-change":Number(line.edge)<0?"negative-change":"")+(marketThreshold !== undefined && Number.isFinite(Math.abs(Number(line.edge))) && Math.abs(Number(line.edge))>=marketThreshold?" threshold-met":"")}><span>MODEL EDGE</span><strong>{Number(line.edge)>0?"+":""}{Number(line.edge).toFixed(1)}</strong><small>{Number(line.edge)>0?"HIGHER":Number(line.edge)<0?"LOWER":"EVEN"}</small></div>
            </div>)}</div>
          </section>;
        }) : <p className="player-vegas-empty">No matched sportsbook lines for this player yet. Lines appear here after the daily Vegas update and when a saved Courtside projection is available.</p>}
        <p className="player-vegas-note">Sportsbook data is a snapshot and may be delayed. OUT players are shown for reference; check availability before using any line.</p>
      </div>
      <p className="detail-note">Minutes-first forecast using recency-weighted production, current-season form, opponent defense, estimated pace, venue splits and rest. Current ESPN availability reports are applied when available.</p>
    </div>}
  </article>;
}

export default function Home() {
  const [status,setStatus] = useState<Status | null>(null);
  const [model,setModel] = useState<ModelDiagnostics | null>(null);
  const [rows,setRows] = useState<Projection[]>([]);
  const [loading,setLoading] = useState(true);
  const [search,setSearch] = useState("");
  const [selectedDate,setSelectedDate] = useState("all");
  const [modelMenuOpen,setModelMenuOpen] = useState(false);
  const [expandedGames,setExpandedGames] = useState<Record<number,boolean>>({});
  const [installPrompt,setInstallPrompt] = useState<any>(null);
  const [refreshingInjuries,setRefreshingInjuries] = useState(false);
  const [injuryRefreshMessage,setInjuryRefreshMessage] = useState("");
  const [refreshingResults,setRefreshingResults] = useState(false);
  const [resultsRefreshMessage,setResultsRefreshMessage] = useState("");
  const [fetchingProps,setFetchingProps] = useState(false);
  const [propsMessage,setPropsMessage] = useState("");
  const [vegasLines,setVegasLines] = useState<VegasLine[]>([]);
  const [scoreboard,setScoreboard] = useState<ScoreboardGame[]>([]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
    const installHandler = (event: Event) => { event.preventDefault(); setInstallPrompt(event as any); };
    window.addEventListener("beforeinstallprompt", installHandler);
    return () => window.removeEventListener("beforeinstallprompt", installHandler);
  },[]);

  useEffect(() => {
    Promise.all([
      fetch("/api/status").then(r=>r.json()),
      fetch("/api/projections").then(r=>r.json())
    ]).then(([s,p]) => {
      setStatus(s);
      setRows(p.projections ?? []);
      fetch("/api/model").then(r=>r.json()).then(setModel).catch(()=>setModel(null));
    }).catch(()=>setStatus({connected:false})).finally(()=>setLoading(false));
    fetch("/api/props").then(r=>r.json()).then(data=>setVegasLines(data.lines ?? [])).catch(()=>setVegasLines([]));
  },[]);

  useEffect(() => {
    let active = true;
    const refreshScoreboard = async () => {
      const dateKeys = [...new Set(rows.map(row => row.game_date.slice(0,10)))];
      if (!dateKeys.length) return;
      try {
        const response = await fetch("/api/scoreboard?dates=" + dateKeys.map(date => date.replace(/-/g,"")).join(","));
        if (!response.ok) return;
        const data = await response.json();
        if (active) setScoreboard(data.games ?? []);
      } catch { /* Keep the last known game status if the scoreboard is temporarily unavailable. */ }
    };
    refreshScoreboard();
    const timer = window.setInterval(refreshScoreboard, 30000);
    return () => { active = false; window.clearInterval(timer); };
  },[rows]);

  const filtered = useMemo(()=>rows.filter(r=>r.full_name.toLowerCase().includes(search.toLowerCase())),[rows,search]);
  const games = useMemo(()=>{
    const map = new Map<number,GameGroup>();
    filtered.forEach(p=>{
      if(selectedDate !== "all" && p.game_date.slice(0,10) !== selectedDate) return;
      if(!map.has(p.game_id)) map.set(p.game_id,{gameId:p.game_id,date:p.game_date,tipoff:p.scheduled_start,home:p.home_team,away:p.away_team,players:[]});
      map.get(p.game_id)!.players.push(p);
    });
    return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date) || String(a.tipoff).localeCompare(String(b.tipoff)));
  },[filtered,selectedDate]);
  const dates = useMemo(()=>[...new Map(rows.map(r=>[r.game_date.slice(0,10),r.game_date])).entries()].map(([key,value])=>({key,value})).sort((a,b)=>a.key.localeCompare(b.key)),[rows]);
  const counts = status?.counts ?? {};
  const totalPlayers = new Set(filtered.map(r=>r.player_id)).size;

  return <main className="app-shell">
    <header className="top-nav">
      <a className="brand" href="#"><img className="brand-icon-image" src="/icon.svg" alt="" /><span><b>COURTSIDE</b><small>PLAYER PERFORMANCE MODEL</small></span></a>
      <nav><a className="nav-active" href="#projections">Projections</a><button className={modelMenuOpen ? "menu-trigger menu-trigger-active" : "menu-trigger"} onClick={()=>setModelMenuOpen(v=>!v)} aria-expanded={modelMenuOpen}>MODEL RESULTS <span>{modelMenuOpen ? "−" : "+"}</span></button></nav>
      <div className="nav-actions">{installPrompt && <button className="install-button" onClick={async()=>{await installPrompt.prompt();setInstallPrompt(null);}}>INSTALL APP</button>}<div className="nav-status"><i/> LIVE DATASET <span className="season-pill">2026–27</span></div></div>
    </header>

    {modelMenuOpen && <section className="model-menu-panel" id="model-lab">
      <div className="model-lab-heading"><div><div className="kicker">UNDER THE HOOD</div><h2>Model results & diagnostics</h2><p>Accuracy checks, saved forecast grades and modeling inputs.</p></div><span className="model-version">VERSION {model?.model?.version ?? "2.0.0"}</span></div>
      <div className="manual-injury-refresh">
        <div><strong>COMPLETED GAME RESULTS</strong><span>Pull final ESPN box scores, save player stats and grade saved forecasts.</span></div>
        <button type="button" disabled={refreshingResults} onClick={async()=>{
          setRefreshingResults(true);setResultsRefreshMessage("");
          try {
            const response=await fetch("/api/cron/sync",{method:"POST"});
            const result=await response.json();
            if(!response.ok && !result.completed_games_checked) throw new Error(result.error || "Game-results update failed");
            const [nextModel,nextStatus]=await Promise.all([
              fetch("/api/model").then(r=>r.json()),
              fetch("/api/status").then(r=>r.json())
            ]);
            setModel(nextModel);setStatus(nextStatus);
            const failureDetails=Array.isArray(result.failures) && result.failures.length
              ? " · " + result.failures.slice(0,2).join(" | ")
              : "";
            setResultsRefreshMessage(`Checked ${result.completed_games_checked ?? 0} completed games · imported ${result.boxscores_imported ?? 0} box scores · saved ${result.player_game_rows ?? 0} player stat rows${failureDetails}`);
          } catch(error) {
            setResultsRefreshMessage(error instanceof Error ? error.message : "Game-results update failed");
          } finally { setRefreshingResults(false); }
        }}>{refreshingResults ? "UPDATING…" : "UPDATE GAME RESULTS"}</button>
        {resultsRefreshMessage && <p role="status">{resultsRefreshMessage}</p>}
      </div>
      <div className="manual-injury-refresh">
        <div><strong>SPORTSBOOK PLAYER LINES</strong><span>Refresh the daily sportsbook snapshot. Lines appear inside each player's card.</span></div>
        <button type="button" disabled={fetchingProps} onClick={async()=>{
          setFetchingProps(true);setPropsMessage("");
          try {
            const response=await fetch("/api/props",{method:"POST"});
            const result=await response.json();
            if(!response.ok) throw new Error(result.error || "Vegas props update failed");
            const board=await fetch("/api/props").then(r=>r.json());
            setVegasLines(board.lines ?? []);
            setPropsMessage(result.already_fetched
              ? "Already collected today · "+(board.lines?.length ?? 0)+" player comparisons loaded"
              : "Fetched "+(result.events_received ?? 0)+" games · saved "+(result.records_written ?? 0)+" lines · matched "+(result.players_matched ?? 0)+" players"+(result.unmatched_players ? " · "+result.unmatched_players+" names unmatched" : ""));
          } catch(error) {
            setPropsMessage(error instanceof Error ? error.message : "Vegas props update failed");
          } finally { setFetchingProps(false); }
        }}>{fetchingProps ? "FETCHING…" : "UPDATE SPORTSBOOK LINES"}</button>
        {propsMessage && <p role="status">{propsMessage}</p>}
      </div>
      <div className="manual-injury-refresh">
        <div><strong>LIVE PLAYER AVAILABILITY</strong><span>Pull the latest ESPN injury report and depth charts now.</span></div>
        <button type="button" disabled={refreshingInjuries} onClick={async()=>{
          setRefreshingInjuries(true);setInjuryRefreshMessage("");
          try {
            const response=await fetch("/api/injuries/refresh",{method:"POST"});
            const result=await response.json();
            if(!response.ok) throw new Error(result.error || "Injury refresh failed");
            const [nextModel,nextProjections]=await Promise.all([
              fetch("/api/model").then(r=>r.json()),
              fetch("/api/projections").then(r=>r.json())
            ]);
            setModel(nextModel);setRows(nextProjections.projections ?? []);
            setInjuryRefreshMessage(`Updated: ${result.injury_rows} injury records · ${result.depth_chart_entries} depth-chart entries${result.failures?.length ? " · Some sources unavailable" : ""}`);
          } catch(error) {
            setInjuryRefreshMessage(error instanceof Error ? error.message : "Injury refresh failed");
          } finally { setRefreshingInjuries(false); }
        }}>{refreshingInjuries ? "UPDATING…" : "UPDATE INJURIES"}</button>
        {injuryRefreshMessage && <p role="status">{injuryRefreshMessage}</p>}
      </div>

      <details className="model-lab" open>
        <summary><span>MODEL PERFORMANCE & METHODOLOGY</span><b>{model?.backtest?.metrics?.length ? "BACKTEST READY" : "LOADING DIAGNOSTICS"}</b></summary>
        <div className="model-lab-content">
          <div className="feature-grid">{(model?.features ?? []).map(feature=><div className="feature-item" key={feature.name}><div><strong>{feature.name}</strong><span className={feature.status==="active"?"feature-active":"feature-waiting"}>{feature.status==="active"?"ACTIVE":"COLLECTING DATA"}</span></div><p>{feature.detail}</p></div>)}</div>
          <div className="backtest-heading"><div><h3>Walk-forward backtest</h3><p>Lower MAE is better. Positive improvement means the model beat the old last-eight average.</p></div></div>
          {model?.backtest?.metrics?.length ? <div className="backtest-table-wrap"><table className="backtest-table"><thead><tr><th>STAT</th><th>GAMES</th><th>BASELINE MAE</th><th>MODEL MAE</th><th>CHANGE</th></tr></thead><tbody>{model.backtest.metrics.map(metric=><tr key={metric.stat}><td>{metric.stat.toUpperCase()}</td><td>{Number(metric.sample_size).toLocaleString()}</td><td>{metric.baseline_mae}</td><td>{metric.model_mae}</td><td className={Number(metric.improvement_pct)>=0?"positive-change":"negative-change"}>{Number(metric.improvement_pct)>0?"+":""}{metric.improvement_pct}%</td></tr>)}</tbody></table></div> : <p className="model-lab-empty">Backtest metrics will appear when the model diagnostics query completes.</p>}
          <div className="backtest-heading saved-grade-heading"><div><h3>Saved forecast grading</h3><p>Forecasts saved before tipoff are compared with the final ESPN box score after the nightly sync.</p></div></div>
          {model?.savedForecasts?.length ? <div className="backtest-table-wrap"><table className="backtest-table"><thead><tr><th>MARKET</th><th>GRADED</th><th>MAE</th><th>BIAS</th></tr></thead><tbody>{model.savedForecasts.map(item=><tr key={item.market_key}><td>{item.market_key.toUpperCase()}</td><td>{Number(item.sample_size).toLocaleString()}</td><td>{item.mae}</td><td>{item.bias}</td></tr>)}</tbody></table></div> : <p className="model-lab-empty">Saved forecast grades will build as games finish after forecasts have been captured.</p>}
          <div className="backtest-heading saved-grade-heading"><div><h3>Player-by-player results</h3><p>Each saved pregame projection compared with the final ESPN box score. Positive error means the model projected too high.</p></div></div>
          {model?.gradedDetails?.length ? <div className="backtest-table-wrap"><table className="backtest-table"><thead><tr><th>GAME</th><th>PLAYER</th><th>STAT</th><th>PROJECTED</th><th>ACTUAL</th><th>ERROR</th></tr></thead><tbody>{model.gradedDetails.map(item=><tr key={item.projection_id}><td>{dateLabel(item.game_date,{month:"short",day:"numeric"})} {item.away_team}@{item.home_team}</td><td>{item.full_name}</td><td>{item.market_name || item.market_key}</td><td>{Number(item.projected_mean).toFixed(1)}</td><td>{Number(item.actual_value).toFixed(1)}</td><td className={Number(item.signed_error)>0?"negative-change":Number(item.signed_error)<0?"positive-change":""}>{Number(item.signed_error)>0?"+":""}{Number(item.signed_error).toFixed(1)}</td></tr>)}</tbody></table></div> : <p className="model-lab-empty">Individual player results will appear after the first saved forecasts are matched to completed box scores.</p>}
          <p className="backtest-method">{model?.backtest?.method ?? "Walk-forward validation uses only data from before each game."} Current injury reports: {model?.data?.injured_players ?? 0} players. Historical injury and depth-chart snapshots are not available, so availability and lineup adjustments are excluded from historical backtest scores.</p>
        </div>
      </details>
    </section>}

    <section className="hero">
      <div className="hero-copy">
        <div className="kicker"><span/> THE DAILY BOARD <span className="kicker-line"/></div>
        <h1>Know the player.<br/><em>Know the performance.</em></h1>
        <p>Independent NBA player forecasts built from historical performance, projected minutes, role, opponent defense and game context. No sportsbook lines. No market influence.</p>
        <div className="hero-foot"><span className="hero-dot"/> {loading ? "UPDATING THE BOARD" : `${totalPlayers} PLAYERS ON THE BOARD`} <span className="hero-separator"/> {games.length} MATCHUPS</div>
      </div>
      <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="ball"><div className="ball-lines"/></div><span className="art-label">PURE<br/>PERFORMANCE</span><span className="art-number">01 / 27</span></div>
    </section>

    <section className="overview-strip">
      <div><span>PLAYER DATABASE</span><strong>{counts.players?.toLocaleString?.() ?? "—"}</strong><small>PLAYER PROFILES</small></div>
      <div><span>GAME HISTORY</span><strong>{counts.player_game_stats?.toLocaleString?.() ?? "—"}</strong><small>PLAYER BOX SCORES</small></div>
      <div><span>GAMES TRACKED</span><strong>{counts.games?.toLocaleString?.() ?? "—"}</strong><small>2021–22 TO PRESENT</small></div>
      <div className="model-status"><span>MODEL STATUS</span><strong><i/> MODEL v2.0 ACTIVE</strong><small>MINUTES + MATCHUP ADJUSTED</small></div>
    </section>

    <section className="board-section" id="projections">
      <div className="section-heading">
        <div><div className="kicker">ON THE COURT</div><h2>Upcoming matchups</h2><p>Explore player forecasts by game. Tap any player to open the full stat profile.</p></div>
        <div className="board-controls"><label className="search-box"><span>⌕</span><input aria-label="Search players" placeholder="Find a player" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
      </div>
      <div className="date-filter"><button className={selectedDate==="all"?"selected":""} onClick={()=>setSelectedDate("all")}>ALL GAMES</button>{dates.map(d=><button key={d.key} className={selectedDate===d.key?"selected":""} onClick={()=>setSelectedDate(d.key)}>{dateLabel(d.value,{weekday:"short",month:"short",day:"numeric"}).toUpperCase()}</button>)}</div>
      {loading ? <div className="loading-state"><div className="loader"/>Building the player board…</div>
      : games.length ? <div className="game-list">{games.map(game=>{ const liveStatus=scoreboard.find(item=>item.date===game.date.slice(0,10) && item.home===game.home && item.away===game.away); const hasVegasProjection=typeof liveStatus?.total==="number" && typeof liveStatus?.spread==="number"; const awayImplied=hasVegasProjection ? (liveStatus!.total!+liveStatus!.spread!)/2 : null; const homeImplied=hasVegasProjection ? (liveStatus!.total!-liveStatus!.spread!)/2 : null; const formatVegasScore=(score:number)=>Number.isInteger(score)?String(score):score.toFixed(1); return <section className="game-card" key={game.gameId}>
        <button type="button" className="game-header game-header-toggle" onClick={()=>setExpandedGames(v=>({...v,[game.gameId]:!v[game.gameId]}))} aria-expanded={!!expandedGames[game.gameId]}>
          <div className="game-date"><strong>{dateLabel(game.date,{weekday:"short",month:"short",day:"numeric"})}</strong><span>{tipoffLabel(game.tipoff)} MT</span>{liveStatus?.state==="live" && <span className="game-status-badge game-status-live"><i/>Live</span>}{liveStatus?.state==="final" && <span className="game-status-badge game-status-final">Final</span>}</div>
          <div className="matchup">
            <div className="team-side"><TeamMark abbr={game.away} large/><div><strong>{game.away}</strong><span>{teamNames[game.away] ?? game.away}</span>{awayImplied !== null && <small className="team-implied-score">{formatVegasScore(awayImplied)}</small>}</div></div>
            {hasVegasProjection ? <div className="matchup-vegas-total"><span>VEGAS TOTAL</span><strong>{liveStatus!.total!.toFixed(1)}</strong></div> : <span className="at-symbol">@</span>}
            <div className="team-side home-side"><TeamMark abbr={game.home} large/><div><strong>{game.home}</strong><span>{teamNames[game.home] ?? game.home}</span>{homeImplied !== null && <small className="team-implied-score">{formatVegasScore(homeImplied)}</small>}</div></div>
          </div>
          {typeof liveStatus?.total === "number" && !hasVegasProjection && <div className="game-total"><span>ESPN GAME TOTAL</span><strong>{liveStatus.total}</strong></div>}
          <div className="game-count">{game.players.length}<span>PLAYER<br/>FORECASTS</span>{game.players.some(p=>p.injury_designator) && <small className="game-injury-count">{game.players.filter(p=>p.injury_designator).length} INJURY TAGS</small>}</div>
          <span className="game-toggle-indicator" aria-hidden="true">{expandedGames[game.gameId] ? "−" : "+"}</span>
        </button>
        {expandedGames[game.gameId] && <div className="player-list">{game.players.some(p=>p.injury_designator) && <div className="game-injury-report"><div className="game-injury-title">INJURY REPORT <span>{game.players.filter(p=>p.injury_designator).length} LISTED</span></div><div className="game-injury-items">{game.players.filter(p=>p.injury_designator).sort((a,b)=>String(a.injury_designator).localeCompare(String(b.injury_designator)) || a.full_name.localeCompare(b.full_name)).map(p=><span key={p.player_id}><b className={`injury-tag injury-${p.injury_designator?.toLowerCase()}`}>{p.injury_designator}</b>{p.full_name} <small>{p.injury_status}</small></span>)}</div></div>} {game.players.sort((a,b)=>Number(b.avg_minutes)-Number(a.avg_minutes) || Number(b.points)-Number(a.points) || a.full_name.localeCompare(b.full_name)).map(player=><PlayerCard key={player.player_id} player={player} vegasLines={vegasLines}/>)}</div>}
      </section>})}</div>
      : <div className="empty-state"><div className="empty-ball">◎</div><h3>{rows.length ? "No players match that search" : "The next slate is loading"}</h3><p>{rows.length ? "Try a different player name or clear your search." : "Player forecasts will appear here when upcoming games and recent player logs are available."}</p></div>}
    </section>
    <footer className="site-footer"><span>COURTSIDE <b>PLAYER PERFORMANCE MODEL</b></span><span>INDEPENDENT FORECASTS · BUILT ON PLAYER HISTORY</span></footer>
  </main>;
}
