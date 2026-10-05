import { describe, test, expect } from "vitest";
import { assembleProgram } from "./assembler";
import { simulate } from "./simulator";
import { AppError } from "./types";
import type { Program } from "./types";
import { PROGRAMS } from "./programs";

function run(prog: Program) {
  const assembled = assembleProgram(prog);
  if (assembled instanceof AppError) throw new Error(assembled.message);
  return simulate(prog, assembled).steps;
}

const word = (mem: Map<number, number>, addr: number) =>
  [0, 1, 2, 3].reduce((v, i) => v | ((mem.get(addr + i) ?? 0) << (i * 8)), 0) >>> 0;

describe("memory regions in OS mode", () => {
  const globalArray = PROGRAMS.find((p) => p.name === "Global array")!;

  test("Global array runs without faulting", () => {
    const steps = run(globalArray);
    expect(steps.every((s) => !s.fault)).toBe(true);
    expect(word(steps[steps.length - 1]!.mem, 0x10008)).toBe(60);
  });

  test("a load just past the end of a region segfaults", () => {
    const steps = run({
      ...globalArray,
      assembly: "foo:\n    li a5, 0x10000\n    lw a0, 16(a5)\n    ret",
    });
    expect(steps[steps.length - 1]!.fault).toEqual({ type: "segfault", addr: 0x10010 });
  });

  test("a word load straddling the end of a region segfaults", () => {
    const steps = run({
      ...globalArray,
      assembly: "foo:\n    li a5, 0x10000\n    lw a0, 14(a5)\n    ret",
    });
    expect(steps[steps.length - 1]!.fault).toEqual({ type: "segfault", addr: 0x1000e });
  });
});

describe("typed regions", () => {
  const base: Program = {
    name: "t", entryPoint: "foo", baseAddress: 0x8000,
    initialRegs: { sp: 0xbfffff00, ra: 0x9000 }, assembly: "foo:\n    ret",
    types: "typedef struct { int x; int y; } Point;\nstruct S { char c; int x; };",
  };

  test("struct values are written in layout order", () => {
    const [s0] = run({
      ...base,
      memoryRegions: [{ addr: 0x10000, decl: "Point pts[3]", init: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }],
    });
    expect([0, 4, 8, 12, 16, 20].map((o) => word(s0!.mem, 0x10000 + o))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("padding bytes are never written", () => {
    const [s0] = run({
      ...base,
      memoryRegions: [{ addr: 0x10000, decl: "struct S s[2]", init: [{ c: 0x41, x: 7 }, { c: 0x42, x: 9 }] }],
    });
    const mem = s0!.mem;
    expect(mem.get(0x10000)).toBe(0x41);
    for (const a of [1, 2, 3, 9, 10, 11]) expect(mem.has(0x10000 + a)).toBe(false);
    expect(word(mem, 0x10004)).toBe(7);
    expect(mem.get(0x10008)).toBe(0x42);
    expect(word(mem, 0x1000c)).toBe(9);
  });
});
