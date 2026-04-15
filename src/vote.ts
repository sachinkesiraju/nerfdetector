import { getRecentEvents, type EventRow } from "./store/db.js";
import { getDeviceId } from "./device.js";
import { normalizeModelId } from "./models.js";

export function getApiBase(): string {
  const envApi = process.env.NERFDETECTOR_API;
  if (!envApi) return "https://nerfdetector.com";
  if (envApi.startsWith("https://") || envApi.startsWith("http://localhost") || envApi.startsWith("http://127.0.0.1")) return envApi;
  throw new Error(`NERFDETECTOR_API must use https:// (got: ${envApi})`);
}

interface Attribution {
  [modelId: string]: number;
}

interface SessionMeta {
  callCount: number;
  errorCount: number;
  toolFailCount?: number;
  retriesTotal?: number;
  avgRetriesPerAction?: number;
  medianResponseSize?: number;
}

export interface VoteContext {
  attribution: Attribution;
  sessionMeta: SessionMeta;
  hasEvents: boolean;
}

export function computeAttribution(events?: EventRow[]): VoteContext {
  const recentEvents = events ?? getRecentEvents();

  if (recentEvents.length === 0) {
    return {
      attribution: {},
      sessionMeta: { callCount: 0, errorCount: 0 },
      hasEvents: false,
    };
  }

  const modelDuration = new Map<string, number>();
  let totalDuration = 0;
  let errorCount = 0;
  let toolFailCount = 0;

  // Retry detection: count consecutive same-tool calls
  let retriesTotal = 0;
  let lastToolName: string | null = null;
  let currentStreak = 0;

  // Response size tracking
  const responseSizes: number[] = [];

  // Sort by timestamp ascending for sequence analysis
  const sorted = [...recentEvents].sort((a, b) => a.ts - b.ts);

  for (const ev of sorted) {
    const normalizedModel = normalizeModelId(ev.model);
    const dur = ev.duration_ms ?? 1000;
    modelDuration.set(normalizedModel, (modelDuration.get(normalizedModel) || 0) + dur);
    totalDuration += dur;

    if (ev.status === "error") errorCount++;
    if (ev.tool_ok === 0) toolFailCount++;

    // Retry detection
    if (ev.event_type === "tool_use" && ev.tool_name) {
      if (ev.tool_name === lastToolName) {
        currentStreak++;
        if (currentStreak >= 2) retriesTotal++; // 3rd+ consecutive = retry
      } else {
        currentStreak = 1;
      }
      lastToolName = ev.tool_name;
    }

    // Response size
    if (ev.response_size != null && ev.response_size > 0) {
      responseSizes.push(ev.response_size);
    }
  }

  const attribution: Attribution = {};
  for (const [model, dur] of modelDuration) {
    if (model === "unknown") continue;
    const weight = dur / totalDuration;
    if (weight >= 0.02) attribution[model] = Math.round(weight * 100) / 100;
  }

  const sum = Object.values(attribution).reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.01) {
    for (const k of Object.keys(attribution)) {
      attribution[k] = Math.round((attribution[k] / sum) * 100) / 100;
    }
  }

  // Median response size
  let medianResponseSize: number | undefined;
  if (responseSizes.length > 0) {
    responseSizes.sort((a, b) => a - b);
    const mid = Math.floor(responseSizes.length / 2);
    medianResponseSize = responseSizes.length % 2 === 0
      ? Math.round((responseSizes[mid - 1] + responseSizes[mid]) / 2)
      : responseSizes[mid];
  }

  const toolUseCount = sorted.filter((e) => e.event_type === "tool_use").length;

  return {
    attribution,
    sessionMeta: {
      callCount: recentEvents.length,
      errorCount,
      toolFailCount: toolFailCount || undefined,
      retriesTotal: retriesTotal || undefined,
      avgRetriesPerAction: toolUseCount > 0 && retriesTotal > 0
        ? Math.round((retriesTotal / toolUseCount) * 100) / 100
        : undefined,
      medianResponseSize,
    },
    hasEvents: true,
  };
}

export async function submitVote(direction: 1 | 0 | -1, context?: VoteContext): Promise<{ ok: boolean; error?: string }> {
  const ctx = context ?? computeAttribution();

  if (!ctx.hasEvents || Object.keys(ctx.attribution).length === 0) {
    return { ok: false, error: "no AI activity in the last 15 min" };
  }

  const deviceId = getDeviceId();

  try {
    const res = await fetch(`${getApiBase()}/api/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction,
        attribution: ctx.attribution,
        sessionMeta: ctx.sessionMeta,
        source: "agent",
        deviceId,
      }),
    });

    if (res.status === 429) {
      return { ok: false, error: "already voted recently, try again in a few minutes" };
    }

    if (!res.ok) {
      return { ok: false, error: `server error (${res.status})` };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface GlobalStatusResponse {
  models: import("./models.js").ModelStatus[];
  updatedAt: string;
}

export async function fetchGlobalStatus(): Promise<GlobalStatusResponse | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
