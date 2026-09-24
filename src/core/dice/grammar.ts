/**
 * Dice notation (docs/DICE.md is the normative description).
 *
 *   expr     := term (("+" | "-") term)*
 *   term     := dice | integer | "adv" | "dis"
 *   dice     := [count] "d" sides [explode] [reroll] [keepdrop] [success]
 *   count    := integer 1..100                  (default 1)
 *   sides    := integer 2..1000 | "%" | "F"
 *   explode  := "!"
 *   reroll   := ("ro" | "r") [cmp] integer      cmp defaults to "="
 *   keepdrop := ("kh" | "kl" | "dh" | "dl") integer
 *   success  := cmp integer
 *   cmp      := ">=" | "<=" | ">" | "<" | "="
 *
 * The modifiers come in that fixed order. That is a real constraint rather
 * than an accident: it makes the canonical form unique, and `normalized` is
 * what the history's "repeat" and the file format store.
 *
 * Whitespace is ignored, case is ignored. Anything else is a ParseError that
 * points at the offending character, because "invalid expression" with no
 * position is useless when you are typing at a table.
 */

export const MAX_COUNT = 100;
export const MAX_SIDES = 1000;
/** A die may be rerolled this many times before the app stops trying. */
export const REROLL_CAP = 100;
/** A term may grow by this many extra dice from explosions. */
export const EXPLODE_CAP = 100;

export type KeepMode = "kh" | "kl" | "dh" | "dl";
export type Cmp = ">=" | "<=" | ">" | "<" | "=";

export interface DiceNode {
  kind: "dice";
  count: number;
  /** Fate dice are three-sided internally; `fate` says how to read them. */
  sides: number;
  fate?: true;
  explode?: true;
  reroll?: { once: boolean; cmp: Cmp; n: number };
  keep?: { mode: KeepMode; n: number };
  success?: { cmp: Cmp; n: number };
}

/** Does a face satisfy a comparator? */
export function matchesCmp(value: number, cmp: Cmp, n: number): boolean {
  switch (cmp) {
    case ">=": return value >= n;
    case "<=": return value <= n;
    case ">": return value > n;
    case "<": return value < n;
    case "=": return value === n;
  }
}

/** The faces a die of this node can show, low to high. */
export function facesOf(node: DiceNode): number[] {
  if (node.fate) return [-1, 0, 1];
  return Array.from({ length: node.sides }, (_, i) => i + 1);
}
export interface ConstNode {
  kind: "const";
  value: number;
}
export type Node = DiceNode | ConstNode;

export interface Term {
  sign: 1 | -1;
  node: Node;
}
export interface Expression {
  terms: Term[];
  /** The expression rewritten in canonical form, e.g. "4d6kh3 + 2". */
  normalized: string;
}

export class ParseError extends Error {
  readonly position: number;
  readonly input: string;
  constructor(message: string, position: number, input: string) {
    super(message);
    this.name = "ParseError";
    this.position = position;
    this.input = input;
  }
  /** A caret line for display under a monospace input. */
  caret(): string {
    return `${this.input}\n${" ".repeat(Math.max(0, this.position))}^`;
  }
}

class Cursor {
  i = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }
  get done(): boolean {
    this.ws();
    return this.i >= this.src.length;
  }
  ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }
  peek(): string {
    this.ws();
    return this.src[this.i] ?? "";
  }
  take(): string {
    this.ws();
    return this.src[this.i++] ?? "";
  }
  fail(msg: string, at = this.i): never {
    throw new ParseError(msg, at, this.src);
  }
  integer(what: string): number {
    this.ws();
    const start = this.i;
    while (this.i < this.src.length && /[0-9]/.test(this.src[this.i])) this.i++;
    if (this.i === start) this.fail(`expected ${what}`, start);
    return Number.parseInt(this.src.slice(start, this.i), 10);
  }
}

/** A comparator, longest first so ">=" is never read as ">". */
function parseCmp(c: Cursor): Cmp | null {
  c.ws();
  const two = c.src.slice(c.i, c.i + 2);
  if (two === ">=" || two === "<=") {
    c.i += 2;
    return two;
  }
  const one = c.src[c.i];
  if (one === ">" || one === "<" || one === "=") {
    c.i += 1;
    return one;
  }
  return null;
}

/** The modifiers, in the one order the canonical form allows. */
const MODIFIER_ORDER = "the order is !, then r or ro, then kh/kl/dh/dl, then a success target";

function word(c: Cursor, text: string): boolean {
  c.ws();
  if (c.src.slice(c.i, c.i + text.length).toLowerCase() !== text) return false;
  // "adv" must not swallow the "ad" of something longer.
  const after = c.src[c.i + text.length] ?? "";
  if (/[a-z0-9]/i.test(after)) return false;
  c.i += text.length;
  return true;
}

function parseDiceOrConst(c: Cursor): Node {
  c.ws();
  const start = c.i;

  // Sugar: the two rolls every d20 game makes constantly. They take no count
  // and no modifiers, and normalise to the forms they stand for.
  if (word(c, "adv")) return { kind: "dice", count: 2, sides: 20, keep: { mode: "kh", n: 1 } };
  if (word(c, "dis")) return { kind: "dice", count: 2, sides: 20, keep: { mode: "kl", n: 1 } };

  let count: number | null = null;
  if (/[0-9]/.test(c.peek())) count = c.integer("a number");

  if (c.peek().toLowerCase() !== "d") {
    if (count === null) c.fail("expected a number or a die such as d20", start);
    return { kind: "const", value: count };
  }
  c.take(); // 'd'

  let sides: number;
  let fate = false;
  if (c.peek() === "%") {
    c.take();
    sides = 100;
  } else if (c.peek().toLowerCase() === "f") {
    c.take();
    // Three faces internally, read as -1, 0, +1.
    sides = 3;
    fate = true;
  } else {
    sides = c.integer("the number of sides, e.g. d20");
  }

  const n = count ?? 1;
  if (n < 1 || n > MAX_COUNT) c.fail(`a roll may use 1 to ${MAX_COUNT} dice, not ${n}`, start);
  if (!fate && (sides < 2 || sides > MAX_SIDES)) {
    c.fail(`dice have 2 to ${MAX_SIDES} sides, not ${sides}`, start);
  }

  const node: DiceNode = { kind: "dice", count: n, sides };
  if (fate) node.fate = true;

  // ---- explode ------------------------------------------------------------
  c.ws();
  if (c.src[c.i] === "!") {
    const at = c.i;
    if (fate) c.fail("Fate dice cannot explode: there is no single top face to explode on", at);
    c.i += 1;
    node.explode = true;
  }

  // ---- reroll -------------------------------------------------------------
  c.ws();
  const twoChars = c.src.slice(c.i, c.i + 2).toLowerCase();
  const oneChar = (c.src[c.i] ?? "").toLowerCase();
  if (twoChars === "ro" || (oneChar === "r" && twoChars !== "ro")) {
    const at = c.i;
    const once = twoChars === "ro";
    c.i += once ? 2 : 1;
    const cmp = parseCmp(c) ?? "=";
    const target = c.integer("what to reroll, for example r1 or r<3");
    const faces = facesOf(node);
    if (faces.every((f) => matchesCmp(f, cmp, target))) {
      c.fail("that would reroll every face, so the roll could never finish", at);
    }
    node.reroll = { once, cmp, n: target };
  }

  // ---- keep / drop --------------------------------------------------------
  // "4d6 kh3" is how people write it, and DICE.md promises it works.
  c.ws();
  const two = c.src.slice(c.i, c.i + 2).toLowerCase();
  if (two === "kh" || two === "kl" || two === "dh" || two === "dl") {
    const at = c.i;
    c.i += 2;
    const k = c.integer(`how many dice to ${two[0] === "k" ? "keep" : "drop"}`);
    if (k < 1) c.fail("that count must be at least 1", at);
    if (two[0] === "k" && k > n) c.fail(`cannot keep ${k} of ${n} dice`, at);
    if (two[0] === "d" && k >= n) c.fail(`cannot drop ${k} of ${n} dice`, at);
    node.keep = { mode: two as KeepMode, n: k };
  }

  // ---- success ------------------------------------------------------------
  c.ws();
  const cmp = parseCmp(c);
  if (cmp) {
    const target = c.integer("what counts as a success, for example >=8");
    node.success = { cmp, n: target };
  }

  // Anything that looks like a modifier from here on arrived out of order.
  c.ws();
  const rest = c.src.slice(c.i, c.i + 2).toLowerCase();
  if (c.src[c.i] === "!" || rest === "kh" || rest === "kl" || rest === "dh" || rest === "dl" || /^r/.test(rest)) {
    c.fail(MODIFIER_ORDER, c.i);
  }
  return node;
}

export function nodeText(node: Node): string {
  if (node.kind === "const") return String(node.value);
  let out = `${node.count === 1 ? "" : node.count}d${node.fate ? "F" : node.sides}`;
  if (node.explode) out += "!";
  if (node.reroll) out += `${node.reroll.once ? "ro" : "r"}${node.reroll.cmp === "=" ? "" : node.reroll.cmp}${node.reroll.n}`;
  if (node.keep) out += `${node.keep.mode}${node.keep.n}`;
  if (node.success) out += `${node.success.cmp}${node.success.n}`;
  return out;
}

export function parse(input: string): Expression {
  const c = new Cursor(input);
  if (c.done) throw new ParseError("type an expression, for example 2d6 + 3", 0, input);

  const terms: Term[] = [];
  let sign: 1 | -1 = 1;
  if (c.peek() === "-") {
    c.take();
    sign = -1;
  } else if (c.peek() === "+") c.take();

  terms.push({ sign, node: parseDiceOrConst(c) });

  while (!c.done) {
    const op = c.take();
    if (op !== "+" && op !== "-") c.fail(`expected + or -, found "${op}"`, c.i - 1);
    terms.push({ sign: op === "-" ? -1 : 1, node: parseDiceOrConst(c) });
  }

  const normalized = terms
    .map((t, i) => (i === 0 ? `${t.sign < 0 ? "-" : ""}${nodeText(t.node)}` : ` ${t.sign < 0 ? "-" : "+"} ${nodeText(t.node)}`))
    .join("");
  return { terms, normalized };
}

/**
 * Is this text a dice roll someone typed, and if so, in its canonical form?
 *
 * For a search box that also takes notation: it has to hold at least one die,
 * because a bare "3" parses as a constant and would otherwise offer to make a
 * randomizer that always says 3 every time someone searched for a number.
 */
export function diceNotation(text: string): string | null {
  const parsed = tryParse(text);
  if (!parsed.ok || !parsed.expression.terms.some((t) => t.node.kind === "dice")) return null;
  return parsed.expression.normalized;
}

/** Validate without throwing; for live feedback in the expression field. */
export function tryParse(input: string): { ok: true; expression: Expression } | { ok: false; error: ParseError } {
  try {
    return { ok: true, expression: parse(input) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e };
    throw e;
  }
}
