import { describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  AzureOpenAiAdapter,
  GithubCopilotCliAdapter,
  OpenAiAdapter,
  type ChatRequest,
  type Transport,
} from './adapters.js';

const REQUEST: ChatRequest = {
  messages: [
    { role: 'system', content: 'You are a lab assistant.' },
    { role: 'user', content: 'Summarize this experiment.' },
  ],
};

function fakeTransport(response: unknown): Transport {
  return { send: async () => response };
}

/** @id TEST-AIRA2-LLM-001
 * @verifies REQ-LLMBACKEND-001
 */
describe('LLM backend adapters', () => {
  it('TEST-AIRA2-LLM-001 returns a successful normalized response from an equivalent chat request for each of the four providers', async () => {
    const copilot = new GithubCopilotCliAdapter(
      fakeTransport({ message: { content: 'Copilot CLI response' } }),
      'https://copilot.example/chat',
    );
    const openai = new OpenAiAdapter(
      fakeTransport({ choices: [{ message: { content: 'OpenAI response' } }] }),
      'https://api.openai.com/v1/chat/completions',
      'sk-test',
    );
    const azure = new AzureOpenAiAdapter(
      fakeTransport({ choices: [{ message: { content: 'Azure OpenAI response' } }] }),
      'https://myres.openai.azure.com/openai/deployments/gpt/chat/completions',
      'azure-key',
    );
    const anthropic = new AnthropicAdapter(
      fakeTransport({ content: [{ type: 'text', text: 'Anthropic response' }] }),
      'https://api.anthropic.com/v1/messages',
      'anthropic-key',
    );

    const copilotResult = await copilot.chat(REQUEST);
    const openaiResult = await openai.chat(REQUEST);
    const azureResult = await azure.chat(REQUEST);
    const anthropicResult = await anthropic.chat(REQUEST);

    expect(copilotResult).toEqual({ providerId: 'github-copilot-cli', content: 'Copilot CLI response' });
    expect(openaiResult).toEqual({ providerId: 'openai', content: 'OpenAI response' });
    expect(azureResult).toEqual({ providerId: 'azure-openai', content: 'Azure OpenAI response' });
    expect(anthropicResult).toEqual({ providerId: 'anthropic', content: 'Anthropic response' });
  });
});
