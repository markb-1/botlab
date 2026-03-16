/**
 * Claude API Client
 *
 * Zero-dependency client for the Anthropic Messages API.
 * Called from main process only — API key never leaves main.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8192;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeApiResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface ClaudeApiError {
  type: string;
  error: { type: string; message: string };
}

/**
 * Call the Claude Messages API.
 * Returns the text content of the assistant's response.
 */
export async function callClaude(opts: {
  apiKey: string;
  system: string;
  messages: ClaudeMessage[];
  maxTokens?: number;
}): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: opts.system,
      messages: opts.messages,
    }),
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as ClaudeApiError;
      if (errorBody.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // Use status code as error
    }
    throw new Error(`Claude API error: ${errorMessage}`);
  }

  const data = (await response.json()) as ClaudeApiResponse;

  const textBlock = data.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error('Claude API returned no text content');
  }

  return textBlock.text;
}

/**
 * Test the Claude API connection with a minimal request.
 */
export async function testClaudeConnection(apiKey: string): Promise<void> {
  await callClaude({
    apiKey,
    system: 'Respond with OK.',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 10,
  });
}

/**
 * Extract code from a markdown code fence in the response.
 * Looks for ```typescript ... ``` or ```ts ... ``` or plain ``` ... ```.
 * If no fence found, returns the full text (assumes it's raw code).
 */
export function extractCodeFromResponse(text: string): string {
  // Try typescript/ts fence first
  const tsMatch = text.match(/```(?:typescript|ts)\s*\n([\s\S]*?)```/);
  if (tsMatch) return tsMatch[1].trim();

  // Try any code fence
  const anyMatch = text.match(/```\s*\n([\s\S]*?)```/);
  if (anyMatch) return anyMatch[1].trim();

  // No fence — return as-is
  return text.trim();
}
