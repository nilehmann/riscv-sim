import type { AssemblyResult, DisplayReg, FrameInfo, Program, ResolvedRegion, SlotLabel, Step } from "./types";
import type { Isa } from "./isa/types";
import { AppError, hx } from "./types";
import { getIsa } from "./isa";
import { assembleProgram } from "./assembler";
import { validateProgram, validateAssembled } from "./validation";
import { simulate } from "./simulator";
import { resolveRegions } from "./regions";
import { garbageReg } from "./garbage";
import { inferDisplayState } from "./inferDisplay";
import { PROGRAMS } from "./programs";

// ─── Helpers ──────────────────────────────────────────────────────────────

function computeDisplayRegs(
  prog: Program,
  assembled: AssemblyResult,
  isa: Isa,
): DisplayReg[] {
  const used = new Set<string>();
  for (const r of Object.keys(prog.initialRegs)) used.add(isa.regs.aliases[r] ?? r);
  for (const si of assembled.sourceInstrs)
    for (const c of si.concretes) for (const r of isa.regsUsed(c.instr)) used.add(r);
  return isa.regs.names
    .filter((r) => used.has(r))
    .map((r) => ({ name: r, desc: "", key: r }));
}

// ─── UIState ─────────────────────────────────────────────────────────────
// Visual toggles and transient UI state that is independent of the simulation.

export class UIState {
  activeTab = $state<"asm" | "c">("asm");
  showFp = $state(false);
  /** Suppresses the CSS transition on the first sp-arrow render. Reset on program load. */
  firstArrowRender = $state(true);
  /** Suppresses the CSS transition on the first fp-arrow render. Reset when fp is toggled on. */
  firstFpArrowRender = $state(true);
  selectorOpen = $state(false);
  /** User-chosen piece size in bytes for a slot, by slot key. */
  slotViewMode = $state<Map<string, number>>(new Map());
  /** Paths of the expanded cards of each memory region, by region name. Reset on program load. */
  openCards = $state<Map<string, Set<string>>>(new Map());
  showGarbage = $state(true);
  theme = $state<'light' | 'dark' | 'system'>(
    (localStorage.getItem('theme') as 'light' | 'dark' | 'system') ?? 'system'
  );
  showSettings = $state(false);
  showEditor = $state(false);
  vimMode = $state<boolean>(localStorage.getItem("vimMode") === "true");
}

export type AsmMode = "source" | "machine";

export const ui = new UIState();

// ─── SimulationState ──────────────────────────────────────────────────────
// Owns the loaded program, assembled code, simulation steps, and navigation.

export class SimulationState {
  // ── Core state ──
  program = $state<Program | null>(null);
  isa = $state<Isa>(getIsa());
  assembled = $state<AssemblyResult | null>(null);
  steps = $state<Step[]>([]);
  /** Concrete step index of the last concrete instr for source[i]. sourcePositions[0]=0, then sourceToConcrete values. */
  sourcePositions = $state<number[]>([]);
  displayRegs = $state<DisplayReg[]>([]);
  /** Memory regions with their types and initial values laid out. */
  regions = $state<ResolvedRegion[]>([]);
  callFramesByStep = $state<FrameInfo[][]>([]);
  slotLabelsByStep = $state<Map<number, SlotLabel>[]>([]);
  inferError = $state<{ step: number; message: string } | null>(null);
  cur = $state(0);
  asmMode = $state<AsmMode>("source");
  loadError = $state<AppError | null>(null);

  // ── Derived navigation ──
  currentSourcePosIdx = $derived.by(() => {
    let p = 0;
    for (let i = this.sourcePositions.length - 1; i >= 0; i--) {
      if (this.sourcePositions[i]! <= this.cur) {
        p = i;
        break;
      }
    }
    return p;
  });

  posIdx = $derived(
    this.asmMode === "source" ? this.currentSourcePosIdx : this.cur,
  );

  total = $derived(
    this.asmMode === "source" ? this.sourcePositions.length : this.steps.length,
  );

  progress = $derived(
    this.total <= 1 ? 100 : (this.posIdx / (this.total - 1)) * 100,
  );

  currentStep = $derived(this.steps[this.cur] ?? null);
  currentCallFrames = $derived(this.callFramesByStep[this.cur] ?? []);
  currentSlotLabels = $derived(this.slotLabelsByStep[this.cur] ?? new Map<number, SlotLabel>());
  stackEnabled = $derived(this.program?.showStack !== false);

  // ── Actions ──

  goTo(idx: number): void {
    const max = this.inferError ? this.inferError.step : this.steps.length - 1;
    this.cur = Math.max(0, Math.min(max, idx));
  }

  go(dir: number): void {
    if (this.asmMode !== "source") {
      this.goTo(this.cur + dir);
      return;
    }
    const p = this.currentSourcePosIdx;
    const newP = Math.max(
      0,
      Math.min(this.sourcePositions.length - 1, p + dir),
    );
    this.goTo(this.sourcePositions[newP]!);
  }

  scrubTo(ratio: number): void {
    if (this.asmMode === "source") {
      const posIdx = Math.round(ratio * (this.sourcePositions.length - 1));
      this.goTo(this.sourcePositions[posIdx]!);
    } else {
      this.goTo(Math.round(ratio * (this.steps.length - 1)));
    }
  }

  switchAsmMode(mode: AsmMode): void {
    this.asmMode = mode;
    if (mode === "source") {
      // Snap cur down to the nearest source boundary
      this.cur = this.sourcePositions[this.currentSourcePosIdx]!;
    }
  }

  loadProgram(prog: Program): void {
    this.loadError = null;

    const isa = getIsa(prog.isa);
    this.loadError = validateProgram(prog, isa);
    if (this.loadError) return;

    const assembled = assembleProgram(prog, isa);
    if (assembled instanceof AppError) {
      this.loadError = assembled;
      return;
    }

    this.loadError = validateAssembled(prog, assembled, isa);
    if (this.loadError) return;

    const regions = resolveRegions(prog, isa);
    if (regions instanceof AppError) {
      this.loadError = regions;
      return;
    }

    const { steps, sourceToConcrete, initialReturnAddr, initialSlotLabels } = simulate(prog, assembled, isa);
    const { callFramesByStep, slotLabelsByStep, error } = inferDisplayState(
      steps, assembled, prog, isa, initialReturnAddr, initialSlotLabels,
    );

    this.program = prog;
    this.isa = isa;
    this.assembled = assembled;
    this.steps = steps;
    this.callFramesByStep = callFramesByStep;
    this.slotLabelsByStep = slotLabelsByStep;
    this.inferError = error;
    this.sourcePositions = [0, ...sourceToConcrete];
    this.displayRegs = computeDisplayRegs(prog, assembled, isa);
    this.regions = regions;
    this.cur = 0;
    this.asmMode = "source";
    ui.activeTab = "asm";
    ui.firstArrowRender = true;
    ui.slotViewMode = new Map();
    ui.openCards = new Map();
  }
}

export const sim = new SimulationState();

// ─── Deterministic garbage register values for uninitialized display ───────

export function fmtRegVal(key: string, val: bigint | null | undefined): string {
  const isa = sim.isa;
  if (val != null) return hx(val, isa.wordBytes);
  const i = isa.regs.names.indexOf(key);
  if (i === -1) return "?";
  return hx(key === isa.regs.zero ? 0n : garbageReg(i, isa.wordBytes), isa.wordBytes);
}

// ─── Load the first program immediately ───────────────────────────────────
sim.loadProgram(PROGRAMS[0]!);
