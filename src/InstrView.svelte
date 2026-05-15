<script lang="ts">
  import type { SourceInstr } from "./types";
  import { hx } from "./assembler";

  let { si, labels }: { si: SourceInstr; labels: Record<string, number> } = $props();

  type Token =
    | { kind: "kw";    text: string }
    | { kind: "reg";   text: string }
    | { kind: "imm";   text: string }
    | { kind: "label"; text: string; addr?: number }
    | { kind: "punct"; text: string };

  function parsedToTokens(si: SourceInstr, labels: Record<string, number>): Token[] {
    const p = si.parsed;
    const trimmed = si.raw.trim();
    const spIdx = trimmed.indexOf(" ");
    const rawOps = spIdx === -1 ? [] : trimmed.slice(spIdx + 1).split(",").map(s => s.trim());

    const toks: Token[] = [{ kind: "kw", text: p.op }];

    const reg   = (r: string): Token    => ({ kind: "reg",   text: r });
    const imm   = (t: string): Token    => ({ kind: "imm",   text: t });
    const lbl   = (name: string): Token => ({ kind: "label", text: name, addr: labels[name] });
    const punct = (t: string): Token    => ({ kind: "punct", text: t });
    const sep   = (): Token             => punct(", ");
    const mem   = (rawOp: string, rs1: string): Token[] => {
      const pi = rawOp.indexOf("(");
      return [imm(pi >= 0 ? rawOp.slice(0, pi) : rawOp), punct("("), reg(rs1), punct(")")];
    };
    const push = (...items: (Token | Token[])[]): void => {
      for (const item of items)
        Array.isArray(item) ? toks.push(...item) : toks.push(item);
    };

    switch (p.op) {
      case "ret":
      case "nop":
        break;
      case "li":
      case "lui":
        push(punct(" "), reg(p.rd), sep(), imm(rawOps[1] ?? ""));
        break;
      case "mv":
      case "neg":
        push(punct(" "), reg(p.rd), sep(), reg(p.rs1));
        break;
      case "jr":
        push(punct(" "), reg(p.rs));
        break;
      case "call":
      case "j":
        push(punct(" "), lbl(p.target));
        break;
      case "jal":
        push(punct(" "), reg(p.rd), sep(), lbl(p.target));
        break;
      case "jalr":
        push(punct(" "), reg(p.rd), sep(), reg(p.rs1), sep(), imm(rawOps[2] ?? ""));
        break;
      case "addi":
      case "andi":
      case "ori":
      case "xori":
      case "slli":
      case "srli":
      case "srai":
        push(punct(" "), reg(p.rd), sep(), reg(p.rs1), sep(), imm(rawOps[2] ?? ""));
        break;
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
      case "sra":
        push(punct(" "), reg(p.rd), sep(), reg(p.rs1), sep(), reg(p.rs2));
        break;
      case "sw":
      case "sh":
      case "sb":
        push(punct(" "), reg(p.rs2), sep(), mem(rawOps[1] ?? "", p.rs1));
        break;
      case "lw":
      case "lh":
      case "lb":
      case "lhu":
      case "lbu":
        push(punct(" "), reg(p.rd), sep(), mem(rawOps[1] ?? "", p.rs1));
        break;
      case "beq":
      case "bne":
      case "blt":
      case "bge":
      case "bltu":
      case "bgeu":
        push(punct(" "), reg(p.rs1), sep(), reg(p.rs2), sep(), lbl(p.target));
        break;
    }
    return toks;
  }

  const tokens = $derived(parsedToTokens(si, labels));
</script>

{#each tokens as tok}
  {#if tok.kind === "kw"}
    <span class="kw">{tok.text}</span>
  {:else if tok.kind === "reg"}
    <span class="reg">{tok.text}</span>
  {:else if tok.kind === "imm"}
    <span class="imm">{tok.text}</span>
  {:else if tok.kind === "label"}
    {#if tok.addr !== undefined}
      <span class="fn" data-target-addr={tok.addr} data-tooltip="addr: {hx(tok.addr)}">{tok.text}</span>
    {:else}
      <span class="fn">{tok.text}</span>
    {/if}
  {:else}
    {tok.text}
  {/if}
{/each}
