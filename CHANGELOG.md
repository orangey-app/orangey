# Changelog

## Unreleased

- **Your own theme.** Settings has a card for making one: a background, a
  text colour, an accent and the wheel's colours, with the rest worked out
  from those and a live preview. Every pair that would be hard to read is
  listed with its contrast as you pick, and the closest readable version is
  shown beside yours — the same hues, lighter or darker as needed — to use
  instead, or not. It becomes a sixth scheme and travels in the settings
  file; a settings file from before leaves it alone. The error, warning and
  success colours follow it too: the same red, amber and green, lightened or
  darkened until they read on its background.
- **A wheel's own colours.** In a wheel's editor, Colours: This wheel's gives
  it three colours of its own (and a spare, if you like), over the theme's.
  They are part of the wheel, so they go with it in its file and in a link.
- **Dice and quick wheels on a board, just for now.** A board has a box for
  dice (`3d20`, anything the notation takes) and a Quick wheel button. Each
  adds a dashed cell after the board's own: it rolls with Roll all, a quick
  wheel's options are typed in its cell, a reload keeps them, and ✕ closes
  one. None of it changes the board; **Save to library** keeps one and puts
  it on the board for good.
- **Rolls made in a chain show under the wheel.** A randomizer opened by an
  outcome was recorded in History, but the Recent rolls panel under the
  wheel (and under a board) only listed the wheel's own rolls, so the second
  roll looked lost. The panel now covers everything the chain has open, and
  its Clear says which randomizers it will clear.
- **A quick wheel.** The home screen has a Quick wheel button: type the
  options one per line and the wheel is there as you type, ready to roll.
  `| 3` or `x3` after a line weighs it. It lives in the page's address, so a
  phone that locks between rolls comes back to it, and Link and Save to
  library work as for any wheel; a dice preset throws it away.
- **Make a choice.** A wheel can offer several outcomes and let the player
  take one: set "Offer … to choose from" in its editor (or beside the quick
  wheel), and Roll deals that many different outcomes as cards. The card
  taken is the outcome — it goes to history with what it was chosen from,
  opens what it points at, and in bag mode only it leaves the bag. Cards
  can be picked with the digits 1 to 9. Hidden rolls deal them face down.

## 0.5.1

Fixes for iPhone and iPad, and one typeface throughout. (The files in this
release still give their version as 0.5.0: the number was not bumped before
the tag. Nothing depends on it — installed copies update from the content,
not the number.)

- **iPhone and iPad on iOS 18 get a library.** Safari 18 — and every browser
  on iOS 18, since they all run on its engine — has a private filesystem that
  can be listed but not written to. Orangey chose it, and then every write
  failed: no starters, no new wheel, no import, and on a first visit a page
  that never got past "Loading…". Browser storage is now checked with a real
  write before it is trusted, and where that fails the library lives in
  IndexedDB, which those browsers do have. A library already in IndexedDB is
  kept when the browser later gains a writable filesystem (iOS 26), so an
  update does not hide it.
- **Files show up in the iPad's picker.** The Import page's file chooser named
  its file types by extension only, which iOS turns into a picker with the
  `.orangey.json` and `.zip` files greyed out. It now names the types too.
- **Import several files at once.** The file chooser and the drop target take
  any number of files, and a single `.orangey.json` lands in the folder
  chosen on the page rather than always at the top level.
- **Arapey everywhere.** The whole interface is now set in Arapey — text,
  buttons, tables, settings, the die captions — with two exceptions: the
  labels on wheel slices stay in the system font, and the numbers on dice
  stay in Young Serif. Arapey reads smaller than the system font at the same
  size, so the body and the small labels each gained a pixel. Arapey has no
  bold; headings and answers stay unfaked, the small interface weights keep
  the browser's.
- **Roll buttons line up on a board.** Every cell in a row is as tall as the
  tallest and its Roll sits at the bottom, so the buttons run in a line
  whatever each cell shows above them.
- **The editor fits a phone.** The outcome table scrolls sideways inside its
  card, as it was meant to; before, the card grew to the table's width and
  the right half of the editor was off the screen.
- The Import page no longer shows an empty card under "Nothing to import
  yet". The README screenshots are retaken with the new type.
- **A create that fails says so.** New wheel, new folder and the starters
  used to fail silently when storage refused the write; there is now a
  message with the reason, and the app opens regardless.

## 0.5.0 — the first release

The first public release of Orangey. Everything below this section was
development before anything was released; it is kept as history, not as
releases anyone could have had.

What 0.5.0 is:

- **A randomizer for tabletop games** — dice, coins, numbers and weighted
  wheels — that runs entirely in the browser, needs no account and no server,
  and works offline. The whole app is one file, `orangey.html`, or a small
  static site.
- **Dice notation for the dice people actually roll**: keep and drop, exploding
  dice, rerolls, success pools, Fate dice, `adv` and `dis`, and dice written
  into an outcome's text ("{2d4} wolves"). Wireframe dice tumble and land on
  the real faces; explosions and rerolls land in throws of their own.
- **Wheels built from your own tables**, with weights that need not add up to
  anything, bag mode for drawing without putting back, pictures on outcomes
  (on the slice, instead of or beside its name), and an import wizard for
  spreadsheets and pasted tables (d100 ranges included). Slices are red,
  yellow and blue in turn.
- **Chains and boards.** An outcome can send you to another randomizer, which
  opens and waits for its own roll — on the play screen and on a board. A
  board puts several randomizers on one screen, each with its own Roll, and
  changes only in Edit board.
- **A library that is a folder of files**: plain `.orangey.json`, in the
  browser's storage or in a real folder on your computer that Dropbox or Git
  can sync. iPhone and iPad are told how to keep a library safe there.
- **Links for slides**: a link that opens a wheel, rolls it and fills the
  screen — either carrying the wheel inside it or pointing at your library.
- **History** with dates, struck rolls, the dice behind an answer and what a
  chained roll came from; exports as CSV and text.
- **Feel and Orangey**: animation you can tune per randomizer, reduced motion
  respected, a hidden roll for the game master, and a mascot who cheers and
  winces when you tell him to. Names and answers are set in Arapey, dice in
  Young Serif; both are built in.

## Before the first release

Development notes, newest first. None of these was released.

### Last round before release

- **A picture or a name, not one over the other.** A slice whose outcome has
  a picture now shows the picture alone; slices without one show their name.
  The editor's **Slices show** (offered once a wheel has a picture) switches
  a wheel to **Names**, or to **Both**, which moves the picture out to the rim
  and fits the name between it and the centre — dropping the picture where a
  slice is too narrow for the two. Saved as `slices` in the file, and only
  when it is not the default.
- **A board follows an outcome's link.** Roll a wheel on a board and, if the
  outcome that came up points at another randomizer, that one opens as a
  dashed cell right after it and waits for its own roll — the same rule as the
  play screen. Every board cell now has its own Roll button, so a single cell
  can be rolled whatever it is; Roll all answers everything afresh and closes
  what the cells had opened.
- **A board changes only when you mean it to.** A board opens ready to play:
  Add…, the ✕ on each cell and dragging to reorder appear under **Edit
  board**. Taking a randomizer off can be undone from the toast or with
  Ctrl/Cmd+Z. An empty board opens ready to edit.
- **Type dice straight onto a board.** In the Add… picker, and in an outcome's
  "where does this send you?", type `2d6 + 3` and pick **Add 2d6 + 3**. The
  dice go into a Dice folder in your library and are reused from there the
  next time you type the same roll.
- **Back goes back.** A randomizer made from a board's picker, or from an
  outcome's "where does this send you?", opens in the editor; Back now returns
  to the board or editor you came from instead of leaving you on the new
  randomizer's play screen.
- **Exploding dice and rerolls land in throws.** With `3d6!` the dice you
  threw land first and the dice their explosions added are thrown in after
  them, the way it happens at a table; a rerolled die lands, then its
  replacement. Instant and reduced motion still land everything at once.
- **History keeps the rest of the roll.** Dice written into an outcome
  ("{2d4} wolves") are kept under the answer, and a roll made in a chained
  randomizer says what sent you there. The CSV export gains `details` and
  `from` columns at the end.
- **iPhone and iPad are told how to keep a library safe.** No browser there
  can keep the library in a folder and Safari clears unused sites' storage
  after about a week, so Settings says so and recommends Add to Home Screen;
  in a browser tab on an iPhone or iPad a one-time notice says the same.
  Settings no longer suggests Chrome or Edge there, where they cannot help.
- **New type.** Names, headings and answers are set in Arapey, and the numbers
  on dice in Young Serif, centred on the face; both are built in and work
  offline. Buttons, tables and wheel labels stay in the system font.
- **Wheels are red, yellow and blue.** Slices take the primary colours in
  turn, with green for the one slice that would otherwise meet its own colour.
  Colours you set on an outcome still win. The pointer is drawn in the ink
  colour, so it no longer disappears against a yellow slice.
- Dropped and rerolled dice are shown faded rather than struck through.
- Fixes: the number on a wireframe die sat off its face when nothing animated
  (reduced motion, Skip); the browser tests left every test's tab running for
  the rest of the suite, which let one test's late roll land in another test's
  storage on Windows. The old 71-colour wheel pool and its curation script are
  gone.

### 0.4.0

- **A wheel can be a bag: draw without putting back.** Turn it on in the
  editor and an outcome that comes up is out until you refill — the play
  screen says "3 of 12 left" and gives you the button. What has been drawn is
  kept on this device rather than in the file, so two people rolling the same
  shared wheel each have their own bag.
- **Dice notation understands exploding dice, rerolls, success pools and Fate
  dice.** `3d6!` adds a die for every 6, `4d6r1` rerolls the ones, `4d6ro1`
  rerolls them once, `5d10>=8` answers with how many made it, and `4dF` rolls
  Fate dice. `adv` and `dis` are there for the two rolls everyone makes most.
- **Dice can be written into an outcome.** "{2d4} wolves, hungry" arrives at
  the table as "3 wolves, hungry", with the breakdown beside it. The braces are
  the whole of the opt-in, so "a d20 system" is left alone.
- **An imported table can give its weights as d100 ranges.** A column of
  `01-65`, `66-85`, `86-99` is read the way a published table means it, and the
  width of the range becomes the weight.
- **Roll behind the screen.** Tick Hidden and a press rolls without showing
  anything or writing anything down; the next press reveals it. For a game
  master with the wheel on a projector who needs to know first.
- **Roll several at once.** Set × to six and one press draws six outcomes, as
  one roll with one line in the history. A bag gives what it has left.
- **Favourites and what you rolled recently are on the home screen**, so the
  wheel a table has used all evening is one tap away rather than three.
- **Deleting a randomizer can be undone.** The toast offers Undo, and what
  comes back is the same file with the same identity, so boards and "goes to"
  links that pointed at it work again.
- **A list can be exported as CSV**, with exactly the columns the import
  wizard recognises, so a table can go out to a spreadsheet and come back.
- **The screen stays awake in full screen.** A table can go several minutes
  between rolls, which used to be long enough for a laptop to dim.
- **History shows dates, not just times, and an export now contains
  everything** that is stored rather than the recent slice on screen.
- **A failed save no longer goes unnoticed, or unrecoverable.** If a write
  fails you get one "Could not save your changes" with a Retry, the change
  stays queued, and saving keeps working afterwards — where before, one
  failure quietly stopped the app saving for the rest of the session.
- **An edit that would make a file unreadable is refused rather than
  written.** The editor keeps your half-typed dice expression and says why it
  is not saved; the file on disk keeps its last good state.
- **An update now reaches copies people already have.** The offline cache is
  named from the app's content, so a deploy arrives instead of waiting for
  the next version number.
- **A folder library notices edits made outside Orangey**, re-reading itself
  when you come back to the tab.
- Under the hood: the whole of `src/` is type-checked on every CI run, the
  outcome table no longer slows down as it grows, rolling lives in one place
  instead of three, and a good deal of duplication and dead code is gone.
  Several bugs went with it — wireframe dice freezing on a board, the ticker
  landing on nothing past 400 outcomes, a missing picture looping for ever, a
  malformed address blanking the page, and top-level fields in a file being
  dropped on re-save.

### After 0.3.1

- **Where an outcome sends you is chosen from the library, not a dropdown.**
  "Goes to" opens your library as a tree, with folders to open and a search box
  that flattens to matches across all of them — a list of every randomizer you
  own is fine with six and unusable with sixty. It also takes a pasted link,
  and can make the randomizer for you: a new one is added, set as the target,
  and opened so you can fill it in.
- **A board can be given a randomizer that does not exist yet.** Add… offers
  New wheel, dice, coin and number beside your library, because a board is
  usually assembled while thinking about tonight and half of what you want has
  not been written yet.
- **Right-click in the library** opens the same menu the ⋯ button does, and
  that menu now has **Copy link** — the link that opens that randomizer by id,
  so renaming or moving it later does not break what you pasted.

- **An outcome can carry a picture.** Put a portrait on "Owlbear" and the table
  sees an owlbear when the wheel lands on it: a round thumbnail sits in the
  slice, and the picture itself fills the space above the answer. Pictures are
  added in the outcome table, shrunk to 1600px on the way in, and kept beside
  the library rather than inside the randomizer's file — so a wheel of a dozen
  portraits is still a small, readable JSON, and a folder-backed library holds
  real PNGs you can swap out.
- **Pictures travel with a file, never in a link.** Export file inlines them so
  a single `.orangey.json` is whole; the ZIP export keeps them as separate
  files; an import takes either. A link carries the wheel and not the pictures,
  which is what keeps it short enough for a slide.
- **An outcome can send you to another randomizer.** Set "Goes to" on an
  outcome and rolling it opens that randomizer beside the wheel, waiting for
  its own press — a table that points at another table, which is how encounter
  tables have always been written. The newest two stay full size and earlier
  ones become icons showing the answer they gave; clicking one brings it back.
  A chain that circles back on itself stops and says so, and an outcome
  pointing at something deleted says which randomizer is missing.

- **Boards: several randomizers on one screen.** A board is a file in your
  library like a randomizer is. Put an encounter table, the weather and a d20
  on it, and they sit side by side, each with its own wheel or dice, its own
  answer and its own spin settings. **Roll all** spins everything at once;
  clicking one cell rolls just that one; full screen shows the same grid and
  space rolls everything. A board holds at most twelve, because past that the
  cells are too small to read across a table.
- **A board points at your randomizers rather than copying them**, by id, so
  renaming or moving one does not break the board and editing a table updates
  every board it is on. A randomizer you have deleted leaves a card saying
  which one is missing, rather than the board quietly shrinking. Add to a board
  with **Add…**, or by dragging from the library; drag a cell onto another to
  reorder.
- **A board travels as a file.** Share… on a board gives a link that opens it
  in the library it is already in — for a slide or a bookmark — and a download
  that packs the board together with every randomizer on it. One randomizer
  fits in an address; a board is several, and the link would outgrow what decks
  and chat apps carry. The library's ⋯ menu offers the same export, and
  importing an archive says so when a board arrives without one of its pieces.
- **Clear clears what is in front of you.** On a board, the rolls of the
  randomizers on it; on the play screen, the rolls of the randomizer you have
  open; on the History screen, everything. Each says what is about to go
  ("Clear 6 rolls from this board?"). The Recent rolls panel has its own Clear
  now, where it is needed mid-game.
- **A roll can be struck.** It stays where it is with a line through it, in
  Recent rolls and in the History screen, so a set-aside roll is visible rather
  than missing. The CSV export carries a struck column.

- **The wheel has three settings instead of four.** The wind-down choice
  (gentle / standard / snappy) is gone — one wind-down, the standard one, and
  the spin length is the control people actually reach for. The roll-back is a
  switch rather than a slider in degrees. Settings files, randomizer overrides
  and shared links that carry a curve or a number of degrees still load: the
  curve is honoured and simply not offered, and any roll-back above zero reads
  as on.
- **A much smaller test suite.** 299 unit tests became 105 and 95 browser
  tests became 44, with the browser run down from minutes to 79 seconds.
  Repeated tests became table-driven ones, the mascot's rules moved from the
  browser into unit tests, and the combination matrix went: it re-walked paths
  the feature tests already cover. Coverage was deliberately dropped in places
  — polyhedron geometry, palette curation (which `npm run check` enforces
  anyway), ZIP internals, most animation detail and most of the mascot. What
  remains was checked by breaking the app on purpose in seven ways — the
  pointer moved back to twelve o'clock, the roll-back bolted onto the end of
  the curve again, weights ignored, a 1 beside a 20 counted as a maximum, the
  link limit cut, labels flipped, the label measurer made to under-report —
  and every one was caught.
- **`orangey.html` is in the repository.** The whole app as one file, at the
  root, rebuilt by `npm run build:single` — hand it to someone, open it from a
  memory stick, or download it from GitHub; nothing to install and nothing to
  serve.

- **The roll-back is part of the spin now, not something added to the end of
  it.** The wheel used to follow its curve to the finish and then, from exactly
  three-quarters of the way through, have a bounce added on top. That addition
  starts at a speed of its own, so it always stepped the wheel up by about half
  a degree per frame. Gentle and standard are still turning at 7.3 and
  3.1°/frame there and swallowed it; snappy is down to 0.4°/frame with 3° of a
  2340° spin left, so it read as a halt, a jump forwards, and then the
  roll-back. The speed profile the curve is built from now takes a single dip
  below zero instead: the wheel decelerates, carries past where it will stop,
  turns once, and eases back. Measured on a real spin, the worst speed jump
  goes from ×1.83 to none.
- **The roll-back is now the number of degrees you asked for.** It was whatever
  the curve happened to be doing when the bounce arrived: the same 11° setting
  gave about 4° on gentle and 10° on snappy. All three curves now pass the
  target by the setting, within a fortieth of a degree.
- **Snappy winds down a little less abruptly** — `(1-t)^3` rather than
  `(1-t)^4`. At the old exponent a six-turn snappy spin was 2337° of 2340° done
  by 70 % of its duration, so the last third was a wheel standing still. It is
  still much the sharpest of the three.

### 0.3.1 — 2026-09-10

- **Wheel labels run along the radius, and the pointer is on the right.**
  Labels used to follow the rim, so a slice could only carry as many letters
  as it was wide: about three on a 32-outcome wheel. Written from the rim
  towards the hub, a label is limited by the radius instead, and the slice only
  needs to be as wide as the letters are tall — twelve or so characters at 32
  outcomes. Each label is sized to its slice and measured at the font actually
  in use, then cut with an ellipsis where it has to be.
- **The winner always arrives the right way up.** Labels on the lower half
  used to be flipped so they read upright at rest, but the flip travelled with
  the wheel, so any outcome from that half reached the pointer upside down.
  With the pointer at three o'clock and labels reading outwards, whatever wins
  arrives horizontal and reads towards it. A slice of nearly half the wheel
  or more now lands within 75° of its middle, so even its label never tips past
  vertical. Labels on the left read upside down while the wheel is still; that
  is the price, and the list beside the wheel is there for reading.
- **Wheels carry labels up to 48 outcomes** (was 32); unlabelled up to 200 and
  the ticker above that are unchanged.
- The labels' sizes now take effect: a stylesheet rule had been overriding
  every label to 11 px. And a slice thinner than the gap between slices no
  longer ends before it starts.
- Three browser tests no longer race the roll a slide link starts by itself
  one frame after it opens; about one run in thirty, a test's own press got in
  first and made two rolls.

### 0.3.0 — 2026-09-10

- **The browser suite cannot hang any more.** Every protocol call is capped,
  every test is capped, and on CI each test prints its name before it runs, so
  a stall is attributable from the log instead of guessed at. The job and the
  step have time limits too — a wedged browser used to mean a run sitting at
  GitHub's six-hour ceiling with nothing to show for it.
- **Full screen holds together.** A link with `present=1` opened in a tab that
  already had Orangey in it silently failed to fill the screen: the outgoing
  view was torn down after the incoming one had set itself up, and took the
  full-screen class with it. The app owns that now. And in full screen the
  wheel is sized by the height it is given rather than the width of the
  window, so a two-line answer can no longer be drawn over by it.

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

### 0.2.0 — 2026-09-10

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

### 0.1.0

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
