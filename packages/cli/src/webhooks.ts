import type { WebhookSettings } from './config.js';

export function fireWebhooks(
  webhooks: WebhookSettings[],
  eventType: string,
  payload: Record<string, unknown>,
): void {
  for (const wh of webhooks) {
    if (!wh.enabled) continue;
    if (wh.events.length > 0 && !wh.events.includes(eventType)) continue;
    fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    }).catch(() => {});
  }
}
