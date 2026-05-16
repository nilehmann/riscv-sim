import type { AssemblyResult, FrameInfo, Program, Step } from "./types";

export interface DisplayState {
  callFramesByStep: FrameInfo[][];
  slotLabelsByStep: Map<number, string>[];
  error: { step: number; message: string } | null;
}

export function inferDisplayState(
  steps: Step[],
  assembled: AssemblyResult,
  prog: Program,
): DisplayState {
  if (steps.length === 0 || prog.showStack === false)
    return { callFramesByStep: [], slotLabelsByStep: [], error: null };

  const { sourceInstrs, addrToSourceIdx, labels } = assembled;

  const nonLocalLabelAddrs = new Map<number, string>();
  for (const [name, addr] of Object.entries(labels)) {
    if (!name.startsWith(".")) nonLocalLabelAddrs.set(addr, name);
  }

  const callStack: FrameInfo[] = [
    {
      label: prog.entryPoint,
      entrySpBefore: steps[0]!.regs.sp,
      allocatedSize: 0,
      returnAddr: steps[0]!.regs.ra,
    },
  ];
  const slotLabels = new Map<number, string>();

  const callFramesByStep: FrameInfo[][] = [callStack.map((f) => ({ ...f }))];
  const slotLabelsByStep: Map<number, string>[] = [new Map(slotLabels)];
  let error: { step: number; message: string } | null = null;

  for (let i = 1; i < steps.length; i++) {
    if (error) {
      callFramesByStep.push(callFramesByStep[callFramesByStep.length - 1]!);
      slotLabelsByStep.push(slotLabelsByStep[slotLabelsByStep.length - 1]!);
      continue;
    }

    const step = steps[i]!;
    const prevStep = steps[i - 1]!;

    if (step.store) slotLabels.set(step.store.addr, step.store.reg);

    // lightweight jump check — guard against branches landing on label addresses
    let isJump = false;
    const instrAddr = step.aHl[0];
    if (instrAddr != null) {
      const siIdx = addrToSourceIdx.get(instrAddr);
      if (siIdx != null) {
        const si = sourceInstrs[siIdx]!;
        const ci = si.concretes[(instrAddr - si.firstAddr) / 4];
        if (ci) isJump = ci.op === "jal" || ci.op === "jalr";
      }
    }

    const raChanged = step.regs.ra !== prevStep.regs.ra;
    const topFrame = callStack[callStack.length - 1]!;

    if (raChanged && isJump && step.nextAddr != null) {
      // Regular call
      callStack.push({
        label: nonLocalLabelAddrs.get(step.nextAddr) ?? "??",
        entrySpBefore: step.regs.sp,
        allocatedSize: 0,
        returnAddr: step.regs.ra,
      });
    } else if (step.nextAddr === topFrame.returnAddr && callStack.length > 1) {
      // Return
      const popped = callStack.pop()!;
      if (step.regs.sp !== popped.entrySpBefore) {
        error = {
          step: i,
          message: `sp not restored before return in "${popped.label}" (expected 0x${popped.entrySpBefore.toString(16)}, got 0x${step.regs.sp.toString(16)})`,
        };
      }
    } else if (
      isJump &&
      !raChanged &&
      step.nextAddr != null &&
      nonLocalLabelAddrs.has(step.nextAddr) &&
      nonLocalLabelAddrs.get(step.nextAddr) !== topFrame.label
    ) {
      // Tail call — replace top frame, inherit returnAddr
      const popped = callStack.pop()!;
      if (step.regs.sp !== popped.entrySpBefore) {
        error = {
          step: i,
          message: `sp not restored before tail call from "${popped.label}" (expected 0x${popped.entrySpBefore.toString(16)}, got 0x${step.regs.sp.toString(16)})`,
        };
      }
      callStack.push({
        label: nonLocalLabelAddrs.get(step.nextAddr)!,
        entrySpBefore: step.regs.sp,
        allocatedSize: 0,
        returnAddr: popped.returnAddr,
      });
    }

    const newTop = callStack[callStack.length - 1]!;
    newTop.allocatedSize = newTop.entrySpBefore - step.regs.sp;

    if (!error && step.regs.sp > newTop.entrySpBefore) {
      error = {
        step: i,
        message: `sp above frame base in "${newTop.label}" (sp=0x${step.regs.sp.toString(16)}, base=0x${newTop.entrySpBefore.toString(16)})`,
      };
    }

    callFramesByStep.push(callStack.map((f) => ({ ...f })));
    slotLabelsByStep.push(new Map(slotLabels));
  }

  return { callFramesByStep, slotLabelsByStep, error };
}
