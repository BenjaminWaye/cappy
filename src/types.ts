export interface Config {
  provider: string;                    // adapter id, e.g. 'deepseek' | 'openai' | 'groq'
  api_key: string;                     // upstream provider API key
  monthly_budget_microdollars: number;
  window_size_hours: number;
  default_model: string;
  session_input_tokens: number;
  session_output_tokens: number;
  local_api_key: string;
  install_epoch: number;
}

export interface WindowRow {
  id: number;
  window_index: number;
  start_time: number;
  end_time: number;
  allocation_microdollars: number;
  used_microdollars: number;
  rollover_before: number;
  rollover_after: number;
}

export interface RequestRow {
  id?: number;
  timestamp: number;
  provider: string;
  model: string;
  estimated_cost: number;
  actual_cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  compression_applied: number;
  compression_ratio: number;
  window_id: number;
  balance_before: number;
  balance_after: number;
  catastrophic_cap_triggered: number;
}

export interface Device {
  id?: number;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: unknown[];
  name?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}
