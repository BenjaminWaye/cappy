import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compress, totalInputTokens } from '../proxy/compression';
import type { Message } from '../types';

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

function assistantToolCall(id: string, content = ''): Message {
  return {
    role: 'assistant',
    content,
    tool_calls: [{ id, type: 'function', function: { name: 'view', arguments: '{}' } }],
  };
}

function toolResult(id: string, content: string): Message {
  return { role: 'tool', tool_call_id: id, content };
}

function repeat(m: Message, n: number): Message[] {
  return Array.from({ length: n }, () => ({ ...m }));
}

// 4 chars per token → 128,000 chars ≈ 32,000 tokens (the trigger threshold)
const BIG = 'x'.repeat(128_004); // just over 32k tokens

// ── No compression needed ─────────────────────────────────────────────────────

test('compress: no-op when input is under 32k tokens', () => {
  const messages = [msg('system', 'You are helpful'), msg('user', 'Hello')];
  const result = compress(messages);
  assert.equal(result.applied, false);
  assert.equal(result.messages.length, 2);
  assert.equal(result.finalTokens, result.originalTokens);
});

// ── Trigger threshold ─────────────────────────────────────────────────────────

test('compress: triggers at > 32k tokens', () => {
  // BIG is the OLD user turn — can be trimmed. A small latest message sits on top.
  const messages = [
    msg('system', 'sys'),
    msg('user', BIG),           // old large user message — trimmable
    msg('assistant', 'ok'),     // old assistant — trimmable
    msg('user', 'latest q'),    // latest user — protected
    msg('assistant', 'latest'), // latest assistant — protected
  ];
  const result = compress(messages);
  assert.equal(result.applied, true);
  assert.ok(result.finalTokens <= 30_000, `expected ≤30k, got ${result.finalTokens}`);
});

// ── Protected messages ────────────────────────────────────────────────────────

test('compress: never removes system prompt', () => {
  const systemContent = 'IMPORTANT SYSTEM PROMPT';
  const messages = [
    msg('system', systemContent),
    ...repeat(msg('user', 'old user message ' + 'x'.repeat(8_000)), 8),
    msg('user', 'latest question'),
    msg('assistant', 'latest response'),
  ];
  const result = compress(messages);
  const hasSystem = result.messages.some(m => m.role === 'system' && m.content === systemContent);
  assert.ok(hasSystem, 'system prompt must survive compression');
});

test('compress: never removes latest user message', () => {
  const latestContent = 'LATEST_USER_MESSAGE';
  const messages = [
    msg('system', 'sys'),
    ...repeat(msg('user', 'old ' + 'x'.repeat(8_000)), 6),
    msg('user', latestContent),
  ];
  const result = compress(messages);
  const hasLatest = result.messages.some(m => m.role === 'user' && m.content === latestContent);
  assert.ok(hasLatest, 'latest user message must survive compression');
});

test('compress: never removes latest assistant message', () => {
  const latestContent = 'LATEST_ASSISTANT_RESPONSE';
  const messages = [
    msg('system', 'sys'),
    ...repeat(msg('assistant', 'old response ' + 'x'.repeat(8_000)), 5),
    msg('user', 'latest q'),
    msg('assistant', latestContent),
  ];
  const result = compress(messages);
  const hasLatest = result.messages.some(m => m.role === 'assistant' && m.content === latestContent);
  assert.ok(hasLatest, 'latest assistant message must survive compression');
});

// ── Trim order ────────────────────────────────────────────────────────────────

test('compress: removes tool outputs before user messages', () => {
  // 44k chars = 11k tokens each; 3 × 11k = 33k > trigger
  const toolMsg = msg('tool', 'x'.repeat(44_000));
  const messages = [
    msg('system', 'sys'),
    toolMsg,
    toolMsg,
    toolMsg,
    msg('user', 'help'),
    msg('assistant', 'sure'),
  ];
  const before = totalInputTokens(messages);
  assert.ok(before > 32_000, `setup: need >32k tokens, got ${before}`);

  const result = compress(messages);
  assert.equal(result.applied, true);
  // User messages should still be present (tool outputs removed first)
  const hasUser = result.messages.some(m => m.role === 'user' && m.content === 'help');
  assert.ok(hasUser, 'user message should survive when tool outputs are trimmed first');
});

test('compress: keeps assistant tool calls with their tool responses', () => {
  const toolCall = assistantToolCall('call_1');
  const tool = toolResult('call_1', 'important tool response');
  const messages = [
    msg('system', 'sys'),
    ...repeat(msg('user', 'old ' + 'x'.repeat(8_000)), 6),
    toolCall,
    tool,
    msg('user', 'continue'),
  ];

  const result = compress(messages);
  const assistantIndex = result.messages.indexOf(toolCall);
  assert.notEqual(assistantIndex, -1, 'assistant tool call must survive compression');
  assert.equal(result.messages[assistantIndex + 1], tool, 'tool response must immediately follow assistant tool call');
});

test('compress: does not leave orphan tool messages when trimming assistant messages', () => {
  const toolCall = assistantToolCall('call_2', 'x'.repeat(40_000));
  const tool = toolResult('call_2', 'tool response');
  const messages = [
    msg('system', 'sys'),
    toolCall,
    tool,
    ...repeat(msg('assistant', 'old assistant ' + 'x'.repeat(8_000)), 8),
    msg('user', 'latest question'),
  ];

  const result = compress(messages);
  const assistantIndex = result.messages.indexOf(toolCall);
  assert.notEqual(assistantIndex, -1, 'assistant tool call must survive assistant trimming');
  assert.equal(result.messages[assistantIndex + 1], tool, 'tool response must stay attached');
});

// ── Duplicate assistant content ───────────────────────────────────────────────

test('compress: deduplicates repeated assistant content', () => {
  // Each duplicate is ~10k tokens so 6 × 10k = 60k > trigger
  const duplicateContent = 'x'.repeat(40_000); // 10k tokens
  const duplicate = msg('assistant', duplicateContent);
  const messages = [
    msg('system', 'sys'),
    duplicate,
    duplicate,
    duplicate,
    duplicate,
    duplicate,
    duplicate,
    msg('user', 'new question'),
    msg('assistant', 'different response'),
  ];
  const result = compress(messages);
  const assistantMessages = result.messages.filter(m => m.role === 'assistant');
  // Dedup pass collapses the 6 identical ones to 1; latest ('different response') is also protected
  assert.ok(assistantMessages.length < 5, `expected deduplication, got ${assistantMessages.length} assistant msgs`);
});

// ── Token count accuracy ──────────────────────────────────────────────────────

test('totalInputTokens: counts 4 chars per token plus 4 overhead per message', () => {
  const messages = [msg('user', 'abcd')]; // 4 chars = 1 token + 4 overhead = 5
  assert.equal(totalInputTokens(messages), 5);
});

test('totalInputTokens: empty content', () => {
  const messages = [msg('user', '')];
  assert.equal(totalInputTokens(messages), 4); // just the role overhead
});
