import { useMemo } from "react";
import { Card, PlayerChip, fmt, signed } from "../components/ui";
import { lineupSwaps, optimalLineup, round1, slotLabel } from "../lib/lineup";
import { OUT_STATUSES } from "../lib/scoring";
import { useLeague } from "../state/LeagueContext";

type Flag = { tone: "bad" | "warn"; text: string };

export default function Lineup() {
  const { data } = useLeague();
  const d = data!;
  const r = d.myRoster;

  const view = useMemo(() => {
    if (!r) return null;
    const current = d.slots.map((_, i) => {
      const id = r.starters?.[i];
      return id && id !== "0" ? id : null;
    });
    // IR/taxi players can't start; only the active roster is a candidate
    const active = (r.players ?? []).filter((id) => !(r.reserve ?? []).includes(id) && !(r.taxi ?? []).includes(id));
    const opt = optimalLineup(d.slots, active, d.weekly, d.players);
    const currentTotal = round1(current.reduce((s, id) => s + (id ? d.weekly(id) : 0), 0));
    const swaps = lineupSwaps(current, opt.assignment, d.weekly, d.players);
    const starters = new Set(opt.assignment.filter(Boolean));
    const bench = active.filter((id) => !current.includes(id)).sort((a, b) => d.weekly(b) - d.weekly(a));

    const flagsFor = (id: string | null): Flag[] => {
      if (!id) return [{ tone: "bad", text: "Empty slot" }];
      const p = d.players[id];
      const f: Flag[] = [];
      if (p?.injury_status && OUT_STATUSES.has(p.injury_status)) f.push({ tone: "bad", text: `${p.injury_status}: won't play` });
      else if (p?.injury_status === "Doubtful") f.push({ tone: "bad", text: "Doubtful" });
      else if (p?.injury_status === "Questionable") f.push({ tone: "warn", text: "Questionable: check before kickoff" });
      if (d.hasProjections && !(d.proj[id] > 0)) f.push({ tone: "bad", text: "No projection: bye or inactive?" });
      if (!p?.team) f.push({ tone: "bad", text: "Not on an NFL team" });
      return f;
    };
    const issues = current.map(flagsFor);
    const issueCount = issues.filter((f) => f.some((x) => x.tone === "bad")).length;
    return { current, opt, currentTotal, swaps, bench, issues, issueCount, starters };
  }, [d, r]);

  if (!r || !view) return <p className="error">Couldn't find your roster in this league.</p>;
  const gap = round1(view.opt.total - view.currentTotal);

  return (
    <div className="grid">
      <div className={`callout ${gap > 0.5 || view.issueCount ? "callout-bad" : "callout-good"}`}>
        <h1>
          {gap > 0.5
            ? `${fmt(gap)} points are sitting on your bench.`
            : view.issueCount
              ? "Best lineup set, but check your flagged starters."
              : "Your lineup is set. Nothing to change."}
        </h1>
        <p>
          Your lineup projects {fmt(view.currentTotal)}. The best one you can set projects {fmt(view.opt.total)}.
          {view.issueCount > 0 &&
            ` ${view.issueCount} starter${view.issueCount > 1 ? "s" : ""} ${view.issueCount > 1 ? "have" : "has"} a problem.`}
        </p>
      </div>

      {!d.hasProjections && (
        <p className="notice">
          Sleeper's projections endpoint didn't respond, so this page uses season points-per-game instead. Bye weeks
          won't be detected.
        </p>
      )}

      <Card
        title="Moves to make"
        zone="green"
        right={<span className="muted">Sleeper's API is read-only. Make these changes in the app.</span>}
      >
        {view.swaps.length === 0 ? (
          <p className="good-text">✓ Your lineup is already optimal for week {d.week}.</p>
        ) : (
          <ul className="swaps">
            {view.swaps.map((s) => (
              <li key={s.startId}>
                <span className="swap-in">Start</span> <PlayerChip player={d.players[s.startId]} sub={<b>{fmt(d.weekly(s.startId))}</b>} />
                <span className="swap-arrow">over</span>
                {s.benchId ? (
                  <PlayerChip player={d.players[s.benchId]} sub={<b>{fmt(d.weekly(s.benchId))}</b>} />
                ) : (
                  <span className="muted">an empty slot</span>
                )}
                <span className="gain">{signed(s.gain)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Week ${d.week} lineup, yours vs. best`}>
        <table>
          <thead>
            <tr>
              <th>Slot</th><th>Your starter</th><th className="num">Proj</th><th>Watch out</th><th>Best option</th><th className="num">Proj</th>
            </tr>
          </thead>
          <tbody>
            {d.slots.map((slot, i) => {
              const cur = view.current[i];
              const best = view.opt.assignment[i];
              return (
                <tr key={i}>
                  <td><span className="slot">{slotLabel(slot)}</span></td>
                  <td><PlayerChip player={cur ? d.players[cur] : undefined} /></td>
                  <td className="num">{cur ? fmt(d.weekly(cur)) : "–"}</td>
                  <td>
                    {view.issues[i].map((f) => (
                      <span key={f.text} className={`tag tag-${f.tone}`}>{f.text}</span>
                    ))}
                  </td>
                  <td className={best && !view.current.includes(best) ? "highlight" : ""}>
                    <PlayerChip player={best ? d.players[best] : undefined} />
                  </td>
                  <td className="num">{best ? fmt(d.weekly(best)) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="On the bench">
        <ul className="menu">
          {view.bench.map((id) => {
            const p = d.players[id];
            return (
              <li key={id}>
                <div className="menu-line">
                  <span className="menu-item">{p?.name ?? id}</span>
                  <span className="leader" aria-hidden="true" />
                  <span className="menu-price">{fmt(d.weekly(id))}</span>
                </div>
                <div className="menu-desc">
                  {p?.position} for {p?.team ?? "no team"}.{" "}
                  {d.ppg[id] ? `${fmt(d.ppg[id].ppg)} points a game over ${d.ppg[id].games} games.` : "No games played yet."}
                  {p?.injury_status && ` Listed ${p.injury_status}.`}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
