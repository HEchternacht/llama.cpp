import { execFile } from "node:child_process";
import type { ProcessManager } from "./process-manager";
import type { Stats } from "./stats";

/** /slots is polled this often for the realtime rates; it is answered even mid-decode. */
const TICK_MS = 1000;
/** Every Nth tick also writes a metrics_snapshots row (slots busy + VRAM). */
const SNAPSHOT_EVERY = 7;
/** Rates are averaged over this window: prompt counters only advance once per
 * ubatch, so a 1 s delta alone would flicker between 0 and a burst. */
const RATE_WINDOW_MS = 3000;

interface SlotJson {
  id?: number;
  id_task?: number;
  n_ctx?: number;
  is_processing?: boolean;
  n_prompt_tokens?: number;
  n_prompt_tokens_processed?: number;
  n_prompt_tokens_cache?: number;
  next_token?: Array<{ n_decoded?: number }>;
}

interface Sample {
  t: number;
  /** Cumulative per-model counters (summed over slots, task restarts folded in). */
  prompt: number;
  gen: number;
}

export interface LiveRates {
  modelId: string;
  profileId?: string;
  state: "idle" | "prompt" | "generating";
  ppPerSecond: number;
  tgPerSecond: number;
  /** Current (or last) task: tokens in the slot, of which reused from cache / processed / generated. */
  nPromptTokens?: number;
  nCached?: number;
  nProcessed?: number;
  nDecoded?: number;
  nCtx?: number;
}

interface Track {
  samples: Sample[];
  last: Map<number, { task?: number; prompt: number; gen: number }>;
  prompt: number;
  gen: number;
  state: LiveRates["state"];
  phaseStart: Sample | undefined;
  lastBusy?: Pick<LiveRates, "nCached" | "nProcessed" | "nDecoded">;
}

export class MetricsPoller {
  private timer: NodeJS.Timeout | undefined;
  private nvidiaSmiMissing = false;
  private ticks = 0;
  private busy = false;
  private tracks = new Map<string, Track>();
  private rates = new Map<string, LiveRates>();

  constructor(
    private pm: ProcessManager,
    private stats: Stats,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch(() => undefined)
        .finally(() => (this.busy = false));
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Latest realtime rates for every loaded model. */
  live(): LiveRates[] {
    return [...this.rates.values()];
  }

  private async tick(): Promise<void> {
    const snapshot = ++this.ticks % SNAPSHOT_EVERY === 0;
    const gpu = snapshot ? await this.readGpuMem() : undefined;
    const seen = new Set<string>();
    for (const entry of this.pm.list()) {
      if (entry.status.value !== "loaded" || !entry.port) continue;
      seen.add(entry.id);
      let slots: SlotJson[] | undefined;
      try {
        const res = await fetch(`http://127.0.0.1:${entry.port}/slots`);
        if (res.ok) {
          const body = (await res.json()) as unknown;
          if (Array.isArray(body)) slots = body as SlotJson[];
        }
      } catch {
        /* model may be mid-restart; skip this tick */
      }
      if (slots) {
        const r = this.updateRates(entry.id, slots);
        r.modelId = entry.model;
        r.profileId = entry.profile;
        this.rates.set(entry.id, r);
      }
      if (snapshot) {
        this.stats.recordMetricsSnapshot({
          modelId: entry.model,
          profileId: entry.profile,
          slotsBusy: slots?.filter((s) => s.is_processing).length,
          slotsTotal: slots?.length,
          gpuMemUsedMb: gpu?.usedMb,
          gpuMemTotalMb: gpu?.totalMb,
        });
      }
    }
    for (const id of [...this.tracks.keys()]) {
      if (!seen.has(id)) {
        this.tracks.delete(id);
        this.rates.delete(id);
      }
    }
  }

  private updateRates(id: string, slots: SlotJson[]): LiveRates {
    let tr = this.tracks.get(id);
    if (!tr) {
      tr = { samples: [], last: new Map(), prompt: 0, gen: 0, state: "idle", phaseStart: undefined };
      this.tracks.set(id, tr);
    }
    const now = Date.now();
    let processing = false;
    let cur: SlotJson | undefined;
    slots.forEach((s, i) => {
      const sid = s.id ?? i;
      const prompt = s.n_prompt_tokens_processed ?? 0;
      const gen = s.next_token?.[0]?.n_decoded ?? 0;
      const prev = tr!.last.get(sid);
      if (prev) {
        // a new task restarts the slot counters from 0
        const newTask = prev.task !== s.id_task;
        tr!.prompt += newTask ? prompt : Math.max(0, prompt - prev.prompt);
        tr!.gen += newTask ? gen : Math.max(0, gen - prev.gen);
      }
      tr!.last.set(sid, { task: s.id_task, prompt, gen });
      if (s.is_processing) processing = true;
      if (s.is_processing || (!cur && s.id_task !== undefined)) cur = s;
    });

    const prev = tr.samples[tr.samples.length - 1];
    const sample = { t: now, prompt: tr.prompt, gen: tr.gen };
    tr.samples.push(sample);
    while (tr.samples.length > 2 && now - tr.samples[1].t >= RATE_WINDOW_MS) tr.samples.shift();

    // the newest step decides the phase; a prompt batch can take longer than a
    // tick, so a busy slot without new tokens keeps its previous phase
    let state: LiveRates["state"] = "idle";
    if (processing) {
      if (prev && sample.gen > prev.gen) state = "generating";
      else if (prev && sample.prompt > prev.prompt) state = "prompt";
      else state = tr.state !== "idle" ? tr.state : (cur?.next_token?.[0]?.n_decoded ?? 0) > 0 ? "generating" : "prompt";
    }
    if (state !== tr.state) {
      tr.state = state;
      tr.phaseStart = prev;
    }
    // tg: average over the window, never across a phase change; pp: average over
    // the whole prompt phase, since one ubatch can take longer than the window
    const rate = (k: "prompt" | "gen", base: Sample) => {
      const dt = (now - base.t) / 1000;
      return dt > 0 ? (sample[k] - base[k]) / dt : 0;
    };
    const winBase = tr.phaseStart && tr.phaseStart.t > tr.samples[0].t ? tr.phaseStart : tr.samples[0];

    // the slot counters reset when the task is released, so idle reports the last busy values
    if (processing && cur) {
      tr.lastBusy = {
        nCached: cur.n_prompt_tokens_cache,
        nProcessed: cur.n_prompt_tokens_processed,
        nDecoded: cur.next_token?.[0]?.n_decoded,
      };
    }
    return {
      modelId: "",
      state,
      ppPerSecond: state === "prompt" ? rate("prompt", tr.phaseStart ?? tr.samples[0]) : 0,
      tgPerSecond: state === "generating" ? rate("gen", winBase) : 0,
      nPromptTokens: cur?.n_prompt_tokens,
      ...tr.lastBusy,
      nCtx: cur?.n_ctx ?? slots[0]?.n_ctx,
    };
  }

  private readGpuMem(): Promise<{ usedMb: number; totalMb: number } | undefined> {
    if (this.nvidiaSmiMissing) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      execFile("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], (err, stdout) => {
        if (err) {
          this.nvidiaSmiMissing = true;
          resolve(undefined);
          return;
        }
        const [used, total] = stdout.trim().split(",").map((s) => parseFloat(s.trim()));
        if (Number.isFinite(used) && Number.isFinite(total)) resolve({ usedMb: used, totalMb: total });
        else resolve(undefined);
      });
    });
  }
}
