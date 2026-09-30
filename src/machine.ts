import type { Isa } from "./isa/types";
import { garbageReg, garbageValue } from "./garbage";

/** Register file and byte-addressed memory shared by all ISAs. */
export class Machine {
  /** Unsigned register values, `bits` wide. */
  regs: Record<string, bigint>;
  mem: Map<number, number>;
  readonly bits: number;
  readonly stackBase: number;
  readonly osMode: boolean;

  constructor(
    readonly isa: Isa,
    initialRegs: Record<string, number>,
    stackBase: number,
    osMode: boolean,
  ) {
    this.bits = isa.wordBytes * 8;
    this.regs = Object.fromEntries(
      isa.regs.names.map((r, i) => [
        r,
        r === isa.regs.zero ? 0n : garbageReg(i, isa.wordBytes),
      ]),
    );
    for (const [k, v] of Object.entries(initialRegs)) {
      const r = this.canonical(k);
      if (r in this.regs) this.regs[r] = BigInt.asUintN(this.bits, BigInt(v));
    }
    this.mem = new Map();
    this.stackBase = stackBase;
    this.osMode = osMode;
  }

  canonical(name: string): string {
    return this.isa.regs.aliases[name] ?? name;
  }

  /** Unsigned value of a register. */
  reg(name: string): bigint {
    return this.regs[this.canonical(name)]!;
  }

  writeReg(name: string, value: bigint): void {
    const r = this.canonical(name);
    if (r === this.isa.regs.zero || !(r in this.regs)) return;
    this.regs[r] = BigInt.asUintN(this.bits, value);
  }

  /** Returns true if addr is a valid (non-faulting) memory address. */
  checkAccess(addr: number): boolean {
    if (!this.osMode) return true;
    return addr >= Number(this.reg(this.isa.regs.sp)) && addr < this.stackBase;
  }

  writeMem(addr: number, value: bigint, bytes: number): void {
    for (let i = 0; i < bytes; i++) {
      this.mem.set(addr + i, Number((value >> BigInt(i * 8)) & 0xffn));
    }
  }

  readByte(addr: number): number {
    if (this.mem.has(addr)) return this.mem.get(addr)!;
    if (this.osMode) {
      // Uninitialized stack slot: materialize garbage deterministically.
      const v = garbageValue(addr) & 0xff;
      this.mem.set(addr, v);
      return v;
    }
    return 0;
  }

  /** Little-endian read; the result is unsigned unless `signed`. */
  readMem(addr: number, bytes: number, signed: boolean): bigint {
    let val = 0n;
    for (let i = 0; i < bytes; i++) {
      val |= BigInt(this.readByte(addr + i)) << BigInt(i * 8);
    }
    return signed ? BigInt.asIntN(bytes * 8, val) : val;
  }

  snapshot(): { regs: Record<string, bigint>; mem: Map<number, number> } {
    return { regs: { ...this.regs }, mem: new Map(this.mem) };
  }
}
