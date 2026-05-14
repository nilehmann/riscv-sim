import type { AssemblyResult, FrameInfo, Program, Step } from "./types";

export interface DisplayState {
  callFramesByStep: FrameInfo[][];
  slotLabelsByStep: Map<number, string>[];
}

export function inferDisplayState(
  steps: Step[],
  assembled: AssemblyResult,
  prog: Program,
): DisplayState {
  if (steps.length === 0) return { callFramesByStep: [], slotLabelsByStep: [] };

  const { sourceInstrs, addrToSourceIdx, labels } = assembled;

  const nonLocalLabelAddrs = new Map<number, string>();
  for (const [name, addr] of Object.entries(labels)) {
    if (!name.startsWith(".")) nonLocalLabelAddrs.set(addr, name);
  }

  const callStack: FrameInfo[] = [
    { label: prog.entryPoint, entrySpBefore: steps[0]!.regs.sp, allocatedSize: 0 },
  ];
  const slotLabels = new Map<number, string>();

  const callFramesByStep: FrameInfo[][] = [callStack.map((f) => ({ ...f }))];
  const slotLabelsByStep: Map<number, string>[] = [new Map(slotLabels)];

  for (let i = 1; i < steps.length; i++) {
    const step = steps[i]!;
    const prevStep = steps[i - 1]!;

    // slotLabels
    if (step.store) slotLabels.set(step.store.addr, step.store.reg);

    // call detection
    const instrAddr = step.aHl[0];
    if (instrAddr != null && step.nextAddr != null) {
      const siIdx = addrToSourceIdx.get(instrAddr);
      if (siIdx != null) {
        const si = sourceInstrs[siIdx]!;
        const ciIdx = (instrAddr - si.firstAddr) / 4;
        const ci = si.concretes[ciIdx];
        if (
          ci &&
          ((ci.op === "jal" && ci.rd === "ra") || (ci.op === "jalr" && ci.rd === "ra")) &&
          nonLocalLabelAddrs.has(step.nextAddr)
        ) {
          callStack.push({
            label: nonLocalLabelAddrs.get(step.nextAddr)!,
            entrySpBefore: step.regs.sp,
            allocatedSize: 0,
          });
        }
      }
    }

    // sp change
    const newSp = step.regs.sp;
    const prevSp = prevStep.regs.sp;
    if (newSp !== prevSp) {
      if (newSp < prevSp) {
        const top = callStack[callStack.length - 1]!;
        top.allocatedSize = top.entrySpBefore - newSp;
      } else {
        while (callStack.length > 1 && callStack[callStack.length - 1]!.entrySpBefore <= newSp) {
          callStack.pop();
        }
        const top = callStack[callStack.length - 1]!;
        top.allocatedSize = top.entrySpBefore - newSp;
      }
    }

    callFramesByStep.push(callStack.map((f) => ({ ...f })));
    slotLabelsByStep.push(new Map(slotLabels));
  }

  return { callFramesByStep, slotLabelsByStep };
}
