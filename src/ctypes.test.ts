import { describe, test, expect } from "vitest";
import { parseTypes, parseDecl, sizeOf, alignOf, typeName, buildTree, leavesOf, internalNodes } from "./ctypes";
import type { TypeEnv, TypedNode, Value } from "./ctypes";
import { AppError } from "./types";

const TYPES = `
typedef struct { int x; int y; } Point;
struct S { char c; int x; };
typedef struct { Point min, max; } Rect;
struct Item {
  char  kind;  // +0, then 3 bytes padding
  Point pos;   /* +4 */
};
typedef struct { int n; Point v[2]; } Poly;
`;

function env(src = TYPES, wordBytes: 4 | 8 = 4): TypeEnv {
  const e = parseTypes(src, wordBytes);
  if (e instanceof AppError) throw new Error(e.message);
  return e;
}

function tree(decl: string, init?: Value, src = TYPES, wordBytes: 4 | 8 = 4): TypedNode {
  const e = env(src, wordBytes);
  const d = parseDecl(decl, e, wordBytes);
  if (d instanceof AppError) throw new Error(d.message);
  const t = buildTree(d.name, d.type, init, 0x10000, e, wordBytes);
  if (t instanceof AppError) throw new Error(t.message);
  return t;
}

const layout = (n: TypedNode) => leavesOf(n).map((l) => `${l.label}@${l.addr - n.addr}`).join(" ");

describe("layout on rv32", () => {
  test.each([
    ["Point pts[3]", 24, ".x@0 .y@4 .x@8 .y@12 .x@16 .y@20"],
    ["struct S s[2]", 16, ".c@0 pad@1 .x@4 .c@8 pad@9 .x@12"],
    ["int arr[4]", 16, "[0]@0 [1]@4 [2]@8 [3]@12"],
    ["Rect rects[2]", 32, ".x@0 .y@4 .x@8 .y@12 .x@16 .y@20 .x@24 .y@28"],
    ["struct Item items[2]", 24, ".kind@0 pad@1 .x@4 .y@8 .kind@12 pad@13 .x@16 .y@20"],
    ["Poly poly", 20, ".n@0 .x@4 .y@8 .x@12 .y@16"],
  ])("%s", (decl, size, leaves) => {
    const t = tree(decl);
    expect(t.size).toBe(size);
    expect(sizeOf(t.type!, env(), 4)).toBe(size);
    expect(layout(t)).toBe(leaves);
  });

  test("leaf paths", () => {
    const t = tree("Rect rects[2]");
    const leaf = leavesOf(t).find((l) => l.addr - t.addr === 28)!;
    expect(leaf.path).toBe("rects[1].max.y");
    expect(leaf.depth).toBe(3);
    expect(leavesOf(tree("struct S s[2]"))[1]!.path).toBe("s[0]+pad1");
  });

  test("internal nodes are pre-order with the root first", () => {
    expect(internalNodes(tree("Poly poly")).map((n) => n.path)).toEqual([
      "poly", "poly.v", "poly.v[0]", "poly.v[1]",
    ]);
  });

  test("padding has no value or type", () => {
    const pad = leavesOf(tree("struct S s[1]"))[1]!;
    expect(pad).toMatchObject({ pad: true, type: null, size: 3 });
    expect(pad.value).toBeUndefined();
  });

  test("trailing padding", () => {
    const t = tree("struct T t", undefined, "struct T { int x; char c; };");
    expect(t.size).toBe(8);
    expect(layout(t)).toBe(".x@0 .c@4 pad@5");
  });

  test("short alignment", () => {
    const t = tree("struct T t", undefined, "struct T { char a; short b; char c; };");
    expect(t.size).toBe(6);
    expect(layout(t)).toBe(".a@0 pad@1 .b@2 .c@4 pad@5");
  });

  test("multi-dimensional arrays", () => {
    const t = tree("int m[2][3]", [[1, 2, 3], [4, 5, 6]]);
    expect(typeName(t.type!)).toBe("int[2][3]");
    expect(t.size).toBe(24);
    expect(leavesOf(t).map((l) => l.path)[4]).toBe("m[1][1]");
    expect(leavesOf(t).map((l) => l.value)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("layout on x86", () => {
  test("long and pointers are 8 bytes", () => {
    const t = tree("struct T t", undefined, "struct T { char c; long *p; };", 8);
    expect(t.size).toBe(16);
    expect(layout(t)).toBe(".c@0 pad@1 .p@8");
    const e = env("struct T { long l; };", 4);
    expect(sizeOf({ kind: "struct", name: "struct T" }, e, 4)).toBe(4);
  });
});

describe("types", () => {
  test("integer types", () => {
    const e = env("struct T { unsigned char a; short b; unsigned c; long d; unsigned long int e; char *f; char **g; };");
    const fields = e.get("struct T")!.fields;
    expect(fields.map((f) => typeName(f.type))).toEqual([
      "unsigned char", "short", "unsigned int", "int", "unsigned int", "char *", "char **",
    ]);
  });

  test("typedef struct Tag defines both names", () => {
    const e = env("typedef struct Item { char k; } Item;");
    expect(e.has("Item")).toBe(true);
    expect(e.has("struct Item")).toBe(true);
  });

  test("pointer to a struct that is not defined yet", () => {
    const e = env("struct Node { int v; struct Node *next; };");
    expect(sizeOf({ kind: "struct", name: "struct Node" }, e, 4)).toBe(8);
    expect(alignOf({ kind: "struct", name: "struct Node" }, e, 4)).toBe(4);
  });

  test("typeName", () => {
    const e = env();
    const d = parseDecl("Point pts[3]", e, 4);
    expect(d instanceof AppError ? d.message : typeName(d.type)).toBe("Point[3]");
    const p = parseDecl("char *names[2];", e, 4);
    expect(p instanceof AppError ? p.message : typeName(p.type)).toBe("char *[2]");
  });
});

describe("initializers", () => {
  test("values land in the leaves; missing entries are 0", () => {
    const t = tree("Point pts[3]", [{ x: 1, y: 2 }, { y: 4 }]);
    expect(leavesOf(t).map((l) => l.value)).toEqual([1, 2, 0, 4, 0, 0]);
  });

  test("negative values and unsigned values that use the sign bit both fit", () => {
    expect(leavesOf(tree("char c[2]", [-128, 255])).map((l) => l.value)).toEqual([-128, 255]);
  });
});

describe("errors", () => {
  const typeErr = (src: string) => {
    const e = parseTypes(src, 4);
    return e instanceof AppError ? e.message : null;
  };
  const declErr = (decl: string) => {
    const d = parseDecl(decl, env(), 4);
    return d instanceof AppError ? d.message : null;
  };
  const initErr = (decl: string, init: unknown) => {
    const e = env();
    const d = parseDecl(decl, e, 4);
    if (d instanceof AppError) return d.message;
    const t = buildTree(d.name, d.type, init as Value, 0, e, 4);
    return t instanceof AppError ? t.message : null;
  };

  test("type errors carry the line number", () => {
    expect(typeErr("struct A { int x; };\nstruct B { int y }")).toMatch(/^line 2:/);
    expect(typeErr("struct A { Foo x; };")).toMatch(/unknown type 'Foo'/);
  });

  test("struct used before it is defined", () => {
    expect(typeErr("struct A { struct B b; };\nstruct B { int x; };")).toMatch(/line 1:.*incomplete/);
  });

  test("struct containing itself by value", () => {
    expect(typeErr("struct A { int x; struct A a; };")).toMatch(/incomplete/);
  });

  test("unsupported constructs", () => {
    expect(typeErr("union U { int x; };")).not.toBeNull();
    expect(typeErr("enum E { A };")).not.toBeNull();
    expect(typeErr("struct A { int x : 3; };")).not.toBeNull();
    expect(typeErr("typedef int myint;")).not.toBeNull();
    expect(typeErr("struct A { };")).not.toBeNull();
    expect(typeErr("struct A { int x; int x; };")).toMatch(/duplicate/);
    expect(typeErr("struct A { int x; };\nstruct A { int y; };")).toMatch(/already defined/);
    expect(typeErr("struct A { int x; /* unterminated")).toMatch(/unterminated/);
  });

  test("bad declarations", () => {
    expect(declErr("")).not.toBeNull();
    expect(declErr("Foo f")).toMatch(/unknown type/);
    expect(declErr("Point")).not.toBeNull();
    expect(declErr("int a[0]")).not.toBeNull();
    expect(declErr("int a[n]")).not.toBeNull();
    expect(declErr("int a b")).not.toBeNull();
    expect(declErr("struct Nope n")).toMatch(/incomplete/);
  });

  test("bad initializers name the path", () => {
    expect(initErr("Rect rects[2]", [{}, { max: { z: 1 } }])).toBe('rects[1].max: unknown field "z"');
    expect(initErr("int a[2]", [1, 2, 3])).toMatch(/^a:/);
    expect(initErr("Point p", { x: "1" })).toMatch(/^p\.x:/);
    expect(initErr("Point p", [1, 2])).toMatch(/^p:/);
    expect(initErr("int a[2]", { x: 1 })).toMatch(/^a:/);
    expect(initErr("char c", 256)).toMatch(/^c: 256 does not fit/);
    expect(initErr("char c", -129)).toMatch(/does not fit/);
    expect(initErr("int i", 1.5)).not.toBeNull();
  });
});
