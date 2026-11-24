import { useState, type ReactNode } from "react";
import { avatarUrl, playerImg } from "../api/sleeper";
import type { Player } from "../api/types";
import { OUT_STATUSES } from "../lib/scoring";

export function PosBadge({ pos }: { pos: string }) {
  return <span className={`pos pos-${pos}`}>{pos}</span>;
}

export function InjuryTag({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const sev = OUT_STATUSES.has(status) ? "bad" : status === "Doubtful" ? "bad" : "warn";
  const short = { Questionable: "Q", Doubtful: "D", Out: "OUT" }[status] ?? status;
  return (
    <span className={`tag tag-${sev}`} title={status}>
      {short}
    </span>
  );
}

export function PlayerChip({ player, sub }: { player: Player | undefined; sub?: ReactNode }) {
  const [imgOk, setImgOk] = useState(true);
  if (!player) return <span className="muted">Empty</span>;
  return (
    <span className="player">
      {imgOk ? (
        <img className="headshot" src={playerImg(player)} alt="" loading="lazy" onError={() => setImgOk(false)} />
      ) : (
        <span className="headshot placeholder" />
      )}
      <span className="player-text">
        <span className="player-name">
          {player.name} <InjuryTag status={player.injury_status} />
        </span>
        <span className="player-sub">
          <PosBadge pos={player.position} /> {player.team ?? "FA"} {sub}
        </span>
      </span>
    </span>
  );
}

/**
 * Shown when our standings run ahead of Sleeper's. The dot pulses to say
 * "newer than the app you'd compare this to", and it never carries the meaning
 * alone — the words are always there, and the animation drops out under
 * prefers-reduced-motion.
 */
export function LiveBadge({ weeks }: { weeks: number[] }) {
  const which =
    weeks.length === 0
      ? "Counted from the weekly scores."
      : `Week ${weeks.join(", ")} ${weeks.length === 1 ? "is" : "are"} final here but not yet scored by Sleeper, so these records run ahead of its standings page.`;
  return (
    <span className="live-badge" title={which}>
      <span className="live-dot" aria-hidden="true" />
      Live standings
    </span>
  );
}

/**
 * Wording that depends on which theme is on screen. The sequential ramp runs in
 * opposite directions per theme, so "darker = more likely" is backwards in dark
 * mode. CSS picks the phrasing, which keeps this correct before any JS runs;
 * the hidden half is `display: none`, so screen readers only ever get one.
 */
export function ByTheme({ light, dark }: { light: ReactNode; dark: ReactNode }) {
  return (
    <>
      <span className="if-light">{light}</span>
      <span className="if-dark">{dark}</span>
    </>
  );
}

export function Avatar({ id, size = 28 }: { id: string | null | undefined; size?: number }) {
  const src = avatarUrl(id);
  return src ? (
    <img className="avatar" src={src} width={size} height={size} alt="" />
  ) : (
    <span className="avatar placeholder" style={{ width: size, height: size }} />
  );
}

export function Card({
  title,
  right,
  zone = "ink",
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  zone?: "ink" | "green" | "yellow" | "blue" | "red";
  children: ReactNode;
}) {
  return (
    <section className={`card zone-${zone}`}>
      <header className="card-head">
        <h2>{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "–");
export const signed = (n: number) => `${n > 0 ? "+" : ""}${fmt(n)}`;
