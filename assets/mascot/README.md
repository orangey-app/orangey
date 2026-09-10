# Orangey — source drawings

**Copyright (c) 2026 Amogh Kinikar. All rights reserved.** These drawings, the
character they depict, the geometry derived from them in
`src/ui/mascot/parts.ts`, the app icon, and the same artwork inside any built
file are not part of the MIT-licensed software — see the top of `LICENSE`.
They may stay in place, unmodified, as the mascot of this application when it
is run, forked or redistributed; any other use, alteration or redistribution
of the character needs the author's written permission.

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
