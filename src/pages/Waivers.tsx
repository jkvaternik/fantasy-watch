import { useEffect, useMemo, useState } from "react";
import * as api from "../api/sleeper";
import type { TrendingPlayer } from "../api/types";
import { Card, PlayerChip, fmt, signed } from "../components/ui";
import { optimalLineup } from "../lib/lineup";
import { OUT_STATUSES } from "../lib/scoring";
import { lineupGain, vor } from "../lib/value";
import { useLeague } from "../state/LeagueContext";

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"];

export default function Waivers() {
  const { data } = useLeague();
  const d = data!;
  const [trending, setTrending] = useState<TrendingPlayer[]>([]);
  const [pos, setPos] = useState("ALL");
  const [lookback, setLookback] = useState(24);

  useEffect(() => {
    api.getTrending("add", lookback, 75).then(setTrending).catch(() => setTrending([]));
  }, [lookback]);

  const myActive = useMemo(() => {
    const r = d.myRoster;
    return (r?.players ?? []).filter((id) => !(r?.reserve ?? []).includes(id) && !(r?.taxi ?? []).includes(id));
  }, [d]);

  // Drop candidate: lowest rest-of-season value among players who don't make my optimal lineup.
  const dropCandidate = useMemo(() => {
    const starters = new Set(optimalLineup(d.slots, myActive, d.ros, d.players).assignment);
    return myActive.filter((id) => !starters.has(id)).sort((a, b) => d.ros(a) - d.ros(b))[0];
  }, [d, myActive]);

  const rows = useMemo(() => {
    const trendCount = new Map(trending.map((t) => [t.player_id, t.count]));
    // Candidates: trending adds + top projected players, minus anyone already rostered.
    const topProjected = Object.entries(d.proj).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([id]) => id);
    const ids = [...new Set([...trending.map((t) => t.player_id), ...topProjected])].filter(
      (id) => d.players[id] && d.rosteredBy[id] === undefined && d.players[id].team,
    );
    return ids
      .map((id) => ({
        id,
        p: d.players[id],
        trend: trendCount.get(id) ?? 0,
        proj: d.weekly(id),
        gainNow: lineupGain(d.slots, myActive, id, d.weekly, d.players),
        gainRos: lineupGain(d.slots, myActive, id, d.ros, d.players),
        vor: vor(id, d.players, d.ros, d.repl),
      }))
      .filter((x) => !OUT_STATUSES.has(x.p.injury_status ?? ""))
      .filter((x) => pos === "ALL" || x.p.position === pos)
      .sort((a, b) => b.gainRos - a.gainRos || b.gainNow - a.gainNow || b.trend - a.trend)
      .slice(0, 40);
  }, [d, trending, pos, myActive]);

  return (
    <div className="grid">
      <Card
        title="Waiver targets"
        zone="yellow"
        right={
          <div className="row">
            <select value={pos} onChange={(e) => setPos(e.target.value)}>
              {POSITIONS.map((p) => <option key={p}>{p}</option>)}
            </select>
            <select value={lookback} onChange={(e) => setLookback(Number(e.target.value))}>
              <option value={24}>Trending: 24h</option>
              <option value={72}>Trending: 3 days</option>
              <option value={168}>Trending: 7 days</option>
            </select>
          </div>
        }
      >
        <p className="muted">
          Ranked by how much each player improves <em>your</em> optimal lineup. "Season gain" uses rest-of-season value;
          "This week" uses week {d.week} projections. Players who'd only sit on your bench show +0.
          {dropCandidate && (
            <> Suggested drop: <strong>{d.players[dropCandidate]?.name}</strong> ({fmt(d.ros(dropCandidate))} ROS value).</>
          )}
        </p>
        <table>
          <thead>
            <tr>
              <th className="rank-h">No.</th><th>Player</th><th className="num">Season gain</th><th className="num">This week</th>
              <th className="num">Proj</th><th className="num">VOR</th><th className="num">Adds</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={x.id} className={x.gainRos > 0 ? "" : "dim"}>
                <td className="rank">{i + 1}</td>
                <td><PlayerChip player={x.p} /></td>
                <td className={`num ${x.gainRos > 0 ? "good-text" : ""}`}>{signed(x.gainRos)}</td>
                <td className={`num ${x.gainNow > 0 ? "good-text" : ""}`}>{signed(x.gainNow)}</td>
                <td className="num">{fmt(x.proj)}</td>
                <td className="num">{signed(x.vor)}</td>
                <td className="num">{x.trend ? x.trend.toLocaleString() : "–"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted">No free agents to recommend right now. Try a longer trending window.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
