import { useState, type ReactNode } from "react";
import { pct } from "../lib/format";

/**
 * Hover layer shared by the charts. The tooltip is position:fixed so it escapes
 * the cards' `overflow-x: auto` instead of being clipped by it.
 */
function useChartTip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const bind = (content: ReactNode) => ({
    onMouseEnter: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onMouseLeave: () => setTip(null),
  });
  const node = tip ? (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  ) : null;
  return { bind, node };
}

export { pct } from "../lib/format";

// ---------- clinch badges ----------
/**
 * Status always ships as icon + word, never color alone — the colors here are
 * the app's status palette and a few of them are intentionally low-contrast.
 */
export function ClinchBadge({ state, short = false }: { state: string | undefined; short?: boolean }) {
  if (state === "clinched-bye")
    return <span className="tag tag-good" title="Mathematically guaranteed a first-round bye">✓ {short ? "Bye" : "Bye locked"}</span>;
  if (state === "clinched")
    return <span className="tag tag-good" title="Mathematically guaranteed a playoff spot">✓ {short ? "In" : "Clinched"}</span>;
  if (state === "eliminated")
    return <span className="tag tag-bad" title="Cannot reach a playoff spot in any remaining scenario">✕ {short ? "Out" : "Eliminated"}</span>;
  return null;
}

// ---------- 100% stacked odds bar ----------
/**
 * Part-to-whole of one team's 100% of outcomes: bye ⊂ playoff spot ⊂ everything.
 * Segments are separated by a 2px surface gap, never a stroke.
 */
export function OddsBar({ playoff, bye, label }: { playoff: number; bye: number; label?: string }) {
  const byeW = Math.max(0, Math.min(playoff, bye)) * 100;
  const inW = Math.max(0, playoff * 100 - byeW);
  return (
    <div className="oddsbar" role="img" aria-label={label ?? `${pct(playoff)} playoff odds`}>
      {byeW > 0 && <div className="seg seg-bye" style={{ width: `${byeW}%` }} />}
      {inW > 0 && <div className="seg seg-in" style={{ width: `${inW}%` }} />}
    </div>
  );
}

export function OddsLegend({ byes }: { byes: number }) {
  return (
    <div className="chart-legend">
      {byes > 0 && (
        <span>
          <i className="key seg-bye" /> First-round bye
        </span>
      )}
      <span>
        <i className="key seg-in" /> {byes > 0 ? "Playoff spot, no bye" : "Playoff spot"}
      </span>
      <span>
        <i className="key key-track" /> Misses the playoffs
      </span>
    </div>
  );
}

// ---------- seed distribution heatmap ----------
/**
 * Sequential ramp, as step numbers rather than colors. CSS owns the actual
 * values so each theme can run the ramp in the direction that reads as "more"
 * on its own surface: light recedes toward white, dark recedes toward black.
 */
const STEPS = [0.005, 0.02, 0.05, 0.1, 0.2, 0.35, 0.6];

/** 0 = leave the cell at surface, 1..7 = ramp step. */
function rampStep(p: number): number {
  let step = 0;
  for (let i = 0; i < STEPS.length; i++) if (p >= STEPS[i]) step = i + 1;
  return step;
}

export interface HeatRow {
  key: number;
  label: string;
  avatar?: ReactNode;
  dist: number[];
  me?: boolean;
}

export function SeedHeatmap({
  rows,
  playoffTeams,
  byes,
}: {
  rows: HeatRow[];
  playoffTeams: number;
  byes: number;
}) {
  const { bind, node } = useChartTip();
  const seeds = rows[0]?.dist.length ?? 0;

  return (
    <div className="heatmap-wrap">
      <table className="heatmap">
        <thead>
          <tr>
            <th />
            {Array.from({ length: seeds }, (_, i) => (
              <th key={i} className={`num ${i + 1 === byes ? "cut-bye" : ""} ${i + 1 === playoffTeams ? "cut-in" : ""}`}>
                {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.me ? "me" : ""}>
              <th scope="row">
                <span className="team">
                  {r.avatar} {r.label}
                </span>
              </th>
              {r.dist.map((p, i) => {
                const step = rampStep(p);
                return (
                  <td
                    key={i}
                    className={`cell ${step ? `s${step}` : ""} ${i + 1 === byes ? "cut-bye" : ""} ${i + 1 === playoffTeams ? "cut-in" : ""}`}
                    {...bind(
                      <>
                        <strong>{r.label}</strong>
                        <br />
                        Seed {i + 1}: {pct(p)}
                      </>,
                    )}
                  >
                    {/* label selectively: only where the number is both meaningful and fits */}
                    {p >= 0.1 ? Math.round(p * 100) : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {node}
    </div>
  );
}

// ---------- odds history, as small multiples ----------
/**
 * One sparkline per team rather than a dozen lines in one frame: a 10-team
 * league is well past the point where categorical colors can tell series apart.
 */
export function OddsSparkline({ series, weeks, me }: { series: number[]; weeks: number[]; me?: boolean }) {
  const { bind, node } = useChartTip();
  const W = 148;
  const H = 40;
  const n = series.length;
  if (n === 0) return null;

  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - 8) + 4);
  const y = (p: number) => H - 4 - p * (H - 8);
  const line = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${H - 4} L${x(0).toFixed(1)} ${H - 4} Z`;
  const stroke = me ? "var(--accent)" : "var(--seq-line)";

  return (
    <div className="spark">
      {/* scales uniformly so the 2px stroke stays 2px; the data itself lives in
          the odds table above, so the drawing is decorative to a screen reader */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} aria-hidden="true">
        <line x1="0" y1={H - 4} x2={W} y2={H - 4} stroke="var(--border)" strokeWidth="1" />
        <path d={area} fill={stroke} opacity="0.1" />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(n - 1)} cy={y(series[n - 1])} r="4" fill={stroke} stroke="var(--bg)" strokeWidth="2" />
        {/* invisible hit targets, wider than the marks */}
        {series.map((p, i) => (
          <rect
            key={i}
            x={x(i) - (W - 8) / (2 * Math.max(1, n - 1))}
            y="0"
            width={(W - 8) / Math.max(1, n - 1)}
            height={H}
            fill="transparent"
            {...bind(
              <>
                Week {weeks[i]}: <strong>{pct(p)}</strong>
              </>,
            )}
          />
        ))}
      </svg>
      {node}
    </div>
  );
}
