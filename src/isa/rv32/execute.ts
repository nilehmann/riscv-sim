import type { Instr } from "./types";
import type { ExecResult } from "../types";
import type { Machine } from "../../machine";

// Registers are stored unsigned; these views give their 32-bit meaning.
const s32 = (v: bigint) => BigInt.asIntN(32, v);
const u32 = (v: bigint) => BigInt.asUintN(32, v);
const shamt = (v: bigint) => v & 31n;

const IMM_OPS: Record<string, (a: bigint, b: bigint) => bigint> = {
  addi: (a, b) => a + b,
  andi: (a, b) => a & b,
  ori: (a, b) => a | b,
  xori: (a, b) => a ^ b,
  slli: (a, b) => a << shamt(b),
  srli: (a, b) => u32(a) >> shamt(b),
  srai: (a, b) => s32(a) >> shamt(b),
};

const REG_OPS: Record<string, (a: bigint, b: bigint) => bigint> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => s32(a) * s32(b),
  // Division by zero: quotient all ones, remainder the dividend (as in hardware).
  div: (a, b) => (s32(b) === 0n ? -1n : s32(a) / s32(b)),
  rem: (a, b) => (s32(b) === 0n ? a : s32(a) % s32(b)),
  and: (a, b) => a & b,
  or: (a, b) => a | b,
  xor: (a, b) => a ^ b,
  sll: (a, b) => a << shamt(b),
  srl: (a, b) => u32(a) >> shamt(b),
  sra: (a, b) => s32(a) >> shamt(b),
};

const BRANCH_CONDS: Record<string, (a: bigint, b: bigint) => boolean> = {
  beq: (a, b) => a === b,
  bne: (a, b) => a !== b,
  blt: (a, b) => s32(a) < s32(b),
  bge: (a, b) => s32(a) >= s32(b),
  bltu: (a, b) => a < b,
  bgeu: (a, b) => a >= b,
};

const LOAD_SIZE = { lw: 4, lh: 2, lhu: 2, lb: 1, lbu: 1 } as const;
const STORE_SIZE = { sw: 4, sh: 2, sb: 1 } as const;

/** Address of the stack/memory word containing addr, for highlighting. */
const wordOf = (addr: number) => addr - (addr % 4);

export function execute(m: Machine, c: Instr, addr: number): ExecResult {
  const next = addr + 4;
  const r = (name: string) => m.reg(name);
  const effAddr = (base: string, offset: number) => Number(u32(r(base) + BigInt(offset)));

  switch (c.op) {
    case "addi": case "andi": case "ori": case "xori":
    case "slli": case "srli": case "srai":
      m.writeReg(c.rd, IMM_OPS[c.op]!(r(c.rs1), BigInt(c.imm)));
      return { next, hiReg: [c.rd] };

    case "add": case "sub": case "mul": case "div": case "rem":
    case "and": case "or": case "xor": case "sll": case "srl": case "sra":
      m.writeReg(c.rd, REG_OPS[c.op]!(r(c.rs1), r(c.rs2)));
      return { next, hiReg: [c.rd] };

    case "lui":
      m.writeReg(c.rd, BigInt(c.imm) << 12n);
      return { next, hiReg: [c.rd] };

    case "auipc":
      m.writeReg(c.rd, BigInt(addr) + (BigInt(c.imm) << 12n));
      return { next, hiReg: [c.rd] };

    case "jal":
    case "jalr": {
      // Read rs1 before writing rd: they may be the same register.
      const target =
        c.op === "jal" ? addr + c.target : Number(u32(r(c.rs1) + BigInt(c.imm)) & ~1n);
      m.writeReg(c.rd, BigInt(next));
      return {
        next: target,
        hiReg: c.rd !== "zero" ? [c.rd] : [],
        control: c.rd === "ra" ? { kind: "call", returnAddr: next } : { kind: "jump" },
      };
    }

    case "sw": case "sh": case "sb": {
      const a = effAddr(c.rs1, c.offset);
      if (!m.checkAccess(a, STORE_SIZE[c.op])) return { next, fault: { type: "segfault", addr: a } };
      const size = STORE_SIZE[c.op];
      m.writeMem(a, r(c.rs2), size);
      const slot = wordOf(a);
      return {
        next, hiSlots: [slot], store: { addr: slot, reg: c.rs2, size: 4 },
        access: [{ addr: a, size, kind: "store" }],
      };
    }

    case "lw": case "lh": case "lb": case "lhu": case "lbu": {
      const a = effAddr(c.rs1, c.offset);
      if (!m.checkAccess(a, LOAD_SIZE[c.op])) return { next, fault: { type: "segfault", addr: a } };
      const signed = c.op === "lh" || c.op === "lb";
      const size = LOAD_SIZE[c.op];
      m.writeReg(c.rd, m.readMem(a, size, signed));
      return { next, hiReg: [c.rd], hiSlots: [wordOf(a)], access: [{ addr: a, size, kind: "load" }] };
    }

    case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu": {
      const taken = BRANCH_CONDS[c.op]!(r(c.rs1), r(c.rs2));
      return { next: taken ? addr + c.target : next };
    }
  }
}
