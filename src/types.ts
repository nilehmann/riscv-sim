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

export class RangeError {
    readonly kind = "RangeError" as const;
    constructor(
        public readonly raw: string,
        public readonly fn: string,
    ) {}
}

export type ConcreteSpec =
    | { op: "jalr"; rd: string; rs1: string; imm: number }
    | { op: "lui" | "auipc"; rd: string; imm: number }
    | { op: "jal"; rd: string; target: number } // PC-relative offset
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
          target: number; // PC-relative offset
      };

export interface SourceInstr {
    fn: string;
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
