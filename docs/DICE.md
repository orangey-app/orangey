# Dice notation

## What Orangey understands

```
expr     := term (("+" | "-") term)*
term     := dice | integer | "adv" | "dis"
dice     := [count] "d" sides [explode] [reroll] [keepdrop] [success]
count    := 1–100                          (default 1)
sides    := 2–1000, or "%" meaning 100, or "F" for Fate
explode  := "!"
reroll   := ("ro" | "r") [cmp] integer     cmp defaults to "="
keepdrop := ("kh" | "kl" | "dh" | "dl") integer
success  := cmp integer
cmp      := ">=" | "<=" | ">" | "<" | "="
```

Whitespace and case are ignored, so `2D6 + 3` and `2d6+3` are the same thing.

**The modifiers come in that order.** `2d6!r1kh1>=4` is valid; `2d6kh1!` is
not, and says so. A fixed order means every expression has exactly one
canonical form, which is what gets stored in a file and repeated from the
history.

| you type | it means |
|---|---|
| `d20` | one twenty-sided die |
| `2d6 + 3` | two six-sided dice plus three |
| `d%` | a percentile die (`d100`) |
| `4d6kh3` | roll four, **k**eep the **h**ighest three — the classic ability score |
| `2d20kh1` | advantage |
| `2d20kl1` | disadvantage |
| `adv` / `dis` | the same two, spelled the way people say them |
| `3d8dl1` | roll three, **d**rop the **l**owest |
| `d20 + 5 - 2` | modifiers stack, and may be negative |
| `3d6!` | **exploding**: every 6 adds another die, and that one can explode too |
| `4d6r1` | **reroll** every 1, as often as it takes |
| `4d6ro1` | reroll a 1 **o**nce, and take what comes |
| `4d6r<3` | reroll anything under 3 |
| `5d10>=8` | a **success pool**: the answer is how many dice made it |
| `4dF` | four **Fate** dice, each −1, 0 or +1 |

A reroll that would reject every face is refused rather than looping for
ever, and Fate dice cannot explode: there is no single top face to explode
on. Runaway rolls stop at 100 rerolls per die and 100 extra dice per term.

In the tray, an explosion's dice and a reroll's replacement land in a throw
of their own after the dice that caused them, the way they would at a table.
Each die records which throw it belongs to (`wave`), so the tray never has to
work it out; only the first three extra throws get a beat of their own.

## What you get back

Every die is recorded individually, kept or dropped, so the app can show

```
4d6kh3 [5, (1), 2, 5] = 12
```

with the dropped die in brackets and struck through, and a screen reader hears
"4d6kh3: 5, 2, 5, dropping 1. Total 12."

Rerolled dice appear in brackets like dropped ones — what happened at the
table is part of the answer — exploded dice carry a `!`, and Fate dice show
their sign: `4dF [+1, -1, 0, +1] = 1`. A success pool ends in words rather
than a bare number: `5d10>=8 [9, 3, 8, 10, 1] = 3 successes`.

The theoretical minimum and maximum are computed alongside the result, which is
how a natural 20 is highlighted without hard-coding what a d20 is. An
exploding roll has no maximum, so the one reported is a floor and the result
is flagged open-ended instead. A reroll narrows the range in the other
direction: `d6r1` can never end on a 1, so its minimum is 2.

## Dice inside an outcome

A list outcome's label, and its description, may hold a dice expression in
braces: `You find {2d6} silver` rolls two dice when that outcome comes up and
reads back as `You find 7 silver`. Anything between the braces goes through the
same parser; braces holding something that is not an expression are left
exactly as they were typed, so a label that happens to contain `{loot}` is
safe.

The expansion happens **after** the outcome has been picked, never before, so
adding braces to a label does not change which outcome a seeded session draws.
A run with a seed therefore still replays exactly — the pick first, then the
inline rolls, always in that order.

## Errors

Parse errors carry the position of the offending character, because "invalid
expression" with no position is useless when you are typing at a table:

```
2d6 + 
      ^ expected a number or a die such as d20
```

## Not supported

Deliberately out of scope, because each needs an expression tree rather than
the flat list of signed terms this grammar produces, and that is a larger
piece of work than the notation itself:

brackets, multiplication, `Nx(...)` repetition, compounding or penetrating
explosions, and reroll-and-keep variants.

The grammar module is separate from everything else so that it can eventually
become a small library of its own.
