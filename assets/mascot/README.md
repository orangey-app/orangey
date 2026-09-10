# Orangey — source drawings

The owner's Illustrator exports, unmodified. `src/ui/mascot/parts.ts` is
derived from these: every path there is one of these paths translated into
the logo's coordinate space (the body starts at 133.13, 53.04).

| File | Pose | Notes |
|---|---|---|
| logo.svg | head-only tile | the app icon; three-quarter eyes, no mouth |
| surprised.svg | Reveal | three-quarter eyes, open O mouth |
| upset.svg | Oops | right eye only; the cream sliver is the squeezed-shut left eye |
| idle.svg | Idle | eye-contact eyes; the smile |
| happy.svg | Happy | eye-contact eyes; the same lip line as idle, opened wider |
| anticipation.svg | Anticipate | the cockeyed squint (deliberate); legs nudged (−3.58, +1.10) by accident — the rig ignores them and uses the canonical legs |

Consistency across the six was measured in the motion sheet session: the
body outline differs by at most 0.0005 units between files, the stem is
identical, and every eye is the same 7.09 × 9.92 ellipse.
