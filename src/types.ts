export interface Program {
    name: string;
    cCode?: string;
    entryPoint: string;
    initialRegs: Record<string, number>;
    baseAddress: number;
    functions: Record<string, string[]>;
}

export type ParsedInstr =
    | { op: "ret" }
    | { op: "nop" }
    | { op: "jalr"; rd: string; rs1: string; imm: number }
    | { op: "call" | "j"; target: string }
    | { op: "jal"; rd: string; target: string }
    | { op: "li" | "lui"; rd: string; imm: number }
    | { op: "mv" | "neg"; rd: string; rs1: string }
    | {
          op: "addi" | "slli" | "srli" | "srai" | "andi" | "ori" | "xori";
          rd: string;
          rs1: string;
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
          rd: string;
          rs1: string;
          rs2: string;
      }
    | { op: "sw" | "sh" | "sb"; rs2: string; offset: number; rs1: string }
    | {
          op: "lw" | "lh" | "lb" | "lhu" | "lbu";
          rd: string;
          offset: number;
          rs1: string;
      }
    | {
          op: "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu";
          rs1: string;
          rs2: string;
          target: string;
      };

export type RelocationType = "R_RISCV_JAL" | "R_RISCV_BRANCH" | "R_RISCV_CALL";

export interface RelocationEntry {
    instrAddr: number;
    symbol: string;
    type: RelocationType;
}

export class LinkError {
    readonly kind = "LinkError" as const;
    constructor(public readonly symbol: string) {}
}

export type ConcreteSpec =
    | { op: "ret" }
    | { op: "jalr"; rd: string; rs1: string; imm: number }
    | { op: "lui" | "auipc"; rd: string; imm: number }
    | { op: "jal"; rd: string; target: number } // 0 pre-link, resolved address post-link
    | {
          op: "addi" | "slli" | "srli" | "srai" | "andi" | "ori" | "xori";
          rd: string;
          rs1: string;
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
          rd: string;
          rs1: string;
          rs2: string;
      }
    | {
          op: "lw" | "lh" | "lb" | "lhu" | "lbu";
          rd: string;
          offset: number;
          rs1: string;
      }
    | { op: "sw" | "sh" | "sb"; rs2: string; offset: number; rs1: string }
    | {
          op: "beq" | "bne" | "blt" | "bge" | "bltu" | "bgeu";
          rs1: string;
          rs2: string;
          target: number; // 0 pre-link, resolved address post-link
      };

export type ConcreteInstr = ConcreteSpec & { addr: number };

export type AssembledInstrs = {
    instrs: ConcreteSpec[];
    /// Whether the list of instructions came from a pseudo-instruction.
    isPseudo: boolean;
};

export interface SourceInstr {
    fn: string;
    raw: string;
    parsed: ParsedInstr;
    concretes: ConcreteInstr[];
    firstAddr: number;
    isPseudo: boolean;
}

export interface AssemblyResult {
    sourceInstrs: SourceInstr[];
    addrToSourceIdx: Map<number, number>;
    labels: Record<string, number>;
    relocations: RelocationEntry[];
}

export interface FrameInfo {
    fn: string;
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
}

export interface DisplayReg {
    name: string;
    desc: string;
    key: string;
}

export type TokenKind = "comment" | "string" | "kw" | "fn" | "num" | "text";
export type Token = [TokenKind, string];

export class ParseError {
    readonly kind = "ParseError" as const;
    constructor(
        public readonly raw: string,
        public readonly fn: string,
    ) {}
}
