import { describe, test, expect } from "vitest";
import { layoutRegion, isAccessed } from "./regionLayout";
import { overlapsAccess } from "./memUtils";
import { parseTypes, parseDecl, buildTree, leavesOf } from "./ctypes";
import type { TypedNode } from "./ctypes";
import { AppError } from "./types";

const TYPES = `
typedef struct { int x; int y; } Point;
typedef struct { Point min, max; } Rect;
struct Item { char kind; Point pos; };
typedef struct { int n; Point v[2]; } Poly;
`;

function tree(decl: string): TypedNode {
  const env = parseTypes(TYPES, 4);
  if (env instanceof AppError) throw new Error(env.message);
  const d = parseDecl(decl, env, 4);
  if (d instanceof AppError) throw new Error(d.message);
  const t = buildTree(d.name, d.type, undefined, 0x10000, env, 4);
  if (t instanceof AppError) throw new Error(t.message);
  return t;
}

const hex = (a: number) => "0x" + a.toString(16);
const lay = (decl: string, open: string[] = []) => layoutRegion(tree(decl), new Set(open), hex);
const cards = (l: ReturnType<typeof lay>) =>
  l.cards.map((c) => `${c.node.path} ${c.col}+${c.span} r${c.lastRow} ${c.where}`);

describe("layoutRegion", () => {
  test("collapsed array of structs: only the elements", () => {
    const l = lay("Rect rects[2]");
    expect(cards(l)).toEqual(["rects[0] 1+4 r2 0x10000", "rects[1] 5+4 r2 0x10010"]);
    expect(l.labelRow).toBe(false);
    expect(l.footerRows).toBe(1);
    expect(l.leaves.filter((c) => c.outerStart).map((c) => c.col)).toEqual([1, 5]);
  });

  test("one level open", () => {
    const l = lay("Rect rects[2]", ["rects[1]"]);
    expect(cards(l)).toEqual([
      "rects[0] 1+4 r3 0x10000",
      "rects[1] 5+4 r3 0x10010",
      "rects[1].min 5+2 r2 +0",
      "rects[1].max 7+2 r2 +8",
    ]);
    expect(l.labelRow).toBe(false);
    expect(l.footerRows).toBe(2);
    expect(l.leaves.filter((c) => c.innerStart).map((c) => c.col)).toEqual([7]);
  });

  test("mixed", () => {
    const l = lay("Rect rects[2]", ["rects[0]", "rects[1]", "rects[1].max"]);
    expect(l.labelRow).toBe(true);
    expect(l.leaves.filter((c) => c.labelled).map((c) => c.leaf.path)).toEqual([
      "rects[1].max.x", "rects[1].max.y",
    ]);
    // Values, labels, then the .max footer row and the [i] footer row.
    expect(cards(l)).toContain("rects[1].max 7+2 r3 +8");
    expect(cards(l)).toContain("rects[0] 1+4 r4 0x10000");
  });

  test("inner cards stay hidden while the parent is closed, and keep their state", () => {
    const l = lay("Rect rects[2]", ["rects[1].max"]);
    expect(cards(l)).toEqual(["rects[0] 1+4 r2 0x10000", "rects[1] 5+4 r2 0x10010"]);
  });

  test("padding before a nested struct", () => {
    const l = lay("struct Item items[2]", ["items[0]"]);
    expect(l.leaves.filter((c) => c.labelled).map((c) => c.leaf.label)).toEqual([".kind", "pad"]);
    expect(cards(l)).toContain("items[0].pos 3+2 r3 +4");
  });

  test("lone struct is its own outermost card", () => {
    const l = lay("Poly poly", ["poly", "poly.v"]);
    expect(cards(l)).toEqual([
      "poly 1+5 r5 0x10000",
      "poly.v 2+4 r4 +4",
      "poly.v[0] 2+2 r3 +4",
      "poly.v[1] 4+2 r3 +12",
    ]);
  });

  test("scalar array: no cards, labels always visible", () => {
    const l = lay("int arr[4]");
    expect(l.cards).toEqual([]);
    expect(l.footerRows).toBe(0);
    expect(l.leaves.map((c) => c.labelled && c.leaf.label)).toEqual(["[0]", "[1]", "[2]", "[3]"]);
  });
});

describe("isAccessed", () => {
  test("a leaf overlaps an access", () => {
    const [x, y] = leavesOf(tree("Point p"));
    const access = [{ addr: 0x10004, size: 4, kind: "load" as const }];
    expect(isAccessed(x!, access)).toBe(false);
    expect(isAccessed(y!, access)).toBe(true);
    expect(isAccessed(y!, undefined)).toBe(false);
  });
});

describe("overlapsAccess", () => {
  test("only the pieces a narrow access touches", () => {
    const access = [{ addr: 0x10009, size: 1, kind: "store" as const }];
    const bytes = [0, 1, 2, 3].map((i) => overlapsAccess(0x10008 + i, 1, access));
    expect(bytes).toEqual([false, true, false, false]);
    expect([0, 2].map((i) => overlapsAccess(0x10008 + i, 2, access))).toEqual([true, false]);
  });
});
