import { describe, it, expect, vi } from 'vitest';
import { CognitiveBus } from '../../src/cognitive/bus.js';

describe('CognitiveBus', () => {
  it('should emit and receive events', async () => {
    const bus = new CognitiveBus();
    const handler = vi.fn();
    bus.on('conversation.end', handler);
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ userId: 'u1', messages: [], toolCallCount: 0 });
  });

  it('should support multiple handlers for same event', async () => {
    const bus = new CognitiveBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('conversation.end', h1);
    bus.on('conversation.end', h2);
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should remove handlers with off', async () => {
    const bus = new CognitiveBus();
    const handler = vi.fn();
    bus.on('conversation.end', handler);
    bus.off('conversation.end', handler);
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit error events when handler throws', async () => {
    const bus = new CognitiveBus();
    const errorHandler = vi.fn();
    bus.on('error', errorHandler);
    bus.on('conversation.end', () => { throw new Error('boom'); });
    await bus.emit('conversation.end', { userId: 'u1', messages: [], toolCallCount: 0 });
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('boom');
  });
});
