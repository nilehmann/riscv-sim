import { describe, test, expect } from "vitest";
import { resolveRegions } from "./regions";
import { leavesOf } from "./ctypes";
import { getIsa } from "./isa";
import { AppError } from "./types";
import type { MemoryRegion, Program, ResolvedRegion } from "./types";

const rv32 = getIsa("rv32");

function resolve(memoryRegions: MemoryRegion[], types?: string): ResolvedRegion[] | AppError {
  const prog: Program = { name: "t", initialRegs: {}, baseAddress: 0x8000, assembly: "", types, memoryRegions };
  return resolveRegions(prog, rv32);
}

function ok(memoryRegions: MemoryRegion[], types?: string): ResolvedRegion[] {
  const r = resolve(memoryRegions, types);
  if (r instanceof AppError) throw new Error(r.message);
  return r;
}

const leafData = (r: ResolvedRegion) => leavesOf(r.root).map(({ addr, size, value, pad }) => ({ addr, size, value, pad }));

describe("resolveRegions", () => {
  test.each([
    [1, "unsigned char"],
    [2, "unsigned short"],
    [4, "int"],
  ] as const)("a legacy %i-byte region matches its declaration", (elementSize, ctype) => {
    const elements = [1, 2, 3];
    const [legacy] = ok([{ addr: 0x10000, elementSize, elements }]);
    const [decl] = ok([{ addr: 0x10000, decl: `${ctype} arr[3]`, init: elements }]);
    expect(legacy!.name).toBe("region0");
    expect(legacy!.size).toBe(3 * elementSize);
    expect(leafData(legacy!)).toEqual(leafData(decl!));
  });

  test("struct regions use the program's types", () => {
    const [r] = ok(
      [{ addr: 0x10000, decl: "Point pts[3]", init: [{ x: 1, y: 2 }] }],
      "typedef struct { int x; int y; } Point;",
    );
    expect(r).toMatchObject({ name: "pts", addr: 0x10000, size: 24 });
  });

  test("errors", () => {
    expect(resolve([{ addr: 0, decl: "int" }])).toBeInstanceOf(AppError);
    expect(resolve([{ addr: 0, decl: "Point p" }])).toBeInstanceOf(AppError);
    expect(resolve([{ addr: 0, decl: "int a" }], "struct {")).toBeInstanceOf(AppError);
    expect(resolve([{ addr: 0, decl: "int a[2]", init: [1, 2, 3] }])).toBeInstanceOf(AppError);
    const dup = resolve([{ addr: 0, decl: "int a" }, { addr: 8, decl: "char a" }]);
    expect(dup instanceof AppError && dup.message).toMatch(/duplicate region name "a"/);
  });
});
