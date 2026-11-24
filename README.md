# Fantasy Watch

A fantasy football dashboard for your Sleeper league: playoff odds, clinching scenarios, optimal lineups, waiver and trade analysis. Vite + React + TypeScript, client-only, reads from Sleeper's public read-only API. No keys, no backend.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests for the decision logic
npm run build      # static site in dist/, host anywhere (Vercel, Netlify, GitHub Pages)
```

**[Try the demo](https://jkvaternik.github.io/fantasy-watch/?demo)** — a fake 10-team league, no Sleeper account needed. Or run it locally and open `http://localhost:5173/?demo`.

Point it at your own league from the setup screen: enter your Sleeper username and pick the league. Everything stays in your browser.

## Features

| Page | What it does |
|---|---|
| **Dashboard** | **Live standings** (computed from the scores, so a finished week counts before Sleeper scores it), PF/PA, **all-play record** (how you'd do vs every team every week), power rank with lucky/unlucky tags, this week's matchups, last 2 weeks of transactions |
| **Playoffs** | **Playoff odds** from simulating the rest of the schedule, plus **exact** clinched / eliminated calls, **what has to happen** (your odds by your own win total, and which games to root for), each team's seed distribution, and how the race moved week by week |
| **Lineup** | Solves your **optimal lineup** for the week, lists exact "Start X over Y" moves with point gains, flags empty slots, OUT/IR/Doubtful/Questionable starters, and starters with no projection (bye/inactive) |
| **Waivers** | Trending adds + top projected free agents, ranked by how much each one improves **your** optimal lineup (this week and rest of season), with VOR and a suggested drop |
| **Trade** | Pick players on both sides → your and their starting-lineup change (pts/wk), net value over replacement, and a plain-English verdict |

Sleeper's API is read-only, so the app recommends moves and you make them in the Sleeper app.

## Architecture

```
src/
  api/
    sleeper.ts        typed fetch wrappers + memory/localStorage TTL cache
    types.ts          Sleeper response shapes
    demo.ts           ?demo fixture league (lazy-loaded, not in main bundle)
  lib/                pure functions, fully unit-tested
    scoring.ts        projected stats → points with YOUR league's scoring_settings; injury discounts
    lineup.ts         slot eligibility + exact optimal lineup (Hungarian algorithm) + swap suggestions
    value.ts          PPG, rest-of-season value, replacement level, VOR, all-play, trade + waiver math
    playoffs.ts       live standings, Monte Carlo playoff odds, exact clinch/elimination by enumeration
    format.ts         probability formatting
  state/
    LeagueContext.tsx loads everything once, exposes derived helpers (weekly(), ros(), repl…)
  pages/              Setup · Dashboard · Playoffs · Lineup · Waivers · Trade
  components/
    ui.tsx            PlayerChip, badges, cards, stats
    ThemeToggle.tsx   sun/moon button
    charts.tsx        odds bars, seed heatmap, sparklines, shared hover layer
  state/
    theme.ts          light / dark / follow-the-OS, persisted
```

**Data flow:** `LeagueContext` fetches league, rosters, users, NFL state, the player DB, every week's matchups through the end of the regular season (future weeks carry the pairings, which the playoff odds need) and this week's projections in parallel, then derives two value functions every page uses:

- `weekly(id)`: this week's projection, injury-adjusted (Out → 0, Doubtful ×0.3, Questionable ×0.9). Used for lineup and waiver decisions.
- `ros(id)`: rest-of-season points per game. It's 70% your league's actual PPG plus 30% projection, and it ignores 0-point bye projections. Used for trades.

### Playoff odds: two questions, two methods
*"What are my chances?"* is a probability and *"am I mathematically in?"* is a proof, so they're computed separately.

- **Odds** come from 20,000 Monte Carlo runs over the remaining schedule (Sleeper publishes future weeks' pairings, so the schedule is known). Each team's weekly score is drawn from a normal around its expected output — its own scoring average blended with its projected optimal lineup, shrunk toward the league mean when history is thin — with volatility from its own week-to-week spread. Seeds break on total points, Sleeper's default.
- **Standings are live, computed from the scores** (`liveStandings`), not read off Sleeper's reported record. A week counts the moment every game in it is final, so nothing sits stale waiting for Sleeper to score the week. They're computed **once in `LeagueContext`** and read by both the standings page and the playoff odds, so the two can't drift apart. When they run ahead of Sleeper, a pulsing green dot plus the words "Live standings" says so (the dot is never the only cue, and the animation drops out under `prefers-reduced-motion`).
- **Points against is head-to-head only**, matching Sleeper's `fpts_against` — the median opponent doesn't count toward PA even though it does count toward your record. Verified against the live API.
- A week that has *started but not finished* is deliberately excluded from the standings and simulated instead: half a week of scores would hand losses to teams whose players simply haven't played, and would drag the median down with them.
- **The derivation is cross-checked against Sleeper.** For every week Sleeper has officially scored, `reconcileRecords` requires our own standings to reproduce its W-L exactly. If they ever diverge, the league is using a rule this model doesn't know about, and the page says the numbers are unreliable instead of quietly publishing them.
- **Median matches are modeled.** With `league_average_match` on, every team plays twice a week: its head-to-head game and a second against the weekly league median, so records move two games a week. The simulation draws a whole week of scores at once, settles the head-to-head, then ranks that week to settle the median game — the two results are correlated by construction, which matters because a team that wins head-to-head cannot be the one below the median. (Mistaking those doubled results for doubled *weeks* runs the clock past the end of the regular season and collapses the odds to 100%/0%, which is why weeks are counted from the schedule, never inferred from the game count.)
- **Clinched / eliminated** are never read off the odds: 100% over 20k samples is not a proof. `clinchStatus` enumerates the remaining outcomes week by week — just the head-to-head winners normally, or the jointly feasible (winner, median-split) combinations in a median league, where exactly half the field clears the median each week — and reports a team as clinched only if it is in the field in *every* one. Tiebreakers are deliberately excluded, so a "clinched" call holds however ties break. The walk is capped at ~1M scenarios; past that the page says so rather than guessing. A median league costs 9,024 combinations **per week**, so exact calls arrive in the final week, which is the only time clinching is live anyway.
- The same enumeration yields each team's **clinch number** ("2 of 4 clinches") and whether any path is left at all.
- **"What would lock up each seed"** (`clinchRecipes`) states clinching as a sentence: *"win all 8, and the Buzzsaws lose 2 of 8 and the Mallards lose 1 of 8."* It solves a **ladder of seed thresholds**, since "clinch seed `s` or better" is one problem with `slots = s` — a playoff spot and a bye are just two rungs of it. The default rungs are the ones that carry a prize: the #1 seed, the last bye, the division-winner block, and the playoff cut. Each rung also shows the chance of landing there anyway, from the seed distribution. Enumeration is hopeless over a long schedule, so it reasons from **ceilings** instead — a rival that drops `l` of its remaining games can finish no higher than a known score, and if too few rivals can reach you, the spot is locked. Every rival is given its best case independently, so a recipe that passes holds for *every* real combination of results: it can ask for more than strictly necessary, never less. With divisions it costs out two routes (win the division, or be safe on the wildcard board) and quotes the cheaper; seeds inside the division-winner block are only reachable by winning the division, so those rungs say so. Tests verify soundness by brute-forcing every outcome a recipe allows and asserting the team is always in, with ties broken against it — at every rung of the ladder — plus that a higher seed never asks for less than a lower one.
- Recipes are **ordered by what they demand**, not by win total: "win 2 and you're in" is far more use than "lose out, and three teams collapse". A path that needs a rival to lose *every* game is flagged, and when those are the only ones available the page says a bye can't realistically be locked yet rather than printing advice nobody can act on.
- The whole card is **per team** — a picker switches focus, and only the focus-dependent work reruns, not the league-wide simulation or the week-by-week replay.
- **"What has to happen"** also answers the two softer questions, by re-reading the *same* simulated seasons rather than running more: split by your own win total ("go 6-2 and the bye is 51%"), and split by each remaining game's winner, which gives a rooting guide ranked by how far it moves your odds. `scenarioAnalysis` shares one engine with `simulate` via an observer hook, so the headline odds and the breakdown can never disagree — there are tests that the conditional rows reconstruct the headline number exactly, and that more wins never score worse.
- That breakdown follows **whichever race is still live**. A locked playoff spot makes every playoff swing zero, and an unreachable bye makes every bye swing zero just as flat, so it picks the measure that still moves and says plainly when nothing does. Those are frequencies, clearly separated from the ✓ marks, which are the only claims proven over every possible outcome.
- **Divisions are modeled.** When the league uses them (`settings.divisions` plus a `division` on every roster), each division winner is seeded ahead of every non-winner, so a division won on a losing record can outseed a better team and take a bye. Winning the division is itself a tiebreaker question, so the enumeration only treats a crown as locked once no tie for it is possible. Partial division data is ignored rather than half-applied.
- Seeding here is the **regular-season** seeding that sets the field and the entry seeds. Re-seeding inside the bracket doesn't affect who makes it or what seed they enter with, so it isn't modeled; it would matter only for championship odds.

### Dark mode
A sun/moon button in the top bar. The icon shows what you'd switch **to**, with an `aria-label` that says so, since a glyph alone can't tell you which way it goes. A tiny inline script in `index.html` stamps the stored choice on `<html>` before first paint, so a dark-mode reload never flashes white.

- **One button, but still three states.** Until you click, there's no stored preference and the app follows the OS — the toggle resolves the live `prefers-color-scheme` and offers the opposite, so the first click in a dark OS goes to *light*, not to dark. A `matchMedia` listener keeps the icon honest if the OS flips while you're following it. Clicking stamps an explicit choice that then wins over the OS both ways.

- **The dark theme is selected, not an inverted flip.** Every colour has its own value measured against the dark surface (`#101319`), and all ink and status tokens clear 4.5:1 on it.
- **Copy that describes colour switches with the theme.** The heatmap legend reads "darker = more likely" in light and "brighter = more likely" in dark, because the ramp genuinely reverses. `<ByTheme>` ships both phrasings and CSS picks one, so it is right before any JS runs and the hidden half is `display: none` — out of the accessibility tree, so a screen reader only ever gets the one that matches.
- **The sequential heatmap ramp runs in opposite directions per theme.** Steps are numbered "nearest the surface" → "most prominent", so light recedes toward white and dark recedes toward black; a near-zero cell always melts into the page rather than glowing. The ramp lives in CSS (`--seq-1…7`) and the chart emits a step number, so neither theme needs its own JS path.
- **Per-step label ink is computed, not guessed.** For each step the ink is whichever of the two inks measures higher contrast on that fill; the switch lands at step 5 in light and step 4 in dark, and the worst case is 4.5:1 (the old hard-coded split had a 3.6:1 cell).
- `color-scheme` flips with the theme so native controls (the selects) follow.
- Tests assert all three scopes define **every** token, that the two dark scopes don't drift apart, and that no hard-coded colour survives outside the token blocks — the failure mode of a retrofitted dark mode is one token silently falling back.

### Design decisions worth knowing
- **Optimal lineup uses the Hungarian algorithm, not a greedy fill.** With overlapping flex slots (W/R + W/T + FLEX + SUPER_FLEX), filling slots greedily can give a wrong answer. There's a test that shows a case where greedy fails.
- **Replacement level is derived from your league,** not hard-coded. The app solves every team's optimal lineup. A position's replacement level is the best player at that position who doesn't start for anyone, so flex usage and superflex are handled automatically.
- **Projections use an undocumented endpoint** (`api.sleeper.app/projections/nfl/{season}/{week}`). If it ever breaks, the app falls back to PPG and shows a banner.
- **Player DB is slimmed** to fantasy positions and needed fields, then cached for 24h in localStorage. Sleeper asks you to fetch `/players/nfl` at most once a day.
- Stays far under Sleeper's 1000 requests/minute limit, since one full load is about 20 requests.

## Roadmap

1. **AI assistant (next phase).** Add a tiny backend (e.g. a Vercel/Cloudflare function holding your Claude API key). Send it a compact JSON context: your roster with `weekly`/`ros`/injury status, the optimal lineup, top waiver targets and your opponent. Then ask things in plain English like *"who should I flex?"* or *"draft a trade offer to Team X"*. The rules engine stays the source of truth; the LLM explains and negotiates.
2. Opponent scouting: their projected lineup and win probability for the week.
3. Playoff odds for *individual games*: "this week's matchup is worth 18% of your playoff odds."
4. Trade finder: search every 1-for-1 and 2-for-1 that's a win-win by lineup delta.
5. Notifications: a scheduled job that checks your lineup Sunday morning and pings you if a starter is OUT.
