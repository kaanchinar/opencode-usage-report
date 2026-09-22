import type { ProviderAdapter } from "../types.js";
import { kimiCnAdapter, kimiGlobalAdapter } from "./kimi.js";
import { opencodeGoAdapter } from "./opencode-go.js";
export const adapters: ProviderAdapter[] = [kimiGlobalAdapter, kimiCnAdapter, opencodeGoAdapter];
export function getAdapter(id: string): ProviderAdapter | undefined { return adapters.find(a => a.id === id); }
