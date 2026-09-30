import type { Encoding } from "../types";

// ─── Registers ────────────────────────────────────────────────────────────

export interface RegInfo {
  name: string;
  /** Register number (0–15), as used in ModRM/SIB/REX. */
  num: number;
  /** Width in bytes. */
  size: 1 | 2 | 4 | 8;
  /** The 64-bit register this is a view of. */
  base: string;
  /** spl/bpl/sil/dil are only addressable with a REX prefix. */
  needsRex?: boolean;
}

// Indexed by register number.
const R64 = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi"];
const R32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const R16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const R8 = ["al", "cl", "dl", "bl", "spl", "bpl", "sil", "dil"];

export const REGS: Record<string, RegInfo> = {};
for (let num = 0; num < 16; num++) {
  const base = num < 8 ? R64[num]! : `r${num}`;
  const names: [string, 1 | 2 | 4 | 8][] =
    num < 8
      ? [[R64[num]!, 8], [R32[num]!, 4], [R16[num]!, 2], [R8[num]!, 1]]
      : [[base, 8], [`${base}d`, 4], [`${base}w`, 2], [`${base}b`, 1]];
  for (const [name, size] of names) {
    REGS[name] = { name, num, size, base };
    if (size === 1 && num >= 4 && num < 8) REGS[name]!.needsRex = true;
  }
}

/** 64-bit registers in display order. */
export const REG64 = [
  "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp",
  "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
] as const;

/** Name of register `num` at the given width. */
export function regName(num: number, size: 1 | 2 | 4 | 8): string {
  return Object.values(REGS).find((r) => r.num === num && r.size === size)!.name;
}

// ─── Operands and instructions ────────────────────────────────────────────

export type Size = 1 | 2 | 4 | 8;

export interface RegOp {
  kind: "reg";
  name: string;
}
export interface ImmOp {
  kind: "imm";
  value: bigint;
  /** As written in the source (e.g. hex). */
  text: string;
}
export interface MemOp {
  kind: "mem";
  /** From BYTE/WORD/DWORD/QWORD PTR, or null if not given. */
  size: Size | null;
  base: string | null;
  index: string | null;
  scale: 1 | 2 | 4 | 8;
  disp: number;
}
export interface LabelOp {
  kind: "label";
  name: string;
}
export type Operand = RegOp | ImmOp | MemOp | LabelOp;

/** A source instruction: mnemonic and operands, destination first. */
export interface Parsed {
  op: string;
  ops: Operand[];
}

/** A machine instruction: a source instruction with its bytes. */
export interface Instr extends Parsed {
  /** Absolute address a label operand resolved to. */
  target?: number;
  enc: Encoding;
}

// ─── Condition codes (jcc / setcc) ────────────────────────────────────────

export const CC: Record<string, number> = {
  o: 0, no: 1, b: 2, c: 2, nae: 2, ae: 3, nb: 3, nc: 3, e: 4, z: 4, ne: 5, nz: 5,
  be: 6, na: 6, a: 7, nbe: 7, s: 8, ns: 9, p: 10, pe: 10, np: 11, po: 11,
  l: 12, nge: 12, ge: 13, nl: 13, le: 14, ng: 14, g: 15, nle: 15,
};

/** Condition code of a jcc/setcc mnemonic, or undefined. */
export function condOf(op: string, prefix: "j" | "set"): number | undefined {
  if (!op.startsWith(prefix) || op === "jmp") return undefined;
  const cc = op.slice(prefix.length);
  return Object.prototype.hasOwnProperty.call(CC, cc) ? CC[cc] : undefined;
}
