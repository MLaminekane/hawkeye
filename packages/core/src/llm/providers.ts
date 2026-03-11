/**
 * Shared LLM provider factories.
 * Used by DriftDetect engine and post-mortem analysis.
 */

export interface LlmProvider {
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

export function createOllamaProvider(model: string, ollamaUrl?: string): LlmProvider {
  const baseUrl = ollamaUrl || 'http://localhost:11434';
  return {
    async complete(prompt, opts) {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: opts?.maxTokens ?? 300 },
        }),
      });
      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as { response: string };
      return data.response;
    },
  };
}

export function createAnthropicProvider(model: string): LlmProvider {
  return {
    async complete(prompt, opts) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: opts?.maxTokens ?? 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Anthropic error: ${response.status}`);
      }
      const data = (await response.json()) as { content: Array<{ text: string }> };
      return data.content[0].text;
    },
  };
}

export function createOpenAIProvider(model: string): LlmProvider {
  return {
    async complete(prompt, opts) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts?.maxTokens ?? 300,
          temperature: 0.1,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI error: ${response.status}`);
      }
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0].message.content;
    },
  };
}

export function createDeepSeekProvider(model: string): LlmProvider {
  return {
    async complete(prompt, opts) {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts?.maxTokens ?? 300,
          temperature: 0.1,
        }),
      });
      if (!response.ok) {
        throw new Error(`DeepSeek error: ${response.status}`);
      }
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0].message.content;
    },
  };
}

export function createMistralProvider(model: string): LlmProvider {
  return {
    async complete(prompt, opts) {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts?.maxTokens ?? 300,
          temperature: 0.1,
        }),
      });
      if (!response.ok) {
        throw new Error(`Mistral error: ${response.status}`);
      }
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0].message.content;
    },
  };
}

export function createGoogleProvider(model: string): LlmProvider {
  return {
    async complete(prompt, opts) {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: opts?.maxTokens ?? 300,
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Google error: ${response.status}`);
      }
      const data = (await response.json()) as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      return data.candidates[0].content.parts[0].text;
    },
  };
}

export function createLlmProvider(
  provider: string,
  model: string,
  ollamaUrl?: string,
): LlmProvider {
  switch (provider) {
    case 'ollama':
      return createOllamaProvider(model, ollamaUrl);
    case 'anthropic':
      return createAnthropicProvider(model);
    case 'openai':
      return createOpenAIProvider(model);
    case 'deepseek':
      return createDeepSeekProvider(model);
    case 'mistral':
      return createMistralProvider(model);
    case 'google':
      return createGoogleProvider(model);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
