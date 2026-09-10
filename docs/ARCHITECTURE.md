# Architecture

## The shape of it

```
        ┌─────────────────────────────┐
        │  UI  (src/ui)               │  vanilla DOM, no framework
        │  views · components · feel  │
        └──────────────┬──────────────┘
                       │
        ┌──────────────▼──────────────┐
        │  Core  (src/core)           │  no DOM, no imports from ui/
        │  rng · dice · weighted      │
        │  wheel geometry · colour    │
        └──────────────┬──────────────┘
                       │
   ┌───────────────────┼────────────────────┐
   │                   │                    │
┌──▼──────────┐  ┌─────▼────────┐  ┌────────▼────────┐
│ model       │  │ import       │  │ storage         │
│ types,      │  │ CSV/TSV →    │  │ OPFS · folder · │
│ validation, │  │ outcomes     │  │ memory · zip ·  │
│ file format │  │              │  │ IndexedDB       │
└─────────────┘  └──────────────┘  └─────────────────┘
                                            │
                                    portable .orangey.json files
```

`src/core`, `src/model`, `src/import` and `src/storage` never import from
`src/ui`. They run under `node --test` with no DOM, which is why the unit
suite is fast and why the dice and wheel engines could be lifted out into
their own package later.

## Rules that the code depends on

**The result is decided before the animation starts, and shown only when it
ends.** `rollRandomizer` produces a complete outcome; `wheel.spinTo` is then
handed a target and works out a pleasant way to arrive at it. Nothing displays
that outcome until the animation resolves — the result panel holds a muted
"Rolling…", the dice tumble through values that are not the answer, the coin
shows nothing — and the reveal and the screen-reader announcement happen
together at the landing. This is why pressing Esc mid-spin is safe: skipping
jumps to the landing, and the answer it reveals is the one that was already
rolled.

**A wheel is a cycle.** Colour assignment constrains the last segment against
both its predecessor *and* segment 0. A left-to-right pass that forgets this
puts two identical slices together at twelve o'clock.

**`disabled` is a flag, not a weight of zero.** Turning an outcome off keeps
its weight in the file so that turning it back on restores it exactly.

**The mascot reads facts; it never names a randomizer and nothing names an
animation.** `src/ui/mascot/` is four layers that do not know each other.
Views put facts on `state.events` with `state.tell()` — a roll started, a
roll landed with its `RollSummary` (`extreme: "max" | "min" | null`, and
`mood: "cheer" | "wince" | null` from an outcome the game master tagged), a
roll that could not happen, a slide link that points nowhere, an import
finished.
`reactions.ts` is a table that turns a fact into a state name: first match
wins, every row has an id the GM can switch off in Settings, and a salience so
an Oops is never buried by a lesser reaction. `host.ts` is the one Orangey
the app shows — a singleton, so "one mascot however many dice" is true by
construction — applying the GM's presence setting (hidden / on triggers /
always) and moving its element into whichever view offers a `.mascot-slot`.
`model.ts` and `states.ts` are the animation: springs as pure numbers, and a
registry of states. A new randomizer type needs only to produce an `Outcome`;
a new trigger is a row; a new animation is `registerMascotState`.

**Tags say what he does, not which pose plays.** A wheel has no honest
maximum, so a list item may carry `reaction: "cheer" | "wince"` and a coin
`faceReactions`. `rollRandomizer` copies the tag onto the `Outcome`,
`summarize()` reads it into `mood`, and two rows at the head of the reactions
table map it to a state. The vocabulary in the file is his behaviour, so a
sixth pose never changes the format; the tag rows have ids like every other
row, so Settings can switch them off.

**Settings that travel are a file of their own.** `src/model/settings-file.ts`
picks the portable part of the preferences — scheme, feel, seed, the
reduced-motion choice, the user's colours — and refuses anything else, so a
settings file from one device can never carry another device's folder or
backend. Loading goes through `normalizeFeel`, exactly as start-up does.

**At rest the mascot is the drawing.** Every path in `parts.ts` is lifted from
the owner's SVGs in `assets/mascot/`. The squash spring's target is derived
from a zero-mean breath and can never be set by a state; poses are carried by a
crouch offset and a tilt; clamps are symmetric; the hop integrates only while
airborne, so standing still injects nothing. `tests/unit/mascot.test.ts`
pins this — the mean body height over a breath cycle equals the drawn height
at every wobble setting — and the browser suite re-measures it against a real
clock, because Chromium's virtual-time budget once hid exactly this bug.

**The mascot never writes.** It reads the bus and moves an element. History
with him hidden and with him always shown is identical for the same seed,
and a test says so.

**Dice can be drawn as the solid they are.** `src/core/polyhedra.ts` holds the
vertex and edge lists — tetrahedron, cube, octahedron, pentagonal
trapezohedron, dodecahedron, icosahedron — and the orientation maths, with no
DOM in sight, so all of it is unit-tested. The drawing follows the Rosetta Code
rotating cube: rotate the vertices, project them, draw the edges. Three things
are added on top, because a die is not a spinning cube:

- *Quaternions, not Euler angles.* The die changes axis mid-flight and then has
  to arrive at an exact resting pose. Accumulated Euler angles gimbal-lock and
  drift under that, and cannot be interpolated into a target orientation.
- *It tumbles about its own diagonals.* Two of them at once, chosen at random;
  at each bounce one of the two is swapped for another diagonal and given a new
  speed while the other carries on.
- *It comes to rest square-on.* `restQuaternion` builds an orientation that
  turns the face being read towards the viewer — allowing for the camera's own
  tilt, or the tilt would leave every landed die skewed — and the final bounce
  slerps into it. The face is then seen undistorted, so its number can sit
  inside it. `facingError` measures how far an orientation is from that, using
  `atan2` rather than `acos`: `acos` loses precision exactly where the question
  matters, near zero.

The shape describes itself. Edges are the vertex pairs at the shortest
distance; faces are found by `computeFaces`, which takes every corner of the
solid, forms the plane through it, and keeps the ones every other vertex lies
behind. Neither can disagree with the vertex list — and the face finder caught
a wrong dodecahedron the first time it ran, where a hand-written normal list
had quietly pointed at vertices instead of faces.

The number on a landed die is sized from the projected face rather than from a
constant: half the mean length of that face's sides, shrunk if it has more than
one digit and would otherwise overflow the face's inscribed circle.

**A landing is a bounce, and its size is one setting.** The Settle control
(none / slight / bouncy, default bouncy) governs all three: the wheel swings a
fixed number of degrees past its target and comes back, and the dice and coin
drop, squash and hop before resting. `easeSpin` adds the overshoot as a damped
half-sine over the last quarter of the spin, and it is exactly zero at t = 1,
so the wheel still stops precisely where the result says.

**All animation timing lives in `src/ui/feel.ts`.** `npm run check` fails the
build if a duration appears anywhere else, which is what makes the settings
panel able to change how the whole app feels.

**Storage is an interface with three implementations.** `LibraryBackend` is
list/read/write/mkdir/move/remove; OPFS and a user-picked folder share one
implementation over `FileSystemDirectoryHandle`, memory is the third and is
what the shared backend test suite runs against. A Tauri backend in 1.0 is a
fourth implementation of the same six methods.

## Build

There is no framework and there are no dependencies. `scripts/bundle.mjs`
strips TypeScript types with Node's own stripper and concatenates the modules
in dependency order into one script; `scripts/build.mjs` writes `dist/` and,
with `--single`, a self-contained `dist/orangey.html`.

The bundler is deliberately strict — only relative imports, no default exports,
no re-exports, no renamed imports, and every top-level name unique across the
program. Each of those rules is checked at build time, and each of them caught
a real bug while the app was being written.

### Why no framework

The plan called for Svelte 5 + Vite. The build environment had no access to any
package registry, so the choice was between a framework and shipping. The
framework-free core was already the plan's design, so only the UI layer
changed. Moving to Svelte later is a rewrite of `src/ui` against an untouched
`src/core`, `src/model`, `src/import` and `src/storage` — and the tests for
those keep working unchanged.

## Tests

`npm test` runs the unit suite under `node --test`: RNG distributions, dice
parsing and evaluation, colour and palette rules, wheel geometry, the file
format, imports, storage backends and the feel settings.

`npm run test:browser` builds nothing itself — run `npm run build:single`
first — and then drives the real app in headless Chromium over the DevTools
protocol (`tests/browser/cdp.mjs`, about 200 lines, no dependencies). It
covers the UI, and the combination matrix: import → edit → reload → roll,
disabled outcomes against geometry and colour, seeded rolls against instant
mode and history, skipping a spin under every curve, library operations against
history, large wheels in all three display modes, and the app running offline
and from a `file://` URL. The mascot tests (`P …`) cover one Orangey for
`8d6`, Happy on a maximum and Oops on a minimum with seeds found in the page,
anticipation still held halfway through a spin, no anticipation flash in
instant mode, link and import reactions, the three presences across a reload,
history parity with him on and off, and his resting height measured in real
time at every wobble setting. The `Q …` tests cover tagging outcomes in the
editor and the bulk bar, a tagged wheel item and coin face landing as Happy or
Oops with a seed found in the page, the tag rules switched off in Settings,
Back from every screen (and its fallback when the last randomizer is gone),
the settings file saved, loaded, applied and refused, my colours added from
Settings and from the picker, and the About card's download of the single
file.
