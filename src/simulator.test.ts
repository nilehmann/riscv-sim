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
