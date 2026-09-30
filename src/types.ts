import type { ControlFlow, Fault, IsaId, StoreInfo } from "./isa/types";

export const hx = (v: number | bigint, bytes: 1 | 2 | 4 | 6 | 8 = 4): string => {
  if (typeof v === "number" && !Number.isInteger(v)) return "0x" + "?".repeat(bytes * 2);
  return (
    "0x" +
    BigInt.asUintN(bytes * 8, BigInt(v))
      .toString(16)
      .toUpperCase()
      .padStart(bytes * 2, "0")
  );
};

/** Hex address: 8 digits, or 12 for addresses above 4 GiB. */
export const fmtAddr = (addr: number): string => hx(addr, addr > 0xffffffff ? 6 : 4);

export interface MemoryRegion {
  addr: number;
  elementSize: 1 | 2 | 4;
  elements: number[];
}

export interface Program {
  name: string;
  /** Instruction set the assembly is written for. Default: "rv32" */
  isa?: IsaId;
  cCode?: string;
  entryPoint?: string;
  initialRegs: Record<string, number>;
  baseAddress: number;
  /** Top of the stack (stack grows down from here). Default: the ISA's */
  stackBase?: number;
  /**
   * Where the entry function returns to, for ISAs that keep the return
   * address on the stack: written at the initial sp. Default: garbage.
   */
  returnAddress?: number;
  /** When true, memory accesses outside [sp, stackBase) segfault. Default: true */
  osMode?: boolean;
  assembly: string;
  memoryRegions?: MemoryRegion[];
  /** When false, stack detection and visualization are disabled. Default: true */
  showStack?: boolean;
}

export class AppError {
  readonly kind = "AppError" as const;
  constructor(
    public readonly message: string,
    public readonly detail?: string,
  ) {}
}

/** A machine instruction placed in memory. */
export interface Concrete<I = unknown> {
  instr: I;
  addr: number;
  /** Encoded size in bytes. */
  size: number;
}

export interface SourceInstr<P = unknown, I = unknown> {
  /** Labels written immediately before this instruction, in source order. */
  labels: string[];
  raw: string;
  parsed: P;
  /** Machine instructions this line assembles to, in address order. */
  concretes: Concrete<I>[];
  firstAddr: number;
}

export interface AssemblyResult<P = unknown, I = unknown> {
  sourceInstrs: SourceInstr<P, I>[];
  /** Address of every concrete instruction → index into sourceInstrs. */
  addrToSourceIdx: Map<number, number>;
  labels: Record<string, number>;
  /** Labels after the last instruction; they point just past the end of the code. */
  trailingLabels: string[];
  /** First address past the last instruction. */
  endAddr: number;
}

export interface FrameInfo {
  label: string;
  entrySpBefore: number;
  allocatedSize: number;
  returnAddr: number;
  /** Lowest address stored to below sp (red zone) while this frame was on top. */
  lowWrite?: number;
}

/** What a stack slot (or part of one) holds. */
export interface SlotLabel {
  name: string;
  /** Bytes the labeled value occupies. */
  size: number;
}

export interface Step {
  aHl: number[];
  nextAddr: number | null;
  /** Register values, unsigned and as wide as the ISA's registers. */
  regs: Record<string, bigint>;
  hiReg: string[];
  mem: Map<number, number>;
  hiSlots: number[];
  store?: StoreInfo;
  fault?: Fault;
  /** Control transfer done by the instruction of this step, if any. */
  control?: ControlFlow;
}

export interface SimulateResult {
  steps: Step[];
  sourceToConcrete: number[]; // steps index of last concrete step of source[i]
  /** Where the entry function returns to, if known. */
  initialReturnAddr: number | null;
  initialSlotLabels: StoreInfo[];
}

export interface DisplayReg {
  name: string;
  desc: string;
  key: string;
}
