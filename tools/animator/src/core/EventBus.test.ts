import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './EventBus';

// Local event map — deliberately not AppEvents, to keep this a pure unit test
// of the generic pub-sub mechanism itself (payload event + void event).
interface TestEvents {
  greet: string;
  tick:  void;
}

describe('EventBus', () => {
  it('calls a subscribed listener with the emitted payload', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    bus.on('greet', listener);

    bus.emit('greet', 'hello');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('hello');
  });

  it('supports void-payload events with no second emit argument', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    bus.on('tick', listener);

    bus.emit('tick');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(undefined);
  });

  it('calls every listener subscribed to the same event, in subscription order', () => {
    const bus = new EventBus<TestEvents>();
    const calls: string[] = [];
    bus.on('greet', () => calls.push('first'));
    bus.on('greet', () => calls.push('second'));

    bus.emit('greet', 'x');

    expect(calls).toEqual(['first', 'second']);
  });

  it('does not call a listener for a different event', () => {
    const bus = new EventBus<TestEvents>();
    const greetListener = vi.fn();
    const tickListener = vi.fn();
    bus.on('greet', greetListener);
    bus.on('tick', tickListener);

    bus.emit('greet', 'hi');

    expect(greetListener).toHaveBeenCalledTimes(1);
    expect(tickListener).not.toHaveBeenCalled();
  });

  it('emitting with no listeners registered does nothing (no throw)', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.emit('greet', 'no one home')).not.toThrow();
  });

  it('off() removes only the specified listener', () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('greet', a);
    bus.on('greet', b);

    bus.off('greet', a);
    bus.emit('greet', 'x');

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('off() on an event with no listeners registered does nothing (no throw)', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.off('greet', vi.fn())).not.toThrow();
  });

  it('the unsubscribe function returned by on() removes that listener', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = bus.on('greet', listener);

    unsubscribe();
    bus.emit('greet', 'x');

    expect(listener).not.toHaveBeenCalled();
  });

  it('calling the unsubscribe function twice is harmless', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = bus.on('greet', listener);

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    bus.emit('greet', 'x');
    expect(listener).not.toHaveBeenCalled();
  });

  it('subscribing the same function twice to the same event only registers it once (Set semantics)', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    bus.on('greet', listener);
    bus.on('greet', listener);

    bus.emit('greet', 'x');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a listener removed mid-emit by a callback still is not called for that emit (Set snapshot at emit time is not required, but no crash)', () => {
    const bus = new EventBus<TestEvents>();
    const b = vi.fn();
    const a = vi.fn(() => bus.off('greet', b));
    bus.on('greet', a);
    bus.on('greet', b);

    expect(() => bus.emit('greet', 'x')).not.toThrow();
  });
});
