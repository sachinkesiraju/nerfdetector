import { getRecentEvents, getBaseline, getPref, setPref, type EventRow } from "./store/db.js";
import { scoreSession, type Fingerprint } from "./analysis/score.js";
import { normalizeModelId } from "./models.js";

export const CLIENT_VERSION = "0.2.0";
const PREF_CONSENT = "fingerprint_consent";  // "send" | "skip"

/**
 * Build a fingerprint for the most recent session window.
 * Pulls baselines for the primary attributed model from the DB.
 */
export function buildFingerprint(events?: EventRow[]): Fingerprint {
  const evs = events ?? getRecentEvents();

  // Pick primary model from event volume
  let primary: string | null = null;
  if (evs.length > 0) {
    const byModel = new Map<string, number>();
    for (const e of evs) {
      if (e.event_type !== "tool_use") continue;
      const m = normalizeModelId(e.model);
      if (m === "unknown") continue;
      byModel.set(m, (byModel.get(m) ?? 0) + 1);
    }
    let best = 0;
    for (const [m, n] of byModel) if (n > best) { best = n; primary = m; }
  }

  const successRate = primary ? getBaseline(primary, "success_rate")?.avg_7d ?? null : null;
  const retryRate = primary ? getBaseline(primary, "retry_rate")?.avg_7d ?? null : null;
  const latencyS = primary ? getBaseline(primary, "latency_p50_s")?.avg_7d ?? null : null;

  return scoreSession({
    events: evs,
    baselines: { successRate, retryRate, latencyS },
    clientVersion: CLIENT_VERSION,
  });
}

// ── Consent ───────────────────────────────────────────

export type FingerprintConsent = "send" | "skip" | "ask";

export function fingerprintConsent(): FingerprintConsent {
  if (process.env.NERFDETECTOR_NO_FINGERPRINT === "1") return "skip";
  const pref = getPref(PREF_CONSENT);
  if (pref === "send" || pref === "skip") return pref;
  return "ask";
}

export function recordFingerprintConsent(choice: "send" | "skip") {
  setPref(PREF_CONSENT, choice);
}
