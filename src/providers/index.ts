import type { ProviderAdapter } from "../types.js";
import { kimiAdapter } from "./kimi.js";
import { opencodeGoAdapter } from "./opencode-go.js";
export const adapters: ProviderAdapter[] = [kimiAdapter, opencodeGoAdapter];
export function getAdapter(id: string): ProviderAdapter | undefined { return adapters.find(a => a.id === id); }
