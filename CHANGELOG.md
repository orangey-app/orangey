# Changelog

## Unreleased

- **A link can carry the wheel itself.** Beside the link to your library there
  is now one with the randomizer inside it: name, outcomes, weights, colours,
  Orangey's tags and the randomizer's own spin settings, compressed into the
  address. It rolls on anyone's machine with nothing installed and nothing
  shared in advance, and it keeps rolling whatever you do to your library
  afterwards — a snapshot rather than a pointer. The payload is in the
  fragment, which browsers never send to a server, so even the hosted copy
  never sees your tables. A twenty-row encounter table comes to a few hundred
  characters. The Link dialog offers both kinds side by side with what each
  costs; the Import page takes a pasted link and offers to keep it; and a wheel
  opened from a link can be saved to your library with the identity it arrived
  with, so a link by id finds it afterwards.

- **The card stops moving.** The result panel used to find its height one roll
  at a time: the detail line arrived with the first result, and a long outcome
  wrapped and pushed everything below it. It now reserves its height from the
  longest outcome the open randomizer can produce — we know them all in
  advance — keeping the large type and one line for short outcomes, dropping
  to the smaller type and two lines for long ones, and clipping anything
  longer with an ellipsis. The spoken announcement is always the whole thing.
- **The dice presets step aside.** With a randomizer open from the library the
  quick presets are replaced by a way home, because pressing one used to swap
  out the randomizer the table was in the middle of.
- **Orangey says less by default.** Watching every roll, reacting to every
  ordinary landing, wincing at a roll that cannot happen and wincing at an
  import that merely had warnings are all off out of the box; what remains is
  the maximum, the minimum, an outcome you tagged, a slide link that points
  nowhere, and a clean import. Every one of them is still a checkbox in
  Settings, and a choice already made is kept.
- **A Storage section in Settings.** Where the library is kept and what that
  means, whether the browser has promised not to evict it (and a button to
  ask), the folder picker, and the ZIP export — all in one place. "About
  storage" in the library now leads somewhere that answers the question.
- **The mark is Orangey.** The top bar, the browser tab and the installed-app
  icon were a placeholder wheel of coloured arcs from 0.1, drawn before the
  mascot existed. They are now his head, as `assets/mascot/logo.svg` draws
  it: the top-bar mark is the head alone so it reads on every scheme, and the
  icons are the head on the brand black tile. `scripts/icon.mjs` rasterises
  the same constants the app animates, so redrawing him reaches all three at
  once, and the maskable icon is inset so a phone cropping it to a circle
  never clips his sides.

## 0.2.0 — 2026-09-10

- **Orangey on wheels and coins.** A wheel has no maximum, so the game master
  tags outcomes: an Orangey cell on every editor row (and under each coin
  face) cycles none → cheer → wince; the bulk bar tags a selection at once.
  The file carries it as `reaction: "cheer" | "wince"` on an item and
  `faceReactions` on a coin — what he does, never which pose, so a new
  animation is never a format change. Two rows at the head of the reactions
  table, switchable in Settings like the rest. Dice keep their rule: every
  kept die at the top is a cheer, every kept die at the bottom a wince; a 1
  and a 20 on 2d20 is neither.
- **Back.** Every screen but Play has a Back button that returns to the
  randomizer you were playing (an editor returns to the one it edits).
- **A settings file.** Settings → Save writes `orangey-settings.json` — the
  scheme, every Feel setting, Orangey's rules, the seed and your colours;
  nothing that describes this device. Load applies one, clamping timings as
  start-up does and refusing a bad file without changing anything.
- **My colours.** Add colours to the palette from Settings or straight from
  the colour picker, which lists them first. The automatic wheel colours keep
  to the curated pool, which is tested for contrast and distinctness.
- **A copy of the app.** Settings → About downloads `orangey.html`; the site
  serves it beside `index.html` and every release attaches it.
- **Orangey the mascot.** One Orangey, in the corner of the result panel
  (bottom-right in full screen). He watches the roll, reacts when it lands —
  Happy on a maximum, Oops on a minimum, a surprised Reveal otherwise — and
  winces when a roll cannot happen, when an import has problems, or when a
  slide link points at a wheel this browser does not have. Presence is the
  game master's choice in Settings: hidden, on triggers, or always; wobble in
  three stops (defaulting to the most); a checkbox per reaction; a live
  preview of the five states. Whole-number draws now know when they hit the
  top or bottom of their range, as dice already did.
- Under the hood: facts go on `state.events`, a reactions table turns them
  into a state, a single host plays it, and the animation is springs as pure
  numbers over the owner's own drawings. Adding a randomizer, a trigger or an
  animation touches one place each. 48 unit tests and 15 browser tests.

## 0.1.0

First release.

- A downloaded `orangey.html` keeps its library: pages opened from disk get no
  origin-private filesystem, so the library now falls to IndexedDB rather than
  to memory — the bug where a new wheel vanished on reload. A chosen folder is
  remembered across reloads, and the library says plainly where it is stored.
- The library sidebar has one **+ New** menu and one **Import** door (paste,
  spreadsheet, `.orangey.json`, or a whole ZIP), drag-and-drop into folders,
  and proper dialogs instead of browser prompts.
- Five colour schemes on the brand colours (`#f3a257`, `#253122`): Orangey,
  Night, Meadow, Ocean, Berry. The colour picker is grouped by hue with names.
- Animation: the wheel eases in as well as out and rolls back by a random
  share of a maximum you set; the coin is tossed along a parabola and shrinks
  towards the apex; the dice fly in from one point, scatter, and land in order;
  wireframe numbers share one size across a mixed handful.
- Each randomizer can carry its own Feel settings, saved in its file; an
  Animate switch on the play screen turns motion off without changing them.
- Starter randomizers on first run.

- Dice with a real notation (`NdS`, modifiers, `kh`/`kl`/`dh`/`dl`, `d%`),
  showing every die and marking the dropped ones.
- Coins with custom faces; number draws with whole/decimal, inclusive bounds,
  repeats or no repeats.
- Weighted wheels: normalized weights, per-outcome colours, three display modes
  (labelled up to 32 outcomes, unlabelled up to 200, a ticker above that).
- An outcome table built for fixing imported data: disable, duplicate, delete,
  bulk actions, filter, drag or keyboard reordering, and a ten-second undo.
- CSV/TSV/semicolon/pipe/whitespace import with delimiter and header detection,
  column mapping, and a report shown before anything is created.
- A library of folders and `.orangey.json` files, with search, ZIP export and
  import, and — where the browser allows it — a real folder on your computer.
- History with repeat, copy, remove, and CSV or text export.
- Seeded rolls, so a table can share a sequence without a server.
- Wireframe dice: each die can be drawn as the solid it actually is and
  tumbled in 3D — two random diagonals to begin with, one axis changing at
  every bounce, and a last bounce that settles it with the face it is showing
  turned square-on, outlined, and its number sized to half a side of that face.
  Off by default; the plain numbered dice are unchanged and still the default.
- The result is never shown before the animation lands: the dice tumble through
  values that are not the answer, and the reveal and the announcement happen
  together when everything comes to rest.
- Everything bounces when it lands — the wheel swings past its target and
  settles back, the dice and coin drop and hop — governed by one Settle
  setting (none / slight / bouncy, default bouncy).
- A Feel panel: spin length, turns, wind-down curve, settle, dice tumble and
  scatter, coin flips, haptics, with a preview for each.
- Links for slides: a **Link…** dialog produces a URL to paste onto a shape in
  Google Slides or PowerPoint that opens the randomizer, rolls it, and fills
  the screen. Links address a randomizer by identity, so renaming or moving it
  does not break a deck.
- A full-screen view for a projector or a table, with Escape to leave.
- Offline by design: installable, and no network requests after load.
