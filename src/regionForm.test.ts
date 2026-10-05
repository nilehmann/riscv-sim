import { describe, test, expect } from "vitest";
import { regionShape, formKey, formFromRegion, initFromForm, setArrayLen, removeRow, parseValue } from "./regionForm";
import type { RegionShape } from "./regionForm";
import { parseTypes } from "./ctypes";
import type { TypeEnv } from "./ctypes";
import { resolveRegions } from "./regions";
import { getIsa } from "./isa";
import { AppError } from "./types";

const TYPES = `
typedef struct { int x; int y; } Point;
typedef struct { Point min, max; } Rect;
struct S { char c; int x; };
typedef struct { int n; Point v[2]; } Poly;
`;

const env = (() => {
  const e = parseTypes(TYPES, 4);
  if (e instanceof AppError) throw new Error(e.message);
  return e;
})() as TypeEnv;

function shape(decl: string): RegionShape {
  const s = regionShape(decl, env, 4);
  if (s instanceof AppError) throw new Error(s.message);
  return s;
}

describe("regionShape", () => {
  test("struct array: one column per leaf of the element, padding skipped", () => {
    expect(shape("Rect rects[2]")).toMatchObject({ name: "rects", len: 2, columns: [".min.x", ".min.y", ".max.x", ".max.y"] });
    expect(shape("struct S s[2]").columns).toEqual([".c", ".x"]);
  });
  test("scalar array: one unnamed column", () => {
    expect(shape("int arr[4]")).toMatchObject({ len: 4, columns: [""] });
  });
  test("lone struct: one row", () => {
    const s = shape("Poly poly");
    expect(s.len).toBeNull();
    expect(s.columns).toEqual([".n", ".v[0].x", ".v[0].y", ".v[1].x", ".v[1].y"]);
    expect(formKey(s, 0, ".n")).toBe(".n");
  });
  test("errors", () => {
    expect(regionShape("Nope n", env, 4)).toBeInstanceOf(AppError);
  });
});

describe("form values", () => {
  test("round trip through a loaded region", () => {
    const regions = resolveRegions({
      name: "t", initialRegs: {}, baseAddress: 0, assembly: "", types: TYPES,
      memoryRegions: [{ addr: 0x10000, decl: "Rect rects[2]", init: [{ min: { x: 1, y: -2 } }, { max: { y: 7 } }] }],
    }, getIsa("rv32"));
    if (regions instanceof AppError) throw new Error(regions.message);
    const values = formFromRegion(regions[0]!);
    expect(values["[0].min.y"]).toBe("-2");
    expect(values["[1].max.y"]).toBe("0x7");
    expect(initFromForm(shape("Rect rects[2]"), values, env, 4)).toEqual([
      { min: { x: 1, y: -2 }, max: { x: 0, y: 0 } },
      { min: { x: 0, y: 0 }, max: { x: 0, y: 7 } },
    ]);
  });

  test("missing values are 0; bad values are errors with the path", () => {
    expect(initFromForm(shape("int a[3]"), { "[1]": "5" }, env, 4)).toEqual([0, 5, 0]);
    const err = initFromForm(shape("Point p"), { ".y": "abc" }, env, 4);
    expect(err instanceof AppError && err.message).toBe("p.y: invalid value");
  });

  test("parseValue", () => {
    expect(parseValue("0x1F")).toBe(31);
    expect(parseValue("-3")).toBe(-3);
    expect(parseValue("'A'")).toBe(65);
    expect(parseValue("")).toBe(0);
    expect(parseValue("1.5")).toBeNull();
    expect(parseValue("12abc")).toBeNull();
  });

  test("setArrayLen rewrites the outer length", () => {
    expect(setArrayLen("Point pts[2]", 3)).toBe("Point pts[3]");
    expect(setArrayLen("int m[2][3]", 4)).toBe("int m[4][3]");
  });

  test("removeRow shifts the later rows up", () => {
    expect(removeRow({ "[0].x": "1", "[1].x": "2", "[2].x": "3", "[2].y": "4" }, 1)).toEqual({
      "[0].x": "1", "[1].x": "3", "[1].y": "4",
    });
  });
});
