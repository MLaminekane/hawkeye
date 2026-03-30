export interface PendingReview {
  id: string;
  timestamp: string;
  sessionId: string;
  command: string;
  matchedPattern: string;
}

export type TaskFilter = 'all' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
