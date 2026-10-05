import { describe, test, expect } from "vitest";
import { assembleProgram } from "../../assembler";
import { simulate } from "../../simulator";
import { AppError } from "../../types";
import type { Program } from "../../types";

function steps(assembly: string) {
  const prog: Program = {
    name: "t", baseAddress: 0x8000, assembly, osMode: false,
    initialRegs: { sp: 0xbfffff00, a1: 0x10000 },
  };
  const assembled = assembleProgram(prog);
  if (assembled instanceof AppError) throw new Error(assembled.message);
  return simulate(prog, assembled).steps;
}

describe("memory access", () => {
  test("loads report their exact address and size", () => {
    expect(steps("lb a0, 1(a1)")[1]!.access).toEqual([{ addr: 0x10001, size: 1, kind: "load" }]);
    expect(steps("lhu a0, 2(a1)")[1]!.access).toEqual([{ addr: 0x10002, size: 2, kind: "load" }]);
    expect(steps("lw a0, 4(a1)")[1]!.access).toEqual([{ addr: 0x10004, size: 4, kind: "load" }]);
  });

  test("stores report their exact address and size", () => {
    expect(steps("sw a0, 8(a1)")[1]!.access).toEqual([{ addr: 0x10008, size: 4, kind: "store" }]);
    expect(steps("sb a0, 3(a1)")[1]!.access).toEqual([{ addr: 0x10003, size: 1, kind: "store" }]);
  });

  test("other instructions access no memory", () => {
    expect(steps("addi a0, a0, 1")[1]!.access).toBeUndefined();
  });
});
