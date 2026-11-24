import { useEffect, useState } from "react";
import { applyTheme, loadTheme, prefersDark, resolveTheme, type Theme } from "../state/theme";

const ICON = { width: 17, height: 17, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" } as const;

function SunIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2.3v1.7M10 16v1.7M2.3 10H4M16 10h1.7M4.6 4.6l1.2 1.2M14.2 14.2l1.2 1.2M15.4 4.6l-1.2 1.2M5.8 14.2l-1.2 1.2" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON} strokeLinejoin="round" aria-hidden="true">
      <path d="M16.3 12.5A7.1 7.1 0 0 1 7.5 3.7a7.1 7.1 0 1 0 8.8 8.8Z" />
    </svg>
  );
}

/**
 * One button, two states. The icon shows what you'd switch *to*, and the label
 * says so out loud — an icon alone can't tell you which way it goes.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [osDark, setOsDark] = useState(prefersDark);

  // Keep the icon honest while we're still following the OS.
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const next = resolveTheme(theme, osDark) === "dark" ? "light" : "dark";
  const label = `Switch to ${next} mode`;

  return (
    <button
      className="ghost icon-btn"
      onClick={() => {
        setTheme(next);
        applyTheme(next);
      }}
      aria-label={label}
      title={label}
    >
      {next === "dark" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
