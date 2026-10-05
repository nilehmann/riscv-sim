import { describe, test, expect } from "vitest";
import { validateProgram, validateAssembled } from "./validation";
import { assembleProgram } from "./assembler";
import { getIsa } from "./isa";
import { AppError } from "./types";
import type { MemoryRegion, Program } from "./types";

const rv32 = getIsa("rv32");

const prog = (memoryRegions: MemoryRegion[]): Program => ({
  name: "t", baseAddress: 0x8000, initialRegs: { sp: 0xbfffff00 },
  assembly: "foo:\n    ret", types: "typedef struct { int x; int y; } Point;", memoryRegions,
});

describe("region validation", () => {
  test("overlap uses the struct size", () => {
    // Point[3] is 24 bytes, so a region 16 bytes later overlaps.
    const err = validateProgram(prog([
      { addr: 0x10000, decl: "Point a[3]" },
      { addr: 0x10010, decl: "Point b[3]" },
    ]), rv32);
    expect(err?.message).toBe(
      'region "b" (0x00010010–0x00010027) overlaps region "a" (0x00010000–0x00010017)',
    );
  });

  test("adjacent regions do not overlap", () => {
    expect(validateProgram(prog([
      { addr: 0x10000, decl: "Point a[3]" },
      { addr: 0x10018, decl: "Point b[3]" },
    ]), rv32)).toBeNull();
  });

  test("region overlapping the stack", () => {
    const err = validateProgram(prog([{ addr: 0xbffffff0, decl: "Point p[4]" }]), rv32);
    expect(err?.message).toMatch(/^region "p" .* overlaps the stack/);
  });

  test("region overlapping the code", () => {
    const p = prog([{ addr: 0x7ffc, decl: "Point p" }]);
    const assembled = assembleProgram(p, rv32);
    if (assembled instanceof AppError) throw new Error(assembled.message);
    expect(validateAssembled(p, assembled, rv32)?.message).toMatch(/^region "p" .* overlaps the code segment/);
  });

  test("initializer errors are reported", () => {
    const err = validateProgram(prog([{ addr: 0x10000, decl: "Point p", init: { z: 1 } }]), rv32);
    expect(err?.message).toMatch(/unknown field "z"/);
  });
});
