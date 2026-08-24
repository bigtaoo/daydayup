import { describe, it, expect, vi } from 'vitest';
import { GlProbe, filterPasses } from './glProbe';

/** A stand-in for a live WebGL context: only the entry points the probe wraps, each
 *  recording that it ran so the test can prove the wrapper still forwards. */
function fakeGl() {
  const calls: string[] = [];
  const gl: Record<string, unknown> = {
    drawArrays: (...a: unknown[]) => void calls.push(`drawArrays:${a.join(',')}`),
    drawElements: () => void calls.push('drawElements'),
    drawArraysInstanced: () => void calls.push('drawArraysInstanced'),
    drawElementsInstanced: () => void calls.push('drawElementsInstanced'),
    useProgram: () => void calls.push('useProgram'),
    bindTexture: () => void calls.push('bindTexture'),
    bindFramebuffer: () => void calls.push('bindFramebuffer'),
    // Not wrapped — proves the probe touches only what it declares.
    viewport: () => void calls.push('viewport'),
  };
  return { gl, calls };
}

describe('GlProbe wrapping', () => {
  it('counts all four draw entry points into one number', () => {
    // Pixi picks between them by geometry/instancing; a batch flush is a batch flush.
    const { gl } = fakeGl();
    const p = new GlProbe();
    p.install(gl);
    (gl.drawArrays as () => void)();
    (gl.drawElements as () => void)();
    (gl.drawArraysInstanced as () => void)();
    (gl.drawElementsInstanced as () => void)();
    expect(p.total.draws).toBe(4);
  });

  it('still calls through, with the original arguments and receiver', () => {
    // The probe rewrites the live context of a running renderer: a wrapper that dropped
    // an argument would not show up as a wrong number, it would show up as a blank screen.
    const { gl, calls } = fakeGl();
    new GlProbe().install(gl);
    (gl.drawArrays as (a: number, b: number) => void)(4, 6);
    expect(calls).toEqual(['drawArrays:4,6']);
  });

  it('keeps each counted command in its own bucket', () => {
    const { gl } = fakeGl();
    const p = new GlProbe();
    p.install(gl);
    (gl.useProgram as () => void)();
    (gl.useProgram as () => void)();
    (gl.bindTexture as () => void)();
    (gl.bindFramebuffer as () => void)();
    expect(p.total).toEqual({ draws: 0, programs: 2, textures: 1, framebuffers: 1 });
  });

  it('leaves un-counted entry points untouched', () => {
    const { gl } = fakeGl();
    const before = gl.viewport;
    new GlProbe().install(gl);
    expect(gl.viewport).toBe(before);
  });

  it('does not double-wrap on a second install', () => {
    // Two installs on one context would count every call twice and, worse, restore only
    // one layer on uninstall.
    const { gl } = fakeGl();
    const p = new GlProbe();
    expect(p.install(gl)).toBe(true);
    expect(p.install(gl)).toBe(false);
    (gl.drawArrays as () => void)();
    expect(p.total.draws).toBe(1);
  });

  it('reports failure and stays inert for a missing context', () => {
    const p = new GlProbe();
    expect(p.install(null)).toBe(false);
    expect(p.install(undefined)).toBe(false);
    expect(p.total.draws).toBe(0);
  });

  it('ignores a context missing some of the entry points', () => {
    // A canvas/WebGPU renderer, or a mocked context in another test, must not throw here.
    const gl: Record<string, unknown> = { drawArrays: vi.fn() };
    const p = new GlProbe();
    expect(p.install(gl)).toBe(true);
    (gl.drawArrays as () => void)();
    expect(p.total.draws).toBe(1);
    expect(p.total.programs).toBe(0);
  });

  it('restores the exact original functions on uninstall', () => {
    const { gl } = fakeGl();
    const originals = { ...gl };
    const p = new GlProbe();
    p.install(gl);
    p.uninstall();
    for (const k of Object.keys(originals)) expect(gl[k]).toBe(originals[k]);
  });

  it('can be re-installed after an uninstall', () => {
    const { gl } = fakeGl();
    const p = new GlProbe();
    p.install(gl);
    p.uninstall();
    expect(p.install(gl)).toBe(true);
    (gl.drawArrays as () => void)();
    expect(p.total.draws).toBe(1);
  });
});

describe('GlProbe per-frame deltas', () => {
  it('reports only the commands issued between begin and end', () => {
    const { gl } = fakeGl();
    const p = new GlProbe();
    p.install(gl);
    (gl.drawArrays as () => void)(); // before the frame — must not count
    p.beginFrame();
    (gl.drawArrays as () => void)();
    (gl.drawArrays as () => void)();
    p.endFrame();
    expect(p.perFrame.draws).toBe(2);
    expect(p.total.draws).toBe(3);
  });

  it('does not carry the previous frame into the next', () => {
    const { gl } = fakeGl();
    const p = new GlProbe();
    p.install(gl);
    p.beginFrame();
    for (let i = 0; i < 5; i++) (gl.drawArrays as () => void)();
    p.endFrame();
    p.beginFrame();
    (gl.drawArrays as () => void)();
    p.endFrame();
    expect(p.perFrame.draws).toBe(1);
  });

  it('holds the last completed frame while the next one is in flight', () => {
    // The sampler reads `perFrame` from a window close, which can land mid-frame; a
    // partially-counted frame must not be what it sees.
    const { gl } = fakeGl();
    const p = new GlProbe();
    p.install(gl);
    p.beginFrame();
    (gl.drawArrays as () => void)();
    (gl.drawArrays as () => void)();
    p.endFrame();
    p.beginFrame();
    (gl.drawArrays as () => void)();
    expect(p.perFrame.draws).toBe(2);
  });
});

describe('filterPasses', () => {
  it('halves the framebuffer binds — a filter binds its target and then puts the old one back', () => {
    expect(filterPasses({ draws: 0, programs: 0, textures: 0, framebuffers: 28 })).toBe(14);
  });

  it('never reports a negative or fractional pass count', () => {
    expect(filterPasses({ draws: 0, programs: 0, textures: 0, framebuffers: 1 })).toBe(0);
    expect(filterPasses({ draws: 0, programs: 0, textures: 0, framebuffers: 0 })).toBe(0);
    expect(filterPasses({ draws: 0, programs: 0, textures: 0, framebuffers: 7 })).toBe(3);
  });
});
