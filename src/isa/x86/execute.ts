import type { Instr, MemOp, Operand, Size } from "./types";
import type { ExecResult, MemAccess, StoreInfo } from "../types";
import type { Machine } from "../../machine";
import { REGS, condOf } from "./types";

// ─── Flags ────────────────────────────────────────────────────────────────

export const FLAGS_REG = "rflags";
export const FLAG_BITS = { CF: 0, PF: 2, ZF: 6, SF: 7, OF: 11 } as const;
type Flag = keyof typeof FLAG_BITS;

const SLOT = 8;
const slotOf = (addr: number) => addr - (addr % SLOT);

class MemFault {
  constructor(readonly addr: number) {}
}
class DivideFault {}

/** Whether condition code cc (0–15) holds for the given flags. */
function condition(cc: number, f: Record<Flag, boolean>): boolean {
  const base = [
    f.OF, f.CF, f.ZF, f.CF || f.ZF, f.SF, f.PF, f.SF !== f.OF, f.ZF || f.SF !== f.OF,
  ][cc >> 1]!;
  // Odd codes are the negation of the even one below them.
  return cc & 1 ? !base : base;
}

// ─── Execution ────────────────────────────────────────────────────────────

export function execute(m: Machine, c: Instr, addr: number, size: number): ExecResult {
  const next = addr + size;
  const hiReg: string[] = [];
  const hiSlots: number[] = [];
  const accesses: MemAccess[] = [];
  let store: StoreInfo | undefined;

  // ── Registers: narrower names are views of the 64-bit register ──
  const readReg = (name: string): bigint => {
    const r = REGS[name]!;
    return BigInt.asUintN(r.size * 8, m.reg(r.base));
  };
  const writeReg = (name: string, value: bigint): void => {
    const r = REGS[name]!;
    const bits = r.size * 8;
    // Writing a 32-bit register zeroes the upper half; 8/16-bit writes keep it.
    const v =
      r.size >= 4
        ? BigInt.asUintN(bits, value)
        : (m.reg(r.base) & ~((1n << BigInt(bits)) - 1n)) | BigInt.asUintN(bits, value);
    m.writeReg(r.base, v);
    if (!hiReg.includes(name)) hiReg.push(name);
  };

  // ── Memory ──
  const effAddr = (o: MemOp): number => {
    let a = BigInt(o.disp);
    if (o.base) a += m.reg(o.base);
    if (o.index) a += m.reg(o.index) * BigInt(o.scale);
    return Number(BigInt.asUintN(64, a));
  };
  const access = (a: number, bytes: number, kind: MemAccess["kind"]): void => {
    if (!m.checkAccess(a, bytes)) throw new MemFault(a);
    hiSlots.push(slotOf(a));
    accesses.push({ addr: a, size: bytes, kind });
  };
  const readMem = (a: number, bytes: number): bigint => {
    access(a, bytes, "load");
    return m.readMem(a, bytes, false);
  };
  const writeMem = (a: number, value: bigint, bytes: number, label: string): void => {
    access(a, bytes, "store");
    m.writeMem(a, value, bytes);
    store = { addr: a, reg: label, size: bytes };
  };

  // ── Operands ──
  const sizeOf = (o: Operand, fallback: Size): Size =>
    o.kind === "reg" ? REGS[o.name]!.size : o.kind === "mem" ? (o.size ?? fallback) : fallback;
  const read = (o: Operand, bytes: Size): bigint => {
    switch (o.kind) {
      case "reg": return readReg(o.name);
      case "imm": return BigInt.asUintN(bytes * 8, o.value);
      case "mem": return readMem(effAddr(o), bytes);
      case "label": throw new Error("label operand");
    }
  };
  /** Writes a result; `from` names the register whose value it is, for slot labels. */
  const write = (o: Operand, value: bigint, bytes: Size, from = ""): void => {
    if (o.kind === "reg") writeReg(o.name, value);
    else if (o.kind === "mem") writeMem(effAddr(o), value, bytes, from);
  };
  /** Operand size of the instruction, taken from its register/memory operands. */
  const opSize = (): Size => {
    for (const o of c.ops) {
      if (o.kind === "reg") return REGS[o.name]!.size;
      if (o.kind === "mem" && o.size) return o.size;
    }
    return 8;
  };

  // ── Flags ──
  const getFlags = (): Record<Flag, boolean> => {
    const v = m.reg(FLAGS_REG);
    return Object.fromEntries(
      Object.entries(FLAG_BITS).map(([name, bit]) => [name, ((v >> BigInt(bit)) & 1n) === 1n]),
    ) as Record<Flag, boolean>;
  };
  const setFlags = (flags: Partial<Record<Flag, boolean>>): void => {
    let v = m.reg(FLAGS_REG);
    for (const [name, on] of Object.entries(flags)) {
      const mask = 1n << BigInt(FLAG_BITS[name as Flag]);
      v = on ? v | mask : v & ~mask;
    }
    m.writeReg(FLAGS_REG, v);
    if (!hiReg.includes(FLAGS_REG)) hiReg.push(FLAGS_REG);
  };
  const sign = (v: bigint, bytes: Size) => ((v >> BigInt(bytes * 8 - 1)) & 1n) === 1n;
  /** ZF, SF and PF of a result. */
  const resultFlags = (r: bigint, bytes: Size) => {
    let low = Number(r & 0xffn);
    let parity = true;
    for (; low; low >>= 1) if (low & 1) parity = !parity;
    return { ZF: r === 0n, SF: sign(r, bytes), PF: parity };
  };

  // ── Arithmetic: each returns the result truncated to `bytes` ──
  const add = (a: bigint, b: bigint, bytes: Size, keepCarry = false): bigint => {
    const r = BigInt.asUintN(bytes * 8, a + b);
    setFlags({
      ...resultFlags(r, bytes),
      OF: sign(a, bytes) === sign(b, bytes) && sign(r, bytes) !== sign(a, bytes),
      ...(keepCarry ? {} : { CF: a + b !== r }),
    });
    return r;
  };
  const sub = (a: bigint, b: bigint, bytes: Size, keepCarry = false): bigint => {
    const r = BigInt.asUintN(bytes * 8, a - b);
    setFlags({
      ...resultFlags(r, bytes),
      OF: sign(a, bytes) !== sign(b, bytes) && sign(r, bytes) !== sign(a, bytes),
      ...(keepCarry ? {} : { CF: a < b }),
    });
    return r;
  };
  const logic = (r: bigint, bytes: Size): bigint => {
    setFlags({ ...resultFlags(r, bytes), CF: false, OF: false });
    return r;
  };

  // ── Stack ──
  const push = (value: bigint, label: string): void => {
    const sp = m.reg("rsp") - 8n;
    m.writeReg("rsp", sp);
    hiReg.push("rsp");
    writeMem(Number(sp), value, 8, label);
  };
  const pop = (): bigint => {
    const sp = m.reg("rsp");
    const v = readMem(Number(sp), 8);
    m.writeReg("rsp", sp + 8n);
    hiReg.push("rsp");
    return v;
  };

  const done = (extra: Partial<ExecResult> = {}): ExecResult => ({
    next, hiReg, hiSlots: [...new Set(hiSlots)], store, access: accesses, ...extra,
  });

  try {
    const { op, ops } = c;
    const [a, b] = ops as [Operand, Operand];
    const target = (): number => {
      if (a.kind === "label") return c.target!;
      return Number(read(a, 8));
    };

    const jcc = condOf(op, "j");
    if (jcc !== undefined) return done({ next: condition(jcc, getFlags()) ? target() : next });
    const setcc = condOf(op, "set");
    if (setcc !== undefined) {
      write(a, condition(setcc, getFlags()) ? 1n : 0n, 1);
      return done();
    }

    switch (op) {
      case "nop":
        return done();

      case "mov":
      case "movabs": {
        const bytes = opSize();
        write(a, read(b, bytes), bytes, b.kind === "reg" ? b.name : "");
        return done();
      }
      case "movzx":
      case "movsx":
      case "movsxd": {
        const srcBytes = sizeOf(b, 4);
        const v = read(b, srcBytes);
        writeReg((a as { name: string }).name, op === "movzx" ? v : BigInt.asIntN(srcBytes * 8, v));
        return done();
      }
      case "lea":
        writeReg((a as { name: string }).name, BigInt(effAddr(b as MemOp)));
        return done();

      case "add": case "sub": case "cmp": {
        const bytes = opSize();
        const r = (op === "add" ? add : sub)(read(a, bytes), read(b, bytes), bytes);
        if (op !== "cmp") write(a, r, bytes);
        return done();
      }
      case "and": case "or": case "xor": case "test": {
        const bytes = opSize();
        const x = read(a, bytes), y = read(b, bytes);
        const r = logic(op === "or" ? x | y : op === "xor" ? x ^ y : x & y, bytes);
        if (op !== "test") write(a, r, bytes);
        return done();
      }
      case "inc": case "dec": {
        // inc/dec leave CF untouched.
        const bytes = opSize();
        write(a, (op === "inc" ? add : sub)(read(a, bytes), 1n, bytes, true), bytes);
        return done();
      }
      case "neg": {
        const bytes = opSize();
        write(a, sub(0n, read(a, bytes), bytes), bytes);
        return done();
      }
      case "not": {
        const bytes = opSize();
        write(a, ~read(a, bytes), bytes);
        return done();
      }

      case "shl": case "sal": case "shr": case "sar": {
        const bytes = sizeOf(a, 8);
        const bits = bytes * 8;
        // The count is masked to the operand width, as the CPU does.
        const count = Number((b ? read(b, 1) : 1n) & BigInt(bits === 64 ? 63 : 31));
        const x = read(a, bytes);
        if (count === 0) return done();
        const n = BigInt(count);
        let r: bigint, carry: boolean, overflow: boolean;
        if (op === "shl" || op === "sal") {
          r = BigInt.asUintN(bits, x << n);
          carry = ((x >> BigInt(bits - count)) & 1n) === 1n;
          overflow = sign(r, bytes) !== carry;
        } else {
          const v = op === "sar" ? BigInt.asIntN(bits, x) : x;
          r = BigInt.asUintN(bits, v >> n);
          carry = ((v >> (n - 1n)) & 1n) === 1n;
          overflow = op === "shr" && sign(x, bytes);
        }
        // OF is only defined for 1-bit shifts.
        setFlags({ ...resultFlags(r, bytes), CF: carry, ...(count === 1 ? { OF: overflow } : {}) });
        write(a, r, bytes);
        return done();
      }

      case "imul": {
        const bytes = REGS[(a as { name: string }).name]!.size;
        const bits = bytes * 8;
        const imm = ops.find((o) => o.kind === "imm");
        const src = ops.length === 3 ? ops[1]! : imm ? a : b;
        const x = BigInt.asIntN(bits, read(src, bytes));
        const y = BigInt.asIntN(bits, imm ? read(imm, bytes) : read(a, bytes));
        const full = x * y;
        const r = BigInt.asUintN(bits, full);
        const overflow = BigInt.asIntN(bits, full) !== full;
        setFlags({ ...resultFlags(r, bytes), CF: overflow, OF: overflow });
        write(a, r, bytes);
        return done();
      }

      case "cdq":
        writeReg("edx", sign(readReg("eax"), 4) ? -1n : 0n);
        return done();
      case "cqo":
        writeReg("rdx", sign(readReg("rax"), 8) ? -1n : 0n);
        return done();
      case "cdqe":
        writeReg("rax", BigInt.asIntN(32, readReg("eax")));
        return done();
      case "idiv": {
        // Divides the double-width value in (e/r)dx:(e/r)ax; quotient → ax, remainder → dx.
        const bytes = opSize();
        const bits = bytes * 8;
        const [lo, hi] = bytes === 8 ? ["rax", "rdx"] : ["eax", "edx"];
        const dividend = BigInt.asIntN(bits * 2, (readReg(hi!) << BigInt(bits)) | readReg(lo!));
        const divisor = BigInt.asIntN(bits, read(a, bytes));
        if (divisor === 0n) throw new DivideFault();
        const q = dividend / divisor;
        if (BigInt.asIntN(bits, q) !== q) throw new DivideFault();
        writeReg(lo!, q);
        writeReg(hi!, dividend % divisor);
        return done();
      }

      case "push":
        push(read(a, 8), a.kind === "reg" ? a.name : "");
        return done();
      case "pop":
        write(a, pop(), 8);
        return done();
      case "leave":
        // mov rsp, rbp; pop rbp
        m.writeReg("rsp", m.reg("rbp"));
        writeReg("rbp", pop());
        return done();

      case "call": {
        const to = target();
        push(BigInt(next), "ret addr");
        return done({ next: to, control: { kind: "call", returnAddr: next } });
      }
      case "ret":
        return done({ next: Number(pop()), control: { kind: "jump" } });
      case "jmp":
        return done({ next: target(), control: { kind: "jump" } });
    }
    throw new Error(`execute: unhandled instruction '${op}'`);
  } catch (e) {
    if (e instanceof MemFault) return { next, fault: { type: "segfault", addr: e.addr } };
    if (e instanceof DivideFault) return { next, fault: { type: "divide" } };
    throw e;
  }
}
