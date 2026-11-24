import { useMemo } from "react";
import { Avatar, Card, LiveBadge, fmt } from "../components/ui";
import { allPlayRecords } from "../lib/value";
import { useLeague } from "../state/LeagueContext";

export default function Dashboard() {
  const { data } = useLeague();
  const d = data!;

  const standings = useMemo(() => {
    // Live standings, and all-play over exactly the weeks those standings count.
    const counted = d.live.weeks.map((w) => d.matchupsByWeek[w - 1]).filter(Boolean);
    const ap = allPlayRecords(counted);
    const rows = d.records.map((rec) => ({
      rec,
      owner: d.rosterOwner(rec.rosterId),
      pf: rec.pf,
      pa: rec.pa ?? 0,
      ap: ap[rec.rosterId],
    }));
    rows.sort((a, b) => b.rec.wins - a.rec.wins || b.pf - a.pf);
    const power = [...rows].sort((a, b) => (b.ap?.pct ?? 0) - (a.ap?.pct ?? 0) || b.pf - a.pf);
    return { rows, powerRank: new Map(power.map((x, i) => [x.rec.rosterId, i + 1])) };
  }, [d]);

  const matchups = useMemo(() => {
    const week = d.matchupsByWeek[d.week - 1] ?? [];
    const groups = new Map<number, typeof week>();
    for (const m of week) if (m.matchup_id != null) groups.set(m.matchup_id, [...(groups.get(m.matchup_id) ?? []), m]);
    return [...groups.values()];
  }, [d]);

  const myId = d.myRoster?.roster_id;
  const name = (id: string) => d.players[id]?.name ?? id;

  return (
    <div className="grid">
      <Card
        title="Standings"
        right={
          <span className="row">
            {d.liveAhead && <LiveBadge weeks={d.liveWeeksAhead} />}
            <span className="muted">Power rank uses each team's record against everyone, every week</span>
          </span>
        }
      >
        <table>
          <thead>
            <tr>
              <th>#</th><th>Team</th><th>W-L</th><th className="num">PF</th><th className="num">PA</th>
              <th>Vs. everyone</th><th className="num">Power</th>
            </tr>
          </thead>
          <tbody>
            {standings.rows.map((x, i) => {
              const pr = standings.powerRank.get(x.rec.rosterId)!;
              const luck = pr - (i + 1); // >0: record better than performance
              return (
                <tr key={x.rec.rosterId} className={x.rec.rosterId === myId ? "me" : ""}>
                  <td>{i + 1}</td>
                  <td>
                    <span className="team"><Avatar id={x.owner.avatar} /> {x.owner.team}</span>
                  </td>
                  <td>{x.rec.wins}-{x.rec.losses}{x.rec.ties ? `-${x.rec.ties}` : ""}</td>
                  <td className="num">{fmt(x.pf)}</td>
                  <td className="num">{fmt(x.pa)}</td>
                  <td>{x.ap ? `${x.ap.wins}-${x.ap.losses}` : "–"}</td>
                  <td className="num">
                    {pr}{" "}
                    {Math.abs(luck) >= 2 && (
                      <span className={`tag ${luck > 0 ? "tag-warn" : "tag-good"}`} title={luck > 0 ? "Record flatters them" : "Unlucky so far"}>
                        {luck > 0 ? "lucky" : "unlucky"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title={`Week ${d.week} matchups`}>
        {matchups.length === 0 && <p className="muted">No matchups this week.</p>}
        <ul className="matchups">
          {matchups.map((pair) => (
            <li key={pair[0].matchup_id} className={pair.some((m) => m.roster_id === myId) ? "me" : ""}>
              {pair.map((m, i) => {
                const o = d.rosterOwner(m.roster_id);
                const win = pair.length === 2 && m.points > pair[1 - i].points;
                return (
                  <div key={m.roster_id} className={`mu-side ${win ? "win" : ""}`}>
                    <span className="team"><Avatar id={o.avatar} /> {o.team}</span>
                    <strong>{fmt(m.points)}</strong>
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Recent transactions">
        {d.transactions.length === 0 && <p className="muted">Nothing in the last two weeks.</p>}
        <ul className="tx">
          {d.transactions.slice(0, 15).map((t) => (
            <li key={t.transaction_id}>
              <span className={`tag tag-${t.type === "trade" ? "warn" : "neutral"}`}>{t.type.replace("_", " ")}</span>{" "}
              {t.roster_ids.map((rid) => d.rosterOwner(rid).team).join(" ⇄ ")}
              <div className="tx-detail">
                {Object.entries(t.adds ?? {}).map(([id, rid]) => (
                  <span key={id} className="add">
                    + {name(id)}
                    {t.type === "trade" && <span className="muted"> → {d.rosterOwner(rid).team}</span>}
                  </span>
                ))}
                {t.type !== "trade" &&
                  Object.keys(t.drops ?? {}).map((id) => <span key={id} className="drop">− {name(id)}</span>)}
                {t.settings?.waiver_bid ? <span className="muted"> ${t.settings.waiver_bid}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
