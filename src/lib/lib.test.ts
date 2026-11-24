import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Matchup, Player, PlayersMap, Roster } from "../api/types";
import { lineupSwaps, optimalLineup, startingSlots } from "./lineup";
import { buildProjectionMap, injuryAdjusted, presetKey, scoreStats } from "./scoring";
import { pct } from "./format";
import { loadTheme, prefersDark, resolveTheme, THEME_KEY } from "../state/theme";
import { allPlayRecords, computePpg, evaluateTrade, lineupGain, replacementLevels, rosValue } from "./value";
import {
  DEFAULT_SD,
  MAX_ENUMERATED_SCENARIOS,
  byeCount,
  clinchStatus,
  clinchRecipes,
  liveStandings,
  reconcileRecords,
  seedOrder,
  weekPhase,
  recordsThrough,
  remainingGames,
  scenarioAnalysis,
  simulate,
  teamStrength,
  weeklyScores,
  type TeamRecord,
} from "./playoffs";

const P = (id: string, position: string): Player => ({
  player_id: id,
  name: id,
  position,
  fantasy_positions: [position],
  team: "XX",
  injury_status: null,
  status: "Active",
  age: 25,
  years_exp: 3,
  search_rank: 1,
});

const players: PlayersMap = Object.fromEntries(
  [
    P("qb1", "QB"), P("qb2", "QB"),
    P("rb1", "RB"), P("rb2", "RB"), P("rb3", "RB"),
    P("wr1", "WR"), P("wr2", "WR"), P("wr3", "WR"),
    P("te1", "TE"), P("te2", "TE"),
    P("k1", "K"), P("def1", "DEF"),
  ].map((p) => [p.player_id, p]),
);

const pts: Record<string, number> = {
  qb1: 20, qb2: 18, rb1: 15, rb2: 12, rb3: 11, wr1: 16, wr2: 13, wr3: 4, te1: 9, te2: 3, k1: 8, def1: 7,
};
const val = (id: string) => pts[id] ?? 0;

describe("scoring", () => {
  it("scores stat lines with league settings", () => {
    expect(scoreStats({ pass_yd: 300, pass_td: 2, int: 1 }, { pass_yd: 0.04, pass_td: 4, int: -2 })).toBe(18);
  });
  it("picks preset by reception scoring", () => {
    expect(presetKey({ rec: 1 })).toBe("pts_ppr");
    expect(presetKey({ rec: 0.5 })).toBe("pts_half_ppr");
    expect(presetKey({})).toBe("pts_std");
  });
  it("uses preset for DEF and custom for skill players", () => {
    const map = buildProjectionMap(
      [
        { player_id: "def1", stats: { pts_ppr: 7.4, sack: 3 } },
        { player_id: "wr1", stats: { rec: 6, rec_yd: 80, pts_ppr: 99 } },
      ],
      { rec: 1, rec_yd: 0.1, sack: 1 },
      players,
    );
    expect(map.def1).toBe(7.4);
    expect(map.wr1).toBe(14);
  });
  it("discounts injuries", () => {
    expect(injuryAdjusted(10, "Out")).toBe(0);
    expect(injuryAdjusted(10, "Questionable")).toBe(9);
  });
});

describe("optimal lineup", () => {
  const slots = startingSlots(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", "BN", "BN"]);

  it("fills every slot with the best eligible players, incl. QB in superflex", () => {
    const lu = optimalLineup(slots, Object.keys(players), val, players);
    expect(lu.assignment[slots.indexOf("SUPER_FLEX")]).toBe("qb2");
    expect(lu.assignment[slots.indexOf("FLEX")]).toBe("rb3"); // 11 > wr3 4, te2 3
    expect(lu.total).toBe(20 + 18 + 15 + 12 + 16 + 13 + 9 + 11 + 8 + 7);
  });

  it("leaves a slot empty rather than putting an ineligible player there", () => {
    const lu = optimalLineup(["QB", "K"], ["qb1", "qb2"], val, players);
    expect(lu.assignment).toEqual(["qb1", null]);
  });

  it("solves overlapping flex types exactly (greedy would fail)", () => {
    // W/R then W/T: greedy filling W/R first takes wr1 (16) and leaves W/T with te2 (3)
    // but optimal is W/R=rb1 (15), W/T=wr1 (16)
    const lu = optimalLineup(["WRRB_FLEX", "REC_FLEX"], ["wr1", "rb1", "te2"], val, players);
    expect(lu.total).toBe(31);
  });

  it("produces swaps", () => {
    const swaps = lineupSwaps(["qb1", "wr3"], ["qb1", "wr2"], val);
    expect(swaps).toEqual([{ startId: "wr2", benchId: "wr3", gain: 9 }]);
  });
});

describe("value", () => {
  const weeks: Matchup[][] = [
    [
      { roster_id: 1, matchup_id: 1, points: 100, starters: [], players: [], players_points: { wr1: 20, rb1: 0 } },
      { roster_id: 2, matchup_id: 1, points: 90, starters: [], players: [], players_points: {} },
      { roster_id: 3, matchup_id: 2, points: 80, starters: [], players: [], players_points: {} },
      { roster_id: 4, matchup_id: 2, points: 110, starters: [], players: [], players_points: {} },
    ],
    [
      { roster_id: 1, matchup_id: 1, points: 0, starters: [], players: [], players_points: { wr1: 10 } },
      { roster_id: 2, matchup_id: 1, points: 0, starters: [], players: [], players_points: {} },
    ],
  ];

  it("computes PPG skipping zero (bye) weeks", () => {
    const ppg = computePpg(weeks);
    expect(ppg.wr1).toEqual({ ppg: 15, games: 2, total: 30 });
    expect(ppg.rb1).toBeUndefined();
  });

  it("ignores bye-week 0 projections in ROS value", () => {
    expect(rosValue(0, { ppg: 14, games: 5, total: 70 })).toBe(14);
    expect(rosValue(20, { ppg: 10, games: 5, total: 50 })).toBe(13);
    expect(rosValue(12, undefined)).toBe(12);
  });

  it("computes all-play and skips unplayed weeks", () => {
    const ap = allPlayRecords(weeks);
    expect(ap[4]).toMatchObject({ wins: 3, losses: 0 });
    expect(ap[3]).toMatchObject({ wins: 0, losses: 3 });
  });

  const rosters = [
    { roster_id: 1, owner_id: "me", players: ["qb1", "rb1", "wr3", "te2"], starters: [], reserve: [], taxi: [], settings: { wins: 0, losses: 0, ties: 0 } },
    { roster_id: 2, owner_id: "them", players: ["qb2", "rb2", "wr1", "te1"], starters: [], reserve: [], taxi: [], settings: { wins: 0, losses: 0, ties: 0 } },
  ] as Roster[];
  const slots = ["QB", "RB", "WR", "TE", "FLEX"];

  it("sets replacement level to best non-starter at each position", () => {
    const repl = replacementLevels(rosters, slots, players, val);
    expect(repl.QB).toBe(0); // both QBs start
    expect(repl.WR).toBe(0);
  });

  it("evaluates a trade from both lineups", () => {
    const repl = replacementLevels(rosters, slots, players, val);
    const r = evaluateTrade({
      myIds: rosters[0].players!, theirIds: rosters[1].players!,
      give: ["te2"], get: ["te1"], slots, players, value: val, repl,
    });
    expect(r.me.delta).toBe(6);
    expect(r.them.delta).toBe(-6);
    expect(r.verdict).toMatch(/pushback/);
  });

  it("measures waiver pickup lineup gain", () => {
    expect(lineupGain(slots, rosters[0].players!, "wr2", val, players)).toBe(13 - 4 + 4); // wr2 starts at WR, wr3 moves to FLEX
  });
});

describe("swap pairing", () => {
  it("pairs same positions first", () => {
    const swaps = lineupSwaps(["wr3", "te2"], ["te1", "wr2"], val, players);
    expect(swaps).toEqual([
      { startId: "wr2", benchId: "wr3", gain: 9 },
      { startId: "te1", benchId: "te2", gain: 6 },
    ]);
  });
});

describe("playoff odds", () => {
  const rec = (rosterId: number, wins: number, losses: number, pf = 1000) => ({
    rosterId, wins, losses, ties: 0, pf,
  });
  const flat = (ids: number[], mean = 100) =>
    new Map(ids.map((id) => [id, { mean, sd: 25 }]));

  it("derives byes from the bracket size", () => {
    expect(byeCount(4)).toBe(0);
    expect(byeCount(6)).toBe(2);
    expect(byeCount(8)).toBe(0);
    expect(byeCount(12)).toBe(4);
  });

  it("reads the remaining schedule from future matchup pairings", () => {
    const weeks = [
      [{ roster_id: 1, matchup_id: 1 }, { roster_id: 2, matchup_id: 1 }],
      [{ roster_id: 1, matchup_id: 1 }, { roster_id: 2, matchup_id: 1 }],
      [{ roster_id: 1, matchup_id: null }, { roster_id: 2, matchup_id: null }],
    ];
    expect(remainingGames(weeks, 2, 3)).toEqual([{ week: 2, a: 1, b: 2 }]);
  });

  it("rebuilds standings as of an earlier week", () => {
    const weeks = [
      [
        { roster_id: 1, matchup_id: 1, points: 110 }, { roster_id: 2, matchup_id: 1, points: 100 },
      ],
      [
        { roster_id: 1, matchup_id: 1, points: 90 }, { roster_id: 2, matchup_id: 1, points: 95 },
      ],
      [{ roster_id: 1, matchup_id: 1, points: 0 }, { roster_id: 2, matchup_id: 1, points: 0 }], // unplayed
    ];
    expect(recordsThrough(weeks, 1)).toEqual([
      { rosterId: 1, wins: 1, losses: 0, ties: 0, pf: 110, pa: 100 },
      { rosterId: 2, wins: 0, losses: 1, ties: 0, pf: 100, pa: 110 },
    ]);
    // the unplayed week must not hand out losses
    expect(recordsThrough(weeks, 3)).toEqual([
      { rosterId: 1, wins: 1, losses: 1, ties: 0, pf: 200, pa: 195 },
      { rosterId: 2, wins: 1, losses: 1, ties: 0, pf: 195, pa: 200 },
    ]);
  });

  it("shrinks a small sample toward the league mean", () => {
    const hot = teamStrength([140, 140], undefined, 100);
    expect(hot.mean).toBeGreaterThan(100);
    expect(hot.mean).toBeLessThan(120); // not taken at face value
    expect(teamStrength([], undefined, 100)).toEqual({ mean: 100, sd: DEFAULT_SD });
  });

  it("gives equal teams equal odds and sums seeds to one", () => {
    const ids = [1, 2, 3, 4];
    const odds = simulate({
      records: ids.map((id) => rec(id, 0, 0)),
      games: [
        { week: 1, a: 1, b: 2 }, { week: 1, a: 3, b: 4 },
        { week: 2, a: 1, b: 3 }, { week: 2, a: 2, b: 4 },
      ],
      strength: flat(ids),
      playoffTeams: 2,
      sims: 4000,
    });
    for (const o of odds) {
      expect(o.playoff).toBeGreaterThan(0.4);
      expect(o.playoff).toBeLessThan(0.6);
      expect(o.seedDist.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 6);
    }
    expect(odds.reduce((s, o) => s + o.playoff, 0)).toBeCloseTo(2, 6); // 2 spots, always filled
  });

  it("favors the stronger team", () => {
    const odds = simulate({
      records: [rec(1, 0, 0), rec(2, 0, 0)],
      games: [{ week: 1, a: 1, b: 2 }],
      strength: new Map([[1, { mean: 130, sd: 20 }], [2, { mean: 90, sd: 20 }]]),
      playoffTeams: 1,
      sims: 4000,
    });
    expect(odds.find((o) => o.rosterId === 1)!.playoff).toBeGreaterThan(0.8);
  });

  describe("mathematical clinching", () => {
    it("clinches a spot no tiebreaker can take away", () => {
      // 3 teams, 1 playoff spot, one game left between #2 and #3.
      // Team 1 is 3-0, the others can finish 1-2 at best → team 1 is in.
      const { teams: state } = clinchStatus({
        records: [rec(1, 3, 0), rec(2, 0, 3), rec(3, 0, 3)],
        games: [{ week: 4, a: 2, b: 3 }],
        playoffTeams: 1,
        byes: 0,
      });
      expect(state!.get(1)!.state).toBe("clinched");
      expect(state!.get(2)!.state).toBe("eliminated");
      expect(state!.get(3)!.state).toBe("eliminated");
    });

    it("does not call a spot clinched when a tie at the cut line is possible", () => {
      // Team 1 (2-1) is passed on wins by nobody, but team 2 can tie it at 2-2
      // and the tiebreaker is not modeled → still alive, not clinched.
      const { teams: state } = clinchStatus({
        records: [rec(1, 2, 1), rec(2, 1, 2), rec(3, 0, 3)],
        games: [{ week: 4, a: 2, b: 3 }],
        playoffTeams: 1,
        byes: 0,
      });
      expect(state!.get(1)!.state).toBe("alive");
      expect(state!.get(2)!.state).toBe("alive");
      expect(state!.get(3)!.state).toBe("eliminated");
    });

    it("clinches a bye separately from a spot", () => {
      // 4 teams, 2 make it, top 1 gets a bye. Team 1 at 4-0 with one game left
      // among the others cannot be caught at all.
      const { teams: state } = clinchStatus({
        records: [rec(1, 4, 0), rec(2, 1, 3), rec(3, 1, 3), rec(4, 0, 4)],
        games: [{ week: 5, a: 2, b: 3 }],
        playoffTeams: 2,
        byes: 1,
      });
      expect(state!.get(1)!.state).toBe("clinched-bye");
      expect(state!.get(4)!.state).toBe("eliminated");
    });

    it("settles ties on points-for once the season is over", () => {
      const { teams: state } = clinchStatus({
        records: [rec(1, 2, 1, 1200), rec(2, 2, 1, 1100), rec(3, 2, 1, 900)],
        games: [],
        playoffTeams: 2,
        byes: 0,
      });
      expect(state!.get(1)!.state).toBe("clinched");
      expect(state!.get(2)!.state).toBe("clinched");
      expect(state!.get(3)!.state).toBe("eliminated");
    });

    it("agrees with the simulation at the extremes", () => {
      const records = [rec(1, 5, 0), rec(2, 4, 1), rec(3, 1, 4), rec(4, 0, 5)];
      const games = [{ week: 6, a: 1, b: 2 }, { week: 6, a: 3, b: 4 }];
      const common = { records, games, playoffTeams: 2, byes: 0 };
      const { teams: state } = clinchStatus(common);
      const odds = simulate({ ...common, strength: flat([1, 2, 3, 4]), sims: 4000 });
      for (const o of odds) {
        if (state!.get(o.rosterId)!.state === "clinched") expect(o.playoff).toBe(1);
        if (state!.get(o.rosterId)!.state === "eliminated") expect(o.playoff).toBe(0);
      }
    });

    it("bails out instead of enumerating an impossible number of scenarios", () => {
      const weeks = Math.log2(MAX_ENUMERATED_SCENARIOS) + 1;
      const games = Array.from({ length: weeks }, (_, i) => ({ week: i + 1, a: 1, b: 2 }));
      const r = clinchStatus({ records: [rec(1, 0, 0), rec(2, 0, 0)], games, playoffTeams: 1 });
      expect(r.teams).toBeNull();
      expect(r.needed).toBeGreaterThan(MAX_ENUMERATED_SCENARIOS);
    });
    it("says how many wins clinch a spot and how many keep a path open", () => {
      // 4 teams, 2 spots, everyone has 2 games left against the bottom two.
      const records = [rec(1, 3, 1), rec(2, 3, 1), rec(3, 1, 3), rec(4, 1, 3)];
      const games = [
        { week: 5, a: 1, b: 3 }, { week: 5, a: 2, b: 4 },
        { week: 6, a: 1, b: 4 }, { week: 6, a: 2, b: 3 },
      ];
      const { teams } = clinchStatus({ records, games, playoffTeams: 2, byes: 0 });
      const t1 = teams!.get(1)!;
      expect(t1.remaining).toBe(2);
      // One win puts it at 4-2, out of reach of the 1-3 teams (3-3 at best).
      // Going 0-2 would leave it tied at 3-3 and dependent on a tiebreaker.
      expect(t1.clinchWins).toBe(1);
      // Team 3 is 1-3 with 2 left: even 3-3 only ties, so no path is guaranteed,
      // but it must win both to have any chance at all.
      const t3 = teams!.get(3)!;
      expect(t3.state).toBe("alive");
      expect(t3.mustWin).toBe(2);
      expect(t3.clinchWins).toBeNull();
    });
  });
});

describe("playoff odds, whole-league pipeline", () => {
  // 10 teams, weeks 1-10 played, 11-14 scheduled: a real league's shape.
  const N = 10, PLAYED = 10, LAST = 14;
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const weeks: Matchup[][] = [];
  for (let w = 1; w <= LAST; w++) {
    const order = Array.from({ length: N }, (_, i) => i + 1).sort(() => rand() - 0.5);
    weeks.push(
      order.map((rid, i) => ({
        roster_id: rid,
        matchup_id: Math.floor(i / 2) + 1,
        points: w <= PLAYED ? +(70 + rand() * 70 + rid * 2).toFixed(1) : 0,
        starters: [],
        players: [],
      })),
    );
  }

  const records = recordsThrough(weeks, PLAYED);
  const games = remainingGames(weeks, PLAYED + 1, LAST);
  const scores = weeklyScores(weeks, PLAYED);
  const allScores = [...scores.values()].flat();
  const leagueMean = allScores.reduce((s, x) => s + x, 0) / allScores.length;
  const strength = new Map(
    records.map((r) => [r.rosterId, teamStrength(scores.get(r.rosterId) ?? [], undefined, leagueMean)]),
  );
  const playoffTeams = 6;
  const byes = byeCount(playoffTeams);

  it("reads the played weeks and the remaining schedule apart", () => {
    expect(records).toHaveLength(N);
    expect(records.every((r) => r.wins + r.losses + r.ties === PLAYED)).toBe(true);
    expect(games).toHaveLength(((LAST - PLAYED) * N) / 2);
    expect(games.every((g) => g.week > PLAYED && g.week <= LAST)).toBe(true);
  });

  it("hands out exactly the available spots, byes and seeds", () => {
    const odds = simulate({ records, games, strength, playoffTeams, byes, sims: 5000 });
    expect(odds.reduce((s, o) => s + o.playoff, 0)).toBeCloseTo(playoffTeams, 5);
    expect(odds.reduce((s, o) => s + o.bye, 0)).toBeCloseTo(byes, 5);
    expect(odds.reduce((s, o) => s + o.topSeed, 0)).toBeCloseTo(1, 5);
    for (let seedIdx = 0; seedIdx < N; seedIdx++) {
      expect(odds.reduce((acc, o) => acc + o.seedDist[seedIdx], 0)).toBeCloseTo(1, 5);
    }
    for (const o of odds) {
      expect(o.expectedWins).toBeGreaterThanOrEqual(0);
      expect(o.expectedWins).toBeLessThanOrEqual(LAST);
      expect(o.avgSeed).toBeGreaterThan(0);
      expect(o.avgSeed).toBeLessThanOrEqual(N);
    }
  });

  it("enumerates a full 4-week slate and never contradicts the simulation", () => {
    const c = clinchStatus({ records, games, playoffTeams, byes });
    expect(c.scenarios).toBe(2 ** 20); // the cap, exercised end to end
    const odds = simulate({ records, games, strength, playoffTeams, byes, sims: 5000 });
    for (const o of odds) {
      const t = c.teams!.get(o.rosterId)!;
      expect(t.remaining).toBe(LAST - PLAYED);
      // a proof and a probability must agree at the extremes
      if (t.state === "clinched" || t.state === "clinched-bye") expect(o.playoff).toBe(1);
      if (t.state === "eliminated") expect(o.playoff).toBe(0);
      if (t.clinchWins !== null) expect(t.clinchWins).toBeLessThanOrEqual(t.remaining);
    }
  });
});

describe("division seeding", () => {
  const rec = (rosterId: number, wins: number, losses: number, pf = 1000) => ({
    rosterId, wins, losses, ties: 0, pf,
  });
  // 1,2,3 in division A; 4,5,6 in division B
  const divs = new Map([[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 2]]);
  const flat = (ids: number[]) => new Map(ids.map((id) => [id, { mean: 100, sd: 25 }]));

  it("puts a weak division winner ahead of a better non-winner", () => {
    const scores = new Map([
      [1, { score: 12, pf: 1200 }], // A, best record overall
      [2, { score: 10, pf: 1150 }], // A, second best record overall, no crown
      [3, { score: 2, pf: 900 }],
      [4, { score: 6, pf: 1000 }], // B winner on a losing record
      [5, { score: 4, pf: 950 }],
      [6, { score: 4, pf: 940 }],
    ]);
    expect(seedOrder(scores)).toEqual([1, 2, 4, 5, 6, 3]); // no divisions
    expect(seedOrder(scores, divs)).toEqual([1, 4, 2, 5, 6, 3]); // 4 jumps 2
  });

  it("gives the division crown to the better record, points-for breaking ties", () => {
    const scores = new Map([
      [1, { score: 8, pf: 1000 }], [2, { score: 8, pf: 1100 }], [3, { score: 0, pf: 800 }],
      [4, { score: 6, pf: 900 }], [5, { score: 2, pf: 850 }], [6, { score: 2, pf: 840 }],
    ]);
    // tied at 8 in A, team 2 wins the crown on points
    expect(seedOrder(scores, divs).slice(0, 2)) .toEqual([2, 4]);
  });

  it("hands out one bye per division winner in the simulation", () => {
    // 1 leads division A by two games and does NOT play 2 again, so the crown is safe
    const records = [rec(1, 6, 0), rec(2, 4, 2), rec(3, 0, 6), rec(4, 1, 5), rec(5, 1, 5), rec(6, 1, 5)];
    const games = [
      { week: 7, a: 1, b: 4 }, { week: 7, a: 2, b: 5 }, { week: 7, a: 3, b: 6 },
    ];
    const odds = simulate({ records, games, strength: flat([1, 2, 3, 4, 5, 6]), playoffTeams: 4, byes: 2, divisions: divs, sims: 4000 });
    const byId = new Map(odds.map((o) => [o.rosterId, o]));
    // team 2 has the second-best record but is stuck behind team 1 in division A,
    // so its bye odds collapse: the other bye belongs to whoever wins division B.
    expect(byId.get(1)!.bye).toBeGreaterThan(0.9);
    expect(byId.get(2)!.bye).toBe(0); // both byes go to division winners, and 2 cannot be one
    expect(odds.reduce((s, o) => s + o.bye, 0)).toBeCloseTo(2, 5);
    // every division winner is a top-2 seed here, so B's winner gets a bye
    expect(byId.get(4)!.bye + byId.get(5)!.bye + byId.get(6)!.bye + byId.get(3)!.bye).toBeGreaterThan(0.85);
  });

  it("clinches a bye off a division crown that record alone would not earn", () => {
    // Team 4 leads a terrible division B by enough that nobody there can catch it.
    const records = [rec(1, 6, 0), rec(2, 5, 1), rec(3, 4, 2), rec(4, 3, 3), rec(5, 0, 6), rec(6, 0, 6)];
    const games = [{ week: 7, a: 5, b: 6 }]; // only B's bottom two still play
    const { teams } = clinchStatus({ records, games, playoffTeams: 4, byes: 2, divisions: divs });
    // 4 is locked into division B's crown, so a top-2 seed, despite 3-3 vs 5-1 and 4-2
    expect(teams!.get(4)!.state).toBe("clinched-bye");
    // team 1 owns division A outright
    expect(teams!.get(1)!.state).toBe("clinched-bye");
    // teams 2 and 3 have better records than 4 but cannot reach a bye
    expect(teams!.get(2)!.state).toBe("clinched");
    expect(teams!.get(3)!.state).toBe("clinched");
    // without divisions, 2 and 3 would be the ones holding byes
    const plain = clinchStatus({ records, games, playoffTeams: 4, byes: 2 });
    expect(plain.teams!.get(2)!.state).toBe("clinched-bye");
    expect(plain.teams!.get(4)!.state).toBe("clinched");
  });

  it("will not call a division crown clinched while a tie for it is possible", () => {
    // 4 is far enough clear that no tie on wins is possible for the top seed
    const records = [rec(1, 4, 2), rec(2, 4, 2), rec(3, 0, 6), rec(4, 6, 0), rec(5, 0, 6), rec(6, 0, 6)];
    const games = [{ week: 7, a: 1, b: 3 }, { week: 7, a: 2, b: 5 }];
    const { teams } = clinchStatus({ records, games, playoffTeams: 2, byes: 1, divisions: divs });
    // 1 and 2 can finish tied atop division A, so neither crown is locked
    expect(teams!.get(1)!.state).toBe("alive");
    expect(teams!.get(2)!.state).toBe("alive");
    // 4 owns division B no matter what, and with 2 playoff spots for 2 divisions it is in
    expect(teams!.get(4)!.state).toBe("clinched-bye");
    expect(teams!.get(3)!.state).toBe("eliminated");
  });

  it("keeps the proof and the probability consistent with divisions on", () => {
    const records = [rec(1, 5, 1), rec(2, 4, 2), rec(3, 2, 4), rec(4, 3, 3), rec(5, 3, 3), rec(6, 1, 5)];
    const games = [
      { week: 7, a: 1, b: 4 }, { week: 7, a: 2, b: 5 }, { week: 7, a: 3, b: 6 },
      { week: 8, a: 1, b: 2 }, { week: 8, a: 3, b: 4 }, { week: 8, a: 5, b: 6 },
    ];
    const common = { records, games, playoffTeams: 4, byes: 2, divisions: divs };
    const { teams } = clinchStatus(common);
    const odds = simulate({ ...common, strength: flat([1, 2, 3, 4, 5, 6]), sims: 6000 });
    for (const o of odds) {
      const t = teams!.get(o.rosterId)!;
      if (t.state === "clinched" || t.state === "clinched-bye") expect(o.playoff).toBe(1);
      if (t.state === "eliminated") expect(o.playoff).toBe(0);
      if (t.state === "clinched-bye") expect(o.bye).toBe(1);
    }
    expect(odds.reduce((s, o) => s + o.playoff, 0)).toBeCloseTo(4, 5);
    expect(odds.reduce((s, o) => s + o.bye, 0)).toBeCloseTo(2, 5);
  });
});

describe("median matches (Sleeper's league average match)", () => {
  const rec = (rosterId: number, wins: number, losses: number, pf = 1000) => ({
    rosterId, wins, losses, ties: 0, pf,
  });
  const N = 12;
  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const flat = new Map(ids.map((id) => [id, { mean: 110, sd: 25 }]));
  const slate = (week: number) =>
    Array.from({ length: N / 2 }, (_, i) => ({ week, a: ids[2 * i], b: ids[2 * i + 1] }));

  it("awards two results per team per week", () => {
    const records = ids.map((id) => rec(id, 0, 0));
    const games = [...slate(1), ...slate(2)];
    const base = records.reduce((s, r) => s + r.wins, 0);

    const med = simulate({ records, games, strength: flat, playoffTeams: 6, sims: 3000, medianMatch: true });
    // every week hands out N/2 head-to-head wins AND N/2 median wins
    expect(med.reduce((s, o) => s + o.expectedWins, 0)).toBeCloseTo(base + 2 * N, 4);

    const plain = simulate({ records, games, strength: flat, playoffTeams: 6, sims: 3000, medianMatch: false });
    expect(plain.reduce((s, o) => s + o.expectedWins, 0)).toBeCloseTo(base + 2 * (N / 2), 4);

    for (const o of med) {
      expect(o.expectedWins).toBeLessThanOrEqual(4); // 2 weeks x 2 results
      expect(o.expectedWins).toBeGreaterThan(0);
    }
  });

  it("rewards a high scorer that keeps losing head-to-head", () => {
    // Team 1 is the best scorer but is scheduled against team 2 every week.
    const records = ids.map((id) => rec(id, 0, 0));
    const strength = new Map(ids.map((id) => [id, { mean: id === 1 || id === 2 ? 150 : 100, sd: 10 }]));
    const games = [...slate(1), ...slate(2), ...slate(3)];
    const withMedian = simulate({ records, games, strength, playoffTeams: 6, sims: 4000, medianMatch: true });
    const without = simulate({ records, games, strength, playoffTeams: 6, sims: 4000, medianMatch: false });
    const w = (xs: typeof withMedian) => xs.find((o) => o.rosterId === 1)!.expectedWins;
    // head-to-head alone it wins ~half its games; the median game it wins nearly always
    expect(w(without)).toBeCloseTo(1.5, 0);
    expect(w(withMedian)).toBeGreaterThan(4); // ~1.5 + 3 median wins
  });

  it("enumerates a final median week exactly, and refuses two", () => {
    const records = ids.map((id) => rec(id, 9, 9));
    const one = clinchStatus({ records, games: slate(10), playoffTeams: 6, medianMatch: true });
    // 6 games x 2 outcomes, and exactly 6 of 12 teams clear the median
    expect(one.scenarios).toBe(9024);
    expect(one.teams).not.toBeNull();
    for (const t of one.teams!.values()) expect(t.remaining).toBe(2); // two results left

    const two = clinchStatus({ records, games: [...slate(10), ...slate(11)], playoffTeams: 6, medianMatch: true });
    expect(two.teams).toBeNull();
    expect(two.needed).toBe(9024 ** 2);
  });

  it("never lets the median game contradict the head-to-head result", () => {
    // A team that wins head-to-head outscored its opponent, so it can't be the
    // one below the median: (loser above, winner below) must never appear.
    const records = ids.map((id) => rec(id, 0, 0));
    const { teams } = clinchStatus({ records, games: slate(1), playoffTeams: 6, medianMatch: true });
    // the pair plays each other, so their combined haul is always exactly 3
    // (winner 2 + loser 1, or winner 2 + loser 0, or winner 1 + loser 0 → 3/2/1)
    for (const t of teams!.values()) {
      expect(t.remaining).toBe(2);
      expect(t.clinchWins === null || t.clinchWins <= 2).toBe(true);
    }
  });

  it("keeps the proof and the probability consistent with the median game on", () => {
    const records = [
      rec(1, 16, 2, 1308), rec(2, 14, 4, 1237), rec(3, 14, 4, 1251), rec(4, 13, 5, 1359),
      rec(5, 13, 5, 1324), rec(6, 8, 10, 1112), rec(7, 8, 10, 1072), rec(8, 5, 13, 1126),
      rec(9, 5, 13, 1075), rec(10, 5, 13, 958), rec(11, 4, 14, 1013), rec(12, 3, 15, 905),
    ];
    const games = slate(10);
    const common = { records, games, playoffTeams: 6, medianMatch: true };
    const { teams } = clinchStatus(common);
    const odds = simulate({ ...common, strength: flat, sims: 6000 });
    for (const o of odds) {
      const t = teams!.get(o.rosterId)!;
      if (t.state === "clinched" || t.state === "clinched-bye") expect(o.playoff).toBe(1);
      if (t.state === "eliminated") expect(o.playoff).toBe(0);
    }
    expect(odds.reduce((s, o) => s + o.playoff, 0)).toBeCloseTo(6, 5);
  });
});

describe("live standings", () => {
  const row = (roster_id: number, matchup_id: number, points: number) => ({ roster_id, matchup_id, points });
  // 4 teams: weeks 1-2 final, week 3 half-played, week 4 not started
  const weeks = [
    [row(1, 1, 120), row(2, 1, 100), row(3, 2, 90), row(4, 2, 110)],
    [row(1, 1, 80), row(2, 1, 95), row(3, 2, 130), row(4, 2, 70)],
    [row(1, 1, 60), row(2, 1, 0), row(3, 2, 115), row(4, 2, 0)], // in progress
    [row(1, 1, 0), row(2, 1, 0), row(3, 2, 0), row(4, 2, 0)], // not started
  ];

  it("classifies how far along each week is", () => {
    expect(weekPhase(weeks[0])).toBe("complete");
    expect(weekPhase(weeks[2])).toBe("partial");
    expect(weekPhase(weeks[3])).toBe("none");
    expect(weekPhase(undefined)).toBe("none");
  });

  it("counts finished weeks and refuses to count a half-played one", () => {
    const live = liveStandings(weeks, 4);
    expect(live.weeks).toEqual([1, 2]);
    expect(live.partialWeeks).toEqual([3]);
    // week 3 must not appear: team 2 and 4 simply haven't played yet
    // points against is the head-to-head opponent only, as Sleeper reports it
    expect(live.records).toEqual([
      { rosterId: 1, wins: 1, losses: 1, ties: 0, pf: 200, pa: 195 },
      { rosterId: 2, wins: 1, losses: 1, ties: 0, pf: 195, pa: 200 },
      { rosterId: 3, wins: 1, losses: 1, ties: 0, pf: 220, pa: 180 },
      { rosterId: 4, wins: 1, losses: 1, ties: 0, pf: 180, pa: 220 },
    ]);
  });

  it("adds the median game to live standings when the league plays one", () => {
    const live = liveStandings(weeks, 2, true);
    // week 1 scores 120/100/90/110 → median 105, so teams 1 and 4 clear it
    // week 2 scores 80/95/130/70  → median 87.5, so teams 2 and 3 clear it
    expect(live.records.map((r) => `${r.rosterId}:${r.wins}-${r.losses}`)).toEqual([
      "1:2-2", // W+above, L+below
      "2:2-2", // L+below, W+above
      "3:2-2", // L+below, W+above
      "4:2-2", // W+above, L+below
    ]);
    // two results per team per week
    for (const r of live.records) expect(r.wins + r.losses + r.ties).toBe(4);
    // the median game must not inflate points against
    expect(live.records.find((r) => r.rosterId === 1)!.pa).toBe(195);
  });

  it("counts a finished week that Sleeper hasn't scored yet", () => {
    const done = weeks.map((w, i) => (i === 2 ? [row(1, 1, 60), row(2, 1, 125), row(3, 2, 115), row(4, 2, 99)] : w));
    const live = liveStandings(done, 4);
    expect(live.weeks).toEqual([1, 2, 3]); // ahead of a Sleeper that still says 2
    expect(live.partialWeeks).toEqual([]);
    expect(live.records.find((r) => r.rosterId === 2)!.wins).toBe(2);
  });

  it("flags teams where our rules don't reproduce Sleeper's record", () => {
    const derived = [
      { rosterId: 1, wins: 2, losses: 0, ties: 0, pf: 100 },
      { rosterId: 2, wins: 0, losses: 2, ties: 0, pf: 90 },
    ];
    expect(reconcileRecords(derived, derived).ok).toBe(true);
    const official = [
      { rosterId: 1, wins: 2, losses: 0, ties: 0, pf: 100 },
      { rosterId: 2, wins: 1, losses: 1, ties: 0, pf: 90 }, // disagrees
    ];
    const r = reconcileRecords(derived, official);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([2]);
  });
});

describe("probability formatting", () => {
  it("never rounds a live race to a dead certainty, or back", () => {
    expect(pct(1)).toBe("100%");
    expect(pct(0.9999)).toBe("100%");
    expect(pct(0.996)).toBe("100%"); // >= 99.95 reads as 100
    expect(pct(0.994)).toBe("99%");
    expect(pct(0)).toBe("0%");
    expect(pct(0.0004)).toBe("<0.1%"); // alive, just barely
    expect(pct(0.004)).toBe("0.4%");
    expect(pct(0.034)).toBe("3.4%");
    expect(pct(0.08)).toBe("8%");
  });
});

describe("live standings vs Sleeper's reported record", () => {
  const row = (roster_id: number, matchup_id: number, points: number) => ({ roster_id, matchup_id, points });
  // week 1 scored by Sleeper, week 2 final but not yet scored by it
  const weeks = [
    [row(1, 1, 120), row(2, 1, 100)],
    [row(1, 1, 90), row(2, 1, 130)],
  ];
  const official = [
    { rosterId: 1, wins: 1, losses: 0, ties: 0, pf: 120, pa: 100 },
    { rosterId: 2, wins: 0, losses: 1, ties: 0, pf: 100, pa: 120 },
  ];

  it("runs ahead of Sleeper once a week is final, and still reconciles", () => {
    // what Sleeper has scored (week 1) must reproduce its record exactly
    expect(reconcileRecords(recordsThrough(weeks, 1), official).ok).toBe(true);

    // but the live standings include week 2, so they differ from Sleeper's
    const live = liveStandings(weeks, 2);
    expect(live.weeks).toEqual([1, 2]);
    const diff = reconcileRecords(live.records, official);
    expect(diff.ok).toBe(false);
    expect(diff.mismatches).toEqual([1, 2]); // this is what lights the live badge
    expect(live.records.map((r) => `${r.wins}-${r.losses}`)).toEqual(["1-1", "1-1"]);
  });

  it("agrees with Sleeper when there is nothing newer to count", () => {
    const live = liveStandings(weeks.slice(0, 1), 1);
    expect(reconcileRecords(live.records, official).ok).toBe(true); // badge stays hidden
  });
});

describe("scenario analysis", () => {
  const rec = (rosterId: number, wins: number, losses: number, pf = 1000) => ({
    rosterId, wins, losses, ties: 0, pf,
  });
  const N = 12;
  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const slate = (week: number) =>
    Array.from({ length: N / 2 }, (_, i) => ({ week, a: ids[2 * i], b: ids[2 * i + 1] }));
  const strength = new Map(ids.map((id) => [id, { mean: 110, sd: 25 }]));
  // a middling team, so there is something to actually say about it
  const records = ids.map((id) => rec(id, id <= 6 ? 12 : 8, id <= 6 ? 8 : 12, 1200 - id));
  const games = [...slate(10), ...slate(11)];
  const common = { records, games, strength, playoffTeams: 6, sims: 8000, medianMatch: true };

  it("splits the same simulated seasons by the team's own win total", () => {
    const a = scenarioAnalysis({ ...common, focus: 7 });
    expect(a.ownWins.length).toBeGreaterThan(1);
    // 2 weeks x 2 results a week
    expect(Math.max(...a.ownWins.map((r) => r.wins))).toBeLessThanOrEqual(4);
    // the splits must account for every simulated season
    expect(a.ownWins.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 6);
    // and must reconstruct the headline odds exactly
    const overall = a.odds.find((o) => o.rosterId === 7)!;
    expect(a.ownWins.reduce((s, r) => s + r.share * r.playoff, 0)).toBeCloseTo(overall.playoff, 6);
    expect(a.ownWins.reduce((s, r) => s + r.share * r.bye, 0)).toBeCloseTo(overall.bye, 6);
  });

  it("never says more wins are worse", () => {
    const a = scenarioAnalysis({ ...common, focus: 7 });
    const solid = a.ownWins.filter((r) => r.share > 0.02); // ignore the noisy tails
    for (let i = 1; i < solid.length; i++) {
      expect(solid[i].playoff).toBeGreaterThanOrEqual(solid[i - 1].playoff - 1e-9);
    }
  });

  it("values a team's own game above a stranger's", () => {
    const a = scenarioAnalysis({ ...common, focus: 7 });
    const own = a.leverage.filter((l) => l.own);
    expect(own).toHaveLength(2); // one per remaining week
    for (const l of own) expect(l.a === 7 || l.b === 7).toBe(true);
    // winning your own game helps you more than any single other result
    const others = a.leverage.filter((l) => !l.own);
    expect(Math.max(...own.map((l) => Math.abs(l.swing)))).toBeGreaterThan(
      Math.max(...others.map((l) => Math.abs(l.swing))),
    );
    // team 7 is the `a` side of its games, so winning them must help
    for (const l of own) expect(l.swing).toBeGreaterThan(0);
  });

  it("weights each game's two branches back to the overall odds", () => {
    const a = scenarioAnalysis({ ...common, focus: 7 });
    const overall = a.odds.find((o) => o.rosterId === 7)!.playoff;
    for (const l of a.leverage) {
      // P(in) = P(a wins)·P(in | a wins) + P(b wins)·P(in | b wins), and with
      // even strengths each branch is about half the seasons
      const mid = (l.ifA + l.ifB) / 2;
      expect(Math.abs(mid - overall)).toBeLessThan(0.06);
    }
  });

  it("reports rooting interest in another division's game", () => {
    const a = scenarioAnalysis({ ...common, focus: 7 });
    const other = a.leverage.find((l) => !l.own)!;
    // a game between two rivals has to move the needle in one direction or the
    // other, and the sign says which side to root for
    expect(Number.isFinite(other.swing)).toBe(true);
    expect(other.ifA).toBeGreaterThan(0);
    expect(other.ifB).toBeGreaterThan(0);
  });
});

/**
 * Independent check: walk every outcome a recipe allows and confirm the team
 * is always in. Seeding comes from `seedOrder` (tested on its own) with the
 * focus team given the worst points-for in the league, so it loses every tie
 * — the pessimistic case a recipe has to survive.
 */
function alwaysIn(opts: {
  records: TeamRecord[];
  games: { week: number; a: number; b: number }[];
  recipe: { wins: number; asks: { rosterId: number; losses: number }[] };
  focus: number;
  slots: number;
  divisions?: Map<number, number>;
  medianMatch?: boolean;
}) {
  const { records, games, recipe, focus, slots, divisions, medianMatch = false } = opts;
  const ids = records.map((r) => r.rosterId);
  const base = new Map(records.map((r) => [r.rosterId, 2 * r.wins + r.ties]));

  // per-week lists of {wins added per team}, mirroring the real outcome space
  const byWeek = new Map<number, typeof games>();
  for (const g of games) byWeek.set(g.week, [...(byWeek.get(g.week) ?? []), g]);
  const weekOpts: Map<number, number>[][] = [];
  for (const [, gs] of [...byWeek.entries()].sort((x, y) => x[0] - y[0])) {
    const out: Map<number, number>[] = [];
    const walk = (i: number, acc: Map<number, number>, aboveLeft: number) => {
      if (i === gs.length) {
        if (!medianMatch || aboveLeft === 0) out.push(new Map(acc));
        return;
      }
      for (const flip of [false, true]) {
        const w = flip ? gs[i].b : gs[i].a;
        const l = flip ? gs[i].a : gs[i].b;
        const choices = medianMatch ? [0, 1, 2].filter((m) => m <= aboveLeft) : [-1];
        for (const m of choices) {
          const next = new Map(acc);
          // without a median game: winner +1. with one: winner +1 or +2, loser +0 or +1,
          // and the winner can never be the one below the median
          next.set(w, (next.get(w) ?? 0) + (m === -1 ? 1 : m === 0 ? 1 : 2));
          next.set(l, (next.get(l) ?? 0) + (m === 2 ? 1 : 0));
          walk(i + 1, next, medianMatch ? aboveLeft - m : aboveLeft);
        }
      }
    };
    walk(0, new Map(), medianMatch ? gs.length : 0);
    weekOpts.push(out);
  }

  const total = weekOpts.reduce((s, o) => s * o.length, 1);
  let checked = 0;
  const digits = new Array(weekOpts.length).fill(0);
  for (let n = 0; n < total; n++) {
    const add = new Map<number, number>(ids.map((id) => [id, 0]));
    weekOpts.forEach((o, w) => {
      for (const [id, v] of o[digits[w]]) add.set(id, (add.get(id) ?? 0) + v);
    });

    const maxResults = weekOpts.length * (medianMatch ? 2 : 1);
    const ok =
      (add.get(focus) ?? 0) >= recipe.wins &&
      recipe.asks.every((a) => maxResults - (add.get(a.rosterId) ?? 0) >= a.losses);

    if (ok) {
      checked += 1;
      const scores = new Map(
        ids.map((id) => [id, { score: base.get(id)! + 2 * (add.get(id) ?? 0), pf: id === focus ? 0 : 1e6 }]),
      );
      const seed = seedOrder(scores, divisions).indexOf(focus);
      expect(seed).toBeLessThan(slots);
    }

    for (let w = weekOpts.length - 1; w >= 0; w--) {
      if (++digits[w] < weekOpts[w].length) break;
      digits[w] = 0;
    }
  }
  return checked;
}

describe("clinching recipes", () => {
  const rec = (rosterId: number, wins: number, losses: number, pf = 1000) => ({
    rosterId, wins, losses, ties: 0, pf,
  });


  /** the rung of the ladder that guarantees `slots` or better */
  const rung = (ladder: ReturnType<typeof clinchRecipes>, slots: number) =>
    ladder.find((t) => t.slots === slots)?.recipes ?? [];

  it("states a win total that needs no help, and it holds up", () => {
    // 6 teams, no divisions, 4 playoff spots, 3 weeks left
    const records = [rec(1, 6, 0), rec(2, 4, 2), rec(3, 4, 2), rec(4, 2, 4), rec(5, 2, 4), rec(6, 0, 6)];
    const games = [11, 12, 13].flatMap((week) => [
      { week, a: 1, b: 2 }, { week, a: 3, b: 4 }, { week, a: 5, b: 6 },
    ]);
    const playoff = rung(clinchRecipes({ records, games, playoffTeams: 4, byes: 0, focus: 3 }), 4);
    expect(playoff.length).toBeGreaterThan(0);
    const free = playoff.find((r) => r.asks.length === 0);
    expect(free).toBeDefined();
    expect(free!.remaining).toBe(3);
    for (const r of playoff) {
      const n = alwaysIn({ records, games, recipe: r, focus: 3, slots: 4 });
      expect(n).toBeGreaterThan(0); // the recipe is actually reachable
    }
  });

  it("names which rivals have to lose, and is right about it", () => {
    const records = [rec(1, 6, 0), rec(2, 5, 1), rec(3, 3, 3), rec(4, 3, 3), rec(5, 1, 5), rec(6, 1, 5)];
    const games = [11, 12].flatMap((week) => [
      { week, a: 1, b: 4 }, { week, a: 2, b: 5 }, { week, a: 3, b: 6 },
    ]);
    const playoff = rung(clinchRecipes({ records, games, playoffTeams: 3, byes: 0, focus: 3 }), 3);
    const withHelp = playoff.find((r) => r.asks.length > 0);
    expect(withHelp).toBeDefined();
    expect(withHelp!.asks.every((a) => a.losses >= 1 && a.rosterId !== 3)).toBe(true);
    for (const r of playoff) {
      expect(alwaysIn({ records, games, recipe: r, focus: 3, slots: 3 })).toBeGreaterThan(0);
    }
  });

  it("holds up with divisions and a median game in play", () => {
    const divisions = new Map([[1, 1], [2, 1], [3, 1], [4, 2], [5, 2], [6, 2]]);
    const records = [rec(1, 9, 3), rec(2, 8, 4), rec(3, 6, 6), rec(4, 9, 3), rec(5, 5, 7), rec(6, 3, 9)];
    const games = [{ week: 7, a: 1, b: 4 }, { week: 7, a: 2, b: 5 }, { week: 7, a: 3, b: 6 }];
    const common = { records, games, playoffTeams: 4, byes: 2, divisions, medianMatch: true };

    for (const focus of [1, 2, 3, 4]) {
      const ladder = clinchRecipes({ ...common, focus });
      const playoff = rung(ladder, 4);
      const bye = rung(ladder, 2);
      for (const r of playoff) {
        expect(alwaysIn({ records, games, recipe: r, focus, slots: 4, divisions, medianMatch: true })).toBeGreaterThan(0);
      }
      for (const r of bye) {
        expect(alwaysIn({ records, games, recipe: r, focus, slots: 2, divisions, medianMatch: true })).toBeGreaterThan(0);
      }
    }
  });

  it("asks a bye-chaser to win its division", () => {
    const divisions = new Map([[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3]]);
    // 3 divisions, 2 byes: a bye means winning your division and outranking a rival winner
    const records = [rec(1, 8, 2), rec(2, 7, 3), rec(3, 9, 1), rec(4, 2, 8), rec(5, 6, 4), rec(6, 3, 7)];
    const games = [{ week: 12, a: 1, b: 2 }, { week: 12, a: 3, b: 4 }, { week: 12, a: 5, b: 6 }];
    const bye = rung(clinchRecipes({ records, games, playoffTeams: 6, byes: 2, divisions, focus: 1 }), 2);
    for (const r of bye) {
      expect(r.route).toBe("division"); // with 3 divisions and 2 byes there is no wildcard bye
      expect(alwaysIn({ records, games, recipe: r, focus: 1, slots: 2, divisions })).toBeGreaterThan(0);
    }
  });

  it("offers nothing when the team is already eliminated", () => {
    const records = [rec(1, 10, 0), rec(2, 10, 0), rec(3, 10, 0), rec(4, 0, 10)];
    const games = [{ week: 11, a: 1, b: 4 }, { week: 11, a: 2, b: 3 }];
    const playoff = rung(clinchRecipes({ records, games, playoffTeams: 2, byes: 0, focus: 4 }), 2);
    expect(playoff).toHaveLength(0);
  });
});

describe("seeding ladder", () => {
  const rec = (rosterId: number, wins: number, losses: number, pf = 1000) => ({
    rosterId, wins, losses, ties: 0, pf,
  });
  const divisions = new Map([[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3]]);
  const records = [rec(1, 8, 2), rec(2, 7, 3), rec(3, 9, 1), rec(4, 2, 8), rec(5, 6, 4), rec(6, 3, 7)];
  const games = [{ week: 12, a: 1, b: 2 }, { week: 12, a: 3, b: 4 }, { week: 12, a: 5, b: 6 }];
  const common = { records, games, playoffTeams: 6, byes: 2, divisions, focus: 1 };

  it("solves a rung per threshold that carries a prize", () => {
    const ladder = clinchRecipes(common);
    // top seed, last bye, division-winner block, playoff cut
    expect(ladder.map((t) => t.slots)).toEqual([1, 2, 3, 6]);
    for (const t of ladder) for (const r of t.recipes) expect(r.slots).toBe(t.slots);
  });

  it("asks for at least as much the higher the seed", () => {
    const ladder = clinchRecipes(common);
    const cheapestAsk = (slots: number) => {
      const rs = ladder.find((t) => t.slots === slots)!.recipes;
      return rs.length === 0 ? Infinity : Math.min(...rs.map((r) => r.asks.reduce((s, a) => s + a.losses, 0) + r.wins));
    };
    // locking the top seed can never be easier than locking a spot
    expect(cheapestAsk(1)).toBeGreaterThanOrEqual(cheapestAsk(2));
    expect(cheapestAsk(2)).toBeGreaterThanOrEqual(cheapestAsk(6));
  });

  it("accepts explicit seed targets", () => {
    const ladder = clinchRecipes({ ...common, targets: [4] });
    expect(ladder.map((t) => t.slots)).toEqual([4]);
  });

  it("holds up at every rung", () => {
    for (const t of clinchRecipes(common)) {
      for (const r of t.recipes) {
        expect(
          alwaysIn({ records, games, recipe: r, focus: 1, slots: t.slots, divisions }),
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("theme preference", () => {
  const stub = (value: string | null) => {
    const store = new Map<string, string>();
    if (value !== null) store.set(THEME_KEY, value);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  };

  it("falls back to following the OS", () => {
    stub(null);
    expect(loadTheme()).toBe("system");
    stub("solarized"); // anything unrecognised
    expect(loadTheme()).toBe("system");
    stub("system");
    expect(loadTheme()).toBe("system");
  });

  it("remembers an explicit choice", () => {
    stub("dark");
    expect(loadTheme()).toBe("dark");
    stub("light");
    expect(loadTheme()).toBe("light");
  });

  it("resolves what's actually on screen", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light"); // an explicit pick beats the OS
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("flips away from whatever is showing, including under system", () => {
    // the toggle offers the opposite of the resolved theme, so a first click
    // while following a dark OS has to go to light, not to dark
    const next = (t: Parameters<typeof resolveTheme>[0], os: boolean) =>
      resolveTheme(t, os) === "dark" ? "light" : "dark";
    expect(next("system", true)).toBe("light");
    expect(next("system", false)).toBe("dark");
    expect(next("dark", false)).toBe("light");
    expect(next("light", true)).toBe("dark");
  });

  it("assumes light where matchMedia isn't available", () => {
    expect(prefersDark()).toBe(false); // no window in the test environment
  });

  it("survives storage being unavailable", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error("blocked");
      },
    };
    expect(loadTheme()).toBe("system");
  });
});

describe("theme tokens", () => {
  // A token defined for one theme but not the other falls back silently and
  // renders wrong, so the three scopes have to stay in lockstep.
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

  const blockAfter = (pattern: RegExp) => {
    const at = css.search(pattern);
    expect(at).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) break;
    }
    return css.slice(open, i);
  };
  const tokens = (text: string) => new Set([...text.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const light = tokens(blockAfter(/^:root \{/m));
  const osDark = tokens(blockAfter(/@media \(prefers-color-scheme: dark\)/));
  const pickedDark = tokens(blockAfter(/^:root\[data-theme="dark"\]/m));

  it("defines every token in all three scopes", () => {
    expect(light.size).toBeGreaterThan(20);
    expect([...light].filter((t) => !osDark.has(t))).toEqual([]);
    expect([...light].filter((t) => !pickedDark.has(t))).toEqual([]);
    // the OS block and the toggle block must not drift apart
    expect([...osDark].filter((t) => !pickedDark.has(t))).toEqual([]);
    expect([...pickedDark].filter((t) => !osDark.has(t))).toEqual([]);
  });

  it("lets a stamped theme beat the OS setting", () => {
    // the media query is guarded so an explicit light choice survives OS dark,
    // and :where() keeps it weak enough for the toggle to win
    expect(css).toMatch(/:root:where\(:not\(\[data-theme="light"\]\)\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
  });

  it("switches color-scheme so native controls follow", () => {
    expect(blockAfter(/^:root \{/m)).toContain("color-scheme: light");
    expect(blockAfter(/@media \(prefers-color-scheme: dark\)/)).toContain("color-scheme: dark");
    expect(blockAfter(/^:root\[data-theme="dark"\]/m)).toContain("color-scheme: dark");
  });

  it("swaps theme-dependent wording in both dark scopes", () => {
    // the heatmap ramp reverses per theme, so "darker = more likely" has to too
    expect(css).toMatch(/\.if-dark \{ display: none; \}/);
    expect(css).toMatch(/:root:where\(:not\(\[data-theme="light"\]\)\) \.if-light \{ display: none; \}/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \.if-light \{ display: none; \}/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \.if-dark \{ display: inline; \}/);
  });

  it("leaves no hard-coded colour outside the token blocks", () => {
    const withoutRoots = css
      .replace(blockAfter(/^:root \{/m), "")
      .replace(blockAfter(/@media \(prefers-color-scheme: dark\)/), "")
      .replace(blockAfter(/^:root\[data-theme="dark"\]/m), "");
    const leftovers = [...withoutRoots.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
    expect(leftovers).toEqual([]);
  });
});
