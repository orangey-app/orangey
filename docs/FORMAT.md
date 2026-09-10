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
one-line diff rather than a reshuffle.

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
| `withoutReplacement` | reserved for bag mode in 0.2 |

Each item has `id`, `label` (1–200 characters), `weight`, and optionally
`disabled`, `description`, `color` (a hex string), `reaction` (see below),
`metadata` (flat string/number/boolean pairs, where extra spreadsheet columns
end up).

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

## File names

`<slug of the name>.orangey.json`, with `-2`, `-3` appended on a collision.
Renaming a randomizer renames its file; the `id` inside is what actually
identifies it.

## What Orangey accepts

A bare randomizer object without the `format` wrapper is accepted, because it
is a natural thing to paste. The import wizard additionally accepts a JSON
array of strings or of `{label, weight}` objects.
