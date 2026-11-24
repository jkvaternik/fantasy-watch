import { useMemo, useState } from "react";
import { Card, PlayerChip, Stat, fmt, signed } from "../components/ui";
import { evaluateTrade, vor } from "../lib/value";
import { useLeague } from "../state/LeagueContext";

export default function Trade() {
  const { data } = useLeague();
  const d = data!;
  const me = d.myRoster;
  const others = d.rosters.filter((r) => r.roster_id !== me?.roster_id);
  const [partnerId, setPartnerId] = useState<number>(others[0]?.roster_id ?? 0);
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const partner = d.rosters.find((r) => r.roster_id === partnerId);

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const result = useMemo(() => {
    if (!me || !partner || (!give.length && !get.length)) return null;
    return evaluateTrade({
      myIds: me.players ?? [], theirIds: partner.players ?? [], give, get,
      slots: d.slots, players: d.players, value: d.ros, repl: d.repl,
    });
  }, [d, me, partner, give, get]);

  if (!me) return <p className="error">Couldn't find your roster in this league.</p>;

  const sortByValue = (ids: string[]) => [...ids].sort((a, b) => d.ros(b) - d.ros(a));
  const RosterPicker = ({ ids, selected, onToggle }: { ids: string[]; selected: string[]; onToggle: (id: string) => void }) => (
    <ul className="picker">
      {sortByValue(ids).map((id) => (
        <li key={id} className={selected.includes(id) ? "sel" : ""} onClick={() => onToggle(id)}>
          <input type="checkbox" readOnly checked={selected.includes(id)} />
          <PlayerChip player={d.players[id]} />
          <span className="num">{fmt(d.ros(id))}</span>
          <span className="num muted">{signed(vor(id, d.players, d.ros, d.repl))}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="grid">
      <div className="trade-cols">
        <Card title="You give" zone="red" right={<span className="muted">Pts/game and value over replacement</span>}>
          <RosterPicker ids={me.players ?? []} selected={give} onToggle={(id) => toggle(give, setGive, id)} />
        </Card>
        <Card
          title={
            <select
              value={partnerId}
              onChange={(e) => {
                setPartnerId(Number(e.target.value));
                setGet([]);
              }}
            >
              {others.map((r) => (
                <option key={r.roster_id} value={r.roster_id}>You get from: {d.rosterOwner(r.roster_id).team}</option>
              ))}
            </select>
          }
          zone="blue"
          right={<span className="muted">Pts/game and value over replacement</span>}
        >
          <RosterPicker ids={partner?.players ?? []} selected={get} onToggle={(id) => toggle(get, setGet, id)} />
        </Card>
      </div>

      <Card title="Verdict" zone="ink">
        {!result ? (
          <p className="muted">Select players on either side to evaluate a trade.</p>
        ) : (
          <>
            <p className="verdict">{result.verdict}</p>
            <div className="stats">
              <Stat label="Your starting lineup (pts/wk)" value={`${fmt(result.me.before)} → ${fmt(result.me.after)}`} />
              <Stat label="Your change" value={signed(result.me.delta)} tone={result.me.delta >= 0 ? "good" : "bad"} />
              <Stat label="Their change" value={signed(result.them.delta)} tone={result.them.delta >= 0 ? "good" : "bad"} />
              <Stat
                label="Net VOR for you"
                value={signed(result.me.vorIn - result.me.vorOut)}
                tone={result.me.vorIn >= result.me.vorOut ? "good" : "bad"}
              />
            </div>
            <p className="muted small">
              Lineup change = how many more points your best possible starting lineup scores per week after the trade,
              using rest-of-season PPG. VOR = value over the best player at that position nobody in your league starts.
              It catches depth-for-star trades, which lineup change alone undervalues.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
