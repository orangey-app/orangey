/**
 * A very small validation helper.
 *
 * The plan called for zod; the build sandbox has no package registry, so this
 * is the ~100 lines of it that the file format actually needs. It keeps the
 * property that mattered: every failure names the path that failed
 * ("items[3].weight"), because that is what makes an import report useful.
 */

export interface Issue {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class Check {
  issues: Issue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  throwIfFailed(): void {
    if (!this.ok) throw new ValidationError(this.issues);
  }

  object(path: string, v: unknown): v is Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      this.fail(path, "expected an object");
      return false;
    }
    return true;
  }

  array(path: string, v: unknown, min = 0): v is unknown[] {
    if (!Array.isArray(v)) {
      this.fail(path, "expected a list");
      return false;
    }
    if (v.length < min) {
      this.fail(path, `expected at least ${min} entr${min === 1 ? "y" : "ies"}`);
      return false;
    }
    return true;
  }

  string(path: string, v: unknown, opts: { min?: number; max?: number } = {}): v is string {
    if (typeof v !== "string") {
      this.fail(path, "expected text");
      return false;
    }
    if (opts.min !== undefined && v.length < opts.min) {
      this.fail(path, opts.min === 1 ? "must not be empty" : `must be at least ${opts.min} characters`);
      return false;
    }
    if (opts.max !== undefined && v.length > opts.max) {
      this.fail(path, `must be at most ${opts.max} characters`);
      return false;
    }
    return true;
  }

  number(path: string, v: unknown, opts: { min?: number; max?: number; integer?: boolean } = {}): v is number {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.fail(path, "expected a number");
      return false;
    }
    if (opts.integer && !Number.isInteger(v)) {
      this.fail(path, "expected a whole number");
      return false;
    }
    if (opts.min !== undefined && v < opts.min) {
      this.fail(path, `must be at least ${opts.min}`);
      return false;
    }
    if (opts.max !== undefined && v > opts.max) {
      this.fail(path, `must be at most ${opts.max}`);
      return false;
    }
    return true;
  }

  boolean(path: string, v: unknown): v is boolean {
    if (typeof v !== "boolean") {
      this.fail(path, "expected true or false");
      return false;
    }
    return true;
  }

  oneOf<T extends string>(path: string, v: unknown, allowed: readonly T[]): v is T {
    if (typeof v !== "string" || !allowed.includes(v as T)) {
      this.fail(path, `expected one of ${allowed.join(", ")}`);
      return false;
    }
    return true;
  }
}
