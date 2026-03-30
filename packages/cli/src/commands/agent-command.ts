export interface AgentInvocationOptions {
  continueConversation?: boolean;
  extraArgs?: string[];
  model?: string;
}

export interface AgentInvocation {
  cmd: string;
  args: string[];
  agentName: string;
}

export function inferAgentName(agentCommand: string): string {
  if (/^cline(?:\/|$)/.test(agentCommand.trim())) return 'cline';
  if (/^(claude-api|anthropic)\//.test(agentCommand.trim())) return 'claude';
  const firstSegment = agentCommand.trim().split(/\s+/)[0] || agentCommand.trim();
  return firstSegment.split('/').pop() || firstSegment;
}

export function getAgentFullAccessArgs(agentCommand: string): string[] {
  const agentName = inferAgentName(agentCommand);

  if (agentName === 'claude') {
    return ['--dangerously-skip-permissions'];
  }

  if (agentName === 'codex') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }

  return [];
}

export function buildAgentInvocation(
  agentCommand: string,
  prompt: string,
  options: AgentInvocationOptions = {},
): AgentInvocation {
  // Handle "ollama/model" or "lmstudio/model" format → route through aider
  const ollamaMatch = agentCommand.match(/^ollama\/(.+)$/);
  const lmstudioMatch = agentCommand.match(/^lmstudio\/(.+)$/);
  const anthropicMatch = agentCommand.match(/^(claude-api|anthropic)\/(.+)$/);
  if (ollamaMatch) {
    return buildAgentInvocation(`aider --model ollama_chat/${ollamaMatch[1]} --no-show-model-warnings --no-auto-commits --map-tokens 1024`, prompt, options);
  }
  if (lmstudioMatch) {
    return buildAgentInvocation(`aider --model openai/${lmstudioMatch[1]} --api-base http://localhost:1234/v1 --no-show-model-warnings --no-auto-commits --map-tokens 1024`, prompt, options);
  }
  if (anthropicMatch) {
    return buildAgentInvocation(`aider --model anthropic/${anthropicMatch[2]} --no-show-model-warnings --no-auto-commits --map-tokens 1024`, prompt, options);
  }
  if (agentCommand === 'ollama' || agentCommand === 'lmstudio') {
    const model = agentCommand === 'ollama' ? 'ollama_chat/auto' : 'openai/auto';
    return buildAgentInvocation(`aider --model ${model} --no-show-model-warnings --no-auto-commits --map-tokens 1024`, prompt, options);
  }

  const parts = agentCommand.trim().split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const baseArgs = parts.slice(1);
  const extraArgs = options.extraArgs || [];
  const agentName = inferAgentName(agentCommand);

  if (agentName === 'claude') {
    return {
      cmd,
      args: [
        ...baseArgs,
        ...extraArgs,
        ...(options.model ? ['--model', options.model] : []),
        ...(options.continueConversation ? ['--continue'] : []),
        '-p',
        prompt,
      ],
      agentName,
    };
  }

  if (agentName === 'aider') {
    return {
      cmd,
      args: [...baseArgs, ...extraArgs, '--message', prompt, '--yes'],
      agentName,
    };
  }

  if (agentName === 'cline') {
    return {
      cmd,
      args: [...baseArgs, ...extraArgs, prompt],
      agentName,
    };
  }

  if (agentName === 'codex') {
    return {
      cmd,
      args: [...baseArgs, ...extraArgs, 'exec', prompt],
      agentName,
    };
  }

  return {
    cmd,
    args: [...baseArgs, ...extraArgs, prompt],
    agentName,
  };
}
