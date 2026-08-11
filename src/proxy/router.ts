import type { Message } from '../types';

// Whalecap hardcoded a DeepSeek-specific pro/flash heuristic here. Cappy makes
// that pattern available as an opt-in hook instead of core behavior — most
// providers don't have a matched pair of "cheap/fast" and "expensive/smart"
// models to route between, and guessing wrong silently changes what a client
// is billed for. Off by default: a request uses whatever model the client
// asked for (falling back to the adapter's default), unmodified.
export type ModelRouter = (messages: Message[], requestedModel: string) => string;

export const passthroughRouter: ModelRouter = (_messages, requestedModel) => requestedModel;
