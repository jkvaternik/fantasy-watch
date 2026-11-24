import type {
  League,
  Matchup,
  NflState,
  Player,
  PlayersMap,
  ProjectionRow,
  Roster,
  SleeperUser,
  Transaction,
  TrendingPlayer,
} from "./types";

const BASE = "https://api.sleeper.app/v1";
// Undocumented: not in docs.sleeper.com, may change without notice.
const UNDOC = "https://api.sleeper.app";

export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

const ONE_DAY = 24 * 60 * 60 * 1000;

// ---------- tiny cache: in-memory + localStorage with TTL ----------
const mem = new Map<string, { at: number; data: unknown }>();

function readCache<T>(key: string, ttl: number): T | undefined {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  try {
    const raw = localStorage.getItem(`sleeper:${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (Date.now() - parsed.at < ttl) {
      mem.set(key, parsed);
      return parsed.data;
    }
  } catch {
    /* storage unavailable or corrupt: ignore */
  }
  return undefined;
}

function writeCache(key: string, data: unknown, persist: boolean) {
  const entry = { at: Date.now(), data };
  mem.set(key, entry);
  if (!persist) return;
  try {
    localStorage.setItem(`sleeper:${key}`, JSON.stringify(entry));
  } catch {
    /* quota exceeded: memory cache still works */
  }
}

async function get<T>(url: string, { ttl = 60_000, persist = false } = {}): Promise<T> {
  const cached = readCache<T>(url, ttl);
  if (cached !== undefined) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper ${res.status}: ${url}`);
  const data = (await res.json()) as T;
  writeCache(url, data, persist);
  return data;
}

// ---------- documented endpoints ----------
export const getUser = (usernameOrId: string) =>
  get<SleeperUser | null>(`${BASE}/user/${encodeURIComponent(usernameOrId)}`, { ttl: ONE_DAY, persist: true });

export const getNflState = () => get<NflState>(`${BASE}/state/nfl`, { ttl: 10 * 60_000 });

export const getUserLeagues = (userId: string, season: string) =>
  get<League[]>(`${BASE}/user/${userId}/leagues/nfl/${season}`, { ttl: 10 * 60_000 });

export const getLeague = (leagueId: string) => get<League>(`${BASE}/league/${leagueId}`);
export const getRosters = (leagueId: string) => get<Roster[]>(`${BASE}/league/${leagueId}/rosters`);
export const getLeagueUsers = (leagueId: string) => get<SleeperUser[]>(`${BASE}/league/${leagueId}/users`);

export const getMatchups = (leagueId: string, week: number) =>
  get<Matchup[]>(`${BASE}/league/${leagueId}/matchups/${week}`);

export const getTransactions = (leagueId: string, week: number) =>
  get<Transaction[]>(`${BASE}/league/${leagueId}/transactions/${week}`);

export const getTrending = (type: "add" | "drop", lookbackHours = 24, limit = 50) =>
  get<TrendingPlayer[]>(`${BASE}/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`, {
    ttl: 15 * 60_000,
  });

/**
 * Full player DB. Sleeper asks you to call this at most once a day.
 * We slim it to fantasy-relevant fields/positions so it fits in localStorage.
 */
export async function getPlayers(): Promise<PlayersMap> {
  const key = "players:slim";
  const cached = readCache<PlayersMap>(key, ONE_DAY);
  if (cached) return cached;

  const res = await fetch(`${BASE}/players/nfl`);
  if (!res.ok) throw new Error(`Sleeper ${res.status}: players`);
  const raw = (await res.json()) as Record<string, Record<string, unknown>>;
  const slim = slimPlayers(raw);
  writeCache(key, slim, true);
  return slim;
}

export function slimPlayers(raw: Record<string, Record<string, unknown>>): PlayersMap {
  const out: PlayersMap = {};
  const keep = new Set<string>(FANTASY_POSITIONS);
  for (const [id, p] of Object.entries(raw)) {
    const position = (p.position as string) ?? "";
    if (!keep.has(position)) continue;
    const name =
      position === "DEF"
        ? `${p.first_name ?? id} ${p.last_name ?? ""}`.trim()
        : ((p.full_name as string) ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim());
    out[id] = {
      player_id: id,
      name,
      position,
      fantasy_positions: (p.fantasy_positions as string[]) ?? [position],
      team: (p.team as string) ?? null,
      injury_status: (p.injury_status as string) ?? null,
      status: (p.status as string) ?? null,
      age: (p.age as number) ?? null,
      years_exp: (p.years_exp as number) ?? null,
      search_rank: (p.search_rank as number) ?? null,
    };
  }
  return out;
}

// ---------- undocumented endpoints (graceful failure) ----------
/** Weekly projections. Returns [] if the endpoint is unavailable. */
export async function getProjections(season: string, week: number): Promise<ProjectionRow[]> {
  const pos = FANTASY_POSITIONS.map((p) => `position[]=${p}`).join("&");
  const url = `${UNDOC}/projections/nfl/${season}/${week}?season_type=regular&${pos}`;
  try {
    const rows = await get<ProjectionRow[]>(url, { ttl: 30 * 60_000 });
    return Array.isArray(rows) ? rows.filter((r) => r && r.player_id && r.stats) : [];
  } catch (e) {
    console.warn("Projections unavailable, falling back to PPG", e);
    return [];
  }
}

// ---------- asset helpers ----------
export const avatarUrl = (avatar: string | null | undefined) =>
  avatar ? `https://sleepercdn.com/avatars/thumbs/${avatar}` : undefined;

export const playerImg = (p: Pick<Player, "player_id" | "position">) =>
  p.position === "DEF"
    ? `https://sleepercdn.com/images/team_logos/nfl/${p.player_id.toLowerCase()}.png`
    : `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`;
