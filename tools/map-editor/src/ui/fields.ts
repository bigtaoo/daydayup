// Tiny plain-DOM form-field builders shared by Inspector/EncounterTable — no UI
// framework (matches both funny's editors and this repo's own client).

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

export function fieldRow(labelText: string, input: HTMLElement): HTMLElement {
  const wrap = el('div');
  const label = el('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}

export function numberField(labelText: string, value: number, onChange: (v: number) => void, step = 1): HTMLElement {
  const input = el('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(value);
  input.onchange = () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) onChange(n);
  };
  return fieldRow(labelText, input);
}

export function textField(labelText: string, value: string, onChange: (v: string) => void): HTMLElement {
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.onchange = () => onChange(input.value);
  return fieldRow(labelText, input);
}

export function checkboxField(labelText: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el('div');
  const label = el('label');
  label.style.display = 'inline-flex';
  label.style.alignItems = 'center';
  label.style.gap = '6px';
  label.style.textTransform = 'none';
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  label.appendChild(input);
  label.appendChild(document.createTextNode(labelText));
  wrap.appendChild(label);
  return wrap;
}

export function selectField(labelText: string, value: string, options: string[], onChange: (v: string) => void): HTMLElement {
  const select = el('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    select.appendChild(o);
  }
  select.onchange = () => onChange(select.value);
  return fieldRow(labelText, select);
}

export function button(text: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = el('button');
  b.textContent = text;
  if (danger) b.style.borderColor = '#e06c75';
  b.onclick = onClick;
  return b;
}

export function section(title: string): HTMLElement {
  const s = el('div', 'section');
  const h = el('h3');
  h.textContent = title;
  s.appendChild(h);
  return s;
}
