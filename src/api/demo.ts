/**
 * Demo mode: open the app with ?demo to use a fake 10-team league instead of api.sleeper.app.
 * Handy for UI work in the off-season or without a league.
 */
const TEAMS = ["KC", "BUF", "PHI", "SF", "DET", "BAL", "CIN", "MIA", "DAL", "LAR", "GB", "HOU", "MIN", "LAC", "SEA", "ATL"];
const FIRST = ["Jalen", "Marcus", "Tyler", "Chris", "Deon", "Amari", "Josh", "Kyle", "Travis", "Bijan", "Puka", "Sam", "Malik", "Drake", "Jaylen", "Zay"];
const LAST = ["Hart", "Mills", "Brooks", "Carter", "Reed", "Hayes", "Ward", "Price", "Bell", "Foster", "Grant", "Hill", "Lane", "Stone", "Wells", "Young"];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const counts = { QB: 32, RB: 60, WR: 80, TE: 32, K: 20, DEF: 16 };
const ceilings = { QB: 24, RB: 20, WR: 19, TE: 14, K: 10, DEF: 10 };
const players: Record<string, Record<string, unknown>> = {};
const proj: { player_id: string; stats: Record<string, number> }[] = [];
const ids: Record<string, string[]> = {};
let n = 1000;
for (const [pos, count] of Object.entries(counts)) {
  ids[pos] = [];
  for (let i = 0; i < count; i++) {
    const team = pos === "DEF" ? TEAMS[i] : pick(TEAMS);
    const id = pos === "DEF" ? team : String(n++);
    const injury = rand() < 0.08 ? pick(["Questionable", "Questionable", "Doubtful", "Out", "IR"]) : null;
    players[id] = {
      player_id: id, position: pos, fantasy_positions: [pos], team, injury_status: injury,
      first_name: pos === "DEF" ? team : pick(FIRST), last_name: pos === "DEF" ? "Defense" : pick(LAST),
      age: 22 + Math.floor(rand() * 10), years_exp: Math.floor(rand() * 8), search_rank: n,
    };
    if (pos !== "DEF") players[id].full_name = `${players[id].first_name} ${players[id].last_name}`;
    const ceiling = ceilings[pos as keyof typeof ceilings];
    const base = Math.max(1, ceiling * (1 - i / count) + (rand() - 0.5) * 4);
    const bye = rand() < 0.07;
    if (!bye) proj.push({ player_id: id, stats: { pts_ppr: +base.toFixed(1), pts_half_ppr: +(base * 0.93).toFixed(1), pts_std: +(base * 0.86).toFixed(1) } });
    ids[pos].push(id);
  }
}

const WEEK = 11;
const LAST_REG_WEEK = 14;
const roster_positions = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "K", "DEF", ...Array(6).fill("BN")];
const users = Array.from({ length: 10 }, (_, i) => ({
  user_id: `u${i + 1}`, display_name: i === 0 ? "demo_user" : `manager${i + 1}`, avatar: null,
  metadata: { team_name: ["Waiver Wire Warriors", "Bijan Mustard", "Puka Shells", "CeeDee's Nuts & Bolts", "Kittle Me This", "Mixon It Up", "Hurts So Good", "Lamb Chops", "Chase the Bag", "Diggs in a Blanket"][i] },
}));

// Snake-ish draft so rosters are realistic
const pool: Record<string, string[]> = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v]]));
const need = { QB: 2, RB: 5, WR: 6, TE: 2, K: 1, DEF: 1 };
const rosters = users.map((u, i) => ({
  roster_id: i + 1, owner_id: u.user_id, players: [] as string[], starters: [] as string[], reserve: [] as string[], taxi: [],
  settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_decimal: 0, fpts_against: 0, fpts_against_decimal: 0, division: i < 5 ? 1 : 2 },
}));
for (const [pos, k] of Object.entries(need)) {
  for (let round = 0; round < k; round++) {
    const order = round % 2 ? [...rosters].reverse() : rosters;
    for (const r of order) {
      // skip a few top players so the wire has talent
      if (rand() < 0.15) pool[pos].shift();
      const id = pool[pos].shift();
      if (id) r.players.push(id);
    }
  }
}
// Deliberately bad starters for the demo user so lineup advice shows up
const slotPos = roster_positions.filter((s) => s !== "BN");
for (const r of rosters) {
  const used = new Set<string>();
  r.starters = slotPos.map((slot) => {
    const flexMap: Record<string, string[]> = { FLEX: ["RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"] };
    const elig = flexMap[slot] ?? [slot];
    const cands = r.players.filter((id) => !used.has(id) && elig.includes(players[id].position as string));
    const choice = r.roster_id === 1 ? cands[cands.length - 1] : cands[0];
    if (choice) used.add(choice);
    return choice ?? "0";
  });
}

const projMap = Object.fromEntries(proj.map((p) => [p.player_id, p.stats.pts_ppr]));
const matchups: Record<number, unknown[]> = {};
// Weeks after WEEK are unplayed: pairings only, no points. That's what Sleeper
// returns for future weeks, and it's what the playoff odds read as "remaining".
for (let w = 1; w <= LAST_REG_WEEK; w++) {
  const pairs = [...rosters].sort(() => rand() - 0.5);
  const future = w > WEEK;
  matchups[w] = pairs.map((r, i) => {
    const pp: Record<string, number> = {};
    if (!future) for (const id of r.players) pp[id] = +Math.max(0, (projMap[id] ?? 6) * (0.4 + rand() * 1.2)).toFixed(1);
    const played = +r.starters.reduce((s, id) => s + (pp[id] ?? 0), 0).toFixed(1);
    const points = future ? 0 : w === WEEK ? +(rand() * 40).toFixed(1) : played;
    return { roster_id: r.roster_id, matchup_id: Math.floor(i / 2) + 1, points, starters: r.starters, players: r.players, players_points: future || w === WEEK ? {} : pp };
  });
  if (w >= WEEK) continue;
  for (let i = 0; i < pairs.length; i += 2) {
    const a = matchups[w][i] as { roster_id: number; points: number };
    const b = matchups[w][i + 1] as { roster_id: number; points: number };
    const ra = rosters[a.roster_id - 1].settings, rb = rosters[b.roster_id - 1].settings;
    if (a.points >= b.points) { ra.wins++; rb.losses++; } else { rb.wins++; ra.losses++; }
    ra.fpts += Math.floor(a.points); rb.fpts += Math.floor(b.points);
    ra.fpts_against += Math.floor(b.points); rb.fpts_against += Math.floor(a.points);
  }
}

const rostered = new Set(rosters.flatMap((r) => r.players));
const trending = Object.values(ids).flat().filter((id) => !rostered.has(id)).slice(0, 30)
  .map((id) => ({ player_id: id, count: Math.floor(rand() * 40000) })).sort((a, b) => b.count - a.count);

const league = {
  league_id: "demo", name: "Demo Dynasty League", season: "2026", status: "in_season", total_rosters: 10,
  roster_positions, scoring_settings: { rec: 1, rec_yd: 0.1, rush_yd: 0.1, pass_yd: 0.04, pass_td: 4 },
  settings: { playoff_week_start: 15, playoff_teams: 6, divisions: 2 }, avatar: null,
  metadata: { division_1: "North", division_2: "South" },
};
const tx = [
  { transaction_id: "t1", type: "trade", status: "complete", roster_ids: [2, 5], adds: { [rosters[1].players[3]]: 5, [rosters[4].players[4]]: 2 }, drops: null, created: Date.now() - 3e6, leg: WEEK },
  { transaction_id: "t2", type: "waiver", status: "complete", roster_ids: [3], adds: { [trending[5].player_id]: 3 }, drops: { [rosters[2].players[12]]: 3 }, created: Date.now() - 9e6, leg: WEEK, settings: { waiver_bid: 14 } },
];

function route(url: string): unknown {
  const u = new URL(url);
  const p = u.pathname;
  if (p === "/v1/state/nfl") return { week: WEEK, season: "2026", season_type: "regular", leg: WEEK };
  if (p.startsWith("/v1/user/") && p.includes("/leagues/")) return [league];
  if (p.startsWith("/v1/user/")) return { user_id: "u1", username: "demo_user", display_name: "demo_user", avatar: null };
  if (p === "/v1/players/nfl") return players;
  if (p.startsWith("/v1/players/nfl/trending")) return trending;
  if (p === "/v1/league/demo") return league;
  if (p === "/v1/league/demo/rosters") return rosters;
  if (p === "/v1/league/demo/users") return users;
  if (p.startsWith("/v1/league/demo/matchups/")) return matchups[Number(p.split("/").pop())] ?? [];
  if (p.startsWith("/v1/league/demo/transactions/")) return Number(p.split("/").pop()) === WEEK ? tx : [];
  if (p.startsWith("/projections/")) return proj;
  return null;
}

export function installDemo() {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("api.sleeper.app")) return real(input, init);
    await new Promise((r) => setTimeout(r, 120));
    return new Response(JSON.stringify(route(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("sleeper:")).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem("fantasy-watch:settings", JSON.stringify({ username: "demo_user", userId: "u1", leagueId: "demo" }));
  } catch { /* ignore */ }
}
