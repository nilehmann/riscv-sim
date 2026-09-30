import type { Instr, Operand, Parsed } from "./types";
import type { Token } from "../types";
import { fmtAddr } from "../../types";

const SIZE_NAMES = { 1: "BYTE", 2: "WORD", 4: "DWORD", 8: "QWORD" } as const;

const kw = (t: string): Token => ({ kind: "kw", text: t });
const reg = (r: string): Token => ({ kind: "reg", text: r });
const imm = (t: string | number): Token => ({ kind: "imm", text: String(t) });
const punct = (t: string): Token => ({ kind: "punct", text: t });

// Intel syntax: `DWORD PTR [rbp+rax*4-8]`.
function operand(o: Operand, label: (name: string) => Token): Token[] {
  switch (o.kind) {
    case "reg":
      return [reg(o.name)];
    case "imm":
      return [imm(o.text)];
    case "label":
      return [label(o.name)];
    case "mem": {
      const toks: Token[] = [];
      if (o.size) toks.push(punct(`${SIZE_NAMES[o.size]} PTR `));
      toks.push(punct("["));
      if (o.base) toks.push(reg(o.base));
      if (o.index) {
        if (o.base) toks.push(punct("+"));
        toks.push(reg(o.index));
        if (o.scale !== 1) toks.push(punct("*"), imm(o.scale));
      }
      if (!o.base && !o.index) toks.push(imm(o.disp));
      else if (o.disp !== 0) toks.push(punct(o.disp < 0 ? "-" : "+"), imm(Math.abs(o.disp)));
      toks.push(punct("]"));
      return toks;
    }
  }
}

function render(p: Parsed, label: (name: string) => Token): Token[] {
  const toks: Token[] = [kw(p.op)];
  p.ops.forEach((o, i) => {
    toks.push(punct(i === 0 ? " " : ", "), ...operand(o, label));
  });
  return toks;
}

/** Machine instruction: branch targets are shown as addresses. */
export function tokens(c: Instr): Token[] {
  return render(c, (name) =>
    c.target === undefined
      ? { kind: "label", text: name }
      : { kind: "label", text: fmtAddr(c.target), addr: c.target },
  );
}

/** Source instruction: branch targets keep their label. */
export function sourceTokens(p: Parsed, labels: Record<string, number>): Token[] {
  return render(p, (name) => ({ kind: "label", text: name, addr: labels[name] }));
}
