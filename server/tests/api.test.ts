import { describe, it, expect, beforeEach } from 'vitest';
import { handleRequest, setServices } from '../index';

describe('API', () => {
  it('GET /health devuelve status ok', async () => {
    const res = await handleRequest(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('POST /chat usa el servicio y devuelve la respuesta', async () => {
    // mock service que devuelve una cadena
    setServices([
      {
        chat: async (_messages: any) => {
          return 'mocked response';
        },
      },
    ] as any);

    const req = new Request('http://localhost/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('mocked response');
  });
});
