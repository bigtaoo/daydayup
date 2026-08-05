import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { StatusBar } from './StatusBar';

function fakeEl(): HTMLElement {
  return { textContent: '' } as unknown as HTMLElement;
}

describe('StatusBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets el.textContent on a status event', () => {
    const bus = new EventBus<AppEvents>();
    const el = fakeEl();
    new StatusBar(el, bus);

    bus.emit('status', 'Saved project');

    expect(el.textContent).toBe('Saved project');
  });

  it('auto-clears back to "Ready" 3 seconds after the status was set', () => {
    const bus = new EventBus<AppEvents>();
    const el = fakeEl();
    new StatusBar(el, bus);

    bus.emit('status', 'Saved project');
    expect(el.textContent).toBe('Saved project');

    vi.advanceTimersByTime(2999);
    expect(el.textContent).toBe('Saved project');

    vi.advanceTimersByTime(1);
    expect(el.textContent).toBe('Ready');
  });

  it('does not clobber a newer status message with an older message`s auto-clear', () => {
    const bus = new EventBus<AppEvents>();
    const el = fakeEl();
    new StatusBar(el, bus);

    bus.emit('status', 'A');
    vi.advanceTimersByTime(1000);
    bus.emit('status', 'B');

    // A's own 3s timer fires here (t=3000 from A's start) — since textContent
    // is now 'B', A's guard (`el.textContent === msg`) must not touch it.
    vi.advanceTimersByTime(2000);
    expect(el.textContent).toBe('B');

    // B's own 3s timer fires here (t=1000+3000=4000) and clears to Ready.
    vi.advanceTimersByTime(1000);
    expect(el.textContent).toBe('Ready');
  });

  it('shows the history label when idle ("Ready") and a history:change event arrives', () => {
    const bus = new EventBus<AppEvents>();
    const el = fakeEl();
    new StatusBar(el, bus);
    expect(el.textContent).toBe(''); // not yet 'Ready' — no status event has happened

    el.textContent = 'Ready';
    bus.emit('history:change', { canUndo: true, canRedo: false, label: 'Undo: rotate bone' });

    expect(el.textContent).toBe('Undo: rotate bone');
  });

  it('ignores history:change while a non-"Ready" status message is showing', () => {
    const bus = new EventBus<AppEvents>();
    const el = fakeEl();
    new StatusBar(el, bus);

    bus.emit('status', 'Exporting...');
    bus.emit('history:change', { canUndo: true, canRedo: false, label: 'Undo: rotate bone' });

    expect(el.textContent).toBe('Exporting...');
  });
});
