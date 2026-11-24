import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import * as api from "../api/sleeper";
import type { League, SleeperUser } from "../api/types";
import { Avatar, Card } from "../components/ui";
import { useLeague } from "../state/LeagueContext";

export default function Setup() {
  const { settings, setSettings } = useLeague();
  const nav = useNavigate();
  const [username, setUsername] = useState(settings?.username ?? "");
  const [user, setUser] = useState<SleeperUser | null>(null);
  const [leagues, setLeagues] = useState<League[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setLeagues(null);
    try {
      const u = await api.getUser(username.trim());
      if (!u) throw new Error("No Sleeper user with that username.");
      const state = await api.getNflState();
      let ls = await api.getUserLeagues(u.user_id, state.season);
      if (!ls.length) ls = await api.getUserLeagues(u.user_id, String(Number(state.season) - 1));
      setUser(u);
      setLeagues(ls);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pick(l: League) {
    if (!user) return;
    setSettings({ username: username.trim(), userId: user.user_id, leagueId: l.league_id });
    nav("/");
  }

  return (
    <div className="setup">
      <Card title="Find your league" zone="green">
        <p className="muted">
          Sleeper's API is public and read-only, so you only need your username. Nothing is sent anywhere except
          api.sleeper.app.
        </p>
        <form onSubmit={lookup} className="row">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Sleeper username" autoFocus />
          <button disabled={!username.trim() || busy}>{busy ? "Looking up…" : "Find leagues"}</button>
        </form>
        {err && <p className="error">{err}</p>}
        {leagues && (
          <ul className="league-list">
            {leagues.length === 0 && <li className="muted">No NFL leagues found for this season.</li>}
            {leagues.map((l) => (
              <li key={l.league_id}>
                <button className="league-btn" onClick={() => pick(l)}>
                  <Avatar id={l.avatar} size={36} />
                  <span className="league-meta">
                    <strong>{l.name}</strong>
                    <span className="muted">
                      {l.season} season, {l.total_rosters} teams
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
