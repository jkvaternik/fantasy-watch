import type { Matchup, PlayersMap, Roster } from "../api/types";
import { optimalLineup, round1 } from "./lineup";

export interface PpgEntry {
  ppg: number;
  games: number;
  total: number;
}

/**
 * Points-per-game from the league's own matchup history (already in league scoring).
 * Weeks where a player scored exactly 0 are skipped (usually bye / inactive).
 * Only covers rostered players: free agents never appear in matchups.
 */
export function computePpg(weeks: Matchup[][]): Record<string, PpgEntry> {
  const acc: Record<string, PpgEntry> = {};
  for (const week of weeks) {
    for (const m of week) {
      for (const [id, pts] of Object.entries(m.players_points ?? {})) {
        if (!pts) continue;
        const e = (acc[id] ??= { ppg: 0, games: 0, total: 0 });
        e.games += 1;
        e.total += pts;
      }
    }
  }
  for (const e of Object.values(acc)) e.ppg = round1(e.total / e.games);
  return acc;
}

/**
 * Rest-of-season value per game: mostly track record (PPG), nudged by this week's projection.
 * A 0 projection (bye week) is ignored so byes don't tank trade values.
 */
export function rosValue(proj: number | undefined, ppg: PpgEntry | undefined): number {
  const hasProj = proj !== undefined && proj > 0;
  if (ppg && ppg.games >= 3) return round1(hasProj ? 0.7 * ppg.ppg + 0.3 * proj! : ppg.ppg);
  if (hasProj && ppg) return round1(0.5 * ppg.ppg + 0.5 * proj!);
  if (hasProj) return proj!;
  return ppg?.ppg ?? 0;
}

export type ReplacementLevels = Record<string, number>;

/**
 * Replacement level per position = value of the best player at that position who would NOT
 * start for any team. Solving every roster's optimal lineup means flex usage is handled
 * automatically (e.g. a WR-heavy league raises WR replacement level).
 */
export function replacementLevels(
  rosters: Roster[],
  slots: string[],
  players: PlayersMap,
  value: (id: string) => number,
): ReplacementLevels {
  const starters = new Set<string>();
  const byPos: Record<string, number[]> = {};
  for (const r of rosters) {
    const ids = r.players ?? [];
    const lu = optimalLineup(slots, ids, value, players);
    lu.assignment.forEach((id) => id && starters.add(id));
    for (const id of ids) {
      const pos = players[id]?.position;
      if (pos) (byPos[pos] ??= []).push(value(id));
    }
  }
  const startersByPos: Record<string, number> = {};
  for (const id of starters) {
    const pos = players[id]?.position;
    if (pos) startersByPos[pos] = (startersByPos[pos] ?? 0) + 1;
  }
  const out: ReplacementLevels = {};
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((a, b) => b - a);
    out[pos] = vals[startersByPos[pos] ?? 0] ?? 0;
  }
  return out;
}

export const vor = (id: string, players: PlayersMap, value: (id: string) => number, repl: ReplacementLevels) =>
  round1(value(id) - (repl[players[id]?.position] ?? 0));

// ---------- power rankings ----------
export interface AllPlay {
  wins: number;
  losses: number;
  ties: number;
  pct: number;
}

/** All-play record: every week, each team "plays" every other team. Removes schedule luck. */
export function allPlayRecords(weeks: Matchup[][]): Record<number, AllPlay> {
  const rec: Record<number, AllPlay> = {};
  for (const week of weeks) {
    const scored = week.filter((m) => m.points > 0);
    if (scored.length < 2) continue; // unplayed week
    for (const a of scored) {
      const r = (rec[a.roster_id] ??= { wins: 0, losses: 0, ties: 0, pct: 0 });
      for (const b of scored) {
        if (a === b) continue;
        if (a.points > b.points) r.wins++;
        else if (a.points < b.points) r.losses++;
        else r.ties++;
      }
    }
  }
  for (const r of Object.values(rec)) {
    const g = r.wins + r.losses + r.ties;
    r.pct = g ? (r.wins + r.ties / 2) / g : 0;
  }
  return rec;
}

// ---------- trades ----------
export interface TradeSide {
  before: number;
  after: number;
  delta: number;
  vorOut: number;
  vorIn: number;
}

export interface TradeResult {
  me: TradeSide;
  them: TradeSide;
  verdict: string;
}

export function evaluateTrade(args: {
  myIds: string[];
  theirIds: string[];
  give: string[];
  get: string[];
  slots: string[];
  players: PlayersMap;
  value: (id: string) => number;
  repl: ReplacementLevels;
}): TradeResult {
  const { myIds, theirIds, give, get, slots, players, value, repl } = args;
  const side = (ids: string[], out: string[], inn: string[]): TradeSide => {
    const before = optimalLineup(slots, ids, value, players).total;
    const afterIds = ids.filter((id) => !out.includes(id)).concat(inn);
    const after = optimalLineup(slots, afterIds, value, players).total;
    const sumVor = (xs: string[]) => round1(xs.reduce((s, id) => s + Math.max(0, vor(id, players, value, repl)), 0));
    return { before, after, delta: round1(after - before), vorOut: sumVor(out), vorIn: sumVor(inn) };
  };
  const me = side(myIds, give, get);
  const them = side(theirIds, get, give);

  let verdict: string;
  if (me.delta > 1 && them.delta > 1) verdict = "Win-win: both starting lineups improve. Good pitch.";
  else if (me.delta > 1 && them.delta <= 0) verdict = "Good for you, but they get worse. Expect pushback.";
  else if (me.delta <= -1) verdict = "Your weekly starting lineup gets worse. Only do it for depth/injury reasons.";
  else if (me.vorIn - me.vorOut > 2) verdict = "Roughly neutral for your lineup now, but you gain value over replacement.";
  else verdict = "Close to even. Decide on schedule, injuries, and gut feel.";
  return { me, them, verdict };
}

// ---------- waivers ----------
export function lineupGain(
  slots: string[],
  myIds: string[],
  candidateId: string,
  value: (id: string) => number,
  players: PlayersMap,
): number {
  const base = optimalLineup(slots, myIds, value, players).total;
  const withC = optimalLineup(slots, [...myIds, candidateId], value, players).total;
  return round1(withC - base);
}
