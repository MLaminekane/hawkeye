import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const reloadMock = vi.fn();

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

function createJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function createTextResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => body,
  } as Response;
}

async function loadApiModule() {
  vi.resetModules();
  MockWebSocket.instances = [];

  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', {
    location: {
      protocol: 'http:',
      host: 'localhost:4242',
      reload: reloadMock,
    },
  });
  vi.stubGlobal('WebSocket', MockWebSocket);

  return import('./api');
}

beforeEach(() => {
  fetchMock.mockReset();
  reloadMock.mockReset();
  MockWebSocket.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard api', () => {
  it('requests sessions with the requested limit', async () => {
    const sessions = [{ id: 'session-1', objective: 'Test dashboard' }];
    fetchMock.mockResolvedValue(createJsonResponse(sessions));

    const { api } = await loadApiModule();

    await expect(api.listSessions(10)).resolves.toEqual(sessions);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions?limit=10');
  });

  it('posts the default completed status when ending a session', async () => {
    fetchMock.mockResolvedValue(createJsonResponse({ ok: true }));

    const { api } = await loadApiModule();

    await expect(api.endSession('session-42')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-42/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
  });

  it('returns plain text for the task journal endpoint', async () => {
    fetchMock.mockResolvedValue(createTextResponse('journal contents'));

    const { api } = await loadApiModule();

    await expect(api.getTaskJournal()).resolves.toBe('journal contents');
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/journal');
  });

  it('throws a readable error when a request fails', async () => {
    fetchMock.mockResolvedValue(createJsonResponse({ error: 'unavailable' }, 503));

    const { api } = await loadApiModule();

    await expect(api.getStats()).rejects.toThrow('API error: 503');
  });

  it('builds the websocket URL from the current browser location', async () => {
    const listener = vi.fn();

    const { hawkeyeWs } = await loadApiModule();
    const unsubscribe = hawkeyeWs.subscribe(listener);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe('ws://localhost:4242/ws');

    MockWebSocket.instances[0]?.onmessage?.({
      data: JSON.stringify({ type: 'session_pause', sessionId: 'session-1' }),
    } as MessageEvent);

    expect(listener).toHaveBeenCalledWith({ type: 'session_pause', sessionId: 'session-1' });

    unsubscribe();
    hawkeyeWs.disconnect();
  });

  it('reloads the page when serve broadcasts a dashboard reload signal', async () => {
    const { hawkeyeWs } = await loadApiModule();
    const unsubscribe = hawkeyeWs.subscribe(() => {});

    MockWebSocket.instances[0]?.onmessage?.({
      data: JSON.stringify({ type: 'session_end', session: { id: '__reload__', status: 'reload' } }),
    } as MessageEvent);

    expect(reloadMock).toHaveBeenCalledTimes(1);

    unsubscribe();
    hawkeyeWs.disconnect();
  });
});
