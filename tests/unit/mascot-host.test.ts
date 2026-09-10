import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REACTIONS, mayInterrupt, pickReaction, MASCOT_SALIENCE } from "../../src/ui/mascot/reactions.ts";
import { MascotHost, type MascotTimers } from "../../src/ui/mascot/host.ts";
import { emitMascotEvent, type MascotEvent } from "../../src/ui/mascot/events.ts";
import type { Mascot, MascotOptions } from "../../src/ui/mascot/mascot.ts";
import { DEFAULT_FEEL, LIMITS, MASCOT_HOLD_MS, MASCOT_ANTICIPATE_MIN_MS, mascotHoldMs, normalizeFeel, type FeelSettings } from "../../src/ui/feel.ts";

const land = (extreme: "max" | "min" | null, mood: "cheer" | "wince" | null = null): MascotEvent => ({
  type: "roll:land", source: "dice", summary: { kind: "dice", extreme, mood, text: "x" },
});

describe("reactions table", () => {
  test("first matching row wins: a max is happy before it is a plain landing", () => {
    assert.equal(pickReaction(land("max"), DEFAULT_REACTIONS)?.then, "happy");
    assert.equal(pickReaction(land("min"), DEFAULT_REACTIONS)?.then, "oops");
    assert.equal(pickReaction(land(null), DEFAULT_REACTIONS)?.then, "reveal");
  });

  test("a tagged outcome is a cheer or a wince, before any extreme is considered", () => {
    assert.equal(pickReaction(land(null, "cheer"), DEFAULT_REACTIONS)?.id, "outcome-cheer");
    assert.equal(pickReaction(land(null, "wince"), DEFAULT_REACTIONS)?.id, "outcome-wince");
    assert.equal(pickReaction(land(null, "cheer"), DEFAULT_REACTIONS)?.then, "happy");
    assert.equal(pickReaction(land(null, "wince"), DEFAULT_REACTIONS)?.then, "oops");
  });

  test("switching off the tag rules leaves a tagged outcome as a plain landing", () => {
    const off = (id: string) => !id.startsWith("outcome-");
    assert.equal(pickReaction(land(null, "cheer"), DEFAULT_REACTIONS, off)?.then, "reveal");
    assert.equal(pickReaction(land(null, "wince"), DEFAULT_REACTIONS, off)?.then, "reveal");
  });

  test("a switched-off rule is skipped and the next match applies", () => {
    const off = (id: string) => id !== "roll-max";
    assert.equal(pickReaction(land("max"), DEFAULT_REACTIONS, off)?.then, "reveal");
    const none = (id: string) => !id.startsWith("roll-");
    assert.equal(pickReaction(land("max"), DEFAULT_REACTIONS, none), null);
  });

  test("failures and links are oops; a clean import is happy", () => {
    assert.equal(pickReaction({ type: "roll:fail", source: "list", reason: "x" }, DEFAULT_REACTIONS)?.then, "oops");
    assert.equal(pickReaction({ type: "link:fail", id: "abc" }, DEFAULT_REACTIONS)?.then, "oops");
    assert.equal(pickReaction({ type: "import:done", ok: true, skipped: 0 }, DEFAULT_REACTIONS)?.then, "happy");
    assert.equal(pickReaction({ type: "import:done", ok: false, skipped: 3 }, DEFAULT_REACTIONS)?.then, "oops");
  });

  test("salience: higher interrupts, equal restarts, lower waits", () => {
    const by = (id: string) => DEFAULT_REACTIONS.find((r) => r.id === id)!;
    assert.equal(mayInterrupt(by("roll-land"), by("roll-min")), true);
    assert.equal(mayInterrupt(by("roll-min"), by("roll-land")), false);
    assert.equal(mayInterrupt(by("roll-max"), by("import-ok")), true);
    assert.equal(mayInterrupt(null, by("roll-start")), true);
    assert.ok(MASCOT_SALIENCE.oops > MASCOT_SALIENCE.happy && MASCOT_SALIENCE.happy > MASCOT_SALIENCE.reveal);
  });

  test("every row has a unique id and a label for the settings panel", () => {
    const ids = DEFAULT_REACTIONS.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of DEFAULT_REACTIONS) assert.ok(r.label.length > 0, r.id);
  });
});

describe("mascot settings", () => {
  test("defaults: present on triggers, the drawn maximum wobble, every rule on", () => {
    assert.deepEqual(DEFAULT_FEEL.mascot, { presence: "triggers", wobble: 1.8, rules: {} });
    assert.deepEqual(normalizeFeel(undefined).mascot, DEFAULT_FEEL.mascot);
  });

  test("a hand-edited preference is clamped: wobble 99 → 1.8, presence 'loud' → triggers", () => {
    const f = normalizeFeel({ mascot: { presence: "loud", wobble: 99, rules: { "roll-max": false, "roll-min": "no" } } });
    assert.equal(f.mascot.presence, "triggers");
    assert.equal(f.mascot.wobble, LIMITS.mascotWobble[1]);
    assert.deepEqual(f.mascot.rules, { "roll-max": false }, "only a real false switches a rule off");
  });

  test("hold times scale with the motion level and a failed link holds longest", () => {
    const quick: FeelSettings = { ...DEFAULT_FEEL, motion: "quick" };
    assert.equal(mascotHoldMs("happy", DEFAULT_FEEL), MASCOT_HOLD_MS.happy);
    assert.equal(mascotHoldMs("happy", quick), MASCOT_HOLD_MS.happy * 0.4);
    assert.equal(mascotHoldMs("unknown-state", DEFAULT_FEEL), MASCOT_HOLD_MS.default);
    assert.ok(mascotHoldMs("oops", DEFAULT_FEEL, "link:fail") > mascotHoldMs("oops", DEFAULT_FEEL));
  });
});

/* ---- the host, with a fake clock and a fake mascot ---------------------- */

function fakeTimers(): MascotTimers & { advance(ms: number): void; time: number } {
  const queue: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const timers = {
    time: 0,
    set(fn: () => void, ms: number) {
      const id = next++;
      queue.push({ at: timers.time + ms, fn, id });
      return id;
    },
    clear(handle: unknown) {
      const i = queue.findIndex((q) => q.id === handle);
      if (i >= 0) queue.splice(i, 1);
    },
    now: () => timers.time,
    advance(ms: number) {
      const until = timers.time + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const head = queue[0];
        if (!head || head.at > until) break;
        queue.shift();
        timers.time = head.at;
        head.fn();
      }
      timers.time = until;
    },
  };
  return timers;
}

function fakeMascot(): Mascot & { log: string[]; classes: Set<string> } {
  const classes = new Set<string>();
  const log: string[] = [];
  const el = {
    classList: { add: (c: string) => classes.add(c), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), contains: (c: string) => classes.has(c) },
    parentElement: null,
    remove: () => log.push("remove"),
  } as unknown as HTMLElement;
  const model = { state: "idle" } as Mascot["model"];
  return {
    el,
    model,
    log,
    classes,
    setState(name) { model.state = name; log.push(`state:${name}`); },
    setWobble(g) { log.push(`wobble:${g}`); },
    setMotion(m) { log.push(`motion:${m}`); },
    pause() { log.push("pause"); },
    resume() { log.push("resume"); },
    destroy() { log.push("destroy"); },
  };
}

function makeHost(over: Partial<FeelSettings["mascot"]> = {}, motion: FeelSettings["motion"] = "full") {
  const bus = new EventTarget();
  const timers = fakeTimers();
  let feel: FeelSettings = normalizeFeel({ ...DEFAULT_FEEL, motion, mascot: { ...DEFAULT_FEEL.mascot, ...over } });
  let mascot = fakeMascot();
  let created = 0;
  const host = new MascotHost({ bus, feel: () => feel, timers, factory: (_o: MascotOptions) => { created++; return (mascot = fakeMascot()); } });
  return { bus, timers, host, get mascot() { return mascot; }, get created() { return created; }, setFeel(patch: Partial<FeelSettings>) { feel = normalizeFeel({ ...feel, ...patch }); host.applyFeel(); } };
}

describe("mascot host", () => {
  test("presence 'triggers': invisible until a roll lands, then holds, then fades", () => {
    const { bus, timers, host, mascot } = makeHost();
    assert.equal(host.visible, false);
    emitMascotEvent(bus, land(null));
    assert.equal(host.visible, true);
    assert.equal(host.state, "reveal");
    timers.advance(MASCOT_HOLD_MS.reveal - 1);
    assert.equal(host.visible, true);
    timers.advance(2);
    assert.equal(host.visible, false);
    assert.ok(mascot.log.includes("pause"), "the ticker is released when he fades");
  });

  test("presence 'always': idles between reactions and returns to idle after one", () => {
    const { bus, timers, host } = makeHost({ presence: "always" });
    assert.equal(host.visible, true);
    assert.equal(host.state, "idle");
    emitMascotEvent(bus, land("max"));
    assert.equal(host.state, "happy");
    timers.advance(MASCOT_HOLD_MS.happy + 1);
    assert.equal(host.state, "idle");
    assert.equal(host.visible, true);
  });

  test("presence 'hidden': no mascot exists and events are ignored", () => {
    const { bus, host } = makeHost({ presence: "hidden" });
    assert.equal(host.el, null);
    emitMascotEvent(bus, land("max"));
    assert.equal(host.el, null);
    assert.deepEqual(host.played, []);
  });

  test("a max roll is happy, a min roll is oops, a plain landing is reveal — and each new roll takes over", () => {
    const { bus, host } = makeHost({ presence: "always" });
    emitMascotEvent(bus, land("max"));
    emitMascotEvent(bus, land("min"));
    emitMascotEvent(bus, land(null)); // a fresh roll is never held back by the last one
    assert.deepEqual(host.played, ["happy", "oops", "reveal"]);
    assert.equal(host.state, "reveal");
  });

  test("salience arbitrates everything that is not a roll: an import waits behind an Oops, a link failure restarts it", () => {
    const { bus, timers, host } = makeHost({ presence: "always" });
    emitMascotEvent(bus, land("min")); // oops, salience 4
    emitMascotEvent(bus, { type: "import:done", ok: true, skipped: 0 }); // happy, 3: waits
    assert.equal(host.state, "oops");
    emitMascotEvent(bus, { type: "link:fail", id: "x" }); // oops, 4: restarts
    assert.deepEqual(host.played, ["oops", "oops"]);
    timers.advance(MASCOT_HOLD_MS.oops + 5000);
    assert.equal(host.state, "idle");
  });

  test("a new roll starting ends whatever he was doing about the last one", () => {
    const { bus, timers, host } = makeHost({ presence: "always" });
    emitMascotEvent(bus, land("max"));
    assert.equal(host.state, "happy");
    emitMascotEvent(bus, { type: "roll:start", source: "dice" });
    timers.advance(MASCOT_ANTICIPATE_MIN_MS + 1);
    assert.equal(host.state, "anticipate");
  });

  test("anticipation waits a beat, so an instant landing never flashes it", () => {
    const { bus, timers, host } = makeHost();
    emitMascotEvent(bus, { type: "roll:start", source: "dice" });
    assert.equal(host.visible, false, "not yet");
    emitMascotEvent(bus, land(null)); // arrives within the gap
    timers.advance(MASCOT_ANTICIPATE_MIN_MS * 2);
    assert.deepEqual(host.played, ["reveal"], "anticipate was cancelled by the landing");
  });

  test("a slow roll shows anticipation, and the landing replaces it", () => {
    const { bus, timers, host } = makeHost();
    emitMascotEvent(bus, { type: "roll:start", source: "list" });
    timers.advance(MASCOT_ANTICIPATE_MIN_MS + 1);
    assert.equal(host.state, "anticipate");
    timers.advance(1500);
    assert.equal(host.state, "anticipate", "still watching at 1.5 s");
    emitMascotEvent(bus, land(null));
    assert.equal(host.state, "reveal");
    assert.deepEqual(host.played, ["anticipate", "reveal"]);
  });

  test("a switched-off rule does nothing; the rest still work", () => {
    const { bus, host } = makeHost({ presence: "always", rules: { "roll-max": false } });
    emitMascotEvent(bus, land("max"));
    assert.equal(host.state, "reveal", "max falls through to the plain landing");
  });

  test("a failed link is an oops with the longer hold", () => {
    const { bus, timers, host } = makeHost();
    emitMascotEvent(bus, { type: "link:fail", id: "nope" });
    assert.equal(host.state, "oops");
    timers.advance(MASCOT_HOLD_MS.oops + 1);
    assert.equal(host.visible, true, "a link failure holds longer than a plain oops");
    timers.advance(1000);
    assert.equal(host.visible, false);
  });

  test("changing presence to hidden destroys him; back to triggers recreates him idle and invisible", () => {
    const h = makeHost({ presence: "always" });
    const first = h.mascot;
    h.setFeel({ mascot: { ...DEFAULT_FEEL.mascot, presence: "hidden" } });
    assert.ok(first.log.includes("destroy"));
    assert.equal(h.host.el, null);
    h.setFeel({ mascot: { ...DEFAULT_FEEL.mascot, presence: "triggers" } });
    assert.notEqual(h.host.el, null);
    assert.equal(h.host.visible, false);
    assert.equal(h.host.state, "idle");
  });

  test("wobble and motion changes reach the mascot", () => {
    const h = makeHost({ presence: "always" });
    h.setFeel({ motion: "quick", mascot: { ...DEFAULT_FEEL.mascot, presence: "always", wobble: 1 } });
    assert.ok(h.mascot.log.includes("wobble:1"));
    assert.ok(h.mascot.log.includes("motion:quick"));
  });

  test("only one mascot ever exists, however many events arrive", () => {
    const h = makeHost({ presence: "always" });
    for (let i = 0; i < 50; i++) {
      emitMascotEvent(h.bus, { type: "roll:start", source: "dice" });
      h.timers.advance(MASCOT_ANTICIPATE_MIN_MS + 5);
      emitMascotEvent(h.bus, land(i % 3 === 0 ? "max" : null));
      h.timers.advance(300);
    }
    assert.equal(h.created, 1, "the factory ran once for fifty rolls");
    assert.equal(h.host.el, h.mascot.el);
  });
});
