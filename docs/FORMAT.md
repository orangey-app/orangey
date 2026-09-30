# The `.orangey.json` file format

Version 1.

A randomizer is one JSON file. There is no database and no index: **the folder
tree is the library**, so a library kept in Dropbox, Nextcloud or Git cannot
develop a conflict between the files and something that claims to describe
them.

```json
{
  "format": "orangey",
  "version": 1,
  "randomizer": {
    "id": "5f1c0000-0000-4000-8000-000000000001",
    "type": "list",
    "name": "Forest Encounters",
    "description": "Daytime, levels 1–4",
    "view": "wheel",
    "created": "2026-09-08T18:00:00.000Z",
    "modified": "2026-09-08T18:20:00.000Z",
    "items": [
      { "id": "a1", "label": "Goblin patrol", "weight": 50 },
      { "id": "a2", "label": "Merchant", "weight": 20, "description": "Friendly, overpriced" },
      { "id": "a3", "label": "Wolf pack", "weight": 20, "disabled": true },
      { "id": "a4", "label": "Dragon", "weight": 1, "color": "#a33a30", "reaction": "cheer" }
    ]
  }
}
```

## Conventions

UTF-8, LF line endings, two-space indentation, and keys written in a fixed
order, so that editing a file by hand and letting Orangey re-save it produces a
one-line diff rather than a reshuffle. The key order is **append only**: a new
key goes at the end of the order, never among the existing ones, so a file
written before that key existed keeps its exact bytes when it is saved again.
The same holds for `.orangey-settings.json`.

**Unknown keys are preserved.** A file written by a newer version and re-saved
by an older one keeps whatever the older one did not understand. A file whose
`version` is higher than the running app knows opens **read-only** with an
explanation, rather than being guessed at.

## Fields

Every randomizer has `id` (stable across renames — history and favourites refer
to it), `type`, `name` (1–120 characters), and optionally `description`,
`tags`, `created`, `modified`.

### `type: "list"`

The type behind choices, weighted choices and wheels — they are one thing shown
two ways.

| field | meaning |
|---|---|
| `items` | at least one outcome |
| `view` | `"wheel"` or `"list"` |
| `withoutReplacement` | bag mode: an outcome that has come up cannot come up again until the bag is refilled |
| `slices` | what a wheel's slice shows when its outcome has a picture: `"pictures"`, `"names"` or `"both"`. Left out means `"pictures"`; slices without a picture always show their name |
| `offer` | make a choice: a roll draws this many different outcomes (2 to 12) and the player picks one, which is the outcome. Left out, a roll lands on one outcome. Where fewer can come up — a bag nearly empty — it offers what there is |
| `palette` | the wheel's own slice colours: three in turn and an optional spare, as `"#rrggbb"` strings. Left out means the theme's colours; with three, the theme's spare. An outcome's own `color` still wins |

**Where the bag's state is kept.** The flag above says the randomizer is a
bag; it does not say what has been drawn out of it. That list lives in the
browser's app database, keyed by the randomizer's id, exactly like history
does — never in this file. Two reasons: a draw would otherwise be a write to
the user's library on every roll, with everything that means for a library in
Dropbox or Git; and two people rolling the same shared wheel would be sharing
one bag, which is not what "draw without putting back" means at a table. A
randomizer that arrived inside a link gets a bag that lasts as long as the
page, because its item ids are made fresh on every load and a stored bag
could never match them again.

Each item has `id`, `label` (1–200 characters), `weight`, and optionally
`disabled`, `description`, `color` (a hex string), `reaction` (see below),
`metadata` (flat string/number/boolean pairs, where extra spreadsheet columns
end up).

**A label or description may carry dice in braces.** `You find {2d6} silver`
is stored exactly as written — the braces are part of the text, not a new
field — and rolled when that outcome comes up, as
[DICE.md](DICE.md) describes. A file read by anything that does not know about
this still holds a sensible, if literal, label.

**`reaction`** is what Orangey the mascot does when this outcome comes up:
`"cheer"` or `"wince"`. Dice and number draws need no tag — a maximum roll is
a cheer and a minimum a wince by themselves — but a wheel has no natural top or
bottom, so the game master marks the outcomes that deserve one. The value names
what he does, never which animation plays, so a new pose is never a format
change. Left out means no reaction beyond the ordinary one when a roll lands.

**Weights are non-negative numbers and Orangey normalizes them**, so
`50/30/20` and `5/3/2` behave identically and nothing has to add up to 100.

**An outcome can come up when it is not `disabled` and its weight is above
zero.** `disabled` exists as its own flag rather than being expressed as a
weight of zero so that turning an outcome off and on again restores its
original weight exactly.

### `type: "dice"`

`expression`, in the notation described in [DICE.md](DICE.md).

### `type: "coin"`

`faces`: exactly two strings. Optionally `faceReactions`: two entries in the
same order as `faces`, each `"cheer"`, `"wince"` or `null`, with the meaning
described under `reaction` above.

### `type: "number"`

`min`, `max`, `integer`, `inclusiveMax`, `count` (1–1000), `unique`.

### `type: "inkblot"`

No fields of its own. Every roll draws a new symmetrical inkblot from one
number, so the file only names it. Orangey 0.8 and earlier do not know this
type and refuse the file.

### `type: "board"`

Several randomizers on one screen, rolled together or one at a time.
`entries` lists them in order, at most 12, each as `{ "id", "name" }`: the
randomizer's `id`, and the name it had when it was put on the board. The id is
what finds it, so renaming or moving a randomizer does not break the board;
the name is what the board shows when the randomizer has been deleted. The
same randomizer cannot be on a board twice, and a board cannot hold another
board.

```json
{
  "id": "…",
  "type": "board",
  "name": "Tonight",
  "entries": [
    { "id": "5f1c0000-0000-4000-8000-000000000001", "name": "Forest Encounters" },
    { "id": "…", "name": "Attack roll" }
  ]
}
```

A board carries references, not copies, so it is shared as an archive of the
board and everything on it (Share… on the board), never inside a link. What a
bag on a board has drawn, and any dice or quick wheel added to a board just
for tonight, are kept in the browser like a bag's draws, never in this file.

## File names

`<slug of the name>.orangey.json`, with `-2`, `-3` appended on a collision.
Renaming a randomizer renames its file; the `id` inside is what actually
identifies it.

## What Orangey accepts

A bare randomizer object without the `format` wrapper is accepted, because it
is a natural thing to paste. The import wizard additionally accepts a JSON
array of strings or of `{label, weight}` objects.

Opening is lenient and saving is strict. A file only has to be well formed to
open, so one already on disk with, say, a dice expression that no longer
parses still opens and can be fixed. The editors check more before they save
(`draftProblem` in `src/model/draft.ts`): Orangey never writes a file it could
not load again.

## A library file

`<name>.orangey-library.json` is a library, or part of one, as a single
plain-text file — something a person can read before importing it, and paste
into a forum post. The library's storage badge exports the whole library this
way, a folder's menu exports that folder, and the selection bar exports what
is selected. The Import page takes the file dropped on it, or its text
pasted into its box.

```json
{
  "format": "orangey-library",
  "version": 1,
  "name": "Forest tables",
  "exported": "2026-09-27T18:04:11.512Z",
  "folders": ["Forest", "Forest/Night", "Treasure"],
  "randomizers": [
    {
      "path": "Forest/encounters.orangey.json",
      "randomizer": { "id": "…", "type": "list", "name": "Encounters", "…": "…" }
    }
  ]
}
```

- `format` and `version` are the library file's own, separate from a
  randomizer file's. A version newer than the reader knows is refused rather
  than guessed at, since a library is written into yours or not at all.
- `randomizer` is exactly what a `.orangey.json` holds under the same key,
  checked the same way; one that fails is left out and named, and the rest
  still import.
- `path` is where it lives, `/`-separated. Each part is cleaned on the way
  in as a typed folder name would be, so `..`, drive letters and leading
  slashes cannot place a file outside the folder being imported into. A
  path that does not end in `.orangey.json` is given a name from the
  randomizer's.
- `folders` lists folders to make, so empty ones arrive too.
- **Links are kept.** "Goes to" and a board's entries name randomizers by
  `id`, so ids travel. Exporting brings along everything the chosen ones
  link to, at its own path. On import, a randomizer whose id is already in
  use gets a new one, and every link in the file is rewritten to match:
  Skip points the file's links at what is already there, Replace keeps the
  existing file's id (so boards that point at it keep working), and Keep
  both makes a copy under a new id that the file's links follow.
- **Pictures are never included.** An outcome's `image` and `imageData` are
  removed on export and ignored on import. The ZIP export keeps pictures.

## A randomizer inside a link

`#/roll?w=…` carries a whole randomizer in the address instead of naming one
in a library. What follows `w=` is a marker character — `1` deflated, `0`
stored — then base64url of the randomizer as JSON, with three things left out:
`created` and `modified`, which mean nothing to a stranger, and the outcomes'
`id`s, which are library bookkeeping and would otherwise be the largest thing
in the payload. All three are made afresh when the link is opened, so the
wheel that arrives is a randomizer of its own, ready to be saved. Pictures
never travel (`image` and `imageData` are left out too): their bytes would make
an address nobody can paste, and a picture id means nothing on another device.

A link is a frozen copy: it rolls the same wheel in a year, whatever has
happened to the library since. A library link (`#/id/…`) is the opposite — it
follows edits, but only works on a device that holds that library.

Everything else travels, including per-outcome `reaction` tags and the
randomizer's own `feel`. `feel` can only override the wheel, dice and coin
sections, never `motion`, so an author's five-second spin arrives intact while
the reader keeps authority over whether anything moves at all.

The payload sits after the `#`, and browsers never send a fragment to a
server: a link carries an encounter table past the host that serves Orangey
without it ever seeing it. A twenty-row table comes to a few hundred
characters. Past 2,000 the app says the link is unwieldy; past 8,000 it will
not offer one.
