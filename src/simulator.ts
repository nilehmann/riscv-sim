import type {
  Program,
  AssemblyResult,
  Step,
  SimulateResult,
  Reg,
} from "./types";
import { ALL_REGS, isReg } from "./types";

// ─── Register metadata ────────────────────────────────────────────────────
// ALL_REGS and Reg are defined in types.ts — imported and re-exported for consumers
export { ALL_REGS } from "./types";

// fp is an alias for s0 (x8) — included so assembly using `fp` is highlighted correctly
export const REG_SET = new Set([...ALL_REGS, "fp"]);

export const REG_META = {
  zero: { desc: "constante cero" },
  ra: { desc: "dirección retorno" },
  sp: { desc: "stack pointer" },
  gp: { desc: "global pointer" },
  tp: { desc: "thread pointer" },
  a0: { desc: "arg / retorno" },
  a1: { desc: "arg 2" },
  a2: { desc: "arg 3" },
  a3: { desc: "arg 4" },
  a4: { desc: "arg 5" },
  a5: { desc: "arg 6" },
  a6: { desc: "arg 7" },
  a7: { desc: "arg 8" },
  s0: { desc: "callee-saved" },
  s1: { desc: "callee-saved" },
  s2: { desc: "callee-saved" },
  s3: { desc: "callee-saved" },
  s4: { desc: "callee-saved" },
  s5: { desc: "callee-saved" },
  s6: { desc: "callee-saved" },
  s7: { desc: "callee-saved" },
  s8: { desc: "callee-saved" },
  s9: { desc: "callee-saved" },
  s10: { desc: "callee-saved" },
  s11: { desc: "callee-saved" },
  t0: { desc: "temporal" },
  t1: { desc: "temporal" },
  t2: { desc: "temporal" },
  t3: { desc: "temporal" },
  t4: { desc: "temporal" },
  t5: { desc: "temporal" },
  t6: { desc: "temporal" },
};

// ─── Machine ──────────────────────────────────────────────────────────────

// Deterministic garbage for uninitialized stack slots — looks like random
// memory but is reproducible across runs, useful for teaching.
function garbageValue(addr: number): number {
  let h = Math.imul(addr ^ 0x45d9f3b, 0x9e3779b9);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5c4d3215);
  return (h ^ (h >>> 16)) | 0;
}

export class Machine {
  regs: Record<Reg, number>;
  mem: Map<number, number>;
  readonly stackBase: number;
  readonly osMode: boolean;

  constructor(
    initialRegs: Record<string, number>,
    stackBase: number,
    osMode: boolean,
  ) {
    this.regs = Object.fromEntries(ALL_REGS.map((r) => [r, 0])) as Record<
      Reg,
      number
    >;
    for (const [k, v] of Object.entries(initialRegs)) {
      const r = k === "fp" ? "s0" : k;
      if (isReg(r)) this.regs[r] = v;
    }
    this.mem = new Map();
    this.stackBase = stackBase;
    this.osMode = osMode;
  }

  /** Returns true if addr is a valid (non-faulting) memory address. */
  checkAccess(addr: number): boolean {
    if (!this.osMode) return true;
    return addr >= this.regs.sp && addr < this.stackBase;
  }

  writeReg(name: string, value: number): void {
    if (name === "zero") return;
    const r = name === "fp" ? "s0" : name;
    if (isReg(r)) this.regs[r] = value;
  }

  writeMemSized(addr: number, value: number, bytes: 1 | 2 | 4): void {
    const mask = bytes === 1 ? 0xff : bytes === 2 ? 0xffff : 0xffffffff;
    this.mem.set(addr, value & mask);
  }

  readMem(addr: number): number {
    if (this.mem.has(addr)) return this.mem.get(addr)!;
    if (this.osMode) {
      // Uninitialized stack slot: materialize garbage deterministically.
      const v = garbageValue(addr);
      this.mem.set(addr, v);
      return v;
    }
    return 0;
  }

  readMemSized(addr: number, bytes: 1 | 2 | 4, signed: boolean): number {
    const raw = this.readMem(addr);
    if (bytes === 4) return raw;
    const mask = bytes === 1 ? 0xff : 0xffff;
    const val = raw & mask;
    if (!signed) return val;
    const shift = (4 - bytes) * 8;
    return (val << shift) >> shift;
  }

  snapshot(): { regs: Record<string, number>; mem: Map<number, number> } {
    return { regs: { ...this.regs }, mem: new Map(this.mem) };
  }
}

// ─── Simulator ────────────────────────────────────────────────────────────
export function simulate(
  prog: Program,
  assembled: AssemblyResult,
): SimulateResult {
  const { sourceInstrs, addrToSourceIdx, labels } = assembled;

  const stackBase = prog.stackBase ?? 0xc0000000;
  const osMode = prog.osMode !== false;
  const machine = new Machine(prog.initialRegs, stackBase, osMode);

  for (const region of prog.memoryRegions ?? []) {
    for (let i = 0; i < region.elements.length; i++) {
      machine.writeMemSized(
        region.addr + i * region.elementSize,
        region.elements[i]!,
        region.elementSize,
      );
    }
  }

  let pc = labels[prog.entryPoint];

  const steps: Step[] = [];
  const sourceToConcrete: number[] = [];

  function snap() {
    const { regs, mem } = machine.snapshot();
    return { regs, mem };
  }

  function makeStep(
    s: ReturnType<typeof snap>,
    hiReg: string[],
    hiSlots: number[],
    instrAddr: number | null,
    nextAddr: number | null,
    fault?: { type: "segfault"; addr: number },
    store?: { addr: number; reg: string },
  ): Step {
    return {
      aHl: instrAddr != null ? [instrAddr] : [],
      nextAddr: nextAddr ?? null,
      regs: s.regs,
      hiReg: hiReg || [],
      mem: s.mem,
      hiSlots: hiSlots || [],
      store,
      fault,
    };
  }

  function segfault(faultAddr: number, instrAddr: number): void {
    steps.push(
      makeStep(snap(), [], [], instrAddr, null, { type: "segfault", addr: faultAddr }),
    );
  }

  // Emit initial step (state before first instruction)
  steps.push(makeStep(snap(), [], [], null, pc));

  const MAX_STEPS = 500;

  const immOps: Record<string, (a: number, b: number) => number> = {
    addi: (a, b) => a + b,
    andi: (a, b) => a & b,
    ori: (a, b) => a | b,
    xori: (a, b) => a ^ b,
    slli: (a, b) => a << b,
    srli: (a, b) => a >>> b,
    srai: (a, b) => a >> b,
  };
  const regOps: Record<string, (a: number, b: number) => number> = {
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    div: (a, b) => (b === 0 ? 0 : Math.trunc(a / b)),
    rem: (a, b) => (b === 0 ? a : a % b),
    and: (a, b) => a & b,
    or: (a, b) => a | b,
    xor: (a, b) => a ^ b,
    sll: (a, b) => a << b,
    srl: (a, b) => a >>> b,
    sra: (a, b) => a >> b,
  };
  const branchConds: Record<string, (a: number, b: number) => boolean> = {
    beq: (a, b) => a === b,
    bne: (a, b) => a !== b,
    blt: (a, b) => a < b,
    bge: (a, b) => a >= b,
    bltu: (a, b) => a >>> 0 < b >>> 0,
    bgeu: (a, b) => a >>> 0 >= b >>> 0,
  };

  while (steps.length < MAX_STEPS) {
    const siIdx = addrToSourceIdx.get(pc);
    if (siIdx == null) break;
    const si = sourceInstrs[siIdx];

    for (let ciIdx = 0; ciIdx < si.concretes.length; ciIdx++) {
      const ci = si.concretes[ciIdx]!;
      const ciAddr = si.firstAddr + ciIdx * 4;
      let hiReg: string[] = [],
        hiSlots: number[] = [];
      switch (ci.op) {
        case "addi":
        case "andi":
        case "ori":
        case "xori":
        case "slli":
        case "srli":
        case "srai": {
          const val = immOps[ci.op](machine.regs[ci.rs1], ci.imm);
          machine.writeReg(ci.rd, val);
          pc += 4;
          hiReg.push(ci.rd);
          break;
        }

        case "add":
        case "sub":
        case "mul":
        case "div":
        case "rem":
        case "and":
        case "or":
        case "xor":
        case "sll":
        case "srl":
        case "sra": {
          const val = regOps[ci.op](machine.regs[ci.rs1], machine.regs[ci.rs2]);
          machine.writeReg(ci.rd, val);
          pc += 4;
          hiReg.push(ci.rd);
          break;
        }

        case "lui": {
          machine.writeReg(ci.rd, ci.imm << 12);
          pc += 4;
          hiReg.push(ci.rd);
          break;
        }

        case "auipc": {
          machine.writeReg(ci.rd, ciAddr + (ci.imm << 12));
          pc += 4;
          hiReg.push(ci.rd);
          break;
        }

        case "jal": {
          machine.writeReg(ci.rd, ciAddr + 4);
          if (ci.rd !== "zero") hiReg.push(ci.rd);
          pc = ciAddr + ci.target;
          break;
        }

        case "jalr": {
          const jumpTarget = (machine.regs[ci.rs1] + ci.imm) & ~1;
          machine.writeReg(ci.rd, ciAddr + 4);
          if (ci.rd !== "zero") hiReg.push(ci.rd);
          pc = jumpTarget;
          break;
        }

        case "sw":
        case "sh":
        case "sb": {
          const addr = machine.regs[ci.rs1] + ci.offset;
          if (!machine.checkAccess(addr)) {
            segfault(addr, ciAddr);
            return { steps, sourceToConcrete };
          }
          const storeBytes = ci.op === "sb" ? 1 : ci.op === "sh" ? 2 : 4;
          machine.writeMemSized(
            addr,
            machine.regs[ci.rs2],
            storeBytes as 1 | 2 | 4,
          );
          const storeDisplayAddr = storeBytes < 4 ? addr & ~3 : addr;
          pc += 4;
          hiSlots.push(storeDisplayAddr);
          steps.push(makeStep(snap(), hiReg, hiSlots, ciAddr, pc, undefined, { addr: storeDisplayAddr, reg: ci.rs2 }));
          continue;
        }

        case "lw":
        case "lh":
        case "lb":
        case "lhu":
        case "lbu": {
          const addr = machine.regs[ci.rs1] + ci.offset;
          if (!machine.checkAccess(addr)) {
            segfault(addr, ciAddr);
            return { steps, sourceToConcrete };
          }
          const loadBytes =
            ci.op === "lb" || ci.op === "lbu"
              ? 1
              : ci.op === "lh" || ci.op === "lhu"
                ? 2
                : 4;
          const loadSigned = ci.op === "lb" || ci.op === "lh";
          machine.writeReg(
            ci.rd,
            machine.readMemSized(addr, loadBytes as 1 | 2 | 4, loadSigned),
          );
          pc += 4;
          hiReg.push(ci.rd);
          hiSlots.push(loadBytes < 4 ? addr & ~3 : addr);
          break;
        }

        case "beq":
        case "bne":
        case "blt":
        case "bge":
        case "bltu":
        case "bgeu": {
          const taken = branchConds[ci.op](
            machine.regs[ci.rs1],
            machine.regs[ci.rs2],
          );
          pc = taken ? ciAddr + ci.target : pc + 4;
          break;
        }

        default: {
          pc += 4;
          break;
        }
      }
      steps.push(makeStep(snap(), hiReg, hiSlots, ciAddr, pc));
    }
    sourceToConcrete.push(steps.length - 1);
  }

  return { steps, sourceToConcrete };
}
