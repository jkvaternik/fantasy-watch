import type { Player, ProjectionRow } from "../api/types";

/** Which preset projection total best matches the league's reception scoring. */
export function presetKey(scoring: Record<string, number>): "pts_ppr" | "pts_half_ppr" | "pts_std" {
  const rec = scoring.rec ?? 0;
  if (rec >= 0.75) return "pts_ppr";
  if (rec >= 0.25) return "pts_half_ppr";
  return "pts_std";
}

/**
 * Score a projected stat line with the league's own scoring_settings.
 * Projection stat keys (pass_yd, rush_td, rec, rec_yd, fgm_40_49 …) use the same names
 * as scoring_settings, so custom scoring (TE premium, 6pt pass TD, etc.) is respected.
 */
export function scoreStats(stats: Record<string, number>, scoring: Record<string, number>): number {
  let total = 0;
  for (const [key, mult] of Object.entries(scoring)) {
    const v = stats[key];
    if (typeof v === "number" && Number.isFinite(v)) total += v * mult;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Build player_id -> projected points for the week.
 * K/DEF use Sleeper's preset totals (bucketed points-allowed scoring isn't in the stat line);
 * skill positions use the league's scoring, falling back to the preset total.
 */
export function buildProjectionMap(
  rows: ProjectionRow[],
  scoring: Record<string, number>,
  players: Record<string, Player>,
): Record<string, number> {
  const preset = presetKey(scoring);
  const out: Record<string, number> = {};
  for (const r of rows) {
    const pos = players[r.player_id]?.position;
    const presetPts = r.stats[preset];
    let pts: number;
    if (pos === "K" || pos === "DEF") {
      pts = presetPts ?? scoreStats(r.stats, scoring);
    } else {
      const custom = scoreStats(r.stats, scoring);
      pts = custom > 0 ? custom : (presetPts ?? 0);
    }
    out[r.player_id] = Math.max(0, Math.round(pts * 10) / 10);
  }
  return out;
}

/** Statuses that mean "will not play". */
export const OUT_STATUSES = new Set(["Out", "IR", "PUP", "Sus", "NA", "COV", "DNR"]);

/** Discount expected points by injury designation for lineup decisions. */
export function injuryAdjusted(points: number, injury: string | null | undefined): number {
  if (!injury) return points;
  if (OUT_STATUSES.has(injury)) return 0;
  if (injury === "Doubtful") return points * 0.3;
  if (injury === "Questionable") return points * 0.9;
  return points;
}
