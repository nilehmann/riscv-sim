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

export interface Program {
  name: string;
  cCode?: string;
  entryPoint: string;
  initialRegs: Record<string, number>;
  baseAddress: number;
  /** Top of the stack (stack grows down from here). Default: 0xC0000000 */
  stackBase?: number;
  /** When true, memory accesses outside [sp, stackBase) segfault. Default: true */
  osMode?: boolean;
  assembly: string;
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
      op: "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu";
      rs1: Reg;
      rs2: Reg;
      target: string;
    };

export class AppError {
  readonly kind = "AppError" as const;
  constructor(
    public readonly message: string,
    public readonly detail?: string,
  ) {}
}

export type ConcreteSpec =
  | { op: "jalr"; rd: Reg; rs1: Reg; imm: number }
  | { op: "lui" | "auipc"; rd: Reg; imm: number }
  | { op: "jal"; rd: Reg; target: number } // PC-relative offset
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
  | {
      op: "lw" | "lh" | "lb" | "lhu" | "lbu";
      rd: Reg;
      offset: number;
      rs1: Reg;
    }
  | { op: "sw" | "sh" | "sb"; rs2: Reg; offset: number; rs1: Reg }
  | {
      op: "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu";
      rs1: Reg;
      rs2: Reg;
      target: number; // PC-relative offset
    };

export interface SourceInstr {
  label: string;
  raw: string;
  parsed: ParsedInstr;
  concretes: ConcreteSpec[];
  firstAddr: number;
}

export interface AssemblyResult {
  sourceInstrs: SourceInstr[];
  addrToSourceIdx: Map<number, number>;
  labels: Record<string, number>;
}

export interface FrameInfo {
  label: string;
  entrySpBefore: number;
  allocatedSize: number;
}

export interface Step {
  aHl: number[];
  nextAddr: number | null;
  regs: Record<string, number>;
  hiReg: string[];
  mem: Map<number, number>;
  hiSlots: number[];
  slotLabels: Map<number, string>;
  callStack: FrameInfo[];
  fault?: { type: "segfault"; addr: number };
}

export interface SimulateResult {
  steps: Step[];
  sourceToConcrete: number[]; // steps index of last concrete step of source[i]
}

export interface DisplayReg {
  name: string;
  desc: string;
  key: string;
}

export type TokenKind = "comment" | "string" | "kw" | "fn" | "num" | "text";
export type Token = [TokenKind, string];
