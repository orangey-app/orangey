# Dice notation

## What 0.1 understands

```
expr     := term (("+" | "-") term)*
term     := dice | integer
dice     := [count] "d" sides [keepdrop]
count    := 1–100        (default 1)
sides    := 2–1000, or "%" meaning 100
keepdrop := ("kh" | "kl" | "dh" | "dl") integer
```

Whitespace and case are ignored, so `2D6 + 3` and `2d6+3` are the same thing.

| you type | it means |
|---|---|
| `d20` | one twenty-sided die |
| `2d6 + 3` | two six-sided dice plus three |
| `d%` | a percentile die (`d100`) |
| `4d6kh3` | roll four, **k**eep the **h**ighest three — the classic ability score |
| `2d20kh1` | advantage |
| `2d20kl1` | disadvantage |
| `3d8dl1` | roll three, **d**rop the **l**owest |
| `d20 + 5 - 2` | modifiers stack, and may be negative |

## What you get back

Every die is recorded individually, kept or dropped, so the app can show

```
4d6kh3 [5, (1), 2, 5] = 12
```

with the dropped die in brackets and struck through, and a screen reader hears
"4d6kh3: 5, 2, 5, dropping 1. Total 12."

The theoretical minimum and maximum are computed alongside the result, which is
how a natural 20 is highlighted without hard-coding what a d20 is.

## Errors

Parse errors carry the position of the offending character, because "invalid
expression" with no position is useless when you are typing at a table:

```
2d6 + 
      ^ expected a number or a die such as d20
```

## Coming in 0.2

`!` exploding dice, `r<N` and `ro` rerolls, `>=N` success counting, `dF` Fate
dice, `adv`/`dis` as sugar for `2d20kh1`/`2d20kl1`, and `Nx(...)` repetition.
The grammar module is separate from everything else so that it can eventually
become a small library of its own.
