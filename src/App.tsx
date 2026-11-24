import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Lineup from "./pages/Lineup";
import Playoffs from "./pages/Playoffs";
import Setup from "./pages/Setup";
import Trade from "./pages/Trade";
import Waivers from "./pages/Waivers";
import { LeagueProvider, useLeague } from "./state/LeagueContext";
import ThemeToggle from "./components/ThemeToggle";

const TABS = [
  { to: "/", label: "League", end: true },
  { to: "/playoffs", label: "Playoffs" },
  { to: "/lineup", label: "Lineup" },
  { to: "/waivers", label: "Waivers" },
  { to: "/trade", label: "Trades" },
];

function Shell() {
  const { settings, setSettings, data, loading, error, reload } = useLeague();

  if (!settings) {
    return (
      <Routes>
        <Route path="*" element={<Setup />} />
      </Routes>
    );
  }

  const myTeam = data?.myRoster ? data.rosterOwner(data.myRoster.roster_id).team : null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <strong>{myTeam ?? "Loading…"}</strong>
            {data && <span className="muted">{data.league.name}, week {data.week}</span>}
          </div>
          <nav>
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className="tab">
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="row">
            <button className="ghost" onClick={reload} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
            <button className="ghost" onClick={() => setSettings(null)}>Switch league</button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main>
        {error && (
          <p className="error">
            Couldn't load your league from Sleeper ({error}). <button className="ghost" onClick={reload}>Try again</button>
          </p>
        )}
        {!data && !error && <p className="muted loading">Pulling your league from Sleeper…</p>}
        {data && (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/playoffs" element={<Playoffs />} />
            <Route path="/lineup" element={<Lineup />} />
            <Route path="/waivers" element={<Waivers />} />
            <Route path="/trade" element={<Trade />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <LeagueProvider>
        <Shell />
      </LeagueProvider>
    </HashRouter>
  );
}
