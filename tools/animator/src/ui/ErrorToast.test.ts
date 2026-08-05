import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type AppEvents } from '../core/EventBus';
import { installFakeDocument } from './fakeDom';
import { ErrorToast } from './ErrorToast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function build() {
  const doc = installFakeDocument();
  // window.setTimeout, delegated to the (fake-timer-patched) global setTimeout.
  vi.stubGlobal('window', { setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args) });
  const bus = new EventBus<AppEvents>();
  new ErrorToast(bus);
  return { doc, bus };
}

describe('ErrorToast', () => {
  it('creates its container on document.body at construction', () => {
    const { doc } = build();
    expect(doc.body.children).toHaveLength(1);
    const container = doc.body.children[0];
    expect(container.id).toBe('error-toast-container');
  });

  it('shows a toast with the icon, message text and a close button on the "error" event', () => {
    const { doc, bus } = build();
    bus.emit('error', 'Something broke');

    const container = doc.body.children[0];
    expect(container.children).toHaveLength(1);
    const toast = container.children[0];

    const [icon, text, close] = toast.children;
    expect(icon.textContent).toBe('⚠');
    expect(text.textContent).toBe('Something broke');
    expect(close.tagName).toBe('BUTTON');
    expect(close.textContent).toBe('✕');
  });

  it('stacks multiple errors as separate toasts', () => {
    const { doc, bus } = build();
    bus.emit('error', 'First');
    bus.emit('error', 'Second');

    const container = doc.body.children[0];
    expect(container.children).toHaveLength(2);
    expect(container.children[0].children[1].textContent).toBe('First');
    expect(container.children[1].children[1].textContent).toBe('Second');
  });

  it('clicking the close button removes just that toast', () => {
    const { doc, bus } = build();
    bus.emit('error', 'First');
    bus.emit('error', 'Second');
    const container = doc.body.children[0];

    const firstClose = container.children[0].children[2];
    firstClose.fire('click');

    expect(container.children).toHaveLength(1);
    expect(container.children[0].children[1].textContent).toBe('Second');
  });

  it('auto-dismisses a toast after 8 seconds', () => {
    const { doc, bus } = build();
    bus.emit('error', 'Ephemeral');
    const container = doc.body.children[0];
    expect(container.children).toHaveLength(1);

    vi.advanceTimersByTime(7999);
    expect(container.children).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(container.children).toHaveLength(0);
  });

  it('removing a toast twice (manual close, then the timer firing) is harmless', () => {
    const { doc, bus } = build();
    bus.emit('error', 'Whatever');
    const container = doc.body.children[0];

    const closeBtn = container.children[0].children[2];
    closeBtn.fire('click');
    expect(container.children).toHaveLength(0);

    vi.advanceTimersByTime(8000); // the auto-dismiss timer still fires — must not throw
    expect(container.children).toHaveLength(0);
  });
});
