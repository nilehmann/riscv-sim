import type { AssemblyResult, FrameInfo, Program, Step } from "./types";
import type { Isa } from "./isa/types";

export interface DisplayState {
  callFramesByStep: FrameInfo[][];
  slotLabelsByStep: Map<number, string>[];
  error: { step: number; message: string } | null;
}

export function inferDisplayState(
  steps: Step[],
  assembled: AssemblyResult,
  prog: Program,
  isa: Isa,
  initialReturnAddr: number | null,
): DisplayState {
  if (steps.length === 0 || prog.showStack === false)
    return { callFramesByStep: [], slotLabelsByStep: [], error: null };

  const { labels } = assembled;
  const sp = (step: Step) => Number(step.regs[isa.regs.sp]);

  const nonLocalLabelAddrs = new Map<number, string>();
  for (const [name, addr] of Object.entries(labels)) {
    // Several labels can share an address; keep the first one in the source.
    if (!name.startsWith(".") && !nonLocalLabelAddrs.has(addr))
      nonLocalLabelAddrs.set(addr, name);
  }

  const callStack: FrameInfo[] = [
    {
      label: prog.entryPoint ?? "(start)",
      entrySpBefore: sp(steps[0]!),
      allocatedSize: 0,
      returnAddr: initialReturnAddr ?? NaN,
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

    const control = step.control;
    const topFrame = callStack[callStack.length - 1]!;

    if (control?.kind === "call" && step.nextAddr != null) {
      // Regular call. The frame starts at sp after the call, so a return
      // address pushed by the call belongs to the caller's frame.
      callStack.push({
        label: nonLocalLabelAddrs.get(step.nextAddr) ?? "??",
        entrySpBefore: sp(step),
        allocatedSize: 0,
        returnAddr: control.returnAddr,
      });
    } else if (step.nextAddr === topFrame.returnAddr && callStack.length > 1) {
      // Return
      // Compare sp before the returning instruction: a `ret` that pops the
      // return address moves sp past the frame base.
      const popped = callStack.pop()!;
      if (sp(prevStep) !== popped.entrySpBefore) {
        error = {
          step: i,
          message: `${isa.regs.sp} not restored before return in "${popped.label}" (expected 0x${popped.entrySpBefore.toString(16)}, got 0x${sp(prevStep).toString(16)})`,
        };
      }
    } else if (
      control?.kind === "jump" &&
      step.nextAddr != null &&
      nonLocalLabelAddrs.has(step.nextAddr) &&
      nonLocalLabelAddrs.get(step.nextAddr) !== topFrame.label
    ) {
      // Tail call — replace top frame, inherit returnAddr
      const popped = callStack.pop()!;
      if (sp(prevStep) !== popped.entrySpBefore) {
        error = {
          step: i,
          message: `${isa.regs.sp} not restored before tail call from "${popped.label}" (expected 0x${popped.entrySpBefore.toString(16)}, got 0x${sp(prevStep).toString(16)})`,
        };
      }
      callStack.push({
        label: nonLocalLabelAddrs.get(step.nextAddr)!,
        entrySpBefore: sp(step),
        allocatedSize: 0,
        returnAddr: popped.returnAddr,
      });
    }

    const newTop = callStack[callStack.length - 1]!;
    newTop.allocatedSize = newTop.entrySpBefore - sp(step);

    if (!error && sp(step) > newTop.entrySpBefore) {
      error = {
        step: i,
        message: `${isa.regs.sp} above frame base in "${newTop.label}" (${isa.regs.sp}=0x${sp(step).toString(16)}, base=0x${newTop.entrySpBefore.toString(16)})`,
      };
    }

    callFramesByStep.push(callStack.map((f) => ({ ...f })));
    slotLabelsByStep.push(new Map(slotLabels));
  }

  return { callFramesByStep, slotLabelsByStep, error };
}
