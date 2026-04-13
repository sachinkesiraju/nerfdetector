export type StatusTier = "fine" | "struggling" | "nerfed";

export interface ModelStatus {
  modelId: string;
  displayName: string;
  provider: string;
  category: string;
  tier: StatusTier;
  sentimentScore: number | null;
  healthScore: number | null;
  voteCount: number;
  sessionCount: number;
  sparkline: number[];
}

/**
 * Normalize a model string into a consistent ID format.
 * No hardcoded model names — generic rules only.
 * The server decides if the resulting ID is valid.
 */
export function normalizeModelId(raw: string): string {
  let id = raw.toLowerCase().trim();

  // Dots to dashes first (before date stripping so 2026.03.05 becomes 2026-03-05)
  id = id.replace(/\./g, "-");

  // Strip provider prefix (meta-llama/llama-4 → llama-4)
  if (id.includes("/")) {
    id = id.split("/").pop()!;
  }

  // Strip date suffixes: -20250501, -2026-03-05
  id = id.replace(/-\d{4}-?\d{2}-?\d{2}$/, "");

  // Strip ephemeral suffixes
  id = id.replace(/-latest$/, "");
  id = id.replace(/-preview(-.+)?$/, "");
  id = id.replace(/-(exp|experimental)$/, "");

  // Collapse repeated dashes
  id = id.replace(/-+/g, "-").replace(/-$/g, "");

  return id;
}
