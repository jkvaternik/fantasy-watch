import { useMemo, useState, type ReactNode } from "react";
import { ClinchBadge, OddsBar, OddsLegend, OddsSparkline, SeedHeatmap, pct } from "../components/charts";
import { Avatar, ByTheme, Card, LiveBadge, Stat, fmt } from "../components/ui";
import { optimalLineup } from "../lib/lineup";
import {
  byeCount,
  clinchStatus,
  recordsThrough,
  clinchRecipes,
  remainingGames,
  scenarioAnalysis,
  simulate,
  teamStrength,
  weeklyScores,
  type Leverage,
  type Recipe,
  type ScenarioAnalysis,
  type SeedTarget,
  type TeamClinch,
  type TeamOdds,
  type TeamRecord,
} from "../lib/playoffs";
import { useLeague } from "../state/LeagueContext";

/** The exact scenario count runs to 20 digits in a median league; keep it readable. */
function scenarioCount(n: number): string {
  if (!Number.isFinite(n)) return "too many combinations";
  if (n <= 1e7) return `${n.toLocaleString()} combinations`;
  if (n >= 1e15) return `over a quadrillion combinations`;
  return `about ${n.toExponential(1).replace("e+", " × 10^")} combinations`;
}

const SIMS = 20000;
const HISTORY_SIMS = 2500;

export default function Playoffs() {
  const { data } = useLeague();
  const d = data!;

  const model = useMemo(() => {
    const playoffTeams = Math.min(d.playoffTeams, d.rosters.length);
    const byes = byeCount(playoffTeams);

    // Live standings are computed once in LeagueContext, so this page and the
    // standings page can never disagree about the record.
    const live = d.live;
    const records = d.records;
    const counted = new Set(live.weeks);
    const playedWeeks = live.weeks.length;

    // Anything not counted is still to be played, including a week that has
    // started but not finished.
    const games = remainingGames(d.matchupsByWeek, 1, d.regularSeasonEnd).filter((g) => !counted.has(g.week));

    // Strength: the team's own scoring history, blended with its projected
    // optimal lineup for this week and shrunk toward the league average.
    const scores = weeklyScores(d.matchupsByWeek, d.regularSeasonEnd, counted);
    const all = [...scores.values()].flat();
    const leagueMean = all.length ? all.reduce((s, x) => s + x, 0) / all.length : 100;
    const projected = new Map(
      d.rosters.map((r) => [r.roster_id, optimalLineup(d.slots, r.players ?? [], d.weekly, d.players).total]),
    );
    const strength = new Map(
      records.map((r) => [r.rosterId, teamStrength(scores.get(r.rosterId) ?? [], projected.get(r.rosterId), leagueMean)]),
    );

    const common = { records, games, playoffTeams, byes, divisions: d.divisions, medianMatch: d.medianMatch };
    const clinch = clinchStatus(common);
    const odds = simulate({ ...common, strength, sims: SIMS });

    // Replay the model after each completed week to show how the race moved.
    const historyWeeks: number[] = [];
    const history = new Map<number, number[]>(records.map((r) => [r.rosterId, []]));
    for (const w of live.weeks) {
      const past = recordsThrough(d.matchupsByWeek, w, d.medianMatch);
      if (past.length === 0) continue;
      const pastWeeks = new Set(live.weeks.filter((x) => x <= w));
      const pastScores = weeklyScores(d.matchupsByWeek, w, pastWeeks);
      const pastAll = [...pastScores.values()].flat();
      const pastMean = pastAll.length ? pastAll.reduce((s, x) => s + x, 0) / pastAll.length : leagueMean;
      const row = simulate({
        records: past,
        games: remainingGames(d.matchupsByWeek, 1, d.regularSeasonEnd).filter((g) => !pastWeeks.has(g.week)),
        // no projections for a past week: judge teams on what they'd scored by then
        strength: new Map(past.map((r) => [r.rosterId, teamStrength(pastScores.get(r.rosterId) ?? [], undefined, pastMean)])),
        playoffTeams,
        byes,
        sims: HISTORY_SIMS,
        divisions: d.divisions,
        medianMatch: d.medianMatch,
      });
      historyWeeks.push(w);
      for (const o of row) history.get(o.rosterId)?.push(o.playoff);
    }

    const recById = new Map(records.map((r) => [r.rosterId, r]));

    // Who currently holds each division, by today's standings.
    const leaders = new Set<number>();
    if (d.divisions) {
      const best = new Map<number, TeamRecord>();
      for (const r of records) {
        const div = d.divisions.get(r.rosterId)!;
        const cur = best.get(div);
        const score = (x: TeamRecord) => 2 * x.wins + x.ties;
        if (!cur || score(r) > score(cur) || (score(r) === score(cur) && r.pf > cur.pf)) best.set(div, r);
      }
      for (const r of best.values()) leaders.add(r.rosterId);
    }

    const rows = [...odds]
      .sort((a, b) => b.playoff - a.playoff || b.bye - a.bye || a.avgSeed - b.avgSeed)
      .map((o) => ({
        odds: o,
        rec: recById.get(o.rosterId)!,
        clinch: clinch.teams?.get(o.rosterId),
        owner: d.rosterOwner(o.rosterId),
        history: history.get(o.rosterId) ?? [],
        divisionLeader: leaders.has(o.rosterId),
      }));

    // A week can be fully played but not yet scored by Sleeper, in which case the
    // standings don't include it and we simulate it instead of counting it.
    return {
      playoffTeams, byes, games, playedWeeks, clinch, rows, historyWeeks,
      partialWeeks: live.partialWeeks, records, strength, common,
      throughWeek: Math.max(0, ...live.weeks),
      weeksLeft: new Set(games.map((g) => g.week)).size,
    };
  }, [d]);

  const { playoffTeams, byes, games, rows, historyWeeks } = model;
  const myId = d.myRoster?.roster_id;
  const [picked, setPicked] = useState<number | null>(null);
  const focusId = picked ?? myId ?? rows[0]?.odds.rosterId;

  // Only this part depends on who you're looking at, so switching teams doesn't
  // redo the league-wide work or the week-by-week replay.
  const focus = useMemo(() => {
    if (focusId === undefined || model.games.length === 0) return null;
    const scen = scenarioAnalysis({ ...model.common, strength: model.strength, sims: SIMS, focus: focusId });
    const recipes = clinchRecipes({ ...model.common, focus: focusId });
    return { scen, recipes, row: rows.find((r) => r.odds.rosterId === focusId) };
  }, [model, rows, focusId]);
  const mine = rows.find((r) => r.odds.rosterId === myId);
  const weeksLeft = model.weeksLeft;

  if (games.length === 0 && model.playedWeeks === 0) {
    return (
      <Card title="Playoff odds">
        <p className="muted">
          No games played yet and no remaining schedule published. Odds show up once week 1 is on the board.
        </p>
      </Card>
    );
  }

  const seedRows = [...rows]
    .sort((a, b) => a.odds.avgSeed - b.odds.avgSeed)
    .map((r) => ({
      key: r.odds.rosterId,
      label: r.owner.team,
      avatar: <Avatar id={r.owner.avatar} size={20} />,
      dist: r.odds.seedDist,
      me: r.odds.rosterId === myId,
    }));

  return (
    <div className="grid">
      {mine && <MyOdds row={mine} byes={byes} playoffTeams={playoffTeams} weeksLeft={weeksLeft} />}

      {!d.liveCheck.ok && (
        <p className="notice">
          These standings are computed from the scores, and for the weeks Sleeper has already scored they don't
          match its record for{" "}
          {d.liveCheck.mismatches.map((rid) => d.rosterOwner(rid).team).join(", ")}. Your league is using a
          scoring or tiebreak rule this model doesn't know about, so treat every number below as unreliable until
          that's sorted out.
        </p>
      )}

      {model.partialWeeks.length > 0 && (
        <p className="notice">
          Week {model.partialWeeks.join(", ")} is still in progress, so it isn't counted yet — half a week of
          scores would hand losses to teams whose players haven't played. It's simulated instead, and will count
          as soon as every game is final.
        </p>
      )}

      {d.divisionsUnavailable && (
        <p className="notice">
          This league is set up with divisions, but Sleeper didn't return a division for every roster, so the
          seeding below is straight record-then-points and will understate a division leader's seed. Hit Refresh;
          if it persists, the league's division data isn't published.
        </p>
      )}

      {focus && focus.row && (
        <WhatHasToHappen
          scen={focus.scen}
          ladder={focus.recipes}
          playoffTeams={playoffTeams}
          divisionCount={d.divisions ? new Set(d.divisions.values()).size : 0}
          clinch={focus.row.clinch}
          byes={byes}
          teamName={(rid) => d.rosterOwner(rid).team}
          focusId={focusId!}
          isMe={focusId === myId}
          picker={
            <select
              value={focusId}
              aria-label="Team"
              onChange={(e) => setPicked(Number(e.target.value))}
            >
              {rows.map((r) => (
                <option key={r.odds.rosterId} value={r.odds.rosterId}>
                  {r.owner.team}
                  {r.odds.rosterId === myId ? " (you)" : ""}
                </option>
              ))}
            </select>
          }
        />
      )}

      <Card
        title="Playoff odds"
        right={
          <span className="row">
            {d.liveAhead && <LiveBadge weeks={d.liveWeeksAhead} />}
            <span className="muted">
              {games.length === 0
              ? "Regular season complete"
                : `Through week ${model.throughWeek}, ${SIMS.toLocaleString()} simulations of the last ${weeksLeft} week${weeksLeft === 1 ? "" : "s"}`}
            </span>
          </span>
        }
      >
        <OddsLegend byes={byes} />
        <table>
          <thead>
            <tr>
              <th className="rank-h">#</th>
              <th>Team</th>
              {d.divisions && <th>Division</th>}
              <th>W-L</th>
              <th className="num">Proj. wins</th>
              <th className="odds-h">Playoff odds</th>
              <th className="num">Odds</th>
              {byes > 0 && <th className="num">Bye</th>}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.odds.rosterId} className={r.odds.rosterId === myId ? "me" : ""}>
                <td className="rank">{i + 1}</td>
                <td>
                  <span className="team">
                    <Avatar id={r.owner.avatar} /> {r.owner.team}
                  </span>
                </td>
                {d.divisions && (
                  <td className="muted div-cell">
                    <span className="div-name" title={d.divisionName(d.divisions.get(r.odds.rosterId)!)}>
                      {d.divisionName(d.divisions.get(r.odds.rosterId)!)}
                    </span>
                    {r.divisionLeader && <span className="tag tag-neutral div-lead">leads</span>}
                  </td>
                )}
                <td>
                  {r.rec.wins}-{r.rec.losses}
                  {r.rec.ties ? `-${r.rec.ties}` : ""}
                </td>
                <td className="num">{fmt(r.odds.expectedWins)}</td>
                <td>
                  <OddsBar
                    playoff={r.odds.playoff}
                    bye={r.odds.bye}
                    label={`${r.owner.team}: ${pct(r.odds.playoff)} playoffs, ${pct(r.odds.bye)} bye`}
                  />
                </td>
                <td className="num">{pct(r.odds.playoff)}</td>
                {byes > 0 && <td className="num">{pct(r.odds.bye)}</td>}
                <td>
                  <ClinchBadge state={r.clinch?.state} />
                  {r.clinch?.state === "alive" && <Needs clinch={r.clinch} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {model.clinch.teams === null && (
          <p className="muted small">
            Clinch and elimination calls need every remaining outcome checked, and {weeksLeft} week
            {weeksLeft === 1 ? "" : "s"} of this schedule is{" "}
            {scenarioCount(model.clinch.needed)}
            {d.medianMatch ? ", because the median game multiplies them" : ""}. They appear once the race is
            short enough to enumerate in full{d.medianMatch ? ", which here means the final week" : ""}. Nothing
            is mathematically locked before then anyway.
          </p>
        )}
      </Card>

      <Card
        title="Where each team finishes"
        right={
          <span className="muted">
            Chance of each final seed, <ByTheme light="darker" dark="brighter" /> = more likely
          </span>
        }
      >
        <SeedHeatmap rows={seedRows} playoffTeams={playoffTeams} byes={byes} />
        <p className="muted small">
          Rows sorted by average finish. The lines mark the {byes > 0 ? `bye cut (${byes}) and the ` : ""}playoff cut (
          {playoffTeams}).
        </p>
      </Card>

      {historyWeeks.length > 1 && (
        <Card title="How the race moved" right={<span className="muted">Playoff odds after each week</span>}>
          <ul className="sparks">
            {rows.map((r) => (
              <li key={r.odds.rosterId} className={r.odds.rosterId === myId ? "me" : ""}>
                <div className="spark-head">
                  <span className="team">
                    <Avatar id={r.owner.avatar} size={20} /> {r.owner.team}
                  </span>
                  <strong>{pct(r.odds.playoff)}</strong>
                </div>
                <OddsSparkline series={r.history} weeks={historyWeeks} me={r.odds.rosterId === myId} />
              </li>
            ))}
          </ul>
          <p className="muted small">
            Each line replays the model with only the results known at the time, so it reads as "what the odds
            would have said then" — weeks {historyWeeks[0]} to {historyWeeks[historyWeeks.length - 1]}, 0 to 100%.
          </p>
        </Card>
      )}

      <Card title="How this is calculated">
        <p className="muted small">
          Every remaining game is simulated {SIMS.toLocaleString()} times. A team's weekly score is drawn from a
          normal distribution around its expected output — its own scoring average blended with its projected
          optimal lineup, shrunk toward the league average when there isn't much history — with volatility from
          its own week-to-week spread. Seeds break on total points, which Sleeper uses by default.
        </p>
        <p className="muted small">
          Standings are <strong>live</strong>: they're computed from the weekly scores, so a week counts the
          moment every game in it is final, rather than when Sleeper gets around to scoring it.
          {d.liveWeeksAhead.length > 0
            ? ` Week ${d.liveWeeksAhead.join(", ")} is counted here but not yet official on Sleeper, so these records run ahead of its standings page.`
            : ""}{" "}
          For the weeks Sleeper has scored, this model reproduces its record for all {d.rosters.length} teams
          exactly{d.liveCheck.ok ? "" : " — except where flagged above"}.
        </p>
        {d.medianMatch && (
          <p className="muted small">
            This league plays <strong>league average match</strong>, so every team banks two results a week: its
            head-to-head game and a second one against the weekly league median. The simulation draws all twelve
            scores for a week, settles the head-to-head, then ranks that week's scores to settle the median game —
            so a high scorer with a brutal schedule still climbs, and records move two games a week, not one.
          </p>
        )}
        {d.divisions ? (
          <p className="muted small">
            Your league has {new Set(d.divisions.values()).size} divisions, so each division winner is seeded ahead
            of every non-winner — a division can be won on a losing record and still outseed a better team. Winning
            the division is itself a tiebreaker question, so a crown only counts as locked once no tie for it is
            possible. Seeding here is the regular-season seeding that sets the field; re-seeding inside the bracket
            doesn't change who makes it or what seed they enter with.
          </p>
        ) : (
          <p className="muted small">
            This league doesn't use divisions, so seeds are straight record-then-points.
          </p>
        )}
        <p className="muted small">
          <strong>Clinched</strong> and <strong>eliminated</strong> are not read off the odds. They come from
          enumerating every combination of remaining results
          {model.clinch.scenarios > 1 ? ` (${model.clinch.scenarios.toLocaleString()} scenarios)` : ""} and
          checking whether any of them changes the answer. Tiebreakers are left out of that check on purpose, so
          "clinched" holds however ties break.
        </p>
      </Card>
    </div>
  );
}

/**
 * What has to happen, for my team.
 *
 * Two questions people actually ask: "what do I need to do" (my own win total)
 * and "who should I root for" (everyone else's games). Both are read off the
 * same simulated seasons.
 *
 * The metric follows whatever is still live: once a playoff spot is a
 * formality, every game's playoff swing is zero and the real race is the bye.
 */
/** Name a seed threshold by whatever it wins you. */
function seedLabel(slots: number, byes: number, playoffTeams: number, divisionCount: number): string {
  if (slots === 1) return "The #1 seed";
  const parts: string[] = [];
  if (byes > 0 && slots === byes) parts.push("a first-round bye");
  if (divisionCount > 1 && slots === divisionCount) parts.push("a division crown");
  if (slots === playoffTeams) parts.push("a playoff spot");
  const what = parts.length ? ` — ${parts.join(" / ")}` : "";
  return `Seed ${slots} or better${what}`;
}

/** Chance of finishing at `slots` or better, from the seed distribution. */
function cumulative(scen: ScenarioAnalysis, focusId: number, slots: number): number {
  const dist = scen.odds.find((o) => o.rosterId === focusId)?.seedDist ?? [];
  return dist.slice(0, slots).reduce((s, p) => s + p, 0);
}

/** Lead with the cheapest ask, not the lowest win total. */
function byDemand(list: Recipe[]): Recipe[] {
  return [...list].sort(
    (x, y) =>
      Number(x.needsCollapse) - Number(y.needsCollapse) ||
      x.asks.reduce((s, a) => s + a.losses, 0) - y.asks.reduce((s, a) => s + a.losses, 0) ||
      x.wins - y.wins,
  );
}

/** "Win 6 of 8, and the Buzzsaws lose 1 of 8." */
function RecipeLine({
  r,
  subject,
  plural,
  teamName,
}: {
  r: Recipe;
  subject: string;
  plural: boolean;
  teamName: (rosterId: number) => string;
}) {
  const verb = plural ? "win" : "wins";
  const own =
    r.wins === 0
      ? `${subject} can lose out`
      : r.wins === r.remaining
        ? `${subject} ${verb} all ${r.remaining}`
        : `${subject} ${verb} ${r.wins} of ${r.remaining}`;
  const shown = r.asks.slice(0, 4);
  const extra = r.asks.length - shown.length;

  return (
    <li>
      <span className="recipe-own">{own}</span>
      {r.asks.length === 0 ? (
        <span className="recipe-free">— in regardless of every other result</span>
      ) : (
        <span className="recipe-asks">
          , and{" "}
          {shown.map((a, i) => (
            <span key={a.rosterId}>
              {i > 0 ? (i === shown.length - 1 && !extra ? " and " : ", ") : ""}
              <strong>{teamName(a.rosterId)}</strong>{" "}
              {a.losses >= a.of ? `loses all ${a.of}` : `loses ${a.losses} of ${a.of}`}
            </span>
          ))}
          {extra > 0 ? `, and ${extra} more team${extra === 1 ? "" : "s"} drop games` : ""}
        </span>
      )}
      {r.route === "division" && <span className="tag tag-neutral recipe-route">via the division</span>}
    </li>
  );
}

function WhatHasToHappen({
  scen,
  ladder,
  clinch,
  byes,
  playoffTeams,
  divisionCount,
  teamName,
  focusId,
  isMe,
  picker,
}: {
  scen: ScenarioAnalysis;
  ladder: SeedTarget[];
  clinch?: TeamClinch;
  byes: number;
  playoffTeams: number;
  divisionCount: number;
  teamName: (rosterId: number) => string;
  focusId: number;
  isMe: boolean;
  picker: ReactNode;
}) {
  const myId = focusId;
  const subject = isMe ? "You" : teamName(focusId);
  // Follow whatever is actually still in play. A locked playoff spot makes every
  // playoff swing zero; an unreachable bye makes every bye swing zero just as
  // flat, so pick the measure that still moves rather than assuming.
  const spread = (pick: (l: Leverage) => number) => Math.max(0, ...scen.leverage.map((l) => Math.abs(pick(l))));
  const playoffSpread = spread((l) => l.swing);
  const byeSpread = byes > 0 ? spread((l) => l.byeSwing) : 0;
  const chasingBye = byeSpread > playoffSpread;
  const settled = Math.max(playoffSpread, byeSpread) < 0.005;
  const metric = (l: Leverage) => (chasingBye ? l.byeSwing : l.swing);
  const target = chasingBye ? "bye" : "playoff";

  // Denominator comes from every reachable total, not just the ones worth showing.
  const most = Math.max(1, ...scen.ownWins.map((r) => r.wins));
  const rows = scen.ownWins.filter((r) => r.share >= 0.005);
  // A column of identical cells is noise: drop it and say it once instead.
  const playoffVaries = new Set(rows.map((r) => pct(r.playoff))).size > 1;
  const games = [...scen.leverage].sort((x, y) => Math.abs(metric(y)) - Math.abs(metric(x)) || x.week - y.week);
  const top = games.slice(0, 8);
  const maxSwing = Math.max(1e-6, ...top.map((l) => Math.abs(metric(l))));

  return (
    <Card title="What has to happen" right={picker}>
      <h3 className="sub">What would lock up each seed</h3>
      <p className="muted small">
        Each rung is a guarantee: hit one of its lines and {isMe ? "you" : "they"} finish that seed or better no
        matter how everything else goes. Odds are the chance of landing there anyway.
      </p>
      {ladder.length === 0 ? (
        <p className="muted small">
          Nothing can be guaranteed from here — every remaining combination of results still leaves{" "}
          {isMe ? "you" : "them"} short in at least one case.
        </p>
      ) : (
        <ul className="ladder">
          {ladder.map((t) => {
            const paths = byDemand(t.recipes);
            const onlyOnCollapse = paths.length > 0 && paths.every((r) => r.needsCollapse);
            return (
              <li key={t.slots}>
                <div className="rung-head">
                  <strong>{seedLabel(t.slots, byes, playoffTeams, divisionCount)}</strong>
                  <span className="muted">{pct(cumulative(scen, focusId, t.slots))} as things stand</span>
                </div>
                {paths.length === 0 ? (
                  <p className="muted small rung-none">Can't be locked up yet from any set of results.</p>
                ) : (
                  <>
                    {onlyOnCollapse && (
                      <p className="muted small rung-none">
                        Only guaranteed if a rival loses out, so treat this as out of reach for now:
                      </p>
                    )}
                    <ul className="recipes">
                      {paths.slice(0, 3).map((r) => (
                        <RecipeLine key={r.wins} r={r} subject={subject} plural={isMe} teamName={teamName} />
                      ))}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">
        These are worked out from how high every rival can still finish, so they can ask for more than strictly
        necessary, never less. Anything short of one of these lines can still work out; it just isn't certain.
      </p>

      <h3 className="sub">{isMe ? "Your own results" : "Their own results"}</h3>
      <p className="muted small">
        Where {isMe ? "you" : "they"} land for each way the last {most} results can go. "Chance of that" is how often the season
        ends on that total, so a row can matter a lot and still be unlikely.
        {settled && rows.length > 0
          ? ` Nothing here is in doubt any more: ${pct(rows[0].playoff)} to make it and a bye settled at ${pct(rows[0].bye)} however these go.`
          : !playoffVaries && rows.length > 0
            ? ` Your playoff spot is ${pct(rows[0].playoff)} regardless of how these go, so only the bye moves.`
            : ""}
      </p>
      <table>
        <thead>
          <tr>
            <th>You go</th>
            <th className="num">Chance of that</th>
            <th className="odds-h">{chasingBye ? "Then: bye" : "Then: playoffs"}</th>
            {playoffVaries && <th className="num">Playoffs</th>}
            {byes > 0 && <th className="num">Bye</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const guaranteed = clinch?.clinchWins != null && r.wins >= clinch.clinchWins;
            return (
              <tr key={r.wins}>
                <td>
                  <strong>
                    {r.wins}-{most - r.wins}
                  </strong>{" "}
                  {guaranteed && <span className="tag tag-good" title="Proven by enumerating every outcome">✓ clinches</span>}
                </td>
                <td className="num">{pct(r.share)}</td>
                <td>
                  <OddsBar
                    playoff={r.playoff}
                    bye={r.bye}
                    label={`${r.wins} of ${most}: ${pct(r.playoff)} playoffs, ${pct(r.bye)} bye`}
                  />
                </td>
                {playoffVaries && <td className="num">{pct(r.playoff)}</td>}
                {byes > 0 && <td className="num">{pct(r.bye)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>

      {settled ? (
        <p className="muted small">
          No remaining result changes that position, so there's nothing left to root for — every one of them
          moves your odds by less than half a point.
        </p>
      ) : (
        <>
              <h3 className="sub">Games that move {isMe ? "your" : "their"} {target} odds</h3>
          <p className="muted small">
            {chasingBye
              ? "A playoff spot is already settled, so these are ranked by what they do to the first-round bye."
              : "Ranked by how far the playoff odds move between the two results."}
          </p>
          <ul className="leverage">
        {top.map((l) => {
          const swing = metric(l);
          const root = swing >= 0 ? l.a : l.b;
          const against = swing >= 0 ? l.b : l.a;
          return (
            <li key={`${l.week}-${l.a}-${l.b}`}>
              <span className="lev-week">Wk {l.week}</span>
              <span className="lev-teams">
                {l.own ? (
                  <>
                    <strong>{isMe ? "You" : teamName(focusId)}</strong> vs {teamName(l.a === myId ? l.b : l.a)}
                  </>
                ) : (
                  <>
                    Root for <strong>{teamName(root)}</strong> over {teamName(against)}
                  </>
                )}
              </span>
              <span className="lev-bar">
                <span className="lev-fill" style={{ width: `${(Math.abs(swing) / maxSwing) * 100}%` }} />
              </span>
              <span className="lev-num">{(Math.abs(swing) * 100).toFixed(1)} pts</span>
            </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="muted small">
        These are frequencies across simulated seasons, not guarantees — the only claims proven for every
        possible outcome are the ✓ marks and the clinch badges above.
      </p>
    </Card>
  );
}

/** "Win 2 of your last 4 and you're in", straight out of the enumeration. */
function Needs({ clinch }: { clinch: TeamClinch }) {
  if (clinch.clinchWins !== null && clinch.clinchWins <= clinch.remaining) {
    const n = clinch.clinchWins;
    return (
      <span className="muted">
        {n === 0
          ? "in with any finish"
          : n === clinch.remaining
            ? "win out to clinch"
            : `${n} of ${clinch.remaining} clinches`}
      </span>
    );
  }
  if (clinch.mustWin !== null) {
    return (
      <span className="muted">
        must win {clinch.mustWin === clinch.remaining ? "out" : `${clinch.mustWin} of ${clinch.remaining}`}
      </span>
    );
  }
  return null;
}

function MyOdds({
  row,
  byes,
  playoffTeams,
  weeksLeft,
}: {
  row: { odds: TeamOdds; clinch?: TeamClinch; owner: { team: string } };
  byes: number;
  playoffTeams: number;
  weeksLeft: number;
}) {
  const { odds, clinch } = row;
  const state = clinch?.state;

  const headline =
    state === "clinched-bye"
      ? "You're in, with a first-round bye."
      : state === "clinched"
        ? "You're in. Mathematically clinched."
        : state === "eliminated"
          ? "Eliminated from playoff contention."
          : `${pct(odds.playoff)} to make the playoffs.`;

  const detail =
    state === "clinched-bye"
      ? `No combination of the last ${weeksLeft} week${weeksLeft === 1 ? "" : "s"} can cost you a top-${byes} seed.`
      : state === "clinched"
        ? clinch && clinch.clinchWins !== null && byes > 0
          ? `A top-${playoffTeams} seed is locked. The bye is still live at ${pct(odds.bye)}.`
          : `A top-${playoffTeams} seed is locked no matter how the rest plays out.`
        : state === "eliminated"
          ? "Every remaining combination of results leaves you outside the top " + playoffTeams + "."
          : clinch && clinch.clinchWins !== null
            ? clinch.clinchWins === clinch.remaining
              ? `Win out and you're in, regardless of everyone else.`
              : `Winning ${clinch.clinchWins} of your last ${clinch.remaining} clinches it regardless of everyone else.`
            : clinch && clinch.mustWin !== null
              ? `You need to win at least ${clinch.mustWin} of your last ${clinch.remaining} to have any path.`
              : `Projected to finish around seed ${Math.round(odds.avgSeed)} with ${weeksLeft} week${weeksLeft === 1 ? "" : "s"} to play.`;

  return (
    <Card title="Your playoff picture" zone={state === "eliminated" ? "red" : "green"}>
      <div className={`callout ${state === "eliminated" ? "callout-bad" : "callout-good"}`}>
        <h1>{headline}</h1>
        <p>{detail}</p>
      </div>
      <div className="stats" style={{ marginTop: 16 }}>
        <Stat label="Playoff odds" value={pct(odds.playoff)} tone={odds.playoff >= 0.5 ? "good" : undefined} />
        {byes > 0 && <Stat label={`First-round bye (top ${byes})`} value={pct(odds.bye)} />}
        <Stat label="Top seed" value={pct(odds.topSeed)} />
        <Stat label="Projected wins" value={fmt(odds.expectedWins)} />
        <Stat label="Average finish" value={`#${fmt(odds.avgSeed)}`} />
      </div>
    </Card>
  );
}
