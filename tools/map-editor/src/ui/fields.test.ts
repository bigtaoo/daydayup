import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFakeDom, FakeElement } from './fakeDom';
import { el, fieldRow, numberField, textField, checkboxField, selectField, button, section } from './fields';

afterEach(() => vi.unstubAllGlobals());

describe('el', () => {
  it('creates an element of the given tag with no className by default', () => {
    installFakeDom();
    const e = el('div') as unknown as FakeElement;
    expect(e.tagName).toBe('DIV');
    expect(e.className).toBe('');
  });

  it('sets className when given one', () => {
    installFakeDom();
    const e = el('div', 'section') as unknown as FakeElement;
    expect(e.className).toBe('section');
  });
});

describe('fieldRow', () => {
  it('wraps a label (with the given text) and the input together', () => {
    installFakeDom();
    const input = el('input') as unknown as FakeElement;
    const row = fieldRow('x', input as unknown as HTMLElement) as unknown as FakeElement;
    expect(row.children).toHaveLength(2);
    const [label, appendedInput] = row.children;
    expect(label!.tagName).toBe('LABEL');
    expect(label!.textContent).toBe('x');
    expect(appendedInput).toBe(input);
  });
});

describe('numberField', () => {
  it('renders a number input pre-filled with the given value and step', () => {
    installFakeDom();
    const row = numberField('w', 5, () => {}, 2) as unknown as FakeElement;
    const input = row.children[1] as unknown as FakeElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('5');
    expect(input.step).toBe('2');
  });

  it('defaults step to 1', () => {
    installFakeDom();
    const row = numberField('w', 5, () => {}) as unknown as FakeElement;
    const input = row.children[1] as unknown as FakeElement;
    expect(input.step).toBe('1');
  });

  it('calls onChange with the parsed number on change', () => {
    installFakeDom();
    const onChange = vi.fn();
    const row = numberField('w', 5, onChange) as unknown as FakeElement;
    const input = row.children[1] as unknown as FakeElement;
    input.value = '9';
    input.onchange!();
    expect(onChange).toHaveBeenCalledWith(9);
  });

  it('does not call onChange when the typed value is not a finite number', () => {
    installFakeDom();
    const onChange = vi.fn();
    const row = numberField('w', 5, onChange) as unknown as FakeElement;
    const input = row.children[1] as unknown as FakeElement;
    input.value = 'not-a-number';
    input.onchange!();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('textField', () => {
  it('renders a text input pre-filled with the given value', () => {
    installFakeDom();
    const row = textField('id', 'room_1', () => {}) as unknown as FakeElement;
    const input = row.children[1] as unknown as FakeElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('room_1');
  });

  it('calls onChange with the raw string on change', () => {
    installFakeDom();
    const onChange = vi.fn();
    const row = textField('id', 'room_1', onChange) as unknown as FakeElement;
    const input = row.children[1] as unknown as FakeElement;
    input.value = 'room_2';
    input.onchange!();
    expect(onChange).toHaveBeenCalledWith('room_2');
  });
});

describe('checkboxField', () => {
  it('renders a checkbox pre-set to the given checked state, with the label text appended', () => {
    installFakeDom();
    const wrap = checkboxField('boss', true, () => {}) as unknown as FakeElement;
    const label = wrap.children[0] as unknown as FakeElement;
    const [input, textNode] = label.children as unknown as [FakeElement, { textContent: string }];
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(true);
    expect(textNode.textContent).toBe('boss');
  });

  it('calls onChange with the new checked state on change', () => {
    installFakeDom();
    const onChange = vi.fn();
    const wrap = checkboxField('boss', false, onChange) as unknown as FakeElement;
    const label = wrap.children[0] as unknown as FakeElement;
    const input = label.children[0] as unknown as FakeElement;
    input.checked = true;
    input.onchange!();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('selectField', () => {
  it('renders one <option> per option, marking the current value selected', () => {
    installFakeDom();
    const row = selectField('role', 'boss', ['normal', 'extraction', 'boss'], () => {}) as unknown as FakeElement;
    const select = row.children[1] as unknown as FakeElement;
    expect(select.children).toHaveLength(3);
    expect(select.children.map((o) => o.value)).toEqual(['normal', 'extraction', 'boss']);
    expect(select.children.map((o) => o.selected)).toEqual([false, false, true]);
  });

  it('calls onChange with the selected value on change', () => {
    installFakeDom();
    const onChange = vi.fn();
    const row = selectField('role', 'normal', ['normal', 'boss'], onChange) as unknown as FakeElement;
    const select = row.children[1] as unknown as FakeElement;
    select.value = 'boss';
    select.onchange!();
    expect(onChange).toHaveBeenCalledWith('boss');
  });
});

describe('button', () => {
  it('renders the given text and wires onClick', () => {
    installFakeDom();
    const onClick = vi.fn();
    const b = button('Save', onClick) as unknown as FakeElement;
    expect(b.textContent).toBe('Save');
    b.onclick!();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not tint the border by default', () => {
    installFakeDom();
    const b = button('Save', () => {}) as unknown as FakeElement;
    expect(b.style.borderColor).toBeUndefined();
  });

  it('tints the border red when danger is true', () => {
    installFakeDom();
    const b = button('Delete', () => {}, true) as unknown as FakeElement;
    expect(b.style.borderColor).toBe('#e06c75');
  });
});

describe('section', () => {
  it('renders a "section"-classed wrapper with an <h3> title', () => {
    installFakeDom();
    const s = section('Room Piece') as unknown as FakeElement;
    expect(s.className).toBe('section');
    expect(s.children).toHaveLength(1);
    expect(s.children[0]!.tagName).toBe('H3');
    expect(s.children[0]!.textContent).toBe('Room Piece');
  });
});
