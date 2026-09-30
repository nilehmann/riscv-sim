import type { AssemblyResult, FrameInfo, Program, SlotLabel, Step } from "./types";
import type { Isa, StoreInfo } from "./isa/types";

export interface DisplayState {
  callFramesByStep: FrameInfo[][];
  slotLabelsByStep: Map<number, SlotLabel>[];
  error: { step: number; message: string } | null;
}

export function inferDisplayState(
  steps: Step[],
  assembled: AssemblyResult,
  prog: Program,
  isa: Isa,
  initialReturnAddr: number | null,
  initialSlotLabels: StoreInfo[] = [],
): DisplayState {
  if (steps.length === 0 || prog.showStack === false)
    return { callFramesByStep: [], slotLabelsByStep: [], error: null };

  const { labels } = assembled;
  const sp = (step: Step) => Number(step.regs[isa.regs.sp]);
  // Without a return-address register, `call` pushes the return address. That
  // slot belongs to the callee: its frame starts at sp before the call.
  const retSlot = isa.regs.returnAddr ? 0 : isa.wordBytes;

  const nonLocalLabelAddrs = new Map<number, string>();
  for (const [name, addr] of Object.entries(labels)) {
    // Several labels can share an address; keep the first one in the source.
    if (!name.startsWith(".") && !nonLocalLabelAddrs.has(addr))
      nonLocalLabelAddrs.set(addr, name);
  }

  const callStack: FrameInfo[] = [
    {
      label: prog.entryPoint ?? "(start)",
      // The entry function's caller has already pushed its return address.
      entrySpBefore: sp(steps[0]!) + retSlot,
      allocatedSize: retSlot,
      returnAddr: initialReturnAddr ?? NaN,
    },
  ];
  // Keyed by the exact address stored to, so halves of a slot can differ.
  const slotLabels = new Map<number, SlotLabel>();
  function recordStore(st: StoreInfo) {
    // Labels this store overlaps no longer describe what the memory holds.
    for (const [a, l] of slotLabels)
      if (a < st.addr + st.size && st.addr < a + l.size) slotLabels.delete(a);
    slotLabels.set(st.addr, { name: st.reg, size: st.size });
  }
  for (const st of initialSlotLabels) recordStore(st);

  const callFramesByStep: FrameInfo[][] = [callStack.map((f) => ({ ...f }))];
  const slotLabelsByStep: Map<number, SlotLabel>[] = [new Map(slotLabels)];
  let error: { step: number; message: string } | null = null;

  for (let i = 1; i < steps.length; i++) {
    if (error) {
      callFramesByStep.push(callFramesByStep[callFramesByStep.length - 1]!);
      slotLabelsByStep.push(slotLabelsByStep[slotLabelsByStep.length - 1]!);
      continue;
    }

    const step = steps[i]!;
    const prevStep = steps[i - 1]!;

    if (step.store) recordStore(step.store);

    const control = step.control;
    const topFrame = callStack[callStack.length - 1]!;

    if (control?.kind === "call" && step.nextAddr != null) {
      // Regular call
      callStack.push({
        label: nonLocalLabelAddrs.get(step.nextAddr) ?? "??",
        entrySpBefore: sp(prevStep),
        allocatedSize: 0,
        returnAddr: control.returnAddr,
      });
    } else if (step.nextAddr === topFrame.returnAddr && callStack.length > 1) {
      // Return
      const popped = callStack.pop()!;
      if (sp(step) !== popped.entrySpBefore) {
        error = {
          step: i,
          message: `${isa.regs.sp} not restored before return in "${popped.label}" (expected 0x${popped.entrySpBefore.toString(16)}, got 0x${sp(step).toString(16)})`,
        };
      }
    } else if (
      control?.kind === "jump" &&
      step.nextAddr != null &&
      nonLocalLabelAddrs.has(step.nextAddr) &&
      nonLocalLabelAddrs.get(step.nextAddr) !== topFrame.label
    ) {
      // Tail call — replace top frame, inherit returnAddr
      // A pushed return address is still on the stack and is reused.
      const popped = callStack.pop()!;
      const expected = popped.entrySpBefore - retSlot;
      if (sp(step) !== expected) {
        error = {
          step: i,
          message: `${isa.regs.sp} not restored before tail call from "${popped.label}" (expected 0x${expected.toString(16)}, got 0x${sp(step).toString(16)})`,
        };
      }
      callStack.push({
        label: nonLocalLabelAddrs.get(step.nextAddr)!,
        entrySpBefore: sp(step) + retSlot,
        allocatedSize: 0,
        returnAddr: popped.returnAddr,
      });
    }

    const newTop = callStack[callStack.length - 1]!;
    newTop.allocatedSize = Math.max(0, newTop.entrySpBefore - sp(step));

    // Stores below sp live in the red zone until sp moves past them.
    if (isa.redZone && step.store && step.store.addr < sp(step))
      newTop.lowWrite = Math.min(newTop.lowWrite ?? Infinity, step.store.addr);
    if (newTop.lowWrite != null && sp(step) <= newTop.lowWrite) delete newTop.lowWrite;

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
