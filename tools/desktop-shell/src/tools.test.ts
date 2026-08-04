import { describe, it, expect, vi, beforeEach } from 'vitest';

const appState = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({
  app: appState,
}));

import { TOOLS, DEFAULT_TOOL_ID, resolveToolUrl } from './tools';

describe('tools', () => {
  beforeEach(() => {
    appState.isPackaged = false;
  });

  it('lists exactly animator and map-editor, in that order', () => {
    expect(TOOLS.map(t => t.id)).toEqual(['animator', 'map-editor']);
  });

  it('defaults to the first tool (animator)', () => {
    expect(DEFAULT_TOOL_ID).toBe('animator');
  });

  it('every tool has distinct dev ports and https prod URLs', () => {
    const ports = TOOLS.map(t => new URL(t.devUrl).port);
    expect(new Set(ports).size).toBe(TOOLS.length);
    for (const tool of TOOLS) {
      expect(tool.prodUrl.startsWith('https://')).toBe(true);
    }
  });

  it('resolveToolUrl returns the dev URL when unpackaged', () => {
    appState.isPackaged = false;
    expect(resolveToolUrl(TOOLS[0])).toBe(TOOLS[0].devUrl);
  });

  it('resolveToolUrl returns the prod URL when packaged', () => {
    appState.isPackaged = true;
    expect(resolveToolUrl(TOOLS[0])).toBe(TOOLS[0].prodUrl);
  });
});
