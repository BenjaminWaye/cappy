import { estimateTokens, CHARS_PER_TOKEN } from '../pacing/pricing';
import type { Message } from '../types';

const TRIGGER_TOKENS = 32_000;
const TARGET_TOKENS  = 30_000;

export interface CompressionResult {
  messages:       Message[];
  originalTokens: number;
  finalTokens:    number;
  applied:        boolean;
}

function messageTokens(m: Message): number {
  return 4 + estimateTokens(m.content); // 4 tokens overhead per role
}

export function totalInputTokens(messages: Message[]): number {
  return messages.reduce((s, m) => s + messageTokens(m), 0);
}

function toolCallIds(m: Message): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(m.tool_calls)) return ids;
  for (const call of m.tool_calls) {
    if (call && typeof call === 'object' && 'id' in call) {
      const id = (call as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

// Build the set of message objects that must never be trimmed.
function protectedSet(messages: Message[]): Set<Message> {
  const s = new Set<Message>();
  let lastUser: Message | null = null;
  let lastAssistant: Message | null = null;
  let lastTool: Message | null = null;
  messages.forEach((m, i) => {
    if (m.role === 'system') s.add(m);
    if (m.role === 'user') lastUser = m;
    if (m.role === 'assistant') lastAssistant = m;
    if (m.role === 'tool') lastTool = m;

    const pendingToolCalls = toolCallIds(m);
    if (m.role !== 'assistant' || pendingToolCalls.size === 0) return;

    s.add(m);
    for (let j = i + 1; j < messages.length && pendingToolCalls.size > 0; j++) {
      const candidate = messages[j]!;
      if (candidate.role !== 'tool') break;
      if (candidate.tool_call_id && pendingToolCalls.has(candidate.tool_call_id)) {
        s.add(candidate);
        pendingToolCalls.delete(candidate.tool_call_id);
      }
    }
  });
  if (lastUser) s.add(lastUser);
  if (lastAssistant) s.add(lastAssistant);
  if (lastTool) s.add(lastTool);
  return s;
}

// Remove oldest matching messages (front-to-back) until target is reached.
function trimOldest(
  messages: Message[],
  protect: Set<Message>,
  target: number,
  match: (m: Message) => boolean,
): Message[] {
  const out = [...messages];
  for (let i = 0; i < out.length && totalInputTokens(out) > target; i++) {
    if (!protect.has(out[i]!) && match(out[i]!)) {
      out.splice(i, 1);
      i--;
    }
  }
  return out;
}

// Collapse consecutive identical assistant-content prefixes (repeated file reads).
function deduplicateAssistant(messages: Message[], protect: Set<Message>): Message[] {
  const seen = new Set<string>();
  return messages.filter((m, i) => {
    if (protect.has(m) || m.role !== 'assistant' || !m.content) return true;
    const key = m.content.slice(0, 150);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Hard-cap individual messages that are huge (terminal logs, etc.)
// Tool messages are excluded: truncating file-read results causes agents to re-read
// the same file in a loop, since they never get the section they actually need.
function capLargeMessages(messages: Message[], protect: Set<Message>, maxTokens: number): Message[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  return messages.map((m) => {
    if (protect.has(m) || m.role === 'tool' || !m.content || m.content.length <= maxChars) return m;
    return { ...m, content: m.content.slice(0, maxChars) + '\n[…truncated for context efficiency]' };
  });
}

export function compress(messages: Message[]): CompressionResult {
  const originalTokens = totalInputTokens(messages);
  if (originalTokens <= TRIGGER_TOKENS) {
    return { messages, originalTokens, finalTokens: originalTokens, applied: false };
  }

  const protect = protectedSet(messages);
  let out = [...messages];

  // Pass 1 — oldest tool outputs
  out = trimOldest(out, protect, TARGET_TOKENS, m => m.role === 'tool');
  if (totalInputTokens(out) <= TARGET_TOKENS) return done(out, originalTokens);

  // Pass 2 — duplicate assistant content (repeated file reads)
  out = deduplicateAssistant(out, protect);
  if (totalInputTokens(out) <= TARGET_TOKENS) return done(out, originalTokens);

  // Pass 3 — cap very large messages (logs / terminal output)
  out = capLargeMessages(out, protect, 2_000);
  if (totalInputTokens(out) <= TARGET_TOKENS) return done(out, originalTokens);

  // Pass 4 — oldest assistant messages
  out = trimOldest(out, protect, TARGET_TOKENS, m => m.role === 'assistant');
  if (totalInputTokens(out) <= TARGET_TOKENS) return done(out, originalTokens);

  // Pass 5 — oldest user messages
  out = trimOldest(out, protect, TARGET_TOKENS, m => m.role === 'user');

  return done(out, originalTokens);
}

function done(messages: Message[], originalTokens: number): CompressionResult {
  return { messages, originalTokens, finalTokens: totalInputTokens(messages), applied: true };
}
