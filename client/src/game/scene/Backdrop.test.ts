/**
 * Backdrop — full-viewport void behind a zoomed-to-fit room (design/10 legibility
 * fix, 2026-08-02). Screen-space, mounted on `layers.backdrop`, tracks resize +
 * per-biome recolour. No public accessor for its Graphics — same convention as
 * Portal/Bullet, reach the child via `layers.backdrop.children[0]`.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { Layers } from './layers';
import { Backdrop } from './Backdrop';
import { biomePalette } from '../theme';

function gfxOf(layers: Layers): Graphics {
  return layers.backdrop.children[0] as Graphics;
}

describe('Backdrop — construction', () => {
  it('mounts its Graphics onto layers.backdrop', () => {
    const layers = new Layers();
    new Backdrop(layers);
    expect(layers.backdrop.children.length).toBe(1);
  });
});

describe('Backdrop.resize', () => {
  it('draws a rect covering the given viewport size', () => {
    const layers = new Layers();
    const backdrop = new Backdrop(layers);
    backdrop.resize(800, 600);
    const bounds = gfxOf(layers).getLocalBounds();
    expect(bounds.width).toBeCloseTo(800, 0);
    expect(bounds.height).toBeCloseTo(600, 0);
  });

  it('a non-positive size draws nothing (no crash, zero bounds)', () => {
    const layers = new Layers();
    const backdrop = new Backdrop(layers);
    backdrop.resize(0, 0);
    expect(gfxOf(layers).getLocalBounds().width).toBe(0);
    backdrop.resize(-5, 100);
    expect(gfxOf(layers).getLocalBounds().width).toBe(0);
  });

  it('re-resizing redraws to the new size, not a stale one', () => {
    const layers = new Layers();
    const backdrop = new Backdrop(layers);
    backdrop.resize(400, 300);
    backdrop.resize(1000, 50);
    const bounds = gfxOf(layers).getLocalBounds();
    expect(bounds.width).toBeCloseTo(1000, 0);
    expect(bounds.height).toBeCloseTo(50, 0);
  });
});

describe('Backdrop.setPalette', () => {
  it('recolours an already-sized backdrop immediately (redraw fires on palette change too)', () => {
    const layers = new Layers();
    const backdrop = new Backdrop(layers);
    backdrop.resize(200, 200);
    // Changing palette must not lose the existing size — still draws a full rect.
    backdrop.setPalette(biomePalette('ember'));
    const bounds = gfxOf(layers).getLocalBounds();
    expect(bounds.width).toBeCloseTo(200, 0);
    expect(bounds.height).toBeCloseTo(200, 0);
  });

  it('setting a palette before any resize draws nothing yet (w/h still 0)', () => {
    const layers = new Layers();
    const backdrop = new Backdrop(layers);
    backdrop.setPalette(biomePalette('ember'));
    expect(gfxOf(layers).getLocalBounds().width).toBe(0);
  });
});
