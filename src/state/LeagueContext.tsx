import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as api from "../api/sleeper";
import type { League, Matchup, NflState, PlayersMap, Roster, SleeperUser, Transaction } from "../api/types";
import { startingSlots } from "../lib/lineup";
import { buildProjectionMap, injuryAdjusted } from "../lib/scoring";
import { liveStandings, reconcileRecords, recordsThrough, type LiveStandings, type TeamRecord } from "../lib/playoffs";
import { computePpg, replacementLevels, rosValue, type PpgEntry, type ReplacementLevels } from "../lib/value";

// ---------- persisted settings ----------
export interface Settings {
  username: string;
  userId: string;
  leagueId: string;
}
const SETTINGS_KEY = "fantasy-watch:settings";

export function loadSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Settings) : null;
  } catch {
    return null;
  }
}
export function saveSettings(s: Settings | null) {
  try {
    if (s) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    else localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- league data ----------
export interface LeagueData {
  league: League;
  state: NflState;
  week: number; // week we're managing
  /** Last week of the regular season (the playoff race runs through here). */
  regularSeasonEnd: number;
  playoffTeams: number;
  /** Sleeper's "league average match": every team also plays the weekly median. */
  medianMatch: boolean;
  /** Last week Sleeper has officially scored; live standings can run ahead of it. */
  lastScoredWeek: number;
  /**
   * Standings computed from the scores, so a finished week counts before
   * Sleeper scores it. Every page reads these, not roster.settings.
   */
  records: TeamRecord[];
  live: LiveStandings;
  /** The live standings differ from Sleeper's reported record. */
  liveAhead: boolean;
  /** Weeks counted here that Sleeper hasn't made official. */
  liveWeeksAhead: number[];
  /** Our rules failed to reproduce Sleeper's record for the weeks it HAS scored. */
  liveCheck: { ok: boolean; mismatches: number[] };
  /** roster_id -> division, or null when the league doesn't use divisions. */
  divisions: Map<number, number> | null;
  divisionName: (division: number) => string;
  /** League claims divisions but the rosters don't carry them: seeding falls back to flat. */
  divisionsUnavailable: boolean;
  players: PlayersMap;
  rosters: Roster[];
  users: SleeperUser[];
  /** index 0 = week 1, through the end of the regular season (future weeks hold the pairings, 0 points) */
  matchupsByWeek: Matchup[][];
  transactions: Transaction[];
  myRoster: Roster | undefined;
  slots: string[];
  hasProjections: boolean;
  proj: Record<string, number>;
  ppg: Record<string, PpgEntry>;
  /** This week's expected points, injury-adjusted. Use for lineup + waiver decisions. */
  weekly: (id: string) => number;
  /** Rest-of-season points per game. Use for trades. */
  ros: (id: string) => number;
  repl: ReplacementLevels;
  rosterOwner: (rosterId: number) => { name: string; team: string; avatar: string | null };
  rosteredBy: Record<string, number>; // player_id -> roster_id
}

interface Ctx {
  settings: Settings | null;
  setSettings: (s: Settings | null) => void;
  data: LeagueData | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const LeagueContext = createContext<Ctx | null>(null);

export function useLeague() {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error("useLeague must be used inside <LeagueProvider>");
  return ctx;
}

/** Week to manage: current NFL week in-season, otherwise the league's last regular-season week. */
function pickWeek(state: NflState, league: League): number {
  if (state.season === league.season && state.season_type === "regular") return Math.max(1, state.week);
  if (state.season === league.season && state.season_type === "pre") return 1;
  return Math.max(1, (league.settings.playoff_week_start ?? 15) - 1);
}

async function loadLeague(settings: Settings): Promise<LeagueData> {
  const [league, state, players, rosters, users] = await Promise.all([
    api.getLeague(settings.leagueId),
    api.getNflState(),
    api.getPlayers(),
    api.getRosters(settings.leagueId),
    api.getLeagueUsers(settings.leagueId),
  ]);
  const week = pickWeek(state, league);
  // Sleeper publishes pairings for future weeks, so fetching through the end of
  // the regular season gives us the remaining schedule for playoff odds.
  const regularSeasonEnd = Math.max(week, (league.settings.playoff_week_start ?? 15) - 1);
  const weekNums = Array.from({ length: regularSeasonEnd }, (_, i) => i + 1);

  const [matchupsByWeek, projRows, txA, txB] = await Promise.all([
    Promise.all(weekNums.map((w) => api.getMatchups(league.league_id, w).catch(() => [] as Matchup[]))),
    api.getProjections(league.season, week),
    api.getTransactions(league.league_id, week).catch(() => [] as Transaction[]),
    week > 1 ? api.getTransactions(league.league_id, week - 1).catch(() => [] as Transaction[]) : Promise.resolve([]),
  ]);

  const proj = buildProjectionMap(projRows, league.scoring_settings, players);
  const hasProjections = Object.keys(proj).length > 0;
  // PPG uses completed weeks only
  const ppg = computePpg(matchupsByWeek.slice(0, Math.max(0, week - 1)));

  const weekly = (id: string) => {
    const base = hasProjections ? (proj[id] ?? 0) : (ppg[id]?.ppg ?? 0);
    return injuryAdjusted(base, players[id]?.injury_status);
  };
  const ros = (id: string) => rosValue(proj[id], ppg[id]);

  const slots = startingSlots(league.roster_positions);
  const repl = replacementLevels(rosters, slots, players, ros);

  const userById = new Map(users.map((u) => [u.user_id, u]));
  const rosterById = new Map(rosters.map((r) => [r.roster_id, r]));
  const rosterOwner = (rosterId: number) => {
    const u = userById.get(rosterById.get(rosterId)?.owner_id ?? "");
    return {
      name: u?.display_name ?? `Team ${rosterId}`,
      team: u?.metadata?.team_name || u?.display_name || `Team ${rosterId}`,
      avatar: u?.avatar ?? null,
    };
  };

  // Divisions only count if every roster has one — partial data would seed some
  // teams as division winners and silently leave others out.
  const claimsDivisions = (league.settings.divisions ?? 0) > 1;
  const hasDivisionData = rosters.every((r) => r.settings.division != null);
  const divisions =
    claimsDivisions && hasDivisionData ? new Map(rosters.map((r) => [r.roster_id, r.settings.division!])) : null;
  const divisionsUnavailable = claimsDivisions && !hasDivisionData;
  const divisionName = (division: number) => league.metadata?.[`division_${division}`] || `Division ${division}`;

  const rosteredBy: Record<string, number> = {};
  for (const r of rosters) {
    for (const id of [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]) rosteredBy[id] = r.roster_id;
  }

  // ---- live standings, computed once and shared by every page ----
  const medianMatch = (league.settings.league_average_match ?? 0) === 1;
  const lastScoredWeek = league.settings.last_scored_leg ?? 0;
  const live = liveStandings(matchupsByWeek, regularSeasonEnd, medianMatch);

  const official: TeamRecord[] = rosters.map((r) => ({
    rosterId: r.roster_id,
    wins: r.settings.wins,
    losses: r.settings.losses,
    ties: r.settings.ties,
    pf: (r.settings.fpts ?? 0) + (r.settings.fpts_decimal ?? 0) / 100,
    pa: (r.settings.fpts_against ?? 0) + (r.settings.fpts_against_decimal ?? 0) / 100,
  }));

  // Keep every roster present even before a single week is final.
  const byRoster = new Map(live.records.map((r) => [r.rosterId, r]));
  const records = official.map((o) => byRoster.get(o.rosterId) ?? { ...o, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 });

  const liveAhead = !reconcileRecords(records, official).ok;
  const liveWeeksAhead = live.weeks.filter((w) => w > lastScoredWeek);
  // Integrity check: our own rules must reproduce Sleeper for the weeks it scored.
  const liveCheck =
    lastScoredWeek > 0
      ? reconcileRecords(recordsThrough(matchupsByWeek, lastScoredWeek, medianMatch), official)
      : { ok: true, mismatches: [] as number[] };

  const transactions = [...txA, ...txB]
    .filter((t) => t.status === "complete")
    .sort((a, b) => b.created - a.created);

  return {
    league, state, week, regularSeasonEnd, playoffTeams: league.settings.playoff_teams ?? 6,
    divisions, divisionName, divisionsUnavailable,
    medianMatch, lastScoredWeek, records, live, liveAhead, liveWeeksAhead, liveCheck,
    players, rosters, users, matchupsByWeek, transactions,
    myRoster: rosters.find((r) => r.owner_id === settings.userId),
    slots, hasProjections, proj, ppg, weekly, ros, repl, rosterOwner, rosteredBy,
  };
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings | null>(loadSettings);
  const [data, setData] = useState<LeagueData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const setSettings = useCallback((s: Settings | null) => {
    saveSettings(s);
    setSettingsState(s);
    setData(null);
  }, []);

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadLeague(settings)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [settings, nonce]);

  const value = useMemo<Ctx>(
    () => ({ settings, setSettings, data, loading, error, reload: () => setNonce((n) => n + 1) }),
    [settings, setSettings, data, loading, error],
  );
  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}
