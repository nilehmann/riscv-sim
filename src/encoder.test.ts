import { describe, test, expect } from "vitest";
import { encode, encodeDetailed, wordBytes } from "./encoder";
import type { Instr } from "./types";

// Reference bytes from `llvm-mc -triple=riscv32 -mattr=+m -show-encoding`.
const CASES: Array<[string, Instr, number[]]> = [
  ["addi a0, a0, 1", { op: "addi", rd: "a0", rs1: "a0", imm: 1 }, [0x13, 0x05, 0x15, 0x00]],
  ["addi sp, sp, -16", { op: "addi", rd: "sp", rs1: "sp", imm: -16 }, [0x13, 0x01, 0x01, 0xff]],
  ["sw ra, 12(sp)", { op: "sw", rs2: "ra", offset: 12, rs1: "sp" }, [0x23, 0x26, 0x11, 0x00]],
  ["lw ra, 12(sp)", { op: "lw", rd: "ra", offset: 12, rs1: "sp" }, [0x83, 0x20, 0xc1, 0x00]],
  ["sb t0, -1(s1)", { op: "sb", rs2: "t0", offset: -1, rs1: "s1" }, [0xa3, 0x8f, 0x54, 0xfe]],
  ["lhu a5, 2047(a1)", { op: "lhu", rd: "a5", offset: 2047, rs1: "a1" }, [0x83, 0xd7, 0xf5, 0x7f]],
  ["jalr zero, 0(ra)", { op: "jalr", rd: "zero", rs1: "ra", imm: 0 }, [0x67, 0x80, 0x00, 0x00]],
  ["add a0, a0, s0", { op: "add", rd: "a0", rs1: "a0", rs2: "s0" }, [0x33, 0x05, 0x85, 0x00]],
  ["sub a0, zero, a1", { op: "sub", rd: "a0", rs1: "zero", rs2: "a1" }, [0x33, 0x05, 0xb0, 0x40]],
  ["mul a0, a0, a1", { op: "mul", rd: "a0", rs1: "a0", rs2: "a1" }, [0x33, 0x05, 0xb5, 0x02]],
  ["div t3, t4, t5", { op: "div", rd: "t3", rs1: "t4", rs2: "t5" }, [0x33, 0xce, 0xee, 0x03]],
  ["rem s11, a7, t6", { op: "rem", rd: "s11", rs1: "a7", rs2: "t6" }, [0xb3, 0xed, 0xf8, 0x03]],
  ["sra a2, a3, a4", { op: "sra", rd: "a2", rs1: "a3", rs2: "a4" }, [0x33, 0xd6, 0xe6, 0x40]],
  ["xori s2, s3, -2048", { op: "xori", rd: "s2", rs1: "s3", imm: -2048 }, [0x13, 0xc9, 0x09, 0x80]],
  ["srai a0, a0, 3", { op: "srai", rd: "a0", rs1: "a0", imm: 3 }, [0x13, 0x55, 0x35, 0x40]],
  ["slli t1, t2, 31", { op: "slli", rd: "t1", rs1: "t2", imm: 31 }, [0x13, 0x93, 0xf3, 0x01]],
  ["lui a0, 0x12345", { op: "lui", rd: "a0", imm: 0x12345 }, [0x37, 0x55, 0x34, 0x12]],
  ["lui t0, 0xfffff", { op: "lui", rd: "t0", imm: -1 }, [0xb7, 0xf2, 0xff, 0xff]],
  ["auipc ra, 1", { op: "auipc", rd: "ra", imm: 1 }, [0x97, 0x10, 0x00, 0x00]],
  ["jal ra, 8", { op: "jal", rd: "ra", target: 8 }, [0xef, 0x00, 0x80, 0x00]],
  ["jal zero, -4", { op: "jal", rd: "zero", target: -4 }, [0x6f, 0xf0, 0xdf, 0xff]],
  ["jal ra, -1048576", { op: "jal", rd: "ra", target: -1048576 }, [0xef, 0x00, 0x00, 0x80]],
  ["beq a0, zero, 8", { op: "beq", rs1: "a0", rs2: "zero", target: 8 }, [0x63, 0x04, 0x05, 0x00]],
  ["bne a0, a1, -4", { op: "bne", rs1: "a0", rs2: "a1", target: -4 }, [0xe3, 0x1e, 0xb5, 0xfe]],
  ["bgeu s1, s2, -4096", { op: "bgeu", rs1: "s1", rs2: "s2", target: -4096 }, [0x63, 0xf0, 0x24, 0x81]],
  ["blt t0, t1, 4094", { op: "blt", rs1: "t0", rs2: "t1", target: 4094 }, [0xe3, 0xcf, 0x62, 0x7e]],
] as Array<[string, Instr, number[]]>;

describe("encode", () => {
  test.each(CASES)("%s", (_, instr, bytes) => {
    expect(wordBytes(encode(instr))).toEqual(bytes);
  });

  test.each(CASES)("fields of %s tile bits 31..0 in order", (_, instr) => {
    const { fields } = encodeDetailed(instr);
    let next = 31;
    for (const f of fields) {
      expect(f.hi).toBe(next);
      expect(f.lo).toBeLessThanOrEqual(f.hi);
      next = f.lo - 1;
    }
    expect(next).toBe(-1);
  });
});

describe("immediate reassembly", () => {
  test("S-type joins imm[11:5] and imm[4:0]", () => {
    const { imm } = encodeDetailed({ op: "sw", rs2: "ra", offset: 12, rs1: "sp" } as Instr);
    expect(imm).toEqual({
      parts: [
        { field: "imm[11:5]", bits: "0000000" },
        { field: "imm[4:0]", bits: "01100" },
      ],
      value: 12,
    });
  });

  test("B-type orders pieces by imm bit and appends implicit zero", () => {
    const { imm } = encodeDetailed({ op: "bne", rs1: "a0", rs2: "a1", target: -4 } as Instr);
    expect(imm!.parts.map((p) => p.field)).toEqual([
      "imm[12]", "imm[11]", "imm[10:5]", "imm[4:1]", null,
    ]);
    expect(imm!.parts.map((p) => p.bits).join("")).toBe("1111111111100");
    expect(imm!.value).toBe(-4);
  });

  test("J-type reassembles to 21 bits", () => {
    const { imm } = encodeDetailed({ op: "jal", rd: "zero", target: -4 } as Instr);
    expect(imm!.parts.map((p) => p.bits).join("")).toBe("111111111111111111100");
  });
});
