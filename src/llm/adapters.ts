export type ProviderId = 'github-copilot-cli' | 'openai' | 'azure-openai' | 'anthropic';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
}

export interface ChatResponse {
  providerId: ProviderId;
  content: string;
}

export interface Transport {
  send(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<unknown>;
}

export interface LlmBackendAdapter {
  readonly providerId: ProviderId;
  chat(request: ChatRequest, options?: { credential: string; model: string }): Promise<ChatResponse>;
}

interface OpenAiStyleResponse {
  choices?: { message?: { content?: string } }[];
}

interface CopilotCliResponse {
  message?: { content?: string };
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
}

/** @id CODE-AIRA2-LLM-001
 * @implements REQ-LLMBACKEND-001
 * @design DES-AIRA2-004
 */
export class GithubCopilotCliAdapter implements LlmBackendAdapter {
  readonly providerId: ProviderId = 'github-copilot-cli';
  constructor(
    private readonly transport: Transport,
    private readonly endpoint: string,
  ) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const raw = (await this.transport.send(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: request.messages, model: request.model }),
    })) as CopilotCliResponse;
    return { providerId: this.providerId, content: raw.message?.content ?? '' };
  }
}

/** @id CODE-AIRA2-LLM-002
 * @implements REQ-LLMBACKEND-001
 * @design DES-AIRA2-004
 */
export class OpenAiAdapter implements LlmBackendAdapter {
  readonly providerId: ProviderId = 'openai';
  constructor(
    private readonly transport: Transport,
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}
  async chat(request: ChatRequest, options?: { credential: string; model: string }): Promise<ChatResponse> {
    const raw = (await this.transport.send(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options?.credential ?? this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: options?.model ?? request.model ?? 'gpt-4o', messages: request.messages }),
    })) as OpenAiStyleResponse;
    return { providerId: this.providerId, content: raw.choices?.[0]?.message?.content ?? '' };
  }
}

/** @id CODE-AIRA2-LLM-003
 * @implements REQ-LLMBACKEND-001
 * @design DES-AIRA2-004
 */
export class AzureOpenAiAdapter implements LlmBackendAdapter {
  readonly providerId: ProviderId = 'azure-openai';
  constructor(
    private readonly transport: Transport,
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}
  async chat(request: ChatRequest, options?: { credential: string; model: string }): Promise<ChatResponse> {
    const raw = (await this.transport.send(this.endpoint, {
      method: 'POST',
      headers: { 'api-key': options?.credential ?? this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: options?.model ?? request.model, messages: request.messages }),
    })) as OpenAiStyleResponse;
    return { providerId: this.providerId, content: raw.choices?.[0]?.message?.content ?? '' };
  }
}

/** @id CODE-AIRA2-LLM-004
 * @implements REQ-LLMBACKEND-001
 * @design DES-AIRA2-004
 */
export class AnthropicAdapter implements LlmBackendAdapter {
  readonly providerId: ProviderId = 'anthropic';
  constructor(
    private readonly transport: Transport,
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}
  async chat(request: ChatRequest, options?: { credential: string; model: string }): Promise<ChatResponse> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const raw = (await this.transport.send(this.endpoint, {
      method: 'POST',
      headers: { 'x-api-key': options?.credential ?? this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? request.model ?? 'claude-3-5-sonnet',
        system,
        messages: nonSystemMessages,
      }),
    })) as AnthropicResponse;
    const text = raw.content?.find((block) => block.type === 'text')?.text ?? '';
    return { providerId: this.providerId, content: text };
  }
}
