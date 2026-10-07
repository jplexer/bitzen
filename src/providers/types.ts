export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type Message =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls: ToolCall[];
      // Opaque round-trip data belongs to the adapter, not the agent loop.
      providerState?: Record<string, unknown>;
    }
  | { role: "tool"; callId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  billing?: "chatgpt-plan";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export interface CompletionRequest {
  model: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  sessionId: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  onProgress?: (update: { type: "text" | "reasoning"; text: string }) => Promise<void>;
}

export interface Completion {
  id: string;
  message: Extract<Message, { role: "assistant" }>;
  usage: Usage;
  finishReason: string;
}

export interface Provider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<Completion>;
  listModels?(signal: AbortSignal): Promise<ModelInfo[]>;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface ModelSelection {
  provider: string;
  model: string;
}
