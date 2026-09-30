import type { Instr, Reg } from "./types";
import type { BitField, Encoding, ImmPart } from "../types";

// ─── Register numbers ─────────────────────────────────────────────────────
// ALL_REGS is ordered for display, not by ABI number, so map explicitly.
const REG_NUM: Record<Reg, number> = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4, t0: 5, t1: 6, t2: 7,
  s0: 8, s1: 9, a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15,
  a6: 16, a7: 17, s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23,
  s8: 24, s9: 25, s10: 26, s11: 27, t3: 28, t4: 29, t5: 30, t6: 31,
};

// ─── Encoding layout ──────────────────────────────────────────────────────

export type Format = "R" | "I" | "S" | "B" | "U" | "J";
type Field = BitField;

/** Extracts bits [hi:lo] of v. */
function bits(v: number, hi: number, lo: number): number {
  return (v >>> lo) & ((1 << (hi - lo + 1)) - 1 || -1);
}

function bin(v: number, width: number): string {
  return (v >>> 0).toString(2).padStart(width, "0").slice(-width);
}

// Field constructors.
function opcode(v: number, note: string): Field {
  return { name: "opcode", hi: 6, lo: 0, value: v, kind: "opcode", note };
}
function funct3(v: number, note: string): Field {
  return { name: "funct3", hi: 14, lo: 12, value: v, kind: "funct", note };
}
function funct7(v: number, note: string): Field {
  return { name: "funct7", hi: 31, lo: 25, value: v, kind: "funct", note };
}
function reg(name: "rd" | "rs1" | "rs2", r: Reg): Field {
  const lo = name === "rd" ? 7 : name === "rs1" ? 15 : 20;
  const n = REG_NUM[r];
  return { name, hi: lo + 4, lo, value: n, kind: "reg", note: `x${n} (${r})` };
}
/** A slice imm[immHi:immLo] placed at word bits [at + (immHi-immLo) : at]. */
function immSlice(imm: number, immHi: number, immLo: number, at: number): Field {
  const name = immHi === immLo ? `imm[${immHi}]` : `imm[${immHi}:${immLo}]`;
  return {
    name,
    hi: at + immHi - immLo,
    lo: at,
    value: bits(imm, immHi, immLo),
    kind: "imm",
    note: "",
  };
}

const R_OPS = {
  add: [0b000, 0x00], sub: [0b000, 0x20], sll: [0b001, 0x00],
  xor: [0b100, 0x00], srl: [0b101, 0x00], sra: [0b101, 0x20],
  or: [0b110, 0x00], and: [0b111, 0x00],
  mul: [0b000, 0x01], div: [0b100, 0x01], rem: [0b110, 0x01],
} as const;
const I_ARITH_F3 = { addi: 0b000, xori: 0b100, ori: 0b110, andi: 0b111 } as const;
const SHIFT_OPS = { slli: [0b001, 0x00], srli: [0b101, 0x00], srai: [0b101, 0x20] } as const;
const LOAD_F3 = { lb: 0b000, lh: 0b001, lw: 0b010, lbu: 0b100, lhu: 0b101 } as const;
const STORE_F3 = { sb: 0b000, sh: 0b001, sw: 0b010 } as const;
const BRANCH_F3 = { beq: 0b000, bne: 0b001, blt: 0b100, bge: 0b101, bltu: 0b110, bgeu: 0b111 } as const;

function layout(c: Instr): { format: Format; fields: Field[]; immValue: number | null } {
  switch (c.op) {
    case "add": case "sub": case "sll": case "xor": case "srl": case "sra":
    case "or": case "and": case "mul": case "div": case "rem": {
      const [f3, f7] = R_OPS[c.op];
      return {
        format: "R",
        fields: [funct7(f7, c.op), reg("rs2", c.rs2), reg("rs1", c.rs1),
          funct3(f3, c.op), reg("rd", c.rd), opcode(0b0110011, "OP")],
        immValue: null,
      };
    }
    case "addi": case "xori": case "ori": case "andi":
      return {
        format: "I",
        fields: [immSlice(c.imm, 11, 0, 20), reg("rs1", c.rs1),
          funct3(I_ARITH_F3[c.op], c.op), reg("rd", c.rd), opcode(0b0010011, "OP-IMM")],
        immValue: c.imm,
      };
    case "slli": case "srli": case "srai": {
      const [f3, f7] = SHIFT_OPS[c.op];
      const shamt = c.imm & 0x1f;
      return {
        format: "I",
        fields: [funct7(f7, c.op),
          { name: "shamt", hi: 24, lo: 20, value: shamt, kind: "imm", note: String(shamt) },
          reg("rs1", c.rs1), funct3(f3, c.op), reg("rd", c.rd), opcode(0b0010011, "OP-IMM")],
        immValue: null,
      };
    }
    case "lb": case "lh": case "lw": case "lbu": case "lhu":
      return {
        format: "I",
        fields: [immSlice(c.offset, 11, 0, 20), reg("rs1", c.rs1),
          funct3(LOAD_F3[c.op], c.op), reg("rd", c.rd), opcode(0b0000011, "LOAD")],
        immValue: c.offset,
      };
    case "jalr":
      return {
        format: "I",
        fields: [immSlice(c.imm, 11, 0, 20), reg("rs1", c.rs1),
          funct3(0b000, "jalr"), reg("rd", c.rd), opcode(0b1100111, "JALR")],
        immValue: c.imm,
      };
    case "sb": case "sh": case "sw":
      return {
        format: "S",
        fields: [immSlice(c.offset, 11, 5, 25), reg("rs2", c.rs2), reg("rs1", c.rs1),
          funct3(STORE_F3[c.op], c.op), immSlice(c.offset, 4, 0, 7), opcode(0b0100011, "STORE")],
        immValue: c.offset,
      };
    case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu":
      return {
        format: "B",
        fields: [immSlice(c.target, 12, 12, 31), immSlice(c.target, 10, 5, 25),
          reg("rs2", c.rs2), reg("rs1", c.rs1), funct3(BRANCH_F3[c.op], c.op),
          immSlice(c.target, 4, 1, 8), immSlice(c.target, 11, 11, 7), opcode(0b1100011, "BRANCH")],
        immValue: c.target,
      };
    case "lui": case "auipc":
      return {
        format: "U",
        fields: [immSlice(c.imm << 12, 31, 12, 12), reg("rd", c.rd),
          opcode(c.op === "lui" ? 0b0110111 : 0b0010111, c.op === "lui" ? "LUI" : "AUIPC")],
        immValue: null,
      };
    case "jal":
      return {
        format: "J",
        fields: [immSlice(c.target, 20, 20, 31), immSlice(c.target, 10, 1, 21),
          immSlice(c.target, 11, 11, 20), immSlice(c.target, 19, 12, 12),
          reg("rd", c.rd), opcode(0b1101111, "JAL")],
        immValue: c.target,
      };
  }
}

/** Width in bits of the reassembled immediate, and how many low bits are implicit zeros. */
const IMM_SHAPE: Partial<Record<Format, { top: number; implicitZeros: number }>> = {
  I: { top: 11, implicitZeros: 0 },
  S: { top: 11, implicitZeros: 0 },
  B: { top: 12, implicitZeros: 1 },
  J: { top: 20, implicitZeros: 1 },
};

export function encode(c: Instr): Encoding {
  const { format, fields, immValue } = layout(c);
  let word = 0;
  for (const f of fields) word |= f.value << f.lo;

  let imm: Encoding["imm"] = null;
  const shape = IMM_SHAPE[format];
  if (immValue !== null && shape) {
    // Walk imm bits from the top down, grouping consecutive bits by source field.
    const immFields = fields
      .filter((f) => f.kind === "imm")
      .map((f) => {
        const m = f.name.match(/^imm\[(\d+)(?::(\d+))?\]$/)!;
        const hi = Number(m[1]);
        return { f, hi, lo: m[2] === undefined ? hi : Number(m[2]) };
      })
      .sort((a, b) => b.hi - a.hi);
    const parts: ImmPart[] = immFields.map(({ f, hi, lo }) => ({
      field: f.name,
      bits: bin(f.value, hi - lo + 1),
    }));
    if (shape.implicitZeros) parts.push({ field: null, bits: "0".repeat(shape.implicitZeros) });
    imm = { parts, value: immValue };
  }

  // Little-endian: bytes[k] is the byte at addr + k.
  const bytes = [0, 8, 16, 24].map((s) => (word >>> s) & 0xff);
  return {
    bytes,
    format,
    parts: [{ name: "instruction", offset: 0, length: 4, fields }],
    imm,
  };
}
