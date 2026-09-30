import type { Instr, ParsedInstr } from "./types";
import type { Token } from "../types";

const kw = (t: string): Token => ({ kind: "kw", text: t });
const reg = (r: string): Token => ({ kind: "reg", text: r });
const imm = (t: string | number): Token => ({ kind: "imm", text: String(t) });
const punct = (t: string): Token => ({ kind: "punct", text: t });
const sep = (): Token => punct(", ");
const rel = (off: number): Token => imm(`${off >= 0 ? "+" : ""}${off}`);
const mem = (off: Token, base: string): Token[] => [off, punct("("), reg(base), punct(")")];

// ─── Machine instructions ─────────────────────────────────────────────────
// Branch and jump targets are shown as PC-relative offsets, as encoded.

export function tokens(c: Instr): Token[] {
  const ops = ((): Token[] => {
    switch (c.op) {
      case "jalr":
        return [reg(c.rd), sep(), ...mem(imm(c.imm), c.rs1)];
      case "jal":
        return [reg(c.rd), sep(), rel(c.target)];
      case "lui":
      case "auipc":
        return [reg(c.rd), sep(), imm(c.imm)];
      case "addi": case "andi": case "ori": case "xori":
      case "slli": case "srli": case "srai":
        return [reg(c.rd), sep(), reg(c.rs1), sep(), imm(c.imm)];
      case "add": case "sub": case "mul": case "div": case "rem":
      case "and": case "or": case "xor": case "sll": case "srl": case "sra":
        return [reg(c.rd), sep(), reg(c.rs1), sep(), reg(c.rs2)];
      case "sw": case "sh": case "sb":
        return [reg(c.rs2), sep(), ...mem(imm(c.offset), c.rs1)];
      case "lw": case "lh": case "lb": case "lhu": case "lbu":
        return [reg(c.rd), sep(), ...mem(imm(c.offset), c.rs1)];
      case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu":
        return [reg(c.rs1), sep(), reg(c.rs2), sep(), rel(c.target)];
    }
  })();
  return [kw(c.op), punct(" "), ...ops];
}

// ─── Source instructions ──────────────────────────────────────────────────
// Immediates keep the text they were written with (e.g. hex).

export function sourceTokens(
  p: ParsedInstr,
  raw: string,
  labels: Record<string, number>,
): Token[] {
  const trimmed = raw.trim();
  const spIdx = trimmed.indexOf(" ");
  const rawOps = spIdx === -1 ? [] : trimmed.slice(spIdx + 1).split(",").map((s) => s.trim());
  const lbl = (name: string): Token => ({ kind: "label", text: name, addr: labels[name] });
  const rawMem = (rawOp: string, base: string): Token[] => {
    const pi = rawOp.indexOf("(");
    return mem(imm(pi >= 0 ? rawOp.slice(0, pi) : rawOp), base);
  };

  const ops = ((): Token[] => {
    switch (p.op) {
      case "ret":
      case "nop":
        return [];
      case "li":
      case "lui":
        return [reg(p.rd), sep(), imm(rawOps[1] ?? "")];
      case "mv":
      case "neg":
        return [reg(p.rd), sep(), reg(p.rs1)];
      case "jr":
        return [reg(p.rs)];
      case "call":
      case "j":
        return [lbl(p.target)];
      case "jal":
        return [reg(p.rd), sep(), lbl(p.target)];
      case "jalr":
        return [reg(p.rd), sep(), ...rawMem(rawOps[1] ?? "", p.rs1)];
      case "addi": case "andi": case "ori": case "xori":
      case "slli": case "srli": case "srai":
        return [reg(p.rd), sep(), reg(p.rs1), sep(), imm(rawOps[2] ?? "")];
      case "add": case "sub": case "mul": case "div": case "rem":
      case "and": case "or": case "xor": case "sll": case "srl": case "sra":
        return [reg(p.rd), sep(), reg(p.rs1), sep(), reg(p.rs2)];
      case "sw": case "sh": case "sb":
        return [reg(p.rs2), sep(), ...rawMem(rawOps[1] ?? "", p.rs1)];
      case "lw": case "lh": case "lb": case "lhu": case "lbu":
        return [reg(p.rd), sep(), ...rawMem(rawOps[1] ?? "", p.rs1)];
      case "beq": case "bne": case "blt": case "bge": case "bltu": case "bgeu":
      case "bgt": case "ble": case "bgtu": case "bleu":
        return [reg(p.rs1), sep(), reg(p.rs2), sep(), lbl(p.target)];
      case "beqz": case "bnez": case "bltz": case "bgez": case "bgtz": case "blez":
        return [reg(p.rs1), sep(), lbl(p.target)];
    }
  })();
  return ops.length ? [kw(p.op), punct(" "), ...ops] : [kw(p.op)];
}
