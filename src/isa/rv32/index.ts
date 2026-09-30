import type { Instr, ParsedInstr, Reg } from "./types";
import type { Isa } from "../types";
import { ALL_REGS, isReg } from "./types";
import { parseInstr } from "./parser";
import { expand, minInstrs } from "./expand";
import { encode } from "./encoder";
import { tokens, sourceTokens } from "./format";
import { execute } from "./execute";
import { garbageValue } from "../../garbage";

// ─── Garbage instructions ─────────────────────────────────────────────────

const GARBAGE_REGS = ALL_REGS.filter((r) => r !== "zero");

function greg(h: number, salt: number): Reg {
  const idx = Math.abs((h >> (salt * 6)) ^ Math.imul(salt + 1, 0x2545f4)) % GARBAGE_REGS.length;
  return GARBAGE_REGS[idx]!;
}
function gimm(h: number): number {
  return ((h >>> 8) % 2048) - 1024;
}

// Immediates are built in range, so the Imm<N> brands hold.
const GARBAGE_TEMPLATES = [
  (h) => ({ op: "addi", rd: greg(h, 0), rs1: greg(h, 1), imm: gimm(h) }),
  (h) => ({ op: "lw", rd: greg(h, 0), offset: gimm(h) & 0xff, rs1: greg(h, 1) }),
  (h) => ({ op: "sw", rs2: greg(h, 0), offset: gimm(h) & 0xff, rs1: greg(h, 1) }),
  (h) => ({ op: "xor", rd: greg(h, 0), rs1: greg(h, 1), rs2: greg(h, 2) }),
  (h) => ({ op: "or", rd: greg(h, 0), rs1: greg(h, 1), rs2: greg(h, 2) }),
  (h) => ({ op: "slli", rd: greg(h, 0), rs1: greg(h, 1), imm: Math.abs(h >>> 3) % 32 }),
] as Array<(h: number) => Instr>;

// ─── ISA ──────────────────────────────────────────────────────────────────

export const rv32: Isa<ParsedInstr, Instr> = {
  id: "rv32",
  name: "RISC-V (RV32IM)",
  shortName: "RISC-V",
  wordBytes: 4,
  slotBytes: 4,
  regs: {
    names: ALL_REGS,
    sp: "sp",
    fp: "s0",
    fpLabel: "fp",
    zero: "zero",
    returnAddr: "ra",
    aliases: { fp: "s0" },
    pc: "pc",
  },
  redZone: 0,
  sizeNames: { 4: "w", 2: "h", 1: "b" },
  defaults: { baseAddress: 0x8000, stackBase: 0xc0000000, sp: 0xbfffff00 },
  lineComment: "#",

  parseInstr,
  minSize: (p) => minInstrs(p) * 4,
  expand,
  size: () => 4,
  encode,
  tokens,
  sourceTokens,
  isPseudo: (p, concretes) => concretes.length > 1 || concretes[0]?.op !== p.op,
  execute,
  regsUsed(c) {
    const used: string[] = [];
    for (const field of ["rd", "rs1", "rs2"] as const) {
      const v = (c as Record<string, unknown>)[field];
      if (typeof v === "string" && isReg(v)) used.push(v);
    }
    return used;
  },
  garbage(seed) {
    const h = garbageValue(seed);
    return GARBAGE_TEMPLATES[Math.abs(h) % GARBAGE_TEMPLATES.length]!(h);
  },
  initialReturnAddr: (m) => Number(m.reg("ra")),

  editor: {
    mnemonics: new Set([
      "add", "addi", "sub", "mul", "div", "rem",
      "and", "andi", "or", "ori", "xor", "xori",
      "sll", "slli", "srl", "srli", "sra", "srai",
      "lui", "auipc", "jal", "jalr", "ret", "nop",
      "beq", "bne", "blt", "bge", "bltu", "bgeu",
      "beqz", "bnez", "bltz", "bgez", "bgtz", "blez",
      "bgt", "ble", "bgtu", "bleu",
      "lw", "lh", "lb", "lhu", "lbu", "sw", "sh", "sb",
      "mv", "neg", "li", "la", "call", "tail", "j", "jr",
    ]),
  },
};
