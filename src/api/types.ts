// Shapes returned by https://api.sleeper.app/v1 (only the fields this app uses).

export interface SleeperUser {
  user_id: string;
  username?: string;
  display_name: string;
  avatar: string | null;
  metadata?: { team_name?: string };
}

export interface League {
  league_id: string;
  name: string;
  season: string;
  status: string;
  total_rosters: number;
  roster_positions: string[]; // e.g. ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF","BN",...]
  scoring_settings: Record<string, number>;
  settings: {
    playoff_week_start?: number;
    playoff_teams?: number;
    divisions?: number;
    /** 1 = every team also plays the weekly league median ("league average match") */
    league_average_match?: number;
    /** last week Sleeper has officially scored */
    last_scored_leg?: number;
    start_week?: number;
    waiver_type?: number;
    [k: string]: unknown;
  };
  avatar?: string | null;
  /** Division names live here as division_1, division_2, … */
  metadata?: Record<string, string> | null;
}

export interface Roster {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null; // "0" means empty slot
  reserve: string[] | null; // IR
  taxi: string[] | null;
  settings: {
    wins: number;
    losses: number;
    ties: number;
    fpts?: number;
    fpts_decimal?: number;
    fpts_against?: number;
    fpts_against_decimal?: number;
    waiver_budget_used?: number;
    /** 1-based division, present only in leagues that use divisions */
    division?: number;
  };
}

export interface Matchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  starters: string[];
  players: string[];
  players_points?: Record<string, number>;
}

export interface Transaction {
  transaction_id: string;
  type: "trade" | "free_agent" | "waiver" | "commissioner";
  status: string;
  roster_ids: number[];
  adds: Record<string, number> | null; // player_id -> roster_id
  drops: Record<string, number> | null;
  created: number;
  leg: number;
  settings?: { waiver_bid?: number } | null;
}

export interface NflState {
  week: number;
  display_week?: number;
  season: string;
  season_type: "pre" | "regular" | "post" | "off";
  leg: number;
}

/** Slimmed player record we keep in cache (the raw /players/nfl payload is ~5 MB). */
export interface Player {
  player_id: string;
  name: string;
  position: string;
  fantasy_positions: string[];
  team: string | null;
  injury_status: string | null;
  status: string | null;
  age: number | null;
  years_exp: number | null;
  search_rank: number | null;
}

export type PlayersMap = Record<string, Player>;

export interface TrendingPlayer {
  player_id: string;
  count: number;
}

/** One row of the undocumented projections endpoint. */
export interface ProjectionRow {
  player_id: string;
  stats: Record<string, number>;
  opponent?: string | null;
  team?: string | null;
}
