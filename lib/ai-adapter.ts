/**
 * Universal AI Adapter
 *
 * Supports two provider types:
 *  - "openai-compatible" — Works with OpenAI, Gemini, Groq, Together, Mistral, DeepSeek, Ollama, etc.
 *  - "anthropic"         — Claude's Messages API
 *
 * Provider config is read from the AiProvider DB table.
 * Falls back to OPENAI_API_KEY env var when no providewr is specified (backward compat).
 */

import { prisma } from "@/lib/prisma";

// ─── Types ─────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
}

export interface ChatCompletionResult {
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    // Tokens served from the provider's prompt cache (OpenAI: prompt_tokens_details.cached_tokens;
    // Anthropic: cache_read_input_tokens). 0 when caching is off or the prefix is below the
    // provider's minimum cacheable size. Subset of prompt_tokens — already counted there.
    cached_tokens: number;
    // Tokens written to the cache this request (Anthropic only; OpenAI doesn't bill writes separately).
    cache_write_tokens: number;
  };
  model: string;
  provider: string;
}

interface ProviderConfig {
  name: string;
  provider: string; // "openai-compatible" | "anthropic" | "bedrock"
  baseUrl: string;  // For Bedrock: AWS region (e.g. "us-east-1")
  apiKey: string;   // For Bedrock: AWS Access Key ID
  secretKey?: string; // AWS Secret Access Key (Bedrock only)
}

// ─── Provider Resolution ───────────────────────────────────────────

async function resolveProvider(providerId?: string): Promise<ProviderConfig> {
  // 1. Explicit provider ID
  if (providerId) {
    const p = await prisma.aiProvider.findUnique({ where: { id: providerId } });
    if (!p) throw new Error(`AI Provider not found: ${providerId}`);
    return { name: p.name, provider: p.provider, baseUrl: p.baseUrl, apiKey: p.apiKey, secretKey: p.secretKey || undefined };
  }

  // 2. Default provider (isDefault = true)
  const defaultProvider = await prisma.aiProvider.findFirst({ where: { isDefault: true } });
  if (defaultProvider) {
    return {
      name: defaultProvider.name,
      provider: defaultProvider.provider,
      baseUrl: defaultProvider.baseUrl,
      apiKey: defaultProvider.apiKey,
      secretKey: defaultProvider.secretKey || undefined,
    };
  }

  // 3. Fallback: env var (backward compatibility)
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return {
      name: "OpenAI (env)",
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: envKey,
    };
  }

  throw new Error(
    "No AI provider configured. Add one via Settings or set OPENAI_API_KEY env var."
  );
}

// ─── OpenAI-Compatible Request ─────────────────────────────────────

async function openaiCompatible(
  config: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.max_tokens ?? 2000,
        ...(opts.response_format ? { response_format: opts.response_format } : {}),
      }),
      signal: AbortSignal.timeout(60000), // 60s timeout for AI requests
    });
  } catch (error: any) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`AI Request timed out after 60s (${config.name})`);
    }
    throw error;
  }

  if (!response.ok) {
    const errData: any = await response.json().catch(() => ({}));
    const msg = errData.error?.message || `API error (${response.status})`;
    if (response.status === 401) throw new Error(`Invalid API key for ${config.name}.`);
    if (response.status === 429) throw new Error(`Rate limit exceeded for ${config.name}. Wait and retry.`);
    if (response.status === 402) throw new Error(`Insufficient credits for ${config.name}.`);
    throw new Error(`${config.name}: ${msg}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error(`No response from ${config.name}.`);

  const u = result.usage || {};
  return {
    content,
    usage: {
      prompt_tokens: u.prompt_tokens || 0,
      completion_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || 0,
      cached_tokens: u.prompt_tokens_details?.cached_tokens || 0,
      cache_write_tokens: 0,
    },
    model: result.model || model,
    provider: config.name,
  };
}

// ─── Anthropic (Claude) Request ────────────────────────────────────

async function anthropicRequest(
  config: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;

  // Separate system message from the rest
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const body: any = {
    model,
    max_tokens: opts.max_tokens ?? 2000,
    messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
  };
  if (systemMsg) body.system = systemMsg.content;
  if (opts.temperature != null) body.temperature = opts.temperature;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60s timeout for AI requests
    });
  } catch (error: any) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`AI Request timed out after 60s (${config.name})`);
    }
    throw error;
  }

  if (!response.ok) {
    const errData: any = await response.json().catch(() => ({}));
    const msg = errData.error?.message || `API error (${response.status})`;
    if (response.status === 401) throw new Error(`Invalid API key for ${config.name}.`);
    if (response.status === 429) throw new Error(`Rate limit exceeded for ${config.name}. Wait and retry.`);
    throw new Error(`${config.name}: ${msg}`);
  }

  const result = await response.json();
  const content = result.content?.[0]?.text;
  if (!content) throw new Error(`No response from ${config.name}.`);

  // Anthropic reports input_tokens as the UNCACHED prefix only.
  // True prompt size = input_tokens + cache_read + cache_creation. We surface that as prompt_tokens
  // so the caller sees a consistent "total prompt size" across providers.
  const inputTokens = result.usage?.input_tokens || 0;
  const cacheRead = result.usage?.cache_read_input_tokens || 0;
  const cacheWrite = result.usage?.cache_creation_input_tokens || 0;
  const outputTokens = result.usage?.output_tokens || 0;
  return {
    content,
    usage: {
      prompt_tokens: inputTokens + cacheRead + cacheWrite,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + cacheRead + cacheWrite + outputTokens,
      cached_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
    model: result.model || model,
    provider: config.name,
  };
}

// ─── AWS Bedrock (Converse API) Request ────────────────────────────
//
// Auth: AWS Signature V4 via aws4fetch (no SDK needed).
// baseUrl stores the AWS region; apiKey stores the Access Key ID;
// secretKey stores the Secret Access Key.
//
// Model access must be enabled in the AWS console before use.

async function bedrockRequest(
  config: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const { AwsClient } = await import("aws4fetch");

  if (!config.secretKey) {
    throw new Error(`${config.name}: AWS Secret Access Key is required for Bedrock.`);
  }

  const region = config.baseUrl; // stored as the region string, e.g. "us-east-1"
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

  const aws = new AwsClient({
    accessKeyId: config.apiKey,
    secretAccessKey: config.secretKey,
    region,
    service: "bedrock",
  });

  const systemMsg = messages.find((m) => m.role === "system");
  const userMsgs = messages.filter((m) => m.role !== "system");

  const body: any = {
    messages: userMsgs.map((m) => ({
      role: m.role,
      content: [{ text: m.content }],
    })),
    inferenceConfig: {
      maxTokens: opts.max_tokens ?? 2000,
      temperature: opts.temperature ?? 0.1,
    },
  };
  if (systemMsg) body.system = [{ text: systemMsg.content }];

  let response;
  try {
    response = await aws.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // 60s timeout for AI requests
    });
  } catch (error: any) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`AI Request timed out after 60s (${config.name})`);
    }
    throw error;
  }

  if (!response.ok) {
    const errData: any = await response.json().catch(() => ({}));
    const msg = errData.message || errData.Message || `API error (${response.status})`;
    if (response.status === 403) throw new Error(`${config.name}: Access denied — check IAM permissions and that model access is enabled in the AWS console.`);
    if (response.status === 404) throw new Error(`${config.name}: Model "${model}" not found in region "${region}". Ensure model access is enabled in the AWS console.`);
    if (response.status === 429) throw new Error(`${config.name}: Rate limit exceeded.`);
    throw new Error(`${config.name}: ${msg}`);
  }

  const result = await response.json();
  const content = result.output?.message?.content?.[0]?.text;
  if (!content) throw new Error(`No response content from ${config.name}.`);

  // Bedrock Converse reports prompt-cache usage on supported models (Claude 3.5 Sonnet v2+).
  const bedrockUsage = result.usage || {};
  return {
    content,
    usage: {
      prompt_tokens: bedrockUsage.inputTokens || 0,
      completion_tokens: bedrockUsage.outputTokens || 0,
      total_tokens: bedrockUsage.totalTokens || 0,
      cached_tokens: bedrockUsage.cacheReadInputTokens || 0,
      cache_write_tokens: bedrockUsage.cacheWriteInputTokens || 0,
    },
    model,
    provider: config.name,
  };
}

// Bedrock streaming — Converse Stream API uses a binary event stream protocol
// that requires the AWS SDK to decode correctly. We fall back to the regular
// Converse API and yield the full response as a single chunk instead.
async function* bedrockStream(
  config: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): AsyncGenerator<string> {
  const result = await bedrockRequest(config, model, messages, opts);
  yield result.content;
}

// ─── OpenAI-Compatible Streaming ──────────────────────────────────

async function* openaiCompatibleStream(
  config: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): AsyncGenerator<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 1000,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errData: any = await response.json().catch(() => ({}));
    const msg = errData.error?.message || `API error (${response.status})`;
    throw new Error(`${config.name}: ${msg}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data);
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // malformed SSE chunk — skip
      }
    }
  }
}

// ─── Anthropic Streaming ───────────────────────────────────────────

async function* anthropicStream(
  config: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): AsyncGenerator<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/messages`;

  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const body: any = {
    model,
    max_tokens: opts.max_tokens ?? 1000,
    stream: true,
    messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
  };
  if (systemMsg) body.system = systemMsg.content;
  if (opts.temperature != null) body.temperature = opts.temperature;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errData: any = await response.json().catch(() => ({}));
    const msg = errData.error?.message || `API error (${response.status})`;
    throw new Error(`${config.name}: ${msg}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      try {
        const chunk = JSON.parse(data);
        if (chunk.type === "content_block_delta" && chunk.delta?.text) {
          yield chunk.delta.text;
        }
      } catch {
        // skip
      }
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Streaming chat completion — yields text chunks as they arrive.
 * Used exclusively by the candidate chat SSE endpoint.
 * Never writes chunks to DB — caller accumulates and saves the full response.
 */
export async function* streamChatCompletion(
  messages: ChatMessage[],
  model: string,
  opts: ChatCompletionOptions = {},
  providerId?: string
): AsyncGenerator<string> {
  const config = await resolveProvider(providerId);

  switch (config.provider) {
    case "anthropic":
      yield* anthropicStream(config, model, messages, opts);
      break;
    case "bedrock":
      yield* bedrockStream(config, model, messages, opts);
      break;
    case "openai-compatible":
    default:
      yield* openaiCompatibleStream(config, model, messages, opts);
  }
}

export async function chatCompletion(
  messages: ChatMessage[],
  model: string,
  opts: ChatCompletionOptions = {},
  providerId?: string
): Promise<ChatCompletionResult> {
  const config = await resolveProvider(providerId);

  console.log(`[AI Adapter] Using provider "${config.name}" (${config.provider}), model: ${model}`);

  switch (config.provider) {
    case "anthropic":
      return anthropicRequest(config, model, messages, opts);
    case "bedrock":
      return bedrockRequest(config, model, messages, opts);
    case "openai-compatible":
    default:
      return openaiCompatible(config, model, messages, opts);
  }
}
