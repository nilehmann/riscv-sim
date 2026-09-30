import type { Program, AssemblyResult, Step, SimulateResult } from "./types";
import type { Isa } from "./isa/types";
import { getIsa } from "./isa";
import { Machine } from "./machine";

const MAX_STEPS = 500;

export function simulate(
  prog: Program,
  assembled: AssemblyResult,
  isa: Isa = getIsa(prog.isa),
): SimulateResult {
  const { sourceInstrs, addrToSourceIdx, labels } = assembled;

  const stackBase = prog.stackBase ?? isa.defaults.stackBase;
  const osMode = prog.osMode !== false;
  const machine = new Machine(isa, prog.initialRegs, stackBase, osMode);

  for (const region of prog.memoryRegions ?? []) {
    for (let i = 0; i < region.elements.length; i++) {
      machine.writeMem(
        region.addr + i * region.elementSize,
        BigInt(region.elements[i]!),
        region.elementSize,
      );
    }
  }

  isa.setup?.(machine, prog);
  const initialReturnAddr = isa.initialReturnAddr(machine);
  const initialSlotLabels = isa.initialSlotLabels?.(machine) ?? [];
  let pc = prog.entryPoint ? labels[prog.entryPoint]! : prog.baseAddress;

  const steps: Step[] = [];
  const sourceToConcrete: number[] = [];

  function pushStep(fields: Partial<Step> & Pick<Step, "nextAddr">): void {
    const { regs, mem } = machine.snapshot();
    steps.push({ aHl: [], regs, mem, hiReg: [], hiSlots: [], ...fields });
  }

  // Initial step: state before the first instruction.
  pushStep({ nextAddr: pc });

  while (steps.length < MAX_STEPS) {
    const siIdx = addrToSourceIdx.get(pc);
    if (siIdx == null) break;
    const si = sourceInstrs[siIdx]!;

    // pc is normally the line's first instruction, but a jump may land mid-line.
    const start = si.concretes.findIndex((c) => c.addr === pc);
    for (const c of si.concretes.slice(start)) {
      const r = isa.execute(machine, c.instr, c.addr, c.size);
      if (r.fault) {
        pushStep({ aHl: [c.addr], nextAddr: null, fault: r.fault });
        return { steps, sourceToConcrete, initialReturnAddr, initialSlotLabels };
      }
      pc = r.next;
      pushStep({
        aHl: [c.addr],
        nextAddr: pc,
        hiReg: r.hiReg ?? [],
        hiSlots: r.hiSlots ?? [],
        store: r.store,
        control: r.control,
      });
    }
    sourceToConcrete.push(steps.length - 1);
  }

  return { steps, sourceToConcrete, initialReturnAddr, initialSlotLabels };
}
