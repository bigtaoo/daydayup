/**
 * A real HTML `<input>` overlaid on top of the Pixi canvas (design/10 "no DOM
 * widgets" is about ON-CANVAS chrome — text entry is the one thing Pixi has no native
 * primitive for at all, and this repo has no on-screen-keyboard precedent to reuse).
 * Used for the party join-code field (design/05/15's squad follow-up) — a single
 * short field, not a form, so a fixed-position centered overlay is simpler and more
 * robust across resizes than trying to track the exact canvas pixel position of a
 * Pixi-drawn field.
 *
 * Lifecycle: `open()` creates and focuses the element; it tears itself down on
 * submit (Enter), cancel (Escape or the caller calling `close()`), or blur — never
 * left dangling in the DOM.
 */
export interface TextInputOverlayOptions {
  placeholder?: string;
  maxLength?: number;
  /** Upper-cased as typed (join codes are alphabetic, case shouldn't matter to the player). */
  uppercase?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export class TextInputOverlay {
  private el: HTMLInputElement | null = null;

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(opts: TextInputOverlayOptions): void {
    this.close(); // never stack two
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = opts.placeholder ?? '';
    input.maxLength = opts.maxLength ?? 32;
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    Object.assign(input.style, {
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '10000',
      fontSize: '24px',
      fontFamily: 'monospace',
      textAlign: 'center',
      letterSpacing: '4px',
      padding: '10px 16px',
      borderRadius: '8px',
      border: '2px solid #63b3ed',
      background: '#0b0e14',
      color: '#e2e8f0',
      width: '220px',
    } satisfies Partial<CSSStyleDeclaration>);

    if (opts.uppercase) {
      input.addEventListener('input', () => {
        const upper = input.value.toUpperCase();
        if (upper !== input.value) input.value = upper;
      });
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = input.value;
        this.close();
        opts.onSubmit(value);
      } else if (e.key === 'Escape') {
        this.close();
        opts.onCancel?.();
      }
      e.stopPropagation(); // never let a keystroke also drive the game's own key handlers
    });

    document.body.appendChild(input);
    this.el = input;
    input.focus();
  }

  close(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
  }
}
