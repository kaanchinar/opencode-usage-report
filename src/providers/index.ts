import type { ProviderAdapter } from "../types";
import { kimiCnAdapter, kimiGlobalAdapter } from "./kimi";
import { opencodeGoAdapter } from "./opencode-go";
import { copilotAdapter } from "./copilot";
import { chatgptAdapter } from "./chatgpt";
export const adapters: ProviderAdapter[] = [
  kimiGlobalAdapter,
  kimiCnAdapter,
  opencodeGoAdapter,
  copilotAdapter,
  chatgptAdapter,
];
export function getAdapter(id: string): ProviderAdapter | undefined {
  return adapters.find((a) => a.id === id);
}
