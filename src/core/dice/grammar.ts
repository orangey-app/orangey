/**
 * Dice notation, 0.1 subset (docs/DICE.md is the normative description).
 *
 *   expr     := term (("+" | "-") term)*
 *   term     := dice | integer
 *   dice     := [count] "d" sides [keepdrop]
 *   count    := integer 1..100        (default 1)
 *   sides    := integer 2..1000 | "%" (= 100)
 *   keepdrop := ("kh" | "kl" | "dh" | "dl") integer
 *
 * Whitespace is ignored, case is ignored. Anything else is a ParseError that
 * points at the offending character, because "invalid expression" with no
 * position is useless when you are typing at a table.
 */

export const MAX_COUNT = 100;
export const MAX_SIDES = 1000;

export type KeepMode = "kh" | "kl" | "dh" | "dl";

export interface DiceNode {
  kind: "dice";
  count: number;
  sides: number;
  keep?: { mode: KeepMode; n: number };
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

function parseDiceOrConst(c: Cursor): Node {
  c.ws();
  const start = c.i;
  let count: number | null = null;
  if (/[0-9]/.test(c.peek())) count = c.integer("a number");

  if (c.peek().toLowerCase() !== "d") {
    if (count === null) c.fail("expected a number or a die such as d20", start);
    return { kind: "const", value: count };
  }
  c.take(); // 'd'

  let sides: number;
  if (c.peek() === "%") {
    c.take();
    sides = 100;
  } else {
    sides = c.integer("the number of sides, e.g. d20");
  }

  const n = count ?? 1;
  if (n < 1 || n > MAX_COUNT) c.fail(`a roll may use 1 to ${MAX_COUNT} dice, not ${n}`, start);
  if (sides < 2 || sides > MAX_SIDES) {
    c.fail(`dice have 2 to ${MAX_SIDES} sides, not ${sides}`, start);
  }

  const node: DiceNode = { kind: "dice", count: n, sides };

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
  return node;
}

export function nodeText(node: Node): string {
  if (node.kind === "const") return String(node.value);
  const base = `${node.count === 1 ? "" : node.count}d${node.sides}`;
  return node.keep ? `${base}${node.keep.mode}${node.keep.n}` : base;
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

/** Validate without throwing; for live feedback in the expression field. */
export function tryParse(input: string): { ok: true; expression: Expression } | { ok: false; error: ParseError } {
  try {
    return { ok: true, expression: parse(input) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e };
    throw e;
  }
}
