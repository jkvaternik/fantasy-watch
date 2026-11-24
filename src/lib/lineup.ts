import type { PlayersMap } from "../api/types";

/** Which positions may fill each Sleeper roster slot. */
export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

export const NON_STARTING = new Set(["BN", "IR", "TAXI"]);

export const slotLabel = (slot: string) =>
  ({ FLEX: "FLX", SUPER_FLEX: "SFLX", REC_FLEX: "RFLX", WRRB_FLEX: "W/R" })[slot] ?? slot;

/** Starting slots in league order (roster.starters aligns with this array). */
export const startingSlots = (rosterPositions: string[]) => rosterPositions.filter((s) => !NON_STARTING.has(s));

export function isEligible(slot: string, playerId: string, players: PlayersMap): boolean {
  const allowed = SLOT_ELIGIBILITY[slot];
  const p = players[playerId];
  if (!allowed || !p) return false;
  return p.fantasy_positions.some((fp) => allowed.includes(fp));
}

export interface LineupResult {
  slots: string[];
  /** player id per slot, or null for an empty slot */
  assignment: (string | null)[];
  total: number;
}

/**
 * Exact optimal lineup via the Hungarian algorithm (min-cost assignment).
 * Rows = slots, columns = candidate players + one "empty" dummy per slot.
 * Handles overlapping flex types (W/R + W/T + FLEX + SFLX) correctly, which greedy fill does not.
 */
export function optimalLineup(
  slots: string[],
  candidateIds: string[],
  points: (id: string) => number,
  players: PlayersMap,
): LineupResult {
  const ids = [...new Set(candidateIds)].filter((id) => players[id]);
  const n = slots.length;
  const m = ids.length + n; // add n empty-slot dummies so every slot can be filled
  const INF = 1e9;
  const BIG = 1e6;

  // cost[i][j], 1-indexed for the classic e-maxx Hungarian implementation
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (j <= ids.length) {
        const id = ids[j - 1];
        cost[i][j] = isEligible(slots[i - 1], id, players) ? -Math.max(0, points(id)) : BIG;
      } else {
        cost[i][j] = 0; // empty slot
      }
    }
  }

  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment: (string | null)[] = new Array(n).fill(null);
  for (let j = 1; j <= ids.length; j++) {
    if (p[j] > 0) assignment[p[j] - 1] = ids[j - 1];
  }
  const total = round1(assignment.reduce((s, id) => s + (id ? Math.max(0, points(id)) : 0), 0));
  return { slots, assignment, total };
}

export interface Swap {
  startId: string;
  benchId: string | null; // null = fills an empty slot
  gain: number;
}

/**
 * Turn current-vs-optimal into human "start X over Y" swaps.
 * Pairs same-position players first (RB for RB reads naturally), then whatever is left.
 */
export function lineupSwaps(
  current: (string | null)[],
  optimal: (string | null)[],
  points: (id: string) => number,
  players?: PlayersMap,
): Swap[] {
  const cur = new Set(current.filter(Boolean) as string[]);
  const opt = new Set(optimal.filter(Boolean) as string[]);
  const ins = [...opt].filter((id) => !cur.has(id)).sort((a, b) => points(b) - points(a));
  const outs = [...cur].filter((id) => !opt.has(id)).sort((a, b) => points(a) - points(b));
  const pos = (id: string) => players?.[id]?.position;

  const pairs = new Map<string, string | null>();
  for (const startId of ins) {
    const i = outs.findIndex((o) => pos(o) !== undefined && pos(o) === pos(startId));
    if (i >= 0) pairs.set(startId, outs.splice(i, 1)[0]);
  }
  for (const startId of ins) if (!pairs.has(startId)) pairs.set(startId, outs.shift() ?? null);

  return ins.map((startId) => {
    const benchId = pairs.get(startId) ?? null;
    return { startId, benchId, gain: round1(points(startId) - (benchId ? points(benchId) : 0)) };
  });
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
