import { describe, test, expect } from "vitest";
import { PROGRAMS } from "./programs";
import { getIsa } from "./isa";
import { assembleProgram } from "./assembler";
import { simulate } from "./simulator";
import { validateProgram, validateAssembled } from "./validation";
import { resolveRegions } from "./regions";
import { leavesOf } from "./ctypes";
import { isAccessed } from "./regionLayout";
import { AppError } from "./types";
import type { Program } from "./types";

function run(prog: Program) {
  const isa = getIsa(prog.isa);
  expect(validateProgram(prog, isa)).toBeNull();
  const assembled = assembleProgram(prog, isa);
  if (assembled instanceof AppError) throw new Error(assembled.message);
  expect(validateAssembled(prog, assembled, isa)).toBeNull();
  const regions = resolveRegions(prog, isa);
  if (regions instanceof AppError) throw new Error(regions.message);
  return { steps: simulate(prog, assembled, isa).steps, regions };
}

describe("bundled programs", () => {
  test.each(PROGRAMS.map((p) => [`${p.isa ?? "rv32"}: ${p.name}`, p] as const))(
    "%s runs without faulting",
    (_, prog) => {
      const { steps } = run(prog);
      expect(steps.filter((s) => s.fault)).toEqual([]);
    },
  );

  test.each([
    ["Struct field", "pts[1].y"],
    ["Struct padding", "s[1].x"],
    ["Nested struct", "rects[1].max.y"],
    ["Padding before a struct", "items[1].pos.y"],
    ["Array in struct", "poly.v[1].y"],
  ])("%s loads %s", (name, path) => {
    const { steps, regions } = run(PROGRAMS.find((p) => p.name === name)!);
    const leaves = regions.flatMap((r) => leavesOf(r.root));
    const touched = steps.flatMap((s) => leaves.filter((l) => isAccessed(l, s.access)).map((l) => l.path));
    expect(touched).toEqual([path]);
  });
});
