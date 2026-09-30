import type { Instr, MemOp, Operand, Parsed, RegInfo, Size } from "./types";
import type { BitField, Encoding, EncodingPart } from "../types";
import { CC, REGS, condOf } from "./types";
import { AppError, fmtAddr } from "../../types";

// ─── Instruction builder ──────────────────────────────────────────────────
// An x86-64 instruction is: [REX] opcode [ModRM [SIB]] [disp] [imm].

interface Builder {
  /** REX bits; the prefix is emitted if any is set or `rexForce`. */
  w: boolean;
  r: boolean;
  x: boolean;
  b: boolean;
  /** spl/bpl/sil/dil need a REX prefix even with no bits set. */
  rexForce: boolean;
  opcode: number[];
  /** What the low bits of the last opcode byte hold, if anything. */
  opcodeLow?: { kind: "reg"; note: string } | { kind: "cc"; note: string };
  modrm?: { mod: number; reg: number; rm: number; regNote: string; rmNote: string };
  sib?: { scale: number; index: number; base: number; indexNote: string; baseNote: string };
  disp?: { value: number; size: 1 | 4 };
  imm?: { value: bigint; size: 1 | 4 | 8 };
  rel?: { value: number; size: 1 | 4; target: number };
}

function builder(opcode: number[]): Builder {
  return { w: false, r: false, x: false, b: false, rexForce: false, opcode };
}

const fitsInt8 = (v: bigint | number) => BigInt(v) >= -128n && BigInt(v) <= 127n;
const fitsInt32 = (v: bigint) => v >= -(2n ** 31n) && v < 2n ** 31n;

function leBytes(value: bigint, size: number): number[] {
  const v = BigInt.asUintN(size * 8, value);
  return Array.from({ length: size }, (_, i) => Number((v >> BigInt(i * 8)) & 0xffn));
}

const MOD_NOTES = ["memory, no displacement", "memory + disp8", "memory + disp32", "register"];

function finish(b: Builder): Encoding {
  const bytes: number[] = [];
  const parts: EncodingPart[] = [];
  const add = (part: Omit<EncodingPart, "offset" | "length">, data: number[]) => {
    parts.push({ ...part, offset: bytes.length, length: data.length });
    bytes.push(...data);
  };
  const bit = (name: string, at: number, on: boolean, note: string): BitField => ({
    name, hi: at, lo: at, value: on ? 1 : 0, kind: "funct", note: on ? note : "",
  });

  if (b.w || b.r || b.x || b.b || b.rexForce) {
    const v = 0x40 | (+b.w << 3) | (+b.r << 2) | (+b.x << 1) | +b.b;
    add({
      name: "REX",
      fields: [
        { name: "0100", hi: 7, lo: 4, value: 4, kind: "opcode", note: "REX prefix" },
        bit("W", 3, b.w, "64-bit operand size"),
        bit("R", 2, b.r, "extends ModRM.reg (r8–r15)"),
        bit("X", 1, b.x, "extends SIB.index (r8–r15)"),
        bit("B", 0, b.b, "extends rm / base / opcode register (r8–r15)"),
      ],
    }, [v]);
  }

  const last = b.opcode[b.opcode.length - 1]!;
  const lead = b.opcode.slice(0, -1);
  if (b.opcodeLow) {
    if (lead.length) add({ name: "escape", kind: "opcode", note: "two-byte opcode" }, lead);
    const lowBits = b.opcodeLow.kind === "reg" ? 3 : 4;
    add({
      name: "opcode",
      kind: "opcode",
      fields: [
        { name: "opcode", hi: 7, lo: lowBits, value: last >> lowBits, kind: "opcode", note: "" },
        {
          name: b.opcodeLow.kind, hi: lowBits - 1, lo: 0, value: last & ((1 << lowBits) - 1),
          kind: b.opcodeLow.kind === "reg" ? "reg" : "funct", note: b.opcodeLow.note,
        },
      ],
    }, [last]);
  } else {
    add({ name: "opcode", kind: "opcode", note: "" }, b.opcode);
  }

  if (b.modrm) {
    const { mod, reg, rm, regNote, rmNote } = b.modrm;
    const named = (note: string) => !note.startsWith("/") && note !== "SIB follows";
    add({
      name: "ModRM",
      fields: [
        { name: "mod", hi: 7, lo: 6, value: mod, kind: "funct", note: MOD_NOTES[mod]! },
        { name: "reg", hi: 5, lo: 3, value: reg, kind: named(regNote) ? "reg" : "funct", note: regNote },
        { name: "rm", hi: 2, lo: 0, value: rm, kind: named(rmNote) ? "reg" : "funct", note: rmNote },
      ],
    }, [(mod << 6) | (reg << 3) | rm]);
  }
  if (b.sib) {
    const { scale, index, base, indexNote, baseNote } = b.sib;
    add({
      name: "SIB",
      fields: [
        { name: "scale", hi: 7, lo: 6, value: scale, kind: "funct", note: `×${1 << scale}` },
        { name: "index", hi: 5, lo: 3, value: index, kind: "reg", note: indexNote },
        { name: "base", hi: 2, lo: 0, value: base, kind: "reg", note: baseNote },
      ],
    }, [(scale << 6) | (index << 3) | base]);
  }
  if (b.disp)
    add({ name: `disp${b.disp.size * 8}`, kind: "imm", note: String(b.disp.value) },
      leBytes(BigInt(b.disp.value), b.disp.size));
  if (b.imm)
    add({ name: `imm${b.imm.size * 8}`, kind: "imm", note: String(b.imm.value) },
      leBytes(b.imm.value, b.imm.size));
  if (b.rel) {
    const sign = b.rel.value >= 0 ? "+" : "";
    add({
      name: `rel${b.rel.size * 8}`, kind: "imm",
      note: `${sign}${b.rel.value} from the next instruction → ${fmtAddr(b.rel.target)}`,
    }, leBytes(BigInt(b.rel.value), b.rel.size));
  }

  return { bytes, format: null, parts, imm: null };
}

// ─── ModRM / SIB ──────────────────────────────────────────────────────────

/** Puts a register in ModRM.reg. */
function setReg(b: Builder, r: RegInfo): void {
  b.modrm = { mod: 0, reg: r.num & 7, rm: 0, regNote: r.name, rmNote: "", ...b.modrm };
  b.modrm.reg = r.num & 7;
  b.modrm.regNote = r.name;
  if (r.num >= 8) b.r = true;
  if (r.needsRex) b.rexForce = true;
}

/** Puts an opcode extension (/0–/7) in ModRM.reg. */
function setExt(b: Builder, ext: number): void {
  b.modrm = { mod: 0, rm: 0, rmNote: "", ...b.modrm, reg: ext, regNote: `/${ext}: opcode extension` };
}

/** Encodes a register or memory operand in ModRM.rm (plus SIB and disp). */
function setRm(b: Builder, op: Operand): void {
  const m = (b.modrm ??= { mod: 0, reg: 0, rm: 0, regNote: "", rmNote: "" });
  if (op.kind === "reg") {
    const r = REGS[op.name]!;
    m.mod = 3;
    m.rm = r.num & 7;
    m.rmNote = r.name;
    if (r.num >= 8) b.b = true;
    if (r.needsRex) b.rexForce = true;
    return;
  }
  if (op.kind !== "mem") throw new Error("setRm: not a register or memory operand");

  const base = op.base ? REGS[op.base]! : null;
  const index = op.index ? REGS[op.index]! : null;
  if (base && base.num >= 8) b.b = true;
  if (index && index.num >= 8) b.x = true;

  // rm = 100 means "SIB follows"; it is needed for an index, for rsp/r12 as
  // base (their number is 100) and for an address with no base at all.
  const needSib = index !== null || base === null || (base.num & 7) === 4;
  if (!base) {
    // No base: SIB.base = 101 with mod = 00 means "disp32, no base".
    m.mod = 0;
    b.disp = { value: op.disp, size: 4 };
  } else if (op.disp === 0 && (base.num & 7) !== 5) {
    m.mod = 0;
  } else if (fitsInt8(op.disp)) {
    // rbp/r13 as base always need a displacement: mod = 00 with base 101
    // means "no base", so [rbp] is encoded as [rbp+0].
    m.mod = 1;
    b.disp = { value: op.disp, size: 1 };
  } else {
    m.mod = 2;
    b.disp = { value: op.disp, size: 4 };
  }

  if (needSib) {
    m.rm = 4;
    m.rmNote = "SIB follows";
    b.sib = {
      scale: Math.log2(op.scale),
      index: index ? index.num & 7 : 4,
      base: base ? base.num & 7 : 5,
      indexNote: index ? index.name : "none",
      baseNote: base ? base.name : "none (disp32 only)",
    };
  } else {
    m.rm = base!.num & 7;
    m.rmNote = `[${base!.name}]`;
  }
}

// ─── Operand helpers ──────────────────────────────────────────────────────

class AsmError {
  constructor(readonly message: string) {}
}
const fail = (msg: string): never => {
  throw new AsmError(msg);
};

const isReg = (o: Operand | undefined): o is Operand & { kind: "reg" } => o?.kind === "reg";
const isMem = (o: Operand | undefined): o is MemOp => o?.kind === "mem";
const isImm = (o: Operand | undefined): o is Operand & { kind: "imm" } => o?.kind === "imm";
const isRm = (o: Operand | undefined) => isReg(o) || isMem(o);
const regOf = (o: Operand) => REGS[(o as { name: string }).name]!;

/** Operand size shared by the register and memory operands: 4 or 8. */
function operandSize(p: Parsed, ops: Operand[] = p.ops): 4 | 8 {
  let size: Size | null = null;
  for (const o of ops) {
    const s = isReg(o) ? regOf(o).size : isMem(o) ? o.size : null;
    if (s === null) continue;
    if (size !== null && s !== size) fail(`Operand sizes of '${p.op}' do not match`);
    size = s;
  }
  if (size === null)
    fail(`Operand size of '${p.op}' is unknown: add DWORD PTR or QWORD PTR`);
  if (size !== 4 && size !== 8) fail(`'${p.op}' only supports 32-bit and 64-bit operands`);
  return size as 4 | 8;
}

/** Immediate as the signed 32-bit value stored in an imm32 field. */
function imm32(value: bigint, size: 4 | 8, op: string): bigint {
  // A 32-bit operation also accepts the unsigned spelling (0xffffffff = -1).
  const ok = size === 4 ? value >= -(2n ** 31n) && value < 2n ** 32n : fitsInt32(value);
  if (!ok) fail(`Immediate ${value} does not fit in 32 bits for '${op}'`);
  return BigInt.asIntN(32, value);
}

function arity(p: Parsed, ...allowed: number[]): void {
  if (!allowed.includes(p.ops.length)) {
    const n = allowed.join(" or ");
    fail(`'${p.op}' expects ${n} operand${n === "1" ? "" : "s"}, got ${p.ops.length}`);
  }
}

// ─── Instruction table ────────────────────────────────────────────────────

/** add/or/and/sub/xor/cmp share one layout; this is their number (/n). */
const ALU: Record<string, number> = { add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 };
const SHIFT: Record<string, number> = { shl: 4, sal: 4, shr: 5, sar: 7 };
/** One-operand group: opcode and extension. */
const UNARY: Record<string, [number, number]> = {
  inc: [0xff, 0], dec: [0xff, 1], not: [0xf7, 2], neg: [0xf7, 3], idiv: [0xf7, 7],
};
const NO_OPERANDS: Record<string, { opcode: number; w?: boolean }> = {
  ret: { opcode: 0xc3 }, leave: { opcode: 0xc9 }, nop: { opcode: 0x90 },
  cdq: { opcode: 0x99 }, cqo: { opcode: 0x99, w: true }, cdqe: { opcode: 0x98, w: true },
};

export const MNEMONICS: ReadonlySet<string> = new Set([
  ...Object.keys(ALU), ...Object.keys(SHIFT), ...Object.keys(UNARY), ...Object.keys(NO_OPERANDS),
  "mov", "movabs", "lea", "test", "imul", "push", "pop", "call", "jmp",
  "movzx", "movsx", "movsxd",
  ...Object.keys(CC).flatMap((cc) => [`j${cc}`, `set${cc}`]),
]);

/** Instructions whose operand is a code label. */
export function isBranch(p: Parsed): boolean {
  return p.ops.length === 1 && p.ops[0]!.kind === "label";
}

function build(p: Parsed, addr: number, target: number | null): Builder {
  const { op, ops } = p;
  const [a, b2, c] = ops;

  if (NO_OPERANDS[op]) {
    arity(p, 0);
    const b = builder([NO_OPERANDS[op]!.opcode]);
    b.w = NO_OPERANDS[op]!.w ?? false;
    return b;
  }

  // ── Branches: the offset is relative to the end of the instruction ──
  const jcc = condOf(op, "j");
  if (op === "jmp" || op === "call" || jcc !== undefined) {
    arity(p, 1);
    if (a!.kind !== "label") {
      // Indirect: jmp/call through a 64-bit register or memory.
      if (jcc !== undefined || !isRm(a)) fail(`'${op}' expects a label`);
      if ((isReg(a) ? regOf(a).size : (a as MemOp).size ?? 8) !== 8)
        fail(`'${op}' needs a 64-bit register or QWORD PTR operand`);
      const b = builder([0xff]);
      setExt(b, op === "call" ? 2 : 4);
      setRm(b, a!);
      return b;
    }
    const to = target ?? addr;
    const rel = (size: number) => to - (addr + size);
    // Short form (rel8) when the target is within -128…+127 bytes; call has none.
    if (op !== "call" && target !== null && fitsInt8(rel(2))) {
      const b = jcc !== undefined ? builder([0x70 | jcc]) : builder([0xeb]);
      if (jcc !== undefined) b.opcodeLow = { kind: "cc", note: `condition: ${op.slice(1)}` };
      b.rel = { value: rel(2), size: 1, target: to };
      return b;
    }
    const b = jcc !== undefined ? builder([0x0f, 0x80 | jcc])
      : builder([op === "call" ? 0xe8 : 0xe9]);
    if (jcc !== undefined) b.opcodeLow = { kind: "cc", note: `condition: ${op.slice(1)}` };
    const size = b.opcode.length + 4;
    if (!fitsInt32(BigInt(rel(size)))) fail(`Target of '${op}' is out of range`);
    b.rel = { value: rel(size), size: 4, target: to };
    return b;
  }
  for (const o of ops) if (o.kind === "label") fail(`'${op}' cannot take a label operand`);

  // ── setcc r/m8 ──
  const setcc = condOf(op, "set");
  if (setcc !== undefined) {
    arity(p, 1);
    const size = isReg(a) ? regOf(a).size : isMem(a) ? a.size ?? 1 : 0;
    if (size !== 1) fail(`'${op}' needs an 8-bit register or BYTE PTR operand`);
    const b = builder([0x0f, 0x90 | setcc]);
    b.opcodeLow = { kind: "cc", note: `condition: ${op.slice(3)}` };
    setExt(b, 0);
    setRm(b, a!);
    return b;
  }

  // ── movzx / movsx / movsxd: the source is narrower than the destination ──
  if (op === "movzx" || op === "movsx" || op === "movsxd") {
    arity(p, 2);
    if (!isReg(a) || !isRm(b2)) fail(`'${op}' expects a register and a register or memory operand`);
    const dst = regOf(a!);
    const srcSize = isReg(b2) ? regOf(b2).size : (b2 as MemOp).size;
    if (dst.size !== 4 && dst.size !== 8) fail(`'${op}' needs a 32-bit or 64-bit destination`);
    if (srcSize === null) fail(`Source size of '${op}' is unknown: add BYTE PTR or WORD PTR`);
    let b: Builder;
    if (srcSize === 4 && op !== "movzx") {
      if (dst.size !== 8) fail(`'${op}' from a 32-bit source needs a 64-bit destination`);
      b = builder([0x63]);
    } else if ((srcSize === 1 || srcSize === 2) && op !== "movsxd") {
      b = builder([0x0f, (op === "movzx" ? 0xb6 : 0xbe) | (srcSize === 2 ? 1 : 0)]);
    } else {
      return fail(`'${op}' cannot extend a ${srcSize! * 8}-bit source`);
    }
    b.w = dst.size === 8;
    setReg(b, dst);
    setRm(b, b2!);
    return b;
  }

  // ── lea r, m ──
  if (op === "lea") {
    arity(p, 2);
    if (!isReg(a) || !isMem(b2)) fail(`'lea' expects a register and a memory operand`);
    const dst = regOf(a!);
    if (dst.size !== 4 && dst.size !== 8) fail(`'lea' needs a 32-bit or 64-bit destination`);
    const b = builder([0x8d]);
    b.w = dst.size === 8;
    setReg(b, dst);
    setRm(b, b2!);
    return b;
  }

  // ── push / pop: always 64-bit ──
  if (op === "push" || op === "pop") {
    arity(p, 1);
    if (isReg(a)) {
      const r = regOf(a);
      if (r.size !== 8) fail(`'${op}' needs a 64-bit register`);
      const b = builder([(op === "push" ? 0x50 : 0x58) | (r.num & 7)]);
      b.opcodeLow = { kind: "reg", note: r.name };
      b.b = r.num >= 8;
      return b;
    }
    if (isImm(a) && op === "push") {
      const v = imm32(a.value, 8, op);
      const b = builder([fitsInt8(v) ? 0x6a : 0x68]);
      b.imm = { value: v, size: fitsInt8(v) ? 1 : 4 };
      return b;
    }
    if (isMem(a)) {
      if ((a.size ?? 8) !== 8) fail(`'${op}' needs a QWORD PTR operand`);
      const b = builder([op === "push" ? 0xff : 0x8f]);
      setExt(b, op === "push" ? 6 : 0);
      setRm(b, a);
      return b;
    }
    return fail(`'${op}' expects a register${op === "push" ? ", immediate" : ""} or memory operand`);
  }

  // ── mov ──
  if (op === "mov" || op === "movabs") {
    arity(p, 2);
    if (isImm(b2)) {
      if (!isRm(a)) fail(`'${op}' cannot write to an immediate`);
      const size = operandSize(p, [a!]);
      const wide = size === 8 && (op === "movabs" || !fitsInt32(b2.value));
      if (isReg(a) && (size === 4 || wide)) {
        // B8+r: the register is in the low 3 bits of the opcode.
        const r = regOf(a);
        if (wide && (b2.value < -(2n ** 63n) || b2.value >= 2n ** 64n))
          fail(`Immediate ${b2.value} does not fit in 64 bits`);
        const b = builder([0xb8 | (r.num & 7)]);
        b.opcodeLow = { kind: "reg", note: r.name };
        b.b = r.num >= 8;
        b.w = wide;
        b.imm = wide ? { value: b2.value, size: 8 } : { value: imm32(b2.value, 4, op), size: 4 };
        return b;
      }
      if (wide) fail(`Only a register can be loaded with a 64-bit immediate`);
      const b = builder([0xc7]);
      b.w = size === 8;
      setExt(b, 0);
      setRm(b, a!);
      b.imm = { value: imm32(b2.value, size, op), size: 4 };
      return b;
    }
    if (op === "movabs") fail(`'movabs' expects a register and an immediate`);
    const size = operandSize(p);
    if (isRm(a) && isReg(b2)) {
      const b = builder([0x89]);
      b.w = size === 8;
      setReg(b, regOf(b2));
      setRm(b, a!);
      return b;
    }
    if (isReg(a) && isMem(b2)) {
      const b = builder([0x8b]);
      b.w = size === 8;
      setReg(b, regOf(a));
      setRm(b, b2);
      return b;
    }
    return fail(`'mov' cannot move memory to memory`);
  }

  // ── add / or / and / sub / xor / cmp, and test ──
  if (op in ALU || op === "test") {
    arity(p, 2);
    const n = ALU[op] ?? 0;
    if (isImm(b2)) {
      if (!isRm(a)) fail(`'${op}' cannot write to an immediate`);
      const size = operandSize(p, [a!]);
      const v = imm32(b2.value, size, op);
      const accumulator = isReg(a) && regOf(a).num === 0;
      let b: Builder;
      if (op === "test") {
        // test has no imm8 form.
        b = builder([accumulator ? 0xa9 : 0xf7]);
        if (!accumulator) { setExt(b, 0); setRm(b, a!); }
        b.imm = { value: v, size: 4 };
      } else if (fitsInt8(v)) {
        b = builder([0x83]);
        setExt(b, n);
        setRm(b, a!);
        b.imm = { value: v, size: 1 };
      } else if (accumulator) {
        // Short form for eax/rax: no ModRM.
        b = builder([0x05 | (n << 3)]);
        b.imm = { value: v, size: 4 };
      } else {
        b = builder([0x81]);
        setExt(b, n);
        setRm(b, a!);
        b.imm = { value: v, size: 4 };
      }
      b.w = size === 8;
      return b;
    }
    const size = operandSize(p);
    let b: Builder;
    if (isRm(a) && isReg(b2)) {
      b = builder([op === "test" ? 0x85 : 0x01 | (n << 3)]);
      setReg(b, regOf(b2));
      setRm(b, a!);
    } else if (isReg(a) && isMem(b2)) {
      // test is symmetric, so it has no separate "register, memory" opcode.
      b = builder([op === "test" ? 0x85 : 0x03 | (n << 3)]);
      setReg(b, regOf(a));
      setRm(b, b2);
    } else {
      return fail(`'${op}' cannot have two memory operands`);
    }
    b.w = size === 8;
    return b;
  }

  // ── inc / dec / not / neg / idiv ──
  if (op in UNARY) {
    arity(p, 1);
    if (!isRm(a)) fail(`'${op}' expects a register or memory operand`);
    const [opcode, ext] = UNARY[op]!;
    const b = builder([opcode]);
    b.w = operandSize(p) === 8;
    setExt(b, ext);
    setRm(b, a!);
    return b;
  }

  // ── shl / shr / sar ──
  if (op in SHIFT) {
    arity(p, 1, 2);
    if (!isRm(a)) fail(`'${op}' expects a register or memory operand`);
    const size = operandSize(p, [a!]);
    let b: Builder;
    if (b2 === undefined || (isImm(b2) && b2.value === 1n)) {
      b = builder([0xd1]);
    } else if (isImm(b2)) {
      if (b2.value < 0n || b2.value > 255n) fail(`Shift count ${b2.value} is out of range`);
      b = builder([0xc1]);
      b.imm = { value: b2.value, size: 1 };
    } else if (isReg(b2) && b2.name === "cl") {
      b = builder([0xd3]);
    } else {
      return fail(`'${op}' shifts by an immediate or by cl`);
    }
    b.w = size === 8;
    setExt(b, SHIFT[op]!);
    setRm(b, a!);
    return b;
  }

  // ── imul r, r/m [, imm] ──
  if (op === "imul") {
    arity(p, 2, 3);
    if (!isReg(a)) fail(`'imul' expects a register destination`);
    const dst = regOf(a!);
    // `imul r, imm` multiplies r by imm in place.
    const [src, immOp] = ops.length === 3 ? [b2, c] : isImm(b2) ? [a, b2] : [b2, undefined];
    if (!isRm(src)) fail(`'imul' expects a register or memory source`);
    const size = operandSize(p, [a!, src!]);
    let b: Builder;
    if (immOp === undefined) {
      b = builder([0x0f, 0xaf]);
    } else {
      if (!isImm(immOp)) fail(`The third operand of 'imul' must be an immediate`);
      const v = imm32((immOp as { value: bigint }).value, size, op);
      b = builder([fitsInt8(v) ? 0x6b : 0x69]);
      b.imm = { value: v, size: fitsInt8(v) ? 1 : 4 };
    }
    b.w = size === 8;
    setReg(b, dst);
    setRm(b, src!);
    return b;
  }

  return fail(`Unknown instruction: '${op}'`);
}

// ─── Entry points ─────────────────────────────────────────────────────────

/**
 * Assembles p at addr. `target` is the address of its label operand, or null
 * when not known yet (the branch is then sized as its long form).
 */
export function assemble(p: Parsed, addr: number, target: number | null, raw?: string): Instr | AppError {
  try {
    const enc = finish(build(p, addr, target));
    // The opcode is what identifies the instruction (together with /n, if any).
    const opcode = enc.parts.find((part) => part.name === "opcode")!;
    if (opcode.fields) opcode.fields[0]!.note = p.op;
    else opcode.note = p.op;
    return { op: p.op, ops: p.ops, enc, ...(target !== null ? { target } : {}) };
  } catch (e) {
    if (e instanceof AsmError)
      return new AppError(e.message, raw ? `Instruction: ${raw}` : undefined);
    throw e;
  }
}

/** Smallest size p can have: branches start as their short form. */
export function minSize(p: Parsed): number {
  if (isBranch(p)) return p.op === "call" ? 5 : 2;
  const r = assemble(p, 0, null);
  return r instanceof AppError ? 0 : r.enc.bytes.length;
}
