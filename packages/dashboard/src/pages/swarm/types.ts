import type { LiveAgentData } from '../../api';

export type AgentRole = LiveAgentData['role'];
export type AgentStatusFilter = 'all' | LiveAgentData['status'];
export type Notice = { type: 'success' | 'error'; text: string } | null;

export interface CommandOption {
  value: string;
  label: string;
  kicker: string;
  summary: string;
  detail: string;
  badgeClass: string;
  borderClass: string;
  surfaceClass: string;
}

export interface RoleOption {
  value: AgentRole;
  label: string;
  summary: string;
  badgeClass: string;
  borderClass: string;
  surfaceClass: string;
}

export interface QuickStart {
  id: string;
  label: string;
  kicker: string;
  summary: string;
  command: string;
  role: AgentRole;
  prompt: string;
  personality: string;
  namePrefix: string;
}

export interface LocalProviderState {
  available: boolean;
  models?: string[];
}

export interface CIReportData {
  markdown: string;
  risk: string;
  passed: boolean;
  flags: string[];
}
