import { describe, test, expect } from "vitest";
import { parseInstr } from "./isa/rv32/parser";
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
    expect(run(prog("beqz zero"), {}).a0).toBe(2n));
  test("bnez does not take branch when reg == 0", () =>
    expect(run(prog("bnez zero"), {}).a0).toBe(1n));
  test("bltz takes branch when reg < 0", () =>
    expect(run(prog("bltz a1"), { a1: -1 }).a0).toBe(2n));
  test("bgez does not take branch when reg < 0", () =>
    expect(run(prog("bgez a1"), { a1: -1 }).a0).toBe(1n));
  test("bgtz takes branch when reg > 0", () =>
    expect(run(prog("bgtz a1"), { a1: 5 }).a0).toBe(2n));
  test("blez takes branch when reg == 0", () =>
    expect(run(prog("blez a1"), { a1: 0 }).a0).toBe(2n));
  test("bgt takes branch when rs1 > rs2", () =>
    expect(run(prog("bgt a1, a2"), { a1: 5, a2: 3 }).a0).toBe(2n));
  test("bgt does not take branch when rs1 == rs2", () =>
    expect(run(prog("bgt a1, a2"), { a1: 3, a2: 3 }).a0).toBe(1n));
  test("ble takes branch when rs1 <= rs2", () =>
    expect(run(prog("ble a1, a2"), { a1: 3, a2: 3 }).a0).toBe(2n));
  test("bgtu treats operands as unsigned", () =>
    expect(run(prog("bgtu a1, a2"), { a1: -1, a2: 1 }).a0).toBe(2n));
  test("bleu treats operands as unsigned", () =>
    expect(run(prog("bleu a1, a2"), { a1: 1, a2: -1 }).a0).toBe(2n));
});

// ─── Unknown / empty ──────────────────────────────────────────────────────────

describe("unknown opcode", () => {
  test("errors on unknown mnemonic", () => err("foobar a0, a1"));
  test("errors on pure comment line", () => err("# just a comment"));
});

// ─── Undefined labels ─────────────────────────────────────────────────────────

describe("undefined labels", () => {
  const asm = (assembly: string) =>
    assembleProgram({ name: "t", initialRegs: {}, baseAddress: 0x8000, assembly });

  test.each([
    "beq a0, a1, nowhere",
    "beqz a0, nowhere",
    "bgt a0, a1, nowhere",
    "j nowhere",
    "jal ra, nowhere",
    "call nowhere",
  ])("%s is an error", (line) => {
    const r = asm(`start:\n  ${line}`);
    expect(r).toBeInstanceOf(AppError);
    expect((r as AppError).message).toBe("Undefined label 'nowhere'");
  });

  test("inherited object keys are not labels", () => {
    expect(asm("start:\n  j toString")).toBeInstanceOf(AppError);
  });

  test("defined labels still resolve", () => {
    expect(asm("start:\n  j start")).not.toBeInstanceOf(AppError);
  });
});

// ─── Label placement ──────────────────────────────────────────────────────────

describe("label placement", () => {
  const asm = (assembly: string) => {
    const r = assembleProgram({ name: "t", initialRegs: {}, baseAddress: 0x8000, assembly });
    if (r instanceof AppError) throw r;
    return r;
  };

  test("trailing label points just past the last instruction", () => {
    const r = asm("start:\n  nop\n  li a0, 5000\nend:");
    // nop (4 bytes) + li as lui+addi (8 bytes)
    expect(r.labels["end"]).toBe(0x8000 + 12);
    expect(r.trailingLabels).toEqual(["end"]);
  });

  test("jumping to a trailing label ends the program", () => {
    const prog: Program = {
      name: "t", initialRegs: {}, baseAddress: 0x8000,
      assembly: "  j end\n  li a0, 1\nend:",
    };
    const { steps } = simulate(prog, asm(prog.assembly));
    expect(steps).toHaveLength(2); // initial state + the jump
    expect(steps[1]!.nextAddr).toBe(0x8000 + 8);
    expect(steps[1]!.regs.a0).not.toBe(1n);
  });

  test("consecutive labels all point to the next instruction", () => {
    const r = asm("a:\nb:\n  nop\nc:\n  nop");
    expect(r.labels).toEqual({ a: 0x8000, b: 0x8000, c: 0x8004 });
    expect(r.sourceInstrs[0]!.labels).toEqual(["a", "b"]);
    expect(r.sourceInstrs[1]!.labels).toEqual(["c"]);
  });

  test("branch to an earlier label of a stacked pair", () => {
    expect(asm("a:\nb:\n  beq a0, a1, a\n  j b")).toBeTruthy();
  });

  test("duplicate label keeps the first definition", () => {
    expect(asm("x:\n  nop\nx:\n  nop").labels["x"]).toBe(0x8000);
  });
});
