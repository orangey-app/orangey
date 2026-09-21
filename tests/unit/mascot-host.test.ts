import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REACTIONS, mayInterrupt, pickReaction, MASCOT_SALIENCE } from "../../src/ui/mascot/reactions.ts";
import { MascotHost, type MascotTimers } from "../../src/ui/mascot/host.ts";
import { emitMascotEvent, type MascotEvent } from "../../src/ui/mascot/events.ts";
import type { Mascot, MascotOptions } from "../../src/ui/mascot/mascot.ts";
import { DEFAULT_FEEL, LIMITS, MASCOT_HOLD_MS, MASCOT_ANTICIPATE_MIN_MS, mascotRuleOn, normalizeFeel, type FeelSettings } from "../../src/ui/feel.ts";

const land = (extreme: "max" | "min" | null, mood: "cheer" | "wince" | null = null): MascotEvent => ({
  type: "roll:land", source: "dice", summary: { kind: "dice", extreme, mood, text: "x" },
});

describe("reactions table", () => {
  test("each event picks its rule, and the first row that matches wins", () => {
    const cases: [string, MascotEvent, string, string][] = [
      ["a roll starting", { type: "roll:start", source: "dice" }, "roll-start", "anticipate"],
      ["a maximum roll", land("max"), "roll-max", "happy"],
      ["a minimum roll", land("min"), "roll-min", "oops"],
      ["a landing that is neither", land(null), "roll-land", "reveal"],
      ["an outcome the author tagged to cheer", land(null, "cheer"), "outcome-cheer", "happy"],
      ["an outcome the author tagged to wince", land(null, "wince"), "outcome-wince", "oops"],
      // A tag is the author speaking about this wheel, so it is considered
      // before anything Orangey works out for itself.
      ["a tag on a roll that is also a maximum", land("max", "wince"), "outcome-wince", "oops"],
      ["a roll that cannot happen", { type: "roll:fail", source: "list", reason: "x" }, "roll-fail", "oops"],
      ["a link that points nowhere", { type: "link:fail", id: "abc" }, "link-fail", "oops"],
      ["a clean import", { type: "import:done", ok: true, skipped: 0 }, "import-ok", "happy"],
      ["an import with problems", { type: "import:done", ok: false, skipped: 3 }, "import-warn", "oops"],
    ];
    for (const [what, event, id, then] of cases) {
      const picked = pickReaction(event, DEFAULT_REACTIONS);
      assert.equal(picked?.id, id, what);
      assert.equal(picked?.then, then, what);
    }
    // Every row is switchable from Settings, so each needs its own id and a name.
    const ids = DEFAULT_REACTIONS.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of DEFAULT_REACTIONS) assert.ok(r.label.length > 0, r.id);
  });

  test("a switched-off rule is skipped, and the next row that matches applies instead", () => {
    const cases: [string, MascotEvent, (id: string) => boolean, string | null][] = [
      ["a maximum with its own rule off falls through to a plain landing", land("max"), (id) => id !== "roll-max", "reveal"],
      ["a tagged cheer with the tag rules off does too", land(null, "cheer"), (id) => !id.startsWith("outcome-"), "reveal"],
      ["and a tagged wince", land(null, "wince"), (id) => !id.startsWith("outcome-"), "reveal"],
      // With nothing left to match, he simply does not appear.
      ["a maximum with every roll rule off produces nothing at all", land("max"), (id) => !id.startsWith("roll-"), null],
    ];
    for (const [what, event, isOn, then] of cases) {
      assert.equal(pickReaction(event, DEFAULT_REACTIONS, isOn)?.then ?? null, then, what);
    }
    // …and the host reads the same switches, so what Settings says is what happens.
    const off = makeHost({ presence: "always", rules: { "roll-max": false } });
    emitMascotEvent(off.bus, land("max"));
    assert.equal(off.host.state, "reveal", "max falls through to the plain landing");
  });

  test("out of the box he appears on triggers, and the four noisiest rules ship off", () => {
    assert.equal(DEFAULT_FEEL.mascot.presence, "triggers");
    assert.equal(DEFAULT_FEEL.mascot.wobble, 1.8);
    // Off out of the box: watching every roll, reacting to every ordinary
    // landing, wincing at a roll that cannot happen, and wincing at an import
    // that merely had warnings.
    assert.deepEqual(DEFAULT_FEEL.mascot.rules, {
      "roll-start": false,
      "roll-land": false,
      "roll-fail": false,
      "import-warn": false,
    });
    const on = (id: string) => mascotRuleOn(DEFAULT_FEEL, id);
    for (const id of ["outcome-cheer", "outcome-wince", "roll-max", "roll-min", "link-fail", "import-ok"]) {
      assert.equal(on(id), true, `${id} should be on out of the box`);
    }
    for (const id of ["roll-start", "roll-land", "roll-fail", "import-warn"]) {
      assert.equal(on(id), false, `${id} should be off out of the box`);
    }
    // every row in the table is accounted for above
    assert.equal(DEFAULT_REACTIONS.length, 10);
    assert.deepEqual(normalizeFeel(undefined).mascot, DEFAULT_FEEL.mascot);

    // An empty rules object is someone having switched everything on, and has
    // to survive a round trip through the settings file as exactly that.
    const all = normalizeFeel({ mascot: { ...DEFAULT_FEEL.mascot, rules: {} } });
    assert.deepEqual(all.mascot.rules, {});
    for (const r of DEFAULT_REACTIONS) assert.equal(mascotRuleOn(all, r.id), true, r.id);

    // A hand-edited preference is clamped rather than refused.
    const edited = normalizeFeel({ mascot: { presence: "loud", wobble: 99, rules: { "roll-max": false, "roll-min": "no" } } });
    assert.equal(edited.mascot.presence, "triggers");
    assert.equal(edited.mascot.wobble, LIMITS.mascotWobble[1]);
    assert.deepEqual(edited.mascot.rules, { "roll-max": false }, "only a real false switches a rule off");
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
  // Every rule on unless a test says otherwise: these are about what the host
  // does with a reaction, not about which reactions Orangey ships with.
  let feel: FeelSettings = normalizeFeel({ ...DEFAULT_FEEL, motion, mascot: { ...DEFAULT_FEEL.mascot, rules: {}, ...over } });
  let mascot = fakeMascot();
  let created = 0;
  const host = new MascotHost({ bus, feel: () => feel, timers, factory: (_o: MascotOptions) => { created++; return (mascot = fakeMascot()); } });
  return { bus, timers, host, get mascot() { return mascot; }, get created() { return created; }, setFeel(patch: Partial<FeelSettings>) { feel = normalizeFeel({ ...feel, ...patch }); host.applyFeel(); } };
}

describe("mascot host", () => {
  test("presence decides whether he is there at all, and there is only ever one of him", () => {
    // hidden: he does not exist, and nothing that happens brings him back.
    const hidden = makeHost({ presence: "hidden" });
    assert.equal(hidden.host.el, null);
    emitMascotEvent(hidden.bus, land("max"));
    assert.equal(hidden.host.el, null);
    assert.deepEqual(hidden.host.played, []);

    // triggers: invisible until something happens, then he holds and fades.
    const triggers = makeHost();
    assert.equal(triggers.host.visible, false);
    emitMascotEvent(triggers.bus, land(null));
    assert.equal(triggers.host.visible, true);
    assert.equal(triggers.host.state, "reveal");
    triggers.timers.advance(MASCOT_HOLD_MS.reveal - 1);
    assert.equal(triggers.host.visible, true);
    triggers.timers.advance(2);
    assert.equal(triggers.host.visible, false);
    assert.ok(triggers.mascot.log.includes("pause"), "the ticker is released when he fades");

    // always: he is on screen idling, and goes back to idling afterwards.
    const always = makeHost({ presence: "always" });
    assert.equal(always.host.visible, true);
    assert.equal(always.host.state, "idle");
    emitMascotEvent(always.bus, land("max"));
    assert.equal(always.host.state, "happy");
    always.timers.advance(MASCOT_HOLD_MS.happy + 1);
    assert.equal(always.host.state, "idle");
    assert.equal(always.host.visible, true);

    // A link that points nowhere needs reading, so he stays put longer for it.
    const failed = makeHost();
    emitMascotEvent(failed.bus, { type: "link:fail", id: "nope" });
    assert.equal(failed.host.state, "oops");
    failed.timers.advance(MASCOT_HOLD_MS.oops + 1);
    assert.equal(failed.host.visible, true, "a failed link holds longer than a plain oops");
    failed.timers.advance(1000);
    assert.equal(failed.host.visible, false);

    // Changing presence moves the one mascot rather than leaving another behind.
    const h = makeHost({ presence: "always" });
    const first = h.mascot;
    h.setFeel({ mascot: { ...DEFAULT_FEEL.mascot, rules: {}, presence: "hidden" } });
    assert.ok(first.log.includes("destroy"));
    assert.equal(h.host.el, null);
    h.setFeel({ mascot: { ...DEFAULT_FEEL.mascot, rules: {}, presence: "triggers" } });
    assert.notEqual(h.host.el, null);
    assert.equal(h.host.visible, false, "back, but waiting for something to happen");
    assert.equal(h.host.state, "idle");
    h.setFeel({ motion: "quick", mascot: { ...DEFAULT_FEEL.mascot, rules: {}, presence: "always", wobble: 1 } });
    assert.ok(h.mascot.log.includes("wobble:1"));
    assert.ok(h.mascot.log.includes("motion:quick"));

    // Fifty rolls must not leave fifty mascots behind the result panel.
    const busy = makeHost({ presence: "always" });
    for (let i = 0; i < 50; i++) {
      emitMascotEvent(busy.bus, { type: "roll:start", source: "dice" });
      busy.timers.advance(MASCOT_ANTICIPATE_MIN_MS + 5);
      emitMascotEvent(busy.bus, land(i % 3 === 0 ? "max" : null));
      busy.timers.advance(300);
    }
    assert.equal(busy.created, 1, "the factory ran once for fifty rolls");
    assert.equal(busy.host.el, busy.mascot.el);
  });

  test("the louder reaction wins, but a fresh roll always takes over", () => {
    assert.ok(MASCOT_SALIENCE.oops > MASCOT_SALIENCE.happy && MASCOT_SALIENCE.happy > MASCOT_SALIENCE.reveal);
    const by = (id: string) => DEFAULT_REACTIONS.find((r) => r.id === id)!;
    assert.equal(mayInterrupt(by("roll-land"), by("roll-min")), true, "louder interrupts");
    assert.equal(mayInterrupt(by("roll-min"), by("roll-land")), false, "quieter waits");
    assert.equal(mayInterrupt(by("roll-max"), by("import-ok")), true, "equal restarts");
    assert.equal(mayInterrupt(null, by("roll-start")), true);

    const { bus, timers, host } = makeHost({ presence: "always" });
    emitMascotEvent(bus, land("min")); // oops
    emitMascotEvent(bus, { type: "import:done", ok: true, skipped: 0 }); // happy: waits
    assert.equal(host.state, "oops");
    emitMascotEvent(bus, { type: "link:fail", id: "x" }); // oops again: restarts
    assert.deepEqual(host.played, ["oops", "oops"]);
    timers.advance(MASCOT_HOLD_MS.oops + 5000);
    assert.equal(host.state, "idle");

    // A roll is the newest fact about the table, so it is never held back by
    // what he is still doing about the last one.
    const rolls = makeHost({ presence: "always" });
    emitMascotEvent(rolls.bus, land("max"));
    emitMascotEvent(rolls.bus, land("min"));
    emitMascotEvent(rolls.bus, land(null));
    assert.deepEqual(rolls.host.played, ["happy", "oops", "reveal"]);
    assert.equal(rolls.host.state, "reveal");
  });

  test("anticipation waits a beat, and the landing always replaces it", () => {
    // An instant roll lands inside the gap, so he never flashes a watching
    // pose at a result that is already on screen.
    const quick = makeHost();
    emitMascotEvent(quick.bus, { type: "roll:start", source: "dice" });
    assert.equal(quick.host.visible, false, "not yet");
    emitMascotEvent(quick.bus, land(null));
    quick.timers.advance(MASCOT_ANTICIPATE_MIN_MS * 2);
    assert.deepEqual(quick.host.played, ["reveal"], "anticipate was cancelled by the landing");

    // A wheel takes seconds, so he watches it all the way down.
    const slow = makeHost();
    emitMascotEvent(slow.bus, { type: "roll:start", source: "list" });
    slow.timers.advance(MASCOT_ANTICIPATE_MIN_MS + 1);
    assert.equal(slow.host.state, "anticipate");
    slow.timers.advance(1500);
    assert.equal(slow.host.state, "anticipate", "still watching at 1.5 s");
    emitMascotEvent(slow.bus, land(null));
    assert.equal(slow.host.state, "reveal");
    assert.deepEqual(slow.host.played, ["anticipate", "reveal"]);

    // A roll starting also ends whatever he was doing about the last one.
    const again = makeHost({ presence: "always" });
    emitMascotEvent(again.bus, land("max"));
    assert.equal(again.host.state, "happy");
    emitMascotEvent(again.bus, { type: "roll:start", source: "dice" });
    again.timers.advance(MASCOT_ANTICIPATE_MIN_MS + 1);
    assert.equal(again.host.state, "anticipate");
  });

});
