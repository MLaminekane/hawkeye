export interface AgentInvocationOptions {
  continueConversation?: boolean;
  extraArgs?: string[];
}

export interface AgentInvocation {
  cmd: string;
  args: string[];
  agentName: string;
}

export function inferAgentName(agentCommand: string): string {
  const firstSegment = agentCommand.trim().split(/\s+/)[0] || agentCommand.trim();
  return firstSegment.split('/').pop() || firstSegment;
}

export function buildAgentInvocation(
  agentCommand: string,
  prompt: string,
  options: AgentInvocationOptions = {},
): AgentInvocation {
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

  if (agentName === 'codex') {
    return {
      cmd,
      args: [...baseArgs, ...extraArgs, '-q', prompt],
      agentName,
    };
  }

  return {
    cmd,
    args: [...baseArgs, ...extraArgs, prompt],
    agentName,
  };
}
