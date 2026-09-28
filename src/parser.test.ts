import { describe, test, expect } from "vitest";
import { parseInstr } from "./parser";
import { assembleProgram } from "./assembler";
import { simulate } from "./simulator";
import { AppError } from "./types";
import type { Program } from "./types";

function ok(raw: string) {
  const r = parseInstr(raw);
  expect(r, `expected ok for: ${raw}`).not.toBeInstanceOf(AppError);
  return r as Exclude<typeof r, AppError>;
}

function err(raw: string) {
  const r = parseInstr(raw);
  expect(r, `expected error for: ${raw}`).toBeInstanceOf(AppError);
  return r as AppError;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

describe("tokenizer", () => {
  test("strips trailing # comment", () => {
    expect(ok("add t0, t1, t2 # comment")).toEqual({
      op: "add",
      rd: "t0",
      rs1: "t1",
      rs2: "t2",
    });
  });

  test("// is not a comment — treated as garbage", () => {
    err("addi a0, a0, 1 // increment");
  });

  test("handles tabs between opcode and args", () => {
    expect(ok("add\tt0, t1, t2")).toEqual({
      op: "add",
      rd: "t0",
      rs1: "t1",
      rs2: "t2",
    });
  });

  test("handles spaces around commas", () => {
    expect(ok("add t0 , t1 , t2")).toEqual({
      op: "add",
      rd: "t0",
      rs1: "t1",
      rs2: "t2",
    });
  });

  test("handles leading/trailing whitespace", () => {
    expect(ok("  add t0, t1, t2  ")).toEqual({
      op: "add",
      rd: "t0",
      rs1: "t1",
      rs2: "t2",
    });
  });
});

// ─── R-type ───────────────────────────────────────────────────────────────────

describe("R-type", () => {
  test("add", () =>
    expect(ok("add t0, t1, t2")).toEqual({ op: "add", rd: "t0", rs1: "t1", rs2: "t2" }));
  test("sub", () =>
    expect(ok("sub a0, a1, a2")).toEqual({ op: "sub", rd: "a0", rs1: "a1", rs2: "a2" }));
  test("mul", () =>
    expect(ok("mul s0, s1, s2")).toEqual({ op: "mul", rd: "s0", rs1: "s1", rs2: "s2" }));
  test("too few args", () => err("add t0, t1"));
  test("extra arg", () => err("add t0, t1, t2, t3"));
  test("bad rd", () => err("add x99, t1, t2"));
  test("bad rs1", () => err("add t0, notareg, t2"));
});

// ─── I-type ───────────────────────────────────────────────────────────────────

describe("I-type", () => {
  test("addi positive", () =>
    expect(ok("addi a0, a1, 5")).toEqual({ op: "addi", rd: "a0", rs1: "a1", imm: 5 }));
  test("addi negative", () =>
    expect(ok("addi a0, a1, -1")).toEqual({ op: "addi", rd: "a0", rs1: "a1", imm: -1 }));
  test("addi zero", () =>
    expect(ok("addi a0, a1, 0")).toEqual({ op: "addi", rd: "a0", rs1: "a1", imm: 0 }));
  test("slli", () =>
    expect(ok("slli a0, a1, 3")).toEqual({ op: "slli", rd: "a0", rs1: "a1", imm: 3 }));
  test("too few args", () => err("addi a0, a1"));
  test("non-integer imm", () => err("addi a0, a1, foo"));
  test("extra arg", () => err("addi a0, a1, 1, 2"));
});

// ─── Loads ────────────────────────────────────────────────────────────────────

describe("loads", () => {
  test("lw", () =>
    expect(ok("lw a0, 8(sp)")).toEqual({ op: "lw", rd: "a0", offset: 8, rs1: "sp" }));
  test("lw negative offset", () =>
    expect(ok("lw a0, -4(sp)")).toEqual({ op: "lw", rd: "a0", offset: -4, rs1: "sp" }));
  test("lb", () =>
    expect(ok("lb t0, 0(a1)")).toEqual({ op: "lb", rd: "t0", offset: 0, rs1: "a1" }));
  test("lhu", () =>
    expect(ok("lhu t1, 2(a0)")).toEqual({ op: "lhu", rd: "t1", offset: 2, rs1: "a0" }));
  test("malformed mem ref — no parens", () => err("lw a0, 8sp"));
  test("malformed mem ref — missing offset", () => err("lw a0, (sp)"));
  test("bad base register", () => err("lw a0, 8(x99)"));
  test("too few args", () => err("lw a0"));
});

// ─── Stores ───────────────────────────────────────────────────────────────────

describe("stores", () => {
  test("sw", () =>
    expect(ok("sw a0, -4(sp)")).toEqual({ op: "sw", rs2: "a0", offset: -4, rs1: "sp" }));
  test("sb", () =>
    expect(ok("sb t0, 0(a1)")).toEqual({ op: "sb", rs2: "t0", offset: 0, rs1: "a1" }));
  test("sh", () =>
    expect(ok("sh t1, 2(a0)")).toEqual({ op: "sh", rs2: "t1", offset: 2, rs1: "a0" }));
  test("malformed mem ref", () => err("sw a0, bad"));
  test("bad base register", () => err("sw a0, 0(notareg)"));
});

// ─── Branches ─────────────────────────────────────────────────────────────────

describe("branches", () => {
  test("beq", () =>
    expect(ok("beq a0, a1, loop")).toEqual({ op: "beq", rs1: "a0", rs2: "a1", target: "loop" }));
  test("bne", () =>
    expect(ok("bne a0, zero, done")).toEqual({ op: "bne", rs1: "a0", rs2: "zero", target: "done" }));
  test("blt", () =>
    expect(ok("blt t0, t1, end")).toEqual({ op: "blt", rs1: "t0", rs2: "t1", target: "end" }));
  test("missing label", () => err("beq a0, a1"));
  test("extra arg", () => err("beq a0, a1, loop, extra"));
  test("bad register", () => err("beq notareg, a1, loop"));
});

describe("branch pseudo-ops", () => {
  test("beqz", () =>
    expect(ok("beqz a0, done")).toEqual({ op: "beqz", rs1: "a0", target: "done" }));
  test("bnez", () =>
    expect(ok("bnez a0, done")).toEqual({ op: "bnez", rs1: "a0", target: "done" }));
  test("bltz", () =>
    expect(ok("bltz t0, neg")).toEqual({ op: "bltz", rs1: "t0", target: "neg" }));
  test("bgez", () =>
    expect(ok("bgez t0, pos")).toEqual({ op: "bgez", rs1: "t0", target: "pos" }));
  test("bgtz", () =>
    expect(ok("bgtz t0, pos")).toEqual({ op: "bgtz", rs1: "t0", target: "pos" }));
  test("blez", () =>
    expect(ok("blez t0, neg")).toEqual({ op: "blez", rs1: "t0", target: "neg" }));
  test("bgt", () =>
    expect(ok("bgt a0, a1, loop")).toEqual({ op: "bgt", rs1: "a0", rs2: "a1", target: "loop" }));
  test("ble", () =>
    expect(ok("ble a0, a1, loop")).toEqual({ op: "ble", rs1: "a0", rs2: "a1", target: "loop" }));
  test("bgtu", () =>
    expect(ok("bgtu a0, a1, loop")).toEqual({ op: "bgtu", rs1: "a0", rs2: "a1", target: "loop" }));
  test("bleu", () =>
    expect(ok("bleu a0, a1, loop")).toEqual({ op: "bleu", rs1: "a0", rs2: "a1", target: "loop" }));
  test("zero-branch missing label", () => err("beqz a0"));
  test("swap-branch missing label", () => err("bgt a0, a1"));
  test("zero-branch bad register", () => err("beqz notareg, done"));
});

// ─── jalr ─────────────────────────────────────────────────────────────────────

describe("jalr", () => {
  test("jalr rd, 0(rs1)", () =>
    expect(ok("jalr ra, 0(a0)")).toEqual({ op: "jalr", rd: "ra", imm: 0, rs1: "a0" }));
  test("jalr with nonzero offset", () =>
    expect(ok("jalr zero, 4(ra)")).toEqual({ op: "jalr", rd: "zero", imm: 4, rs1: "ra" }));
  test("malformed mem operand", () => err("jalr ra, a0"));
  test("bad base register", () => err("jalr ra, 0(x99)"));
});

// ─── jal ──────────────────────────────────────────────────────────────────────

describe("jal", () => {
  test("1-arg form defaults rd to ra", () =>
    expect(ok("jal foo")).toEqual({ op: "jal", rd: "ra", target: "foo" }));
  test("2-arg form", () =>
    expect(ok("jal ra, foo")).toEqual({ op: "jal", rd: "ra", target: "foo" }));
  test("2-arg form with explicit rd", () =>
    expect(ok("jal zero, skip")).toEqual({ op: "jal", rd: "zero", target: "skip" }));
  test("0 args errors", () => err("jal"));
  test("3 args errors", () => err("jal a, b, c"));
  test("bad rd in 2-arg form", () => err("jal notareg, foo"));
});

// ─── Pseudo-ops ───────────────────────────────────────────────────────────────

describe("pseudo-ops", () => {
  test("ret", () => expect(ok("ret")).toEqual({ op: "ret" }));
  test("nop", () => expect(ok("nop")).toEqual({ op: "nop" }));
  test("ret with extra arg", () => err("ret x0"));
  test("call", () =>
    expect(ok("call foo")).toEqual({ op: "call", target: "foo" }));
  test("j", () =>
    expect(ok("j loop")).toEqual({ op: "j", target: "loop" }));
  test("jr", () =>
    expect(ok("jr ra")).toEqual({ op: "jr", rs: "ra" }));
  test("jr bad register", () => err("jr notareg"));
  test("li", () =>
    expect(ok("li a0, 42")).toEqual({ op: "li", rd: "a0", imm: 42 }));
  test("li negative", () =>
    expect(ok("li a0, -1")).toEqual({ op: "li", rd: "a0", imm: -1 }));
  test("lui", () =>
    expect(ok("lui a0, 4096")).toEqual({ op: "lui", rd: "a0", imm: 4096 }));
  test("mv", () =>
    expect(ok("mv a0, a1")).toEqual({ op: "mv", rd: "a0", rs1: "a1" }));
  test("neg", () =>
    expect(ok("neg a0, a1")).toEqual({ op: "neg", rd: "a0", rs1: "a1" }));
  test("fp alias resolves to s0", () =>
    expect(ok("mv a0, fp")).toEqual({ op: "mv", rd: "a0", rs1: "s0" }));
});

// ─── Branch pseudo-op semantics (full assemble + simulate) ────────────────────

describe("branch pseudo-ops semantics", () => {
  function run(assembly: string, initialRegs: Record<string, number>) {
    const prog: Program = { name: "t", initialRegs, baseAddress: 0x1000, assembly };
    const assembled = assembleProgram(prog);
    if (assembled instanceof AppError) throw assembled;
    const result = simulate(prog, assembled);
    return result.steps[result.steps.length - 1]!.regs;
  }

  const prog = (branch: string) => `
    ${branch}, taken
    li a0, 1
    j end
    taken:
    li a0, 2
    end:
  `;

  test("beqz takes branch when reg == 0", () =>
    expect(run(prog("beqz zero"), {}).a0).toBe(2));
  test("bnez does not take branch when reg == 0", () =>
    expect(run(prog("bnez zero"), {}).a0).toBe(1));
  test("bltz takes branch when reg < 0", () =>
    expect(run(prog("bltz a1"), { a1: -1 }).a0).toBe(2));
  test("bgez does not take branch when reg < 0", () =>
    expect(run(prog("bgez a1"), { a1: -1 }).a0).toBe(1));
  test("bgtz takes branch when reg > 0", () =>
    expect(run(prog("bgtz a1"), { a1: 5 }).a0).toBe(2));
  test("blez takes branch when reg == 0", () =>
    expect(run(prog("blez a1"), { a1: 0 }).a0).toBe(2));
  test("bgt takes branch when rs1 > rs2", () =>
    expect(run(prog("bgt a1, a2"), { a1: 5, a2: 3 }).a0).toBe(2));
  test("bgt does not take branch when rs1 == rs2", () =>
    expect(run(prog("bgt a1, a2"), { a1: 3, a2: 3 }).a0).toBe(1));
  test("ble takes branch when rs1 <= rs2", () =>
    expect(run(prog("ble a1, a2"), { a1: 3, a2: 3 }).a0).toBe(2));
  test("bgtu treats operands as unsigned", () =>
    expect(run(prog("bgtu a1, a2"), { a1: -1, a2: 1 }).a0).toBe(2));
  test("bleu treats operands as unsigned", () =>
    expect(run(prog("bleu a1, a2"), { a1: 1, a2: -1 }).a0).toBe(2));
});

// ─── Unknown / empty ──────────────────────────────────────────────────────────

describe("unknown opcode", () => {
  test("errors on unknown mnemonic", () => err("foobar a0, a1"));
  test("errors on pure comment line", () => err("# just a comment"));
});
