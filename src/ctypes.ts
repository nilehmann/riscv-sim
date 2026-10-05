import { AppError } from "./types";

// ─── C types for memory regions ───────────────────────────────────────────
// A small subset of C: integer types, pointers, fixed-size arrays and
// structs (no unions, bitfields, enums or function pointers), laid out with
// the standard C alignment rules.

export type CType =
  | { kind: "int"; size: 1 | 2 | 4 | 8; signed: boolean }
  | { kind: "ptr"; to: CType }
  | { kind: "struct"; name: string }
  | { kind: "array"; elem: CType; len: number };

export interface StructDef {
  name: string;
  fields: { name: string; type: CType }[];
}
export type TypeEnv = Map<string, StructDef>;

// ─── Tokenizer ────────────────────────────────────────────────────────────

interface Tok {
  text: string;
  line: number;
}

function tokenize(src: string): Tok[] | AppError {
  const toks: Tok[] = [];
  let line = 1;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\n") {
      line++;
      i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return new AppError(`line ${line}: unterminated comment`);
      for (let j = i; j < end; j++) if (src[j] === "\n") line++;
      i = end + 2;
    } else {
      const m = /^(?:[A-Za-z_]\w*|0[xX][0-9a-fA-F]+|\d+|[{}\[\];,*])/.exec(src.slice(i));
      if (!m) return new AppError(`line ${line}: unexpected character '${ch}'`);
      toks.push({ text: m[0], line });
      i += m[0].length;
    }
  }
  return toks;
}

const isIdent = (s: string) => /^[A-Za-z_]\w*$/.test(s);
const isNumber = (s: string) => /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(s);

const INT_WORDS = new Set(["char", "short", "int", "long", "signed", "unsigned"]);
const KEYWORDS = new Set([...INT_WORDS, "struct", "typedef", "union", "enum", "void"]);

class ParseError {
  constructor(readonly error: AppError) {}
}

/** Recursive-descent parser over the token list; errors throw ParseError. */
class Parser {
  private pos = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly env: TypeEnv,
    private readonly wordBytes: 4 | 8,
  ) {}

  done(): boolean {
    return this.pos >= this.toks.length;
  }

  private peek(k = 0): string | undefined {
    return this.toks[this.pos + k]?.text;
  }

  private fail(msg: string): never {
    const tok = this.toks[Math.min(this.pos, this.toks.length - 1)];
    throw new ParseError(new AppError(tok ? `line ${tok.line}: ${msg}` : msg));
  }

  private next(): string {
    const t = this.peek();
    if (t === undefined) this.fail("unexpected end of input");
    this.pos++;
    return t;
  }

  private expect(text: string): void {
    const t = this.peek();
    if (t !== text) this.fail(t === undefined ? `expected '${text}'` : `expected '${text}', found '${t}'`);
    this.pos++;
  }

  private accept(text: string): boolean {
    if (this.peek() !== text) return false;
    this.pos++;
    return true;
  }

  private ident(what: string): string {
    const t = this.peek();
    if (t === undefined || !isIdent(t) || KEYWORDS.has(t))
      this.fail(t === undefined ? `expected ${what}` : `expected ${what}, found '${t}'`);
    this.pos++;
    return t;
  }

  /** Top level: a sequence of struct definitions and typedefs. */
  definitions(): void {
    while (!this.done()) {
      if (this.accept("typedef")) {
        if (this.peek() !== "struct") this.fail("only 'typedef struct' is supported");
        const { tag, fields } = this.structSpecifier();
        const def = fields ?? (tag !== null ? this.env.get(tag)?.fields : undefined);
        if (!def) this.fail(`'${tag}' is not defined`);
        this.define(this.ident("typedef name"), def);
        this.expect(";");
      } else if (this.peek() === "struct") {
        const { tag, fields } = this.structSpecifier();
        if (!fields) this.fail(`expected '{' after '${tag}'`);
        this.expect(";");
      } else {
        this.fail(`expected 'struct' or 'typedef', found '${this.peek()}'`);
      }
    }
  }

  private define(name: string, fields: StructDef["fields"]): void {
    if (this.env.has(name)) this.fail(`'${name}' is already defined`);
    this.env.set(name, { name, fields });
  }

  /**
   * `struct Tag`, `struct Tag { … }` or `struct { … }`. A tagged body defines
   * `struct Tag`. Returns the tag ("struct Tag", null if anonymous) and the
   * fields if there was a body.
   */
  private structSpecifier(): { tag: string | null; fields?: StructDef["fields"] } {
    this.expect("struct");
    const tag = this.peek() === "{" ? null : `struct ${this.ident("struct name")}`;
    if (!this.accept("{")) return { tag };
    const fields: StructDef["fields"] = [];
    while (!this.accept("}")) {
      for (const f of this.declaration()) {
        if (fields.some((g) => g.name === f.name)) this.fail(`duplicate field '${f.name}'`);
        this.requireComplete(f.type, f.name);
        fields.push(f);
      }
      this.expect(";");
    }
    if (fields.length === 0) this.fail("a struct needs at least one field");
    if (tag !== null) this.define(tag, fields);
    return { tag, fields };
  }

  /** Errors if a struct is used by value before it is defined. */
  private requireComplete(t: CType, name: string): void {
    if (t.kind === "array") this.requireComplete(t.elem, name);
    else if (t.kind === "struct" && !this.env.has(t.name))
      this.fail(`'${name}' has incomplete type '${t.name}' (define it first)`);
  }

  /** A type specifier: an integer type, `struct Tag`, or a typedef name. */
  private specifier(): CType {
    const t = this.peek();
    if (t === undefined) this.fail("expected a type");
    if (t === "struct") {
      const { tag, fields } = this.structSpecifier();
      if (fields || tag === null) this.fail("struct definitions are only allowed at the top level");
      return { kind: "struct", name: tag };
    }
    if (t === "union" || t === "enum" || t === "void") this.fail(`'${t}' is not supported`);
    if (INT_WORDS.has(t)) return this.intType();
    if (isIdent(t)) {
      if (!this.env.has(t)) this.fail(`unknown type '${t}'`);
      this.pos++;
      return { kind: "struct", name: t };
    }
    this.fail(`expected a type, found '${t}'`);
  }

  private intType(): CType {
    let signed: boolean | null = null;
    const words: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t === "signed" || t === "unsigned") {
        if (signed !== null) this.fail(`unexpected '${t}'`);
        signed = t === "signed";
      } else if (t === "char" || t === "short" || t === "int" || t === "long") {
        words.push(t);
      } else break;
      this.pos++;
    }
    const base = words.filter((w) => w !== "int");
    const ints = words.length - base.length;
    let size: 1 | 2 | 4 | 8;
    const key = base.join(" ");
    if (ints > 1) this.fail("invalid type");
    if (key === "") size = 4;
    else if (key === "char" && ints === 0) size = 1;
    else if (key === "short") size = 2;
    else if (key === "long") size = this.wordBytes;
    else if (key === "long long") size = 8;
    else this.fail(`invalid type '${words.join(" ")}'`);
    return { kind: "int", size, signed: signed ?? true };
  }

  /** `T *a[2], b` — a specifier and one or more declarators. */
  private declaration(): { name: string; type: CType }[] {
    const base = this.specifier();
    const out = [this.declarator(base)];
    while (this.accept(",")) out.push(this.declarator(base));
    return out;
  }

  private declarator(base: CType): { name: string; type: CType } {
    let type = base;
    while (this.accept("*")) type = { kind: "ptr", to: type };
    const name = this.ident("a name");
    const dims: number[] = [];
    while (this.accept("[")) {
      const n = this.next();
      if (!isNumber(n)) this.fail(`expected an array length, found '${n}'`);
      const len = Number(n);
      if (len <= 0) this.fail("array length must be positive");
      dims.push(len);
      this.expect("]");
    }
    // `int a[2][3]` is an array of 2 arrays of 3 ints.
    for (let i = dims.length - 1; i >= 0; i--) type = { kind: "array", elem: type, len: dims[i]! };
    return { name, type };
  }

  /** One declaration with a single declarator and an optional `;`. */
  singleDecl(): { name: string; type: CType } {
    const base = this.specifier();
    const d = this.declarator(base);
    this.requireComplete(d.type, d.name);
    this.accept(";");
    if (!this.done()) this.fail(`unexpected '${this.peek()}'`);
    return d;
  }
}

function run<T>(src: string, f: (toks: Tok[]) => T): T | AppError {
  const toks = tokenize(src);
  if (toks instanceof AppError) return toks;
  try {
    return f(toks);
  } catch (e) {
    if (e instanceof ParseError) return e.error;
    throw e;
  }
}

/** Parses `Program.types`. Errors carry the line number. */
export function parseTypes(src: string, wordBytes: 4 | 8): TypeEnv | AppError {
  const env: TypeEnv = new Map();
  return run(src, (toks) => {
    new Parser(toks, env, wordBytes).definitions();
    return env;
  });
}

/** Parses one declaration like `Point pts[3]` or `char *names[2]`. */
export function parseDecl(
  src: string,
  env: TypeEnv,
  wordBytes: 4 | 8,
): { name: string; type: CType } | AppError {
  if (src.trim() === "") return new AppError("empty declaration");
  return run(src, (toks) => new Parser(toks, env, wordBytes).singleDecl());
}

// ─── Layout ───────────────────────────────────────────────────────────────

function structDef(t: { name: string }, env: TypeEnv): StructDef {
  const def = env.get(t.name);
  if (!def) throw new Error(`undefined struct '${t.name}'`);
  return def;
}

export function alignOf(t: CType, env: TypeEnv, wordBytes: 4 | 8): number {
  switch (t.kind) {
    case "int": return t.size;
    case "ptr": return wordBytes;
    case "array": return alignOf(t.elem, env, wordBytes);
    case "struct":
      return Math.max(...structDef(t, env).fields.map((f) => alignOf(f.type, env, wordBytes)));
  }
}

const roundUp = (n: number, a: number) => Math.ceil(n / a) * a;

/** Offsets of each field of a struct, and its size. */
function structLayout(def: StructDef, env: TypeEnv, wordBytes: 4 | 8) {
  let off = 0;
  let align = 1;
  const offsets: number[] = [];
  for (const f of def.fields) {
    const a = alignOf(f.type, env, wordBytes);
    align = Math.max(align, a);
    off = roundUp(off, a);
    offsets.push(off);
    off += sizeOf(f.type, env, wordBytes);
  }
  return { offsets, size: roundUp(off, align) };
}

export function sizeOf(t: CType, env: TypeEnv, wordBytes: 4 | 8): number {
  switch (t.kind) {
    case "int": return t.size;
    case "ptr": return wordBytes;
    case "array": return t.len * sizeOf(t.elem, env, wordBytes);
    case "struct": return structLayout(structDef(t, env), env, wordBytes).size;
  }
}

const INT_NAMES: Record<number, string> = { 1: "char", 2: "short", 4: "int", 8: "long" };

/** C spelling of a type: "Point", "int", "Point[3]", "char *". */
export function typeName(t: CType): string {
  switch (t.kind) {
    case "int": return (t.signed ? "" : "unsigned ") + INT_NAMES[t.size]!;
    case "struct": return t.name;
    case "array": {
      // `int[2][3]`: the outer length comes first.
      let dims = "";
      let e: CType = t;
      for (; e.kind === "array"; e = e.elem) dims += `[${e.len}]`;
      return typeName(e) + dims;
    }
    case "ptr": return t.to.kind === "ptr" ? `${typeName(t.to)}*` : `${typeName(t.to)} *`;
  }
}

// ─── Value trees ──────────────────────────────────────────────────────────

export type Value = number | Value[] | { [field: string]: Value };

export interface TypedNode {
  /** null for padding. */
  type: CType | null;
  pad: boolean;
  addr: number;
  size: number;
  /** "[1]", ".max", "pad", or the region name for the root. */
  label: string;
  /** "rects[1].max.y"; padding: parent path + "+pad<off>". */
  path: string;
  /** Root = 0. */
  depth: number;
  /** Leaves only (ints and pointers); absent for padding. */
  value?: number;
  /** null for leaves. */
  children: TypedNode[] | null;
}

/** Whether v fits in `size` bytes, read either as signed or as unsigned. */
export function fitsInt(v: number, size: number): boolean {
  if (!Number.isInteger(v)) return false;
  const bits = BigInt(size * 8);
  const b = BigInt(v);
  return b >= -(1n << (bits - 1n)) && b < 1n << bits;
}

class BuildError {
  constructor(readonly msg: string) {}
}

const isRecord = (v: unknown): v is Record<string, Value> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Lays out a value of `type` at `addr`. Missing initializer entries are 0;
 * padding becomes explicit `pad` leaves.
 */
export function buildTree(
  name: string,
  type: CType,
  init: Value | undefined,
  addr: number,
  env: TypeEnv,
  wordBytes: 4 | 8,
): TypedNode | AppError {
  function build(t: CType, v: Value | undefined, at: number, label: string, path: string, depth: number): TypedNode {
    const size = sizeOf(t, env, wordBytes);
    const node: TypedNode = { type: t, pad: false, addr: at, size, label, path, depth, children: null };

    if (t.kind === "int" || t.kind === "ptr") {
      const val = v ?? 0;
      if (typeof val !== "number") throw new BuildError(`${path}: expected a number`);
      if (!fitsInt(val, size)) throw new BuildError(`${path}: ${val} does not fit in ${size} byte(s)`);
      node.value = val;
      return node;
    }

    const children: TypedNode[] = [];
    node.children = children;

    if (t.kind === "array") {
      if (v !== undefined && !Array.isArray(v)) throw new BuildError(`${path}: expected an array`);
      if (v && v.length > t.len)
        throw new BuildError(`${path}: ${v.length} values for an array of ${t.len}`);
      const es = sizeOf(t.elem, env, wordBytes);
      for (let i = 0; i < t.len; i++)
        children.push(build(t.elem, v?.[i], at + i * es, `[${i}]`, `${path}[${i}]`, depth + 1));
      return node;
    }

    if (v !== undefined && !isRecord(v)) throw new BuildError(`${path}: expected a struct`);
    const def = structDef(t, env);
    for (const k of Object.keys(v ?? {}))
      if (!def.fields.some((f) => f.name === k)) throw new BuildError(`${path}: unknown field "${k}"`);
    const { offsets } = structLayout(def, env, wordBytes);
    let off = 0;
    const pad = (to: number) => {
      if (to > off)
        children.push({
          type: null, pad: true, addr: at + off, size: to - off, label: "pad",
          path: `${path}+pad${off}`, depth: depth + 1, children: null,
        });
    };
    def.fields.forEach((f, i) => {
      pad(offsets[i]!);
      off = offsets[i]!;
      children.push(build(f.type, v?.[f.name], at + off, `.${f.name}`, `${path}.${f.name}`, depth + 1));
      off += sizeOf(f.type, env, wordBytes);
    });
    pad(size);
    return node;
  }

  try {
    return build(type, init, addr, name, name, 0);
  } catch (e) {
    if (e instanceof BuildError) return new AppError(e.msg);
    throw e;
  }
}

/** Leaves in address order, padding included. */
export function leavesOf(n: TypedNode): TypedNode[] {
  return n.children ? n.children.flatMap(leavesOf) : [n];
}

/** Struct and array nodes in pre-order, root included. */
export function internalNodes(n: TypedNode): TypedNode[] {
  return n.children ? [n, ...n.children.flatMap(internalNodes)] : [];
}
