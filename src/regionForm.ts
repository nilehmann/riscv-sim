import { AppError } from "./types";
import type { ResolvedRegion } from "./types";
import type { CType, TypeEnv, TypedNode, Value } from "./ctypes";
import { buildTree, leavesOf, parseDecl } from "./ctypes";

// ─── Region value form for the program editor ─────────────────────────────
// A region's values are edited as a grid: one row per array element (one
// row for a non-array), one column per leaf of the element. Values are kept
// as strings keyed by their path relative to the region ("[1].min.x", ".n",
// "[2]", ""), so changing the declaration keeps whatever still fits.

export type FormValues = Record<string, string>;

export interface RegionShape {
  name: string;
  type: CType;
  /** Array length, or null when the region is not an array. */
  len: number | null;
  /** Leaf paths inside one element (".min.x"; "" for a scalar element). */
  columns: string[];
}

const relPath = (leaf: TypedNode, name: string) => leaf.path.slice(name.length);

export function regionShape(decl: string, env: TypeEnv, wordBytes: 4 | 8): RegionShape | AppError {
  const d = parseDecl(decl, env, wordBytes);
  if (d instanceof AppError) return d;
  const isArray = d.type.kind === "array";
  const elem = d.type.kind === "array" ? d.type.elem : d.type;
  const tree = buildTree("", elem, undefined, 0, env, wordBytes);
  if (tree instanceof AppError) return tree;
  return {
    name: d.name,
    type: d.type,
    len: isArray && d.type.kind === "array" ? d.type.len : null,
    columns: leavesOf(tree).filter((l) => !l.pad).map((l) => l.path),
  };
}

/** Key of the value in row `row` (ignored for non-arrays), column `col`. */
export function formKey(shape: RegionShape, row: number, col: string): string {
  return shape.len === null ? col : `[${row}]${col}`;
}

/** Form values for a loaded region. */
export function formFromRegion(r: ResolvedRegion): FormValues {
  const out: FormValues = {};
  for (const leaf of leavesOf(r.root)) {
    if (leaf.pad) continue;
    const v = leaf.value!;
    out[relPath(leaf, r.name)] = v < 0 ? String(v) : "0x" + v.toString(16);
  }
  return out;
}

/** Parses a value field: decimal, hex, or a character literal like 'A'. Empty is 0. */
export function parseValue(s: string): number | null {
  const t = s.trim();
  if (t === "") return 0;
  const ch = /^'(.)'$/.exec(t);
  if (ch) return ch[1]!.charCodeAt(0);
  if (!/^-?(?:0[xX][0-9a-fA-F]+|\d+)$/.test(t)) return null;
  return t.startsWith("-") ? -Number(t.slice(1)) : Number(t);
}

/** Builds the initializer for a region from its form values. */
export function initFromForm(
  shape: RegionShape,
  values: FormValues,
  env: TypeEnv,
  wordBytes: 4 | 8,
): Value | AppError {
  const tree = buildTree(shape.name, shape.type, undefined, 0, env, wordBytes);
  if (tree instanceof AppError) return tree;
  let error: AppError | null = null;
  const toValue = (n: TypedNode): Value => {
    if (!n.children) {
      const v = parseValue(values[relPath(n, shape.name)] ?? "");
      if (v === null) error ??= new AppError(`${n.path}: invalid value`);
      return v ?? 0;
    }
    const kids = n.children.filter((c) => !c.pad);
    if (n.type?.kind === "array") return kids.map(toValue);
    return Object.fromEntries(kids.map((c) => [c.label.slice(1), toValue(c)]));
  };
  const init = toValue(tree);
  return error ?? init;
}

/** Rewrites the outermost array length of a declaration: `Point pts[2]` → `Point pts[3]`. */
export function setArrayLen(decl: string, len: number): string {
  return decl.replace(/\[\s*(?:0[xX][0-9a-fA-F]+|\d+)\s*\]/, `[${len}]`);
}

/** Removes array row `row`, moving the rows after it up by one. */
export function removeRow(values: FormValues, row: number): FormValues {
  const out: FormValues = {};
  for (const [k, v] of Object.entries(values)) {
    const m = /^\[(\d+)\](.*)$/.exec(k);
    if (!m) {
      out[k] = v;
      continue;
    }
    const i = Number(m[1]);
    if (i < row) out[k] = v;
    else if (i > row) out[`[${i - 1}]${m[2]}`] = v;
  }
  return out;
}
