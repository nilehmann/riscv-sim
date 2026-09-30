import { AppError } from "../../types";

// ─── Registers ────────────────────────────────────────────────────────────
// Display order (not ABI number order).
export const ALL_REGS = [
  "zero",
  "ra",
  "sp",
  "gp",
  "tp",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "s0",
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s8",
  "s9",
  "s10",
  "s11",
  "t0",
  "t1",
  "t2",
  "t3",
  "t4",
  "t5",
  "t6",
] as const;

export type Reg = (typeof ALL_REGS)[number];

export function isReg(s: string): s is Reg {
  return (ALL_REGS as readonly string[]).includes(s);
}

export type ParsedInstr =
  | { op: "ret" }
  | { op: "nop" }
  | { op: "jalr"; rd: Reg; rs1: Reg; imm: number }
  | { op: "call" | "j"; target: string }
  | { op: "jal"; rd: Reg; target: string }
  | { op: "jr"; rs: Reg }
  | { op: "li" | "lui"; rd: Reg; imm: number }
  | { op: "mv" | "neg"; rd: Reg; rs1: Reg }
  | {
      op: "addi" | "slli" | "srli" | "srai" | "andi" | "ori" | "xori";
      rd: Reg;
      rs1: Reg;
      imm: number;
    }
  | {
      op:
        | "add"
        | "sub"
        | "mul"
        | "div"
        | "rem"
        | "and"
        | "or"
        | "xor"
        | "sll"
        | "srl"
        | "sra";
      rd: Reg;
      rs1: Reg;
      rs2: Reg;
    }
  | { op: "sw" | "sh" | "sb"; rs2: Reg; offset: number; rs1: Reg }
  | {
      op: "lw" | "lh" | "lb" | "lhu" | "lbu";
      rd: Reg;
      offset: number;
      rs1: Reg;
    }
  | {
      op:
        | "beq"
        | "bne"
        | "blt"
        | "bge"
        | "bltu"
        | "bgeu"
        | "bgt"
        | "ble"
        | "bgtu"
        | "bleu";
      rs1: Reg;
      rs2: Reg;
      target: string;
    }
  | {
      op: "beqz" | "bnez" | "bltz" | "bgez" | "bgtz" | "blez";
      rs1: Reg;
      target: string;
    };

declare const __bits: unique symbol;
export type Imm<N extends number> = number & { [__bits]: N };

export function imm<N extends number>(value: number, bits: N): Imm<N> | AppError {
  const min = -(1 << (bits - 1));
  const max = (1 << (bits - 1)) - 1;
  if (value < min || value > max)
    return new AppError(`Immediate ${value} does not fit in a signed ${bits}-bit field`);
  return value as Imm<N>;
}

export type Instr =
  | { op: "jalr"; rd: Reg; rs1: Reg; imm: Imm<12> }
  | { op: "lui" | "auipc"; rd: Reg; imm: Imm<20> }
  | { op: "jal"; rd: Reg; target: Imm<21> } // PC-relative offset
  | {
      op: "addi" | "slli" | "srli" | "srai" | "andi" | "ori" | "xori";
      rd: Reg;
      rs1: Reg;
      imm: Imm<12>;
    }
  | {
      op:
        | "add"
        | "sub"
        | "mul"
        | "div"
        | "rem"
        | "and"
        | "or"
        | "xor"
        | "sll"
        | "srl"
        | "sra";
      rd: Reg;
      rs1: Reg;
      rs2: Reg;
    }
  | {
      op: "lw" | "lh" | "lb" | "lhu" | "lbu";
      rd: Reg;
      offset: Imm<12>;
      rs1: Reg;
    }
  | { op: "sw" | "sh" | "sb"; rs2: Reg; offset: Imm<12>; rs1: Reg }
  | {
      op: "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu";
      rs1: Reg;
      rs2: Reg;
      target: Imm<13>; // PC-relative offset
    };
