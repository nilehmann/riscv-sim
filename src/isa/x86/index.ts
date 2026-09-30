import type { Instr, Operand, Parsed } from "./types";
import type { Isa } from "../types";
import { REG64, REGS, regName } from "./types";
import { parseLine } from "./parser";
import { MNEMONICS, assemble, isBranch, minSize } from "./encoder";
import { tokens, sourceTokens } from "./format";
import { execute, FLAGS_REG, FLAG_BITS } from "./execute";
import { AppError } from "../../types";
import { garbageValue } from "../../garbage";
import type { Machine } from "../../machine";

// ─── Parsing and assembly ─────────────────────────────────────────────────

function parseInstr(raw: string): Parsed | AppError {
  const p = parseLine(raw);
  if (p instanceof AppError) return p;
  // Everything but the branch distance is known now, so report errors early.
  const checked = assemble(p, 0, null, raw);
  return checked instanceof AppError ? checked : p;
}

function expand(p: Parsed, ctx: { addr: number; labels: Record<string, number>; raw: string }) {
  let target: number | null = null;
  if (isBranch(p)) {
    const name = (p.ops[0] as { name: string }).name;
    // hasOwnProperty, not `in`: labels is a plain object, so `in` would accept
    // inherited names like "toString".
    if (!Object.prototype.hasOwnProperty.call(ctx.labels, name))
      return new AppError(`Undefined label '${name}'`, `Instruction: ${ctx.raw}`);
    target = ctx.labels[name]!;
  }
  const instr = assemble(p, ctx.addr, target, ctx.raw);
  return instr instanceof AppError ? instr : [instr];
}

// ─── Registers ────────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {};
const SUB_REG_BYTES: Record<string, number> = {};
for (const r of Object.values(REGS)) {
  if (r.size === 8) continue;
  ALIASES[r.name] = r.base;
  SUB_REG_BYTES[r.name] = r.size;
}

/** Registers an instruction uses without naming them. */
const IMPLICIT: Record<string, string[]> = {
  push: ["rsp"], pop: ["rsp"], call: ["rsp"], ret: ["rsp"], leave: ["rsp", "rbp"],
  cdq: ["rax", "rdx"], cqo: ["rax", "rdx"], cdqe: ["rax"], idiv: ["rax", "rdx"],
};

function regsUsed(c: Instr): string[] {
  const used = [...(IMPLICIT[c.op] ?? [])];
  for (const o of c.ops) {
    if (o.kind === "reg") used.push(REGS[o.name]!.base);
    if (o.kind === "mem") {
      if (o.base) used.push(o.base);
      if (o.index) used.push(o.index);
    }
  }
  return used;
}

// ─── Garbage instructions ─────────────────────────────────────────────────

const pick = (h: number, salt: number, n: number) =>
  Math.abs((h >> (salt * 5)) ^ Math.imul(salt + 1, 0x2545f4)) % n;
const reg = (num: number, size: 4 | 8): Operand => ({ kind: "reg", name: regName(num, size) });
const mem = (size: 4 | 8 | null, base: number, disp: number): Operand => ({
  kind: "mem", size, base: regName(base, 8), index: null, scale: 1, disp,
});
const imm = (v: number): Operand => ({ kind: "imm", value: BigInt(v), text: String(v) });

const GARBAGE_TEMPLATES: Array<(h: number) => Parsed> = [
  (h) => ({ op: "mov", ops: [reg(pick(h, 0, 16), 4), mem(4, pick(h, 1, 16), (pick(h, 2, 32) - 16) * 4)] }),
  (h) => ({ op: "mov", ops: [mem(8, pick(h, 0, 16), pick(h, 2, 16) * 8), reg(pick(h, 1, 16), 8)] }),
  (h) => ({ op: "add", ops: [reg(pick(h, 0, 16), 4), reg(pick(h, 1, 16), 4)] }),
  (h) => ({ op: "sub", ops: [reg(pick(h, 0, 16), 8), imm(pick(h, 1, 100) + 1)] }),
  (h) => ({ op: "xor", ops: [reg(pick(h, 0, 8), 4), reg(pick(h, 1, 8), 4)] }),
  (h) => ({ op: "lea", ops: [reg(pick(h, 0, 16), 8), mem(null, pick(h, 1, 16), pick(h, 2, 64) - 32)] }),
  (h) => ({ op: "cmp", ops: [reg(pick(h, 0, 8), 4), imm(pick(h, 1, 50))] }),
  (h) => ({ op: "push", ops: [reg(pick(h, 0, 16), 8)] }),
];

function garbage(seed: number): Instr {
  const h = garbageValue(seed);
  const p = GARBAGE_TEMPLATES[Math.abs(h) % GARBAGE_TEMPLATES.length]!(h);
  return assemble(p, 0, null) as Instr;
}

/** Whether rsp points into the stack (it is garbage in programs without one). */
const hasStack = (m: Machine) => m.checkAccess(Number(m.reg("rsp")));

// ─── ISA ──────────────────────────────────────────────────────────────────

export const x86: Isa<Parsed, Instr> = {
  id: "x86",
  name: "x86-64",
  shortName: "x86-64",
  wordBytes: 8,
  slotBytes: 8,
  regs: {
    names: REG64,
    sp: "rsp",
    fp: "rbp",
    fpLabel: "rbp",
    zero: null,
    returnAddr: null,
    aliases: ALIASES,
    pc: "rip",
    subRegBytes: SUB_REG_BYTES,
  },
  flags: {
    reg: FLAGS_REG,
    bits: (["ZF", "SF", "CF", "OF"] as const).map((name) => ({ name, bit: FLAG_BITS[name] })),
  },
  // System V ABI: leaf functions may use 128 bytes below rsp.
  redZone: 128,
  sizeNames: { 8: "q", 4: "d", 2: "w", 1: "b" },
  defaults: { baseAddress: 0x401000, stackBase: 0x7ffffffff000, sp: 0x7fffffffef08 },
  lineComment: "#",

  parseInstr,
  minSize,
  expand,
  size: (c) => c.enc.bytes.length,
  encode: (c) => c.enc,
  tokens: (c) => tokens(c),
  sourceTokens: (p, _raw, labels) => sourceTokens(p, labels),
  isPseudo: () => false,
  execute,
  regsUsed,
  garbage,
  // The caller's `call` left the return address at the top of the stack.
  initialReturnAddr: (m) => (hasStack(m) ? Number(m.readMem(Number(m.reg("rsp")), 8, false)) : null),
  setup(m, prog) {
    if (prog.returnAddress != null && hasStack(m))
      m.writeMem(Number(m.reg("rsp")), BigInt(prog.returnAddress), 8);
  },
  initialSlotLabels: (m) =>
    hasStack(m) ? [{ addr: Number(m.reg("rsp")), reg: "ret addr", size: 8 }] : [],

  editor: { mnemonics: MNEMONICS },
};
