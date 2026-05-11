import type { Program, AssemblyResult, Step } from "./types";

// ─── Register metadata ────────────────────────────────────────────────────
export const ALL_REGS = [
    "zero",
    "ra",
    "sp",
    "gp",
    "tp",
    "a0",
    "a1",
    "a2",
    "a3",
    "a4",
    "a5",
    "a6",
    "a7",
    "s0",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s11",
    "t0",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
    "fp",
];

export const REG_SET = new Set([
    "zero",
    "ra",
    "sp",
    "gp",
    "tp",
    "fp",
    "a0",
    "a1",
    "a2",
    "a3",
    "a4",
    "a5",
    "a6",
    "a7",
    "s0",
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s11",
    "t0",
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
]);

export const REG_META = {
    zero: { desc: "constante cero" },
    ra: { desc: "dirección retorno" },
    sp: { desc: "stack pointer" },
    gp: { desc: "global pointer" },
    tp: { desc: "thread pointer" },
    fp: { desc: "frame pointer" },
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
export class Machine {
    regs: Record<string, number>;
    mem: Map<number, number>;

    constructor(initialRegs: Record<string, number>) {
        this.regs = {};
        for (const r of ALL_REGS) this.regs[r] = 0;
        for (const [k, v] of Object.entries(initialRegs)) this.regs[k] = v;
        this.regs.fp = this.regs.s0; // s0 and fp alias x8
        this.mem = new Map();
    }

    writeReg(name: string, value: number): void {
        if (name === "zero") return;              // zero is hardwired to 0
        this.regs[name] = value;
        if (name === "s0") this.regs.fp = value; // keep alias in sync
        if (name === "fp") this.regs.s0 = value;
    }

    writeMem(addr: number, value: number): void {
        this.mem.set(addr, value);
    }

    readMem(addr: number): number {
        return this.mem.get(addr) ?? 0;
    }

    snapshot(): { regs: Record<string, number>; mem: Map<number, number> } {
        return { regs: { ...this.regs }, mem: new Map(this.mem) };
    }
}

// ─── Simulator ────────────────────────────────────────────────────────────
export function simulate(prog: Program, assembled: AssemblyResult): Step[] {
    const { sourceInstrs, addrToSourceIdx, labels } = assembled;

    const machine = new Machine(prog.initialRegs);
    const slotLabels = new Map<number, string>(); // addr → saved register name

    let pc = labels[prog.entryPoint];

    // callStack tracks inferred call frames for the stack visualization.
    // entrySpBefore: sp when this function was entered.
    // allocatedSize: bytes claimed by the prologue so far.
    const callStack = [
        {
            label: prog.entryPoint,
            entrySpBefore: machine.regs.sp,
            allocatedSize: 0,
        },
    ];

    const steps: Step[] = [];

    function snap() {
        const { regs, mem } = machine.snapshot();
        return {
            regs,
            mem,
            slotLabels: new Map(slotLabels),
            callStack: callStack.map((f) => ({ ...f })),
            pc,
        };
    }

    function makeStep(
        s: ReturnType<typeof snap>,
        hiReg: string[],
        hiSlots: number[],
        instrAddr: number | null,
        nextAddr: number | null,
    ): Step {
        return {
            aHl: instrAddr != null ? [instrAddr] : [],
            nextAddr: nextAddr ?? null,
            regs: s.regs,
            hiReg: hiReg || [],
            mem: s.mem,
            hiSlots: hiSlots || [],
            slotLabels: s.slotLabels,
            callStack: s.callStack,
        };
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

        const instrAddr = si.firstAddr;
        let hiReg: string[] = [],
            hiSlots: number[] = [];

        for (let ciIdx = 0; ciIdx < si.concretes.length; ciIdx++) {
            const ci = si.concretes[ciIdx]!;
            const ciAddr = si.firstAddr + ciIdx * 4;
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
                    if (ci.rd === "sp") {
                        let top = null;
                        for (let i = callStack.length - 1; i >= 0; i--) {
                            if (callStack[i].label === si.label) {
                                top = callStack[i];
                                break;
                            }
                        }
                        if (!top) top = callStack[callStack.length - 1];
                        top.allocatedSize = top.entrySpBefore - val;
                    }
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
                    if (si.parsed.op === "call") {
                        callStack.push({
                            label: (si.parsed as any).target,
                            entrySpBefore: machine.regs.sp,
                            allocatedSize: 0,
                        });
                    }
                    machine.writeReg(ci.rd, ciAddr + 4);
                    if (ci.rd !== "zero") hiReg.push(ci.rd);
                    pc = jumpTarget;
                    break;
                }

                case "sw":
                case "sh":
                case "sb": {
                    const addr = machine.regs[ci.rs1] + ci.offset;
                    machine.writeMem(addr, machine.regs[ci.rs2]);
                    slotLabels.set(addr, ci.rs2);
                    pc += 4;
                    hiSlots.push(addr);
                    break;
                }

                case "lw":
                case "lh":
                case "lb":
                case "lhu":
                case "lbu": {
                    const addr = machine.regs[ci.rs1] + ci.offset;
                    machine.writeReg(ci.rd, machine.readMem(addr));
                    pc += 4;
                    hiReg.push(ci.rd);
                    hiSlots.push(addr);
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
        }

        steps.push(makeStep(snap(), hiReg, hiSlots, instrAddr, pc));
    }

    return steps;
}
