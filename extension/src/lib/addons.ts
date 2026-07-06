// Add-on catalog. Single source of truth lives in
// templates/add-ons.json at the playbook repo root, which is read by
// both this extension (system-prompt block + Options UI) and any
// future user-facing rendering. Per VISION.md, add-ons are toggled
// ONLY by the ProDocStore agent in chat - never hand-edited.
//
// We import the JSON at build time so the catalog ships inside the
// extension bundle. Updating the catalog is a coordinated change:
// edit templates/add-ons.json, rebuild the extension, ship.

import catalogJson from "../../../templates/add-ons.json";

export interface AddOn {
  /** Matches the key in features.json (e.g. "search", "nav"). */
  key: string;
  /** Human-readable name shown in UI. */
  name: string;
  /** One- or two-sentence description for the UI + system prompt. */
  description: string;
  /** What the add-on emits or injects at deploy time. */
  generates: string;
  /** Example natural-language prompts the user can ask the agent. */
  askPrompts: string[];
}

// The JSON has a leading "_comment" field for human readers; strip via
// destructuring to keep the public type clean.
const raw = catalogJson as { addOns: AddOn[] };

export const ADDONS: readonly AddOn[] = Object.freeze(raw.addOns);

/** Look up an add-on by features.json key. Returns undefined when unknown. */
export function getAddOn(key: string): AddOn | undefined {
  return ADDONS.find((a) => a.key === key);
}

/**
 * Format the catalog as a system-prompt prefix block for the chat agent.
 * Annotated with each add-on's current on/off state from the site's
 * features.json so the model can answer "what's enabled?" and propose
 * the right toggle without guessing.
 *
 * Per VISION: this block does NOT contain copy-paste config snippets.
 * It describes each add-on as something the user asks the agent for.
 */
export function formatAddonsBlock(
  enabled: Record<string, boolean | undefined> | null | undefined,
): string {
  if (ADDONS.length === 0) return "";
  const lines: string[] = [
    "Available add-ons (toggle by asking the agent - never hand-edit features.json):",
  ];
  for (const a of ADDONS) {
    const on = enabled?.[a.key] === true ? "ON" : "off";
    lines.push(`- ${a.key} [${on}]: ${a.description}`);
  }
  return lines.join("\n") + "\n";
}
