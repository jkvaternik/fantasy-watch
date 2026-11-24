/**
 * Playoff odds: Monte Carlo over the remaining schedule, plus an EXACT
 * clinch/elimination check by enumerating every remaining outcome.
 *
 * Two different questions, two different methods, on purpose:
 *  - "What are my chances?" is a probability. Simulate.
 *  - "Am I mathematically in?" is a proof. Simulating 20k times and seeing 100%
 *    is not a proof, so `clinchStatus` enumerates all 2^games outcomes instead.
 */
import { round1 } from "./lineup";

export interface Game {
  week: number;
  a: number; // roster_id
  b: number; // roster_id
}

export interface TeamRecord {
  rosterId: number;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  /**
   * Head-to-head points against, for display only — never used in seeding.
   * Sleeper's `fpts_against` excludes the median opponent, and so does this.
   */
  pa?: number;
}

export interface Strength {
  /** expected points per week */
  mean: number;
  /** week-to-week standard deviation */
  sd: number;
}

/** Fantasy weekly scores vary a lot; used when a team has too little history. */
export const DEFAULT_SD = 26;

/** roster_id -> division number. Null/empty means the league has no divisions. */
export type Divisions = Map<number, number> | null;

/**
 * Seeding order, best-to-worst.
 *
 * Base rule is Sleeper's default: record first, then total points for. When the
 * league has divisions, each division's best team takes a top seed ahead of
 * every non-winner, which is what lets a weak division winner outseed a better
 * second-place team.
 */
export function seedOrder(scores: Map<number, { score: number; pf: number }>, divisions?: Divisions): number[] {
  const entries = [...scores.entries()];
  const better = (a: { score: number; pf: number }, b: { score: number; pf: number }) =>
    a.score > b.score || (a.score === b.score && a.pf > b.pf);

  const winners = new Set<number>();
  if (divisions && divisions.size) {
    const best = new Map<number, number>(); // division -> roster id
    for (const [id, v] of entries) {
      const d = divisions.get(id);
      if (d === undefined) continue;
      const cur = best.get(d);
      if (cur === undefined || better(v, scores.get(cur)!)) best.set(d, id);
    }
    for (const id of best.values()) winners.add(id);
  }

  return entries
    .sort(
      (x, y) =>
        (winners.has(y[0]) ? 1 : 0) - (winners.has(x[0]) ? 1 : 0) ||
        y[1].score - x[1].score ||
        y[1].pf - x[1].pf ||
        x[0] - y[0],
    )
    .map(([id]) => id);
}

/**
 * Maps roster ids onto dense division indices for the simulation loops.
 * Returns null unless every team has a division — partial data would silently
 * seed some teams as division winners and others not.
 */
function denseDivisions(ids: number[], divisions?: Divisions): { divOf: Int32Array; count: number } | null {
  if (!divisions || !divisions.size) return null;
  const divOf = new Int32Array(ids.length).fill(-1);
  const index = new Map<number, number>();
  for (let i = 0; i < ids.length; i++) {
    const d = divisions.get(ids[i]);
    if (d === undefined) return null;
    let di = index.get(d);
    if (di === undefined) index.set(d, (di = index.size));
    divOf[i] = di;
  }
  return index.size > 1 ? { divOf, count: index.size } : null;
}

/**
 * How many top seeds get a first-round bye: the byes needed to pad the field
 * out to a power of two (6 teams → 2 byes, 4 or 8 → none, 12 → 4).
 */
export function byeCount(playoffTeams: number): number {
  if (playoffTeams < 2) return 0;
  const bracket = 2 ** Math.ceil(Math.log2(playoffTeams));
  return bracket - playoffTeams;
}

/**
 * Remaining games from the schedule. Sleeper publishes matchup pairings for
 * future weeks, so each unplayed week already tells us who plays whom.
 */
export function remainingGames(matchupsByWeek: { roster_id: number; matchup_id: number | null }[][], fromWeek: number, throughWeek: number): Game[] {
  const games: Game[] = [];
  for (let w = fromWeek; w <= throughWeek; w++) {
    const week = matchupsByWeek[w - 1];
    if (!week) continue;
    const byMatchup = new Map<number, number[]>();
    for (const m of week) {
      if (m.matchup_id == null) continue;
      byMatchup.set(m.matchup_id, [...(byMatchup.get(m.matchup_id) ?? []), m.roster_id]);
    }
    for (const ids of byMatchup.values()) {
      if (ids.length === 2) games.push({ week: w, a: ids[0], b: ids[1] });
    }
  }
  return games;
}

type ScoreRow = { roster_id: number; matchup_id: number | null; points: number };

/** How complete a week's scoring is. */
export type WeekPhase = "none" | "partial" | "complete";

export function weekPhase(rows: ScoreRow[] | undefined): WeekPhase {
  const playing = (rows ?? []).filter((m) => m.matchup_id != null);
  if (playing.length < 2) return "none";
  const scored = playing.filter((m) => m.points > 0).length;
  if (scored === 0) return "none";
  return scored === playing.length ? "complete" : "partial";
}

/**
 * Fold one week of final scores into running records: the head-to-head result,
 * plus the median game when the league plays one.
 */
function foldWeek(rows: ScoreRow[], team: (id: number) => TeamRecord, medianMatch: boolean) {
  const playing = rows.filter((m) => m.matchup_id != null);

  const byMatchup = new Map<number, ScoreRow[]>();
  for (const m of playing) byMatchup.set(m.matchup_id!, [...(byMatchup.get(m.matchup_id!) ?? []), m]);

  for (const pair of byMatchup.values()) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const ta = team(a.roster_id);
    const tb = team(b.roster_id);
    ta.pf += a.points;
    tb.pf += b.points;
    // points against counts the head-to-head opponent only, matching Sleeper
    ta.pa = (ta.pa ?? 0) + b.points;
    tb.pa = (tb.pa ?? 0) + a.points;
    if (a.points > b.points) {
      ta.wins += 1;
      tb.losses += 1;
    } else if (b.points > a.points) {
      tb.wins += 1;
      ta.losses += 1;
    } else {
      ta.ties += 1;
      tb.ties += 1;
    }
  }

  if (!medianMatch) return;
  const pts = playing.map((m) => m.points).sort((x, y) => x - y);
  const k = pts.length;
  if (k < 2) return;
  const median = k % 2 ? pts[(k - 1) / 2] : (pts[k / 2 - 1] + pts[k / 2]) / 2;
  for (const m of playing) {
    const t = team(m.roster_id);
    if (m.points > median) t.wins += 1;
    else if (m.points < median) t.losses += 1;
    else t.ties += 1;
  }
}

/**
 * Standings as of the end of a given week, rebuilt from matchup results.
 * Used to replay what the odds would have said earlier in the season.
 */
export function recordsThrough(
  matchupsByWeek: ScoreRow[][],
  throughWeek: number,
  medianMatch = false,
): TeamRecord[] {
  const acc = new Map<number, TeamRecord>();
  const team = (id: number) => {
    let t = acc.get(id);
    if (!t) acc.set(id, (t = { rosterId: id, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }));
    return t;
  };

  for (let w = 1; w <= throughWeek; w++) {
    if (weekPhase(matchupsByWeek[w - 1]) !== "complete") continue;
    foldWeek(matchupsByWeek[w - 1], team, medianMatch);
  }
  for (const t of acc.values()) {
    t.pf = round1(t.pf);
    t.pa = round1(t.pa ?? 0);
  }
  return [...acc.values()].sort((x, y) => x.rosterId - y.rosterId);
}

export interface LiveStandings {
  records: TeamRecord[];
  /** weeks counted: every team in them has a final score */
  weeks: number[];
  /** a week that has started but isn't finished, so it is simulated, not counted */
  partialWeeks: number[];
}

/**
 * Standings computed from the scores themselves rather than from Sleeper's
 * reported record, so a week that has finished counts immediately instead of
 * waiting for Sleeper to score it.
 *
 * A week that has started but not finished is deliberately left out: half a
 * week of scores would hand losses to teams whose players simply haven't
 * played, and would drag the median down with them.
 */
export function liveStandings(
  matchupsByWeek: ScoreRow[][],
  throughWeek: number,
  medianMatch = false,
): LiveStandings {
  const weeks: number[] = [];
  const partialWeeks: number[] = [];
  const acc = new Map<number, TeamRecord>();
  const team = (id: number) => {
    let t = acc.get(id);
    if (!t) acc.set(id, (t = { rosterId: id, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }));
    return t;
  };

  for (let w = 1; w <= throughWeek; w++) {
    const phase = weekPhase(matchupsByWeek[w - 1]);
    if (phase === "partial") partialWeeks.push(w);
    if (phase !== "complete") continue;
    foldWeek(matchupsByWeek[w - 1], team, medianMatch);
    weeks.push(w);
  }
  for (const t of acc.values()) {
    t.pf = round1(t.pf);
    t.pa = round1(t.pa ?? 0);
  }
  return { records: [...acc.values()].sort((x, y) => x.rosterId - y.rosterId), weeks, partialWeeks };
}

/**
 * Do our own standings agree with Sleeper's for the weeks Sleeper has scored?
 *
 * If not, the league is using a rule we don't model and every number built on
 * these records is suspect, so the caller should say so rather than quietly
 * publish them.
 */
export function reconcileRecords(
  derived: TeamRecord[],
  official: TeamRecord[],
): { ok: boolean; mismatches: number[] } {
  const by = new Map(derived.map((r) => [r.rosterId, r]));
  const mismatches: number[] = [];
  for (const o of official) {
    const d = by.get(o.rosterId);
    if (!d || d.wins !== o.wins || d.losses !== o.losses || d.ties !== o.ties) mismatches.push(o.rosterId);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Each roster's weekly score history. Pass `only` to count just those weeks. */
export function weeklyScores(
  matchupsByWeek: { roster_id: number; points: number }[][],
  throughWeek: number,
  only?: Set<number>,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let w = 1; w <= throughWeek; w++) {
    if (only && !only.has(w)) continue;
    const week = matchupsByWeek[w - 1];
    if (!week || week.filter((m) => m.points > 0).length < 2) continue; // unplayed
    for (const m of week) {
      if (m.points <= 0) continue;
      out.set(m.roster_id, [...(out.get(m.roster_id) ?? []), m.points]);
    }
  }
  return out;
}

/**
 * Expected weekly score and volatility for one team.
 *
 * The mean blends the team's own average with its projected optimal lineup, and
 * is shrunk toward the league average when there's little history — a 2-0 team
 * that got lucky twice shouldn't be modeled as a juggernaut.
 */
export function teamStrength(scores: number[], projected: number | undefined, leagueMean: number): Strength {
  const n = scores.length;
  const avg = n ? scores.reduce((s, x) => s + x, 0) / n : leagueMean;

  // Shrink toward the league mean: full weight at ~6 games of history.
  const k = 6;
  const shrunk = (n * avg + k * leagueMean) / (n + k);
  const mean = projected && projected > 0 ? 0.65 * shrunk + 0.35 * projected : shrunk;

  let sd = DEFAULT_SD;
  if (n >= 4) {
    const varr = scores.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1);
    // Blend the sample sd with the default so one wild week doesn't dominate.
    sd = 0.6 * Math.sqrt(varr) + 0.4 * DEFAULT_SD;
  }
  return { mean: round1(mean), sd: Math.max(8, round1(sd)) };
}

// ---------- rng ----------
/** Seeded so the odds don't jitter every re-render. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, one value per call (the spare is cheap enough to discard). */
function normal(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- monte carlo ----------
export interface TeamOdds {
  rosterId: number;
  playoff: number; // 0..1
  bye: number; // 0..1
  topSeed: number; // 0..1
  expectedWins: number;
  /** seedDist[i] = probability of finishing seed i+1 */
  seedDist: number[];
  avgSeed: number;
}

export interface SimArgs {
  records: TeamRecord[];
  games: Game[];
  strength: Map<number, Strength>;
  playoffTeams: number;
  byes?: number;
  sims?: number;
  seed?: number;
  divisions?: Divisions;
  /** Sleeper's "league average match": each team also plays the weekly median. */
  medianMatch?: boolean;
}

/** Shared per-sim state handed to an observer, reused across sims — read, don't keep. */
interface SimFrame {
  /** half-points: 2 per win, 1 per tie */
  score: Float64Array;
  base: Float64Array;
  /** team index -> final seed (0-based) */
  seedOf: Int32Array;
  /** game index -> winning team index, or -1 for a tie */
  gameWinner: Int32Array;
}

/**
 * One Monte Carlo engine, used both for plain odds and for scenario analysis,
 * so the two can never disagree about the same league.
 */
function runSims(args: SimArgs, observe?: (f: SimFrame) => void): TeamOdds[] {
  const { records, games, strength, playoffTeams, medianMatch = false } = args;
  const byes = args.byes ?? byeCount(playoffTeams);
  const sims = args.sims ?? 20000;
  const rng = mulberry32(args.seed ?? 12345);

  const ids = records.map((r) => r.rosterId);
  const n = ids.length;
  const pos = new Map(ids.map((id, i) => [id, i]));

  const baseScore = new Float64Array(n);
  const basePf = new Float64Array(n);
  records.forEach((r, i) => {
    baseScore[i] = 2 * r.wins + r.ties;
    basePf[i] = r.pf;
  });

  const means = new Float64Array(n);
  const sds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const st = strength.get(ids[i]) ?? { mean: 100, sd: DEFAULT_SD };
    means[i] = st.mean;
    sds[i] = st.sd;
  }

  // Weeks, not loose games: the median match couples every score in a week.
  const slates = weekSlates(games, pos);

  const playoffHits = new Float64Array(n);
  const byeHits = new Float64Array(n);
  const topHits = new Float64Array(n);
  const winSum = new Float64Array(n);
  const seedHits = Array.from({ length: n }, () => new Float64Array(n));

  const score = new Float64Array(n);
  const pf = new Float64Array(n);
  const order = new Int32Array(n);
  const weekScore = new Float64Array(n);
  const seedOf = new Int32Array(n);
  const gameWinner = new Int32Array(games.length);
  const frame: SimFrame = { score, base: baseScore, seedOf, gameWinner };

  // Division winners are seeded ahead of everyone else, so each sim has to find
  // them before it can sort the field.
  const dense = denseDivisions(ids, args.divisions);
  const divOf = dense?.divOf;
  const divCount = dense?.count ?? 0;
  const divBest = new Int32Array(divCount);
  const isWinner = new Int32Array(n); // stays all-zero without divisions

  for (let s = 0; s < sims; s++) {
    score.set(baseScore);
    pf.set(basePf);

    for (const slate of slates) {
      const { idx, ga, gb, gi, buf } = slate;
      for (let t = 0; t < idx.length; t++) {
        const i = idx[t];
        const v = normal(rng, means[i], sds[i]);
        weekScore[i] = v;
        pf[i] += v;
        buf[t] = v;
      }

      // head-to-head
      for (let g = 0; g < ga.length; g++) {
        const a = ga[g];
        const b = gb[g];
        const sa = weekScore[a];
        const sb = weekScore[b];
        if (sa > sb) {
          score[a] += 2;
          gameWinner[gi[g]] = a;
        } else if (sb > sa) {
          score[b] += 2;
          gameWinner[gi[g]] = b;
        } else {
          score[a] += 1;
          score[b] += 1;
          gameWinner[gi[g]] = -1;
        }
      }

      // second game of the week: everyone against the league median
      if (medianMatch) {
        const sorted = buf.slice().sort((x, y) => x - y);
        const k = sorted.length;
        const med = k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
        for (let t = 0; t < idx.length; t++) {
          const i = idx[t];
          if (weekScore[i] > med) score[i] += 2;
          else if (weekScore[i] === med) score[i] += 1;
        }
      }
    }

    if (divOf) {
      divBest.fill(-1);
      for (let i = 0; i < n; i++) {
        const b = divBest[divOf[i]];
        if (b < 0 || score[i] > score[b] || (score[i] === score[b] && pf[i] > pf[b])) divBest[divOf[i]] = i;
      }
      isWinner.fill(0);
      for (let d = 0; d < divCount; d++) if (divBest[d] >= 0) isWinner[divBest[d]] = 1;
    }

    for (let i = 0; i < n; i++) order[i] = i;
    // division winners first, then record, then points for
    order.sort((x, y) => isWinner[y] - isWinner[x] || score[y] - score[x] || pf[y] - pf[x]);

    for (let seed = 0; seed < n; seed++) {
      const i = order[seed];
      seedOf[i] = seed;
      seedHits[i][seed] += 1;
      if (seed < playoffTeams) playoffHits[i] += 1;
      if (seed < byes) byeHits[i] += 1;
      if (seed === 0) topHits[i] += 1;
      winSum[i] += score[i] / 2;
    }

    observe?.(frame);
  }

  return ids.map((id, i) => {
    const dist = Array.from(seedHits[i], (c) => c / sims);
    return {
      rosterId: id,
      playoff: playoffHits[i] / sims,
      bye: byeHits[i] / sims,
      topSeed: topHits[i] / sims,
      expectedWins: round1(winSum[i] / sims),
      seedDist: dist,
      avgSeed: round1(dist.reduce((acc, p, k) => acc + p * (k + 1), 0)),
    };
  });
}

export const simulate = (args: SimArgs): TeamOdds[] => runSims(args);

// ---------- scenario analysis ----------
/** One row of "if you bank this many wins, here's where you land". */
export interface OwnWinsRow {
  wins: number;
  /** share of simulated seasons that finish on this win total */
  share: number;
  playoff: number;
  bye: number;
  /** true when enumeration proved this win total is enough no matter what */
  guaranteed?: boolean;
}

/** How much one remaining game moves a particular team's odds. */
export interface Leverage {
  week: number;
  a: number;
  b: number;
  /** focus team's playoff odds in the seasons where a / b won */
  ifA: number;
  ifB: number;
  /** signed toward a: positive means rooting for a */
  swing: number;
  byeSwing: number;
  /** the focus team is playing in this game */
  own: boolean;
}

export interface ScenarioAnalysis {
  odds: TeamOdds[];
  /** reachable win totals for the focus team, worst to best */
  ownWins: OwnWinsRow[];
  /** remaining games, biggest mover first */
  leverage: Leverage[];
}

/**
 * What has to happen, for one team.
 *
 * Exact enumeration is out of reach for a long remaining schedule (a median
 * league multiplies out to ~9,024 combinations per week), so this answers the
 * question by frequency instead: it re-reads the same simulated seasons, split
 * by the team's own win total and by each remaining game's winner. Those are
 * probabilities, not proofs — `clinchStatus` is still the only thing that
 * claims a guarantee.
 */
export function scenarioAnalysis(args: SimArgs & { focus: number }): ScenarioAnalysis {
  const { records, games, playoffTeams, focus } = args;
  const byes = args.byes ?? byeCount(playoffTeams);
  const sims = args.sims ?? 20000;

  const ids = records.map((r) => r.rosterId);
  const fi = ids.indexOf(focus);
  const G = games.length;

  const maxWins = 2 * (args.medianMatch ? 2 : 1) * new Set(games.map((g) => g.week)).size + 1;
  const winTally = new Float64Array(maxWins + 1);
  const winPlayoff = new Float64Array(maxWins + 1);
  const winBye = new Float64Array(maxWins + 1);

  // [game][side] where side 0 = games[g].a won, 1 = b won
  const gTally = [new Float64Array(G), new Float64Array(G)];
  const gPlayoff = [new Float64Array(G), new Float64Array(G)];
  const gBye = [new Float64Array(G), new Float64Array(G)];

  const aIdx = games.map((g) => ids.indexOf(g.a));

  const odds = runSims(args, (f) => {
    if (fi < 0) return;
    const seed = f.seedOf[fi];
    const inPlayoffs = seed < playoffTeams ? 1 : 0;
    const gotBye = seed < byes ? 1 : 0;

    const w = Math.round((f.score[fi] - f.base[fi]) / 2);
    if (w >= 0 && w <= maxWins) {
      winTally[w] += 1;
      winPlayoff[w] += inPlayoffs;
      winBye[w] += gotBye;
    }

    for (let g = 0; g < G; g++) {
      const winner = f.gameWinner[g];
      if (winner < 0) continue; // tie, rare enough to skip
      const side = winner === aIdx[g] ? 0 : 1;
      gTally[side][g] += 1;
      gPlayoff[side][g] += inPlayoffs;
      gBye[side][g] += gotBye;
    }
  });

  const ownWins: OwnWinsRow[] = [];
  for (let w = 0; w <= maxWins; w++) {
    if (winTally[w] === 0) continue;
    ownWins.push({
      wins: w,
      share: winTally[w] / sims,
      playoff: winPlayoff[w] / winTally[w],
      bye: winBye[w] / winTally[w],
    });
  }

  const leverage: Leverage[] = games.map((g, i) => {
    const nA = gTally[0][i];
    const nB = gTally[1][i];
    const ifA = nA ? gPlayoff[0][i] / nA : 0;
    const ifB = nB ? gPlayoff[1][i] / nB : 0;
    const byeA = nA ? gBye[0][i] / nA : 0;
    const byeB = nB ? gBye[1][i] / nB : 0;
    return {
      week: g.week,
      a: g.a,
      b: g.b,
      ifA,
      ifB,
      swing: ifA - ifB,
      byeSwing: byeA - byeB,
      own: g.a === focus || g.b === focus,
    };
  });
  leverage.sort((x, y) => Math.abs(y.swing) - Math.abs(x.swing) || x.week - y.week);

  return { odds, ownWins, leverage };
}

// ---------- week structure ----------
interface Slate {
  week: number;
  /** dense team indices playing this week */
  idx: Int32Array;
  ga: Int32Array;
  gb: Int32Array;
  /** global game index, so observers can line outcomes up with `games` */
  gi: Int32Array;
  buf: Float64Array;
}

function weekSlates(games: Game[], pos: Map<number, number>): Slate[] {
  const byWeek = new Map<number, number[]>();
  games.forEach((g, i) => byWeek.set(g.week, [...(byWeek.get(g.week) ?? []), i]));

  const out: Slate[] = [];
  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const ga: number[] = [];
    const gb: number[] = [];
    const gi: number[] = [];
    const idx: number[] = [];
    for (const i of byWeek.get(week)!) {
      const a = pos.get(games[i].a);
      const b = pos.get(games[i].b);
      if (a === undefined || b === undefined) continue;
      ga.push(a);
      gb.push(b);
      gi.push(i);
      idx.push(a, b);
    }
    if (!idx.length) continue;
    out.push({
      week,
      idx: Int32Array.from(idx),
      ga: Int32Array.from(ga),
      gb: Int32Array.from(gb),
      gi: Int32Array.from(gi),
      buf: new Float64Array(idx.length),
    });
  }
  return out;
}

// ---------- exact clinch / elimination ----------
export type ClinchState = "clinched-bye" | "clinched" | "eliminated" | "alive";

export interface TeamClinch {
  state: ClinchState;
  /** results this team still has to bank (two per week in a median league) */
  remaining: number;
  /**
   * Fewest wins from here that put the team in the field in EVERY scenario,
   * however the other games go. null when no number of wins can guarantee it.
   */
  clinchWins: number | null;
  /**
   * Fewest wins that leave any path at all. null when the team is already in
   * regardless (0 would do) or already out entirely.
   */
  mustWin: number | null;
}

export interface ClinchResult {
  /** null when the remaining schedule is too large to enumerate exactly. */
  teams: Map<number, TeamClinch> | null;
  scenarios: number;
  /** Scenario count the schedule would need, even when we refuse to walk it. */
  needed: number;
}

/** Ceiling on scenarios we'll walk: ~1M keeps the exact check inside a frame budget. */
export const MAX_ENUMERATED_SCENARIOS = 2 ** 20;

/**
 * Every jointly feasible "wins added this week" vector for one week.
 *
 * Without a median match that's just who wins each game. With one, the two
 * results are coupled: a team that wins head-to-head outscored its opponent, so
 * it cannot be the one below the median. Exactly half the field clears the
 * median every week, which constrains the combinations further.
 *
 * Returns null when the week can't be enumerated exactly (odd field, so one team
 * sits exactly on the median).
 */
function weekOutcomes(slate: Slate, n: number, medianMatch: boolean): Int32Array[] | null {
  const G = slate.ga.length;
  const out: Int32Array[] = [];

  if (!medianMatch) {
    for (let mask = 0; mask < 1 << G; mask++) {
      const v = new Int32Array(n);
      for (let g = 0; g < G; g++) v[mask & (1 << g) ? slate.ga[g] : slate.gb[g]] = 1;
      out.push(v);
    }
    return out;
  }

  const teams = new Set(slate.idx);
  if (teams.size % 2 !== 0) return null;
  const target = teams.size / 2; // teams above the median

  // Per game, picking the winner and how many of the pair clear the median:
  //   2 → winner +2, loser +1   (both above)
  //   1 → winner +2, loser +0   (winner above only)
  //   0 → winner +1, loser +0   (both below)
  const v = new Int32Array(n);
  const walk = (g: number, aboveLeft: number) => {
    if (g === G) {
      if (aboveLeft === 0) out.push(v.slice());
      return;
    }
    if (aboveLeft > 2 * (G - g)) return; // can't place the rest
    for (const flip of [false, true]) {
      const w = flip ? slate.gb[g] : slate.ga[g];
      const l = flip ? slate.ga[g] : slate.gb[g];
      for (let m = 0; m <= Math.min(2, aboveLeft); m++) {
        v[w] += m === 0 ? 1 : 2;
        v[l] += m === 2 ? 1 : 0;
        walk(g + 1, aboveLeft - m);
        v[w] -= m === 0 ? 1 : 2;
        v[l] -= m === 2 ? 1 : 0;
      }
    }
  };
  walk(0, target);
  return out;
}

/**
 * Exact status by brute force over every combination of remaining results.
 *
 * Tiebreakers are deliberately NOT modeled: a team tied at the cut line is
 * treated as missing when we ask "clinched?" and as making it when we ask
 * "eliminated?". So a "clinched" answer here holds no matter how ties break.
 */
export function clinchStatus(args: {
  records: TeamRecord[];
  games: Game[];
  playoffTeams: number;
  byes?: number;
  divisions?: Divisions;
  medianMatch?: boolean;
}): ClinchResult {
  const { records, games, playoffTeams, medianMatch = false } = args;
  const byes = args.byes ?? byeCount(playoffTeams);
  const n = records.length;

  const pos = new Map(records.map((r, i) => [r.rosterId, i]));
  const base = new Int32Array(n);
  records.forEach((r, i) => (base[i] = 2 * r.wins + r.ties));

  // Season already over: ranks are known, points-for settles ties.
  if (games.length === 0) {
    const order = seedOrder(
      new Map(records.map((r) => [r.rosterId, { score: base[pos.get(r.rosterId)!], pf: r.pf }])),
      args.divisions,
    );
    const teams = new Map<number, TeamClinch>();
    order.forEach((id, seed) =>
      teams.set(id, {
        state: seed < byes ? "clinched-bye" : seed < playoffTeams ? "clinched" : "eliminated",
        remaining: 0,
        clinchWins: null,
        mustWin: null,
      }),
    );
    return { teams, scenarios: 1, needed: 1 };
  }

  const slates = weekSlates(games, pos);
  const perWeek: Int32Array[][] = [];
  let needed = 1;
  for (const slate of slates) {
    const opts = weekOutcomes(slate, n, medianMatch);
    if (!opts || opts.length === 0) return { teams: null, scenarios: 0, needed: Infinity };
    perWeek.push(opts);
    needed *= opts.length;
    if (needed > MAX_ENUMERATED_SCENARIOS) {
      // keep multiplying for the message, but stop allocating
      for (let k = perWeek.length; k < slates.length; k++) needed *= medianMatch ? 9024 : 2 ** slates[k].ga.length;
      return { teams: null, scenarios: 0, needed };
    }
  }

  // Most wins each team can still bank.
  const ownGames = new Int32Array(n);
  for (const week of perWeek) {
    const best = new Int32Array(n);
    for (const v of week) for (let i = 0; i < n; i++) if (v[i] > best[i]) best[i] = v[i];
    for (let i = 0; i < n; i++) ownGames[i] += best[i];
  }

  const dense = denseDivisions(
    records.map((r) => r.rosterId),
    args.divisions,
  );
  const divOf = dense?.divOf;
  const divCount = dense?.count ?? 0;
  const divMax = new Int32Array(divCount);
  const divMaxCount = new Int32Array(divCount);

  const maxScore = Math.max(...base) + 2 * Math.max(...ownGames) + 1;
  const hist = new Int32Array(maxScore + 2);
  const above = new Int32Array(maxScore + 2); // above[s] = teams scoring strictly more than s
  const score = new Int32Array(n);

  const stride = Math.max(...ownGames) + 1;
  const worstRank = new Int32Array(n);
  const bestRank = new Int32Array(n).fill(n + 1);
  const worstByWins = new Int32Array(n * stride);
  const bestByWins = new Int32Array(n * stride).fill(n + 1);

  const digits = new Int32Array(perWeek.length);
  const total = needed;

  for (let scenario = 0; scenario < total; scenario++) {
    score.set(base);
    for (let w = 0; w < perWeek.length; w++) {
      const v = perWeek[w][digits[w]];
      for (let i = 0; i < n; i++) score[i] += 2 * v[i];
    }

    hist.fill(0);
    for (let i = 0; i < n; i++) hist[score[i]] += 1;
    let running = 0;
    for (let s = maxScore; s >= 0; s--) {
      above[s] = running;
      running += hist[s];
    }

    if (divOf) {
      divMax.fill(-1);
      divMaxCount.fill(0);
      for (let i = 0; i < n; i++) {
        const d = divOf[i];
        if (score[i] > divMax[d]) {
          divMax[d] = score[i];
          divMaxCount[d] = 1;
        } else if (score[i] === divMax[d]) divMaxCount[d] += 1;
      }
    }

    for (let i = 0; i < n; i++) {
      const s = score[i];
      let best: number;
      let worst: number;

      if (divOf) {
        const d = divOf[i];
        // Winning the division is itself a tiebreaker question: tied at the top
        // of the division, the team takes the crown only in its best case.
        const canWinDivision = s === divMax[d];
        const ownsDivision = canWinDivision && divMaxCount[d] === 1;

        if (canWinDivision) {
          let ahead = 0;
          for (let k = 0; k < divCount; k++) if (k !== d && divMax[k] > s) ahead += 1;
          best = ahead + 1;
        } else {
          // A non-winner sits behind every division winner, including the weak
          // ones it outscored, plus every non-winner that outscored it.
          let weakWinners = 0;
          for (let k = 0; k < divCount; k++) if (divMax[k] <= s) weakWinners += 1;
          best = above[s] + weakWinners + 1;
        }

        if (ownsDivision) {
          let ahead = 0;
          for (let k = 0; k < divCount; k++) if (k !== d && divMax[k] >= s) ahead += 1;
          worst = ahead + 1;
        } else {
          let weakWinners = 0;
          for (let k = 0; k < divCount; k++) if (divMax[k] < s) weakWinners += 1;
          worst = above[s] + hist[s] - 1 + weakWinners + 1;
        }
      } else {
        const better = above[s];
        const tied = hist[s] - 1;
        best = better + 1; // every tie breaks your way
        worst = better + 1 + tied; // every tie breaks against you
      }

      if (worst > worstRank[i]) worstRank[i] = worst;
      if (best < bestRank[i]) bestRank[i] = best;
      const k = i * stride + (s - base[i]) / 2; // own wins in this scenario
      if (worst > worstByWins[k]) worstByWins[k] = worst;
      if (best < bestByWins[k]) bestByWins[k] = best;
    }

    // odometer over the weeks
    for (let w = perWeek.length - 1; w >= 0; w--) {
      if (++digits[w] < perWeek[w].length) break;
      digits[w] = 0;
    }
  }

  const teams = new Map<number, TeamClinch>();
  records.forEach((r, i) => {
    const state: ClinchState =
      worstRank[i] <= byes
        ? "clinched-bye"
        : worstRank[i] <= playoffTeams
          ? "clinched"
          : bestRank[i] > playoffTeams
            ? "eliminated"
            : "alive";

    const own = ownGames[i];
    // Winning more never hurts, so scan down from a sweep for the clinch number
    // and up from zero for the first win total that leaves a path.
    let clinchWins: number | null = null;
    for (let k = own; k >= 0; k--) {
      if (worstByWins[i * stride + k] > 0 && worstByWins[i * stride + k] <= playoffTeams) clinchWins = k;
      else if (worstByWins[i * stride + k] > 0) break;
    }
    let mustWin: number | null = null;
    for (let k = 0; k <= own; k++) {
      const b = bestByWins[i * stride + k];
      if (b <= n && b <= playoffTeams) {
        mustWin = k;
        break;
      }
    }
    teams.set(r.rosterId, {
      state,
      remaining: own,
      clinchWins,
      mustWin: state === "alive" && mustWin !== null && mustWin > 0 ? mustWin : null,
    });
  });
  return { teams, scenarios: total, needed };
}

// ---------- clinching recipes ----------
export interface RecipeAsk {
  rosterId: number;
  /** games this team must lose from its remaining results */
  losses: number;
  /** how many it has left, so "loses 6" can be read against "of 8" */
  of: number;
}

export interface Recipe {
  /** finishing this seed or better is what this recipe guarantees */
  slots: number;
  /** wins the focus team must bank from its own remaining results */
  wins: number;
  remaining: number;
  /** what else has to happen; empty means the win total alone is enough */
  asks: RecipeAsk[];
  /** how the team gets in: by winning its division, or on the wildcard board */
  route: "division" | "field";
  /** true when some rival has to lose every remaining game: true, but not realistic */
  needsCollapse: boolean;
}

/** One rung of the seeding ladder: a seed threshold and how to lock it up. */
export interface SeedTarget {
  slots: number;
  recipes: Recipe[];
}

/**
 * "Win 6 of 8, and X loses 1" — a *sufficient* condition, not a prediction.
 *
 * Enumerating every outcome is hopeless over a long schedule, so this reasons
 * from ceilings instead: a rival that loses `l` of its remaining games can
 * finish no higher than a known score, and if too few rivals can reach the
 * focus team, the spot is locked. Because every rival is given its best case
 * independently, a recipe that passes here holds for *every* real combination
 * of results — it can ask for more than strictly necessary, never less.
 */
export function clinchRecipes(args: {
  records: TeamRecord[];
  games: Game[];
  playoffTeams: number;
  byes?: number;
  divisions?: Divisions;
  medianMatch?: boolean;
  focus: number;
  /** seed thresholds to solve for; defaults to the ones that carry a prize */
  targets?: number[];
}): SeedTarget[] {
  const { records, games, playoffTeams, focus, medianMatch = false } = args;
  const byes = args.byes ?? byeCount(playoffTeams);
  const per = medianMatch ? 2 : 1;

  const rec = new Map(records.map((r) => [r.rosterId, r]));
  if (!rec.has(focus)) return [];

  // Remaining results per team: a week played is `per` results banked.
  const weeksOf = new Map<number, Set<number>>();
  for (const g of games) {
    for (const id of [g.a, g.b]) {
      let w = weeksOf.get(id);
      if (!w) weeksOf.set(id, (w = new Set()));
      w.add(g.week);
    }
  }
  const remaining = (id: number) => (weeksOf.get(id)?.size ?? 0) * per;

  const base = (id: number) => {
    const r = rec.get(id)!;
    return 2 * r.wins + r.ties;
  };
  /** Highest score a team can still reach after losing `l` of its games. */
  const ceiling = (id: number, l = 0) => base(id) + 2 * Math.max(0, remaining(id) - l);
  /** Losses needed to put a team strictly below `score`; Infinity if hopeless. */
  const costToDrop = (id: number, score: number) => {
    const gap = score - base(id);
    if (gap <= 0) return Infinity; // already at or above us even losing out
    const need = remaining(id) - Math.floor((gap - 1) / 2);
    return need <= 0 ? 0 : need <= remaining(id) ? need : Infinity;
  };

  const others = records.map((r) => r.rosterId).filter((id) => id !== focus);
  const divOf = (id: number) => args.divisions?.get(id);
  const myDiv = divOf(focus);
  const useDiv = args.divisions != null && args.divisions.size > 0 && myDiv !== undefined;
  const allDivs = useDiv ? [...new Set(records.map((r) => divOf(r.rosterId)!))] : [];
  const mates = others.filter((id) => useDiv && divOf(id) === myDiv);

  const sum = (asks: RecipeAsk[]) => asks.reduce((s, a) => s + a.losses, 0);

  /** Everything the focus team must be guaranteed to outrank its own division. */
  const buyDivision = (score: number): RecipeAsk[] | null => {
    const asks: RecipeAsk[] = [];
    for (const id of mates) {
      if (ceiling(id) < score) continue;
      const c = costToDrop(id, score);
      if (!Number.isFinite(c)) return null;
      if (c > 0) asks.push({ rosterId: id, losses: c, of: remaining(id) });
    }
    return asks;
  };

  /**
   * Safety on the wildcard board: at most `slots - 1` teams may be able to
   * finish ahead. With divisions, each division is credited with its winner
   * even when nobody there can match our record.
   */
  const buyField = (score: number, slots: number): RecipeAsk[] | null => {
    const threatsBy = new Map<number | undefined, { id: number; cost: number }[]>();
    for (const id of others) {
      if (ceiling(id) < score) continue;
      const key = useDiv ? divOf(id) : undefined;
      const list = threatsBy.get(key) ?? [];
      list.push({ id, cost: costToDrop(id, score) });
      threatsBy.set(key, list);
    }

    if (!useDiv) {
      const all = (threatsBy.get(undefined) ?? []).sort((x, y) => x.cost - y.cost);
      const mustDrop = all.length - (slots - 1);
      if (mustDrop <= 0) return [];
      const chosen = all.slice(0, mustDrop);
      if (chosen.some((c) => !Number.isFinite(c.cost))) return null;
      return chosen.filter((c) => c.cost > 0).map((c) => ({ rosterId: c.id, losses: c.cost, of: remaining(c.id) }));
    }

    // Each division contributes max(1, its threats): somebody wins it, and if
    // that winner can't reach us then nobody else there can either.
    const contrib = new Map<number, number>();
    for (const d of allDivs) contrib.set(d, Math.max(1, (threatsBy.get(d) ?? []).length));
    let total = [...contrib.values()].reduce((s, x) => s + x, 0);
    if (total <= slots - 1) return [];

    // Only a division holding more than one threat can be cut down.
    const options: { id: number; cost: number; div: number }[] = [];
    for (const d of allDivs) {
      const list = [...(threatsBy.get(d) ?? [])].sort((x, y) => x.cost - y.cost);
      for (let i = 0; i < list.length - 1; i++) options.push({ ...list[i], div: d });
    }
    options.sort((x, y) => x.cost - y.cost);

    const asks: RecipeAsk[] = [];
    for (const o of options) {
      if (total <= slots - 1) break;
      if ((contrib.get(o.div) ?? 0) <= 1) continue;
      if (!Number.isFinite(o.cost)) return null;
      contrib.set(o.div, contrib.get(o.div)! - 1);
      total -= 1;
      if (o.cost > 0) asks.push({ rosterId: o.id, losses: o.cost, of: remaining(o.id) });
    }
    return total <= slots - 1 ? asks : null;
  };

  /** Once we own our division, only other division winners outrank us. */
  const buyAmongWinners = (score: number, slots: number): RecipeAsk[] | null => {
    const dangerous = allDivs
      .filter((d) => d !== myDiv)
      .map((d) => {
        const members = others.filter((id) => divOf(id) === d && ceiling(id) >= score);
        return { d, members, cost: members.reduce((s, id) => s + costToDrop(id, score), 0) };
      })
      .filter((x) => x.members.length > 0)
      .sort((x, y) => x.cost - y.cost);

    const mustClear = dangerous.length - (slots - 1);
    if (mustClear <= 0) return [];
    const chosen = dangerous.slice(0, mustClear);
    if (chosen.some((c) => !Number.isFinite(c.cost))) return null;
    return chosen.flatMap((c) =>
      c.members.map((id) => ({ rosterId: id, losses: costToDrop(id, score), of: remaining(id) })).filter((a) => a.losses > 0),
    );
  };

  const cheapest = (slots: number): Recipe[] => {
    const out: Recipe[] = [];
    const R = remaining(focus);
    for (let w = 0; w <= R; w++) {
      const score = base(focus) + 2 * w;
      const candidates: { asks: RecipeAsk[]; route: "division" | "field" }[] = [];

      if (useDiv) {
        const crown = buyDivision(score);
        if (crown) {
          const rest = buyAmongWinners(score, slots);
          if (rest) candidates.push({ asks: merge(crown, rest), route: "division" });
        }
        // Seeds above the division-winner block are only reachable by winning
        // the division; below it, the wildcard board is open too.
        if (slots > allDivs.length) {
          const field = buyField(score, slots);
          if (field) candidates.push({ asks: field, route: "field" });
        }
      } else {
        const field = buyField(score, slots);
        if (field) candidates.push({ asks: field, route: "field" });
      }

      if (!candidates.length) continue;
      candidates.sort((x, y) => sum(x.asks) - sum(y.asks) || x.asks.length - y.asks.length);
      const asks = candidates[0].asks;
      out.push({
        slots,
        wins: w,
        remaining: R,
        asks,
        route: candidates[0].route,
        needsCollapse: asks.some((a) => a.losses >= a.of),
      });
    }
    // Drop rows that ask for more than a lower win total already did.
    return out.filter((r, i) => i === 0 || sum(r.asks) < sum(out[i - 1].asks) || out[i - 1].asks.length > r.asks.length);
  };

  // Default rungs: the top seed, the last bye, the division-winner block, and
  // the playoff cut — each a threshold something actually changes at.
  const wanted =
    args.targets ??
    [1, byes, useDiv ? allDivs.length : 0, playoffTeams].filter((n) => n > 0 && n <= records.length);
  const ladder = [...new Set(wanted)].sort((x, y) => x - y);
  return ladder.map((slots) => ({ slots, recipes: cheapest(slots) }));
}

function merge(a: RecipeAsk[], b: RecipeAsk[]): RecipeAsk[] {
  const by = new Map<number, RecipeAsk>();
  for (const x of [...a, ...b]) {
    const cur = by.get(x.rosterId);
    if (!cur || x.losses > cur.losses) by.set(x.rosterId, x);
  }
  return [...by.values()].sort((x, y) => y.losses - x.losses);
}
