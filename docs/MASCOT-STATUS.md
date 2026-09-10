# Orangey the mascot — build status

The resume file. A session picking this up reads this first, then
`claude/orangey-mascot-plan.md` in the project for the design.

| Stage | What | Status |
|---|---|---|
| P0 | Art & motion sheet (artifact) | done 2026-09-10 |
| P1 | Core: number extremes, event vocabulary | done — `7d71386` |
| P2 | Mascot module: model, view, states, ticker | done — `ecc583b` |
| P3 | Reactions, host, FeelSettings.mascot, settings section | done — `c029ec4` |
| P4 | Wiring: play, links, import, slots; browser tests | done — `f65fd77` |
| P5 | Release: docs, changelog, full run | done |
| Q1 | Per-outcome reaction in the model, format, summary, reactions table | done |
| Q2 | Editor controls: wheel rows, bulk bar, coin faces; browser tests | done |
| Q3 | Back, settings file, my colours, download a copy | done |
| Q4 | Publishing pass: workflows on `main`, docs, one public commit | done |
| R  | The mark is Orangey; the app moves to a subpath | done |
| S  | A card that does not move, a way home, a Storage card, quieter defaults | done |
| T  | A link that carries the wheel itself | done |
| U  | Wheel labels along the radius, the pointer on the right | done |

All stages complete. At 0.3.1: `npm run check` (60 source files),
`npm test` (294) and `npm run test:browser` (94) are green.

Test names carry their stage's letter, so `P …`, `Q …`, `R …`, `S …`, `T …`
and `U …` in `tests/browser/run.mjs` are that stage's browser tests.

## Where things are

- `src/ui/mascot/` — `events.ts` (the facts), `reactions.ts` (the table),
  `host.ts` (the one instance), `mascot.ts` (model + view + ticker),
  `model.ts`, `states.ts`, `view.ts`, `ticker.ts`, `springs.ts`, `parts.ts`.
- `assets/mascot/` — the owner's six SVGs, unmodified.
- `FeelSettings.mascot` in `src/model/feel.ts`; defaults, clamps and every
  hold duration in `src/ui/feel.ts`.
- Settings → Orangey card in `src/ui/views/settings.ts`.
- `.mascot-slot` on the play screen's result panel and in the
  not-in-this-library message; CSS at the end of `src/ui/styles/app.css`.

## How to extend

- **A new randomizer type**: produce an `Outcome` with `isMaximum` /
  `isMinimum` where honest; `summarize()` does the rest.
- **A new trigger**: a row in `DEFAULT_REACTIONS`, with an id and a label —
  it appears in Settings automatically.
- **A new animation**: `registerMascotState(name, { pose, enter, drive,
  limbs })` before the app mounts, then name it in a row. A pose needs its
  parts in `parts.ts` and its visibility rules in the CSS.

## Beyond the mascot

Stages R to U were not about him, but they are recorded here because
this is the file a session reads first:

- **R** — the top bar, the favicon and the installed icon are his head,
  rasterised in `scripts/icon.mjs` from the constants in
  `src/ui/mascot/parts.ts`; the app moved from the organisation's root to
  `orangey-app.github.io/orangey/`.
- **S** — the result panel reserves its height from `longestOutcome()`
  rather than discovering it per roll; the dice presets give way to a Home
  button when a randomizer from the library is open; Settings has a Storage
  card; four of the ten reactions ship switched off.
- **T** — `src/model/link.ts` puts a whole randomizer in the address
  (`#/roll?w=…`), the Link dialog offers that and the library link side by
  side, and the Import page accepts a pasted one.
- **U** — wheel labels run along the radius and the pointer sits at three
  o'clock (`POINTER_ANGLE` in `src/core/wheel-geometry.ts`), so every winner
  arrives horizontal; `radialLabelRoom` and `fitLabelToWidth` size and cut the
  labels; wheels are labelled up to 48 outcomes.

## Not done, by decision

- No per-randomizer mascot override (`Randomizer.feel` covers a randomizer's
  own animation; the mascot is app chrome).
- No third "pleased" pose for good-but-not-maximum rolls.
- Coins and wheels have no honest extreme, so they never trigger Happy or
  Oops on their own; the game master tags outcomes instead (`reaction` on an
  item, `faceReactions` on a coin — stage Q1).
- Dice keep the all-kept-dice rule: a 1 and a 20 on `2d20` is neither a
  cheer nor a wince. "Any die at the bound" was offered and declined.
- No tagging of particular dice totals.
- The empty-library screen has no separate placement; the play screen's slot
  is the one place he lives, plus the failed-link message.
