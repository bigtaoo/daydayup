import { describe, it, expect, vi } from 'vitest';
import { EventBus, type AppEvents } from './EventBus';
import { CommandManager, type Command } from './CommandManager';

function fakeCommand(label: string): Command & { execute: ReturnType<typeof vi.fn<() => void>>; undo: ReturnType<typeof vi.fn<() => void>> } {
  return {
    label,
    execute: vi.fn<() => void>(),
    undo: vi.fn<() => void>(),
  };
}

function build() {
  const bus = new EventBus<AppEvents>();
  const manager = new CommandManager(bus);
  return { bus, manager };
}

describe('CommandManager', () => {
  it('starts with empty stacks — cannot undo or redo, generic labels', () => {
    const { manager } = build();
    expect(manager.canUndo).toBe(false);
    expect(manager.canRedo).toBe(false);
    expect(manager.undoLabel).toBe('Nothing to undo');
    expect(manager.redoLabel).toBe('Nothing to redo');
  });

  describe('execute', () => {
    it('runs the command immediately and pushes it onto the undo stack', () => {
      const { manager } = build();
      const cmd = fakeCommand('move bone');

      manager.execute(cmd);

      expect(cmd.execute).toHaveBeenCalledTimes(1);
      expect(manager.canUndo).toBe(true);
      expect(manager.undoLabel).toBe('Undo: move bone');
    });

    it('clears the redo stack', () => {
      const { manager } = build();
      manager.execute(fakeCommand('a'));
      manager.undo();
      expect(manager.canRedo).toBe(true);

      manager.execute(fakeCommand('b'));

      expect(manager.canRedo).toBe(false);
      expect(manager.redoLabel).toBe('Nothing to redo');
    });

    it('emits history:change with the current canUndo/canRedo/label', () => {
      const { bus, manager } = build();
      const spy = vi.fn();
      bus.on('history:change', spy);

      manager.execute(fakeCommand('paint'));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ canUndo: true, canRedo: false, label: 'Undo: paint' });
    });

    it('trims the undo stack to MAX_STACK (100), dropping the oldest command', () => {
      const { manager } = build();
      for (let i = 0; i < 101; i++) manager.execute(fakeCommand(`cmd${i}`));

      // Most recent (cmd100) is present.
      expect(manager.undoLabel).toBe('Undo: cmd100');

      // Undo all 100 remaining commands (cmd100 down to cmd1) — cmd0 must have
      // been dropped when the 101st command pushed the stack over MAX_STACK.
      for (let i = 100; i >= 1; i--) manager.undo();

      expect(manager.canUndo).toBe(false);
    });
  });

  describe('undo', () => {
    it('calls undo() on the last executed command and moves it to the redo stack', () => {
      const { manager } = build();
      const cmd = fakeCommand('rotate');
      manager.execute(cmd);

      manager.undo();

      expect(cmd.undo).toHaveBeenCalledTimes(1);
      expect(manager.canUndo).toBe(false);
      expect(manager.canRedo).toBe(true);
      expect(manager.redoLabel).toBe('Redo: rotate');
    });

    it('does nothing when the undo stack is empty', () => {
      const { bus, manager } = build();
      const spy = vi.fn();
      bus.on('history:change', spy);

      expect(() => manager.undo()).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    });

    it('emits history:change reflecting the post-undo state', () => {
      const { bus, manager } = build();
      manager.execute(fakeCommand('scale'));
      const spy = vi.fn();
      bus.on('history:change', spy);

      manager.undo();

      expect(spy).toHaveBeenCalledWith({ canUndo: false, canRedo: true, label: 'Redo: scale' });
    });

    it('undoes multiple commands in reverse (LIFO) order', () => {
      const { manager } = build();
      const order: string[] = [];
      const a: Command = { label: 'a', execute: () => order.push('exec-a'), undo: () => order.push('undo-a') };
      const b: Command = { label: 'b', execute: () => order.push('exec-b'), undo: () => order.push('undo-b') };
      manager.execute(a);
      manager.execute(b);

      manager.undo();
      manager.undo();

      expect(order).toEqual(['exec-a', 'exec-b', 'undo-b', 'undo-a']);
    });
  });

  describe('redo', () => {
    it('does nothing when the redo stack is empty', () => {
      const { bus, manager } = build();
      const spy = vi.fn();
      bus.on('history:change', spy);

      expect(() => manager.redo()).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    });

    it('re-executes the command and moves it back onto the undo stack', () => {
      const { manager } = build();
      const cmd = fakeCommand('translate');
      manager.execute(cmd);
      manager.undo();

      manager.redo();

      expect(cmd.execute).toHaveBeenCalledTimes(2); // once from execute(), once from redo()
      expect(manager.canUndo).toBe(true);
      expect(manager.canRedo).toBe(false);
      expect(manager.undoLabel).toBe('Undo: translate');
    });

    it('emits history:change reflecting the post-redo state', () => {
      const { bus, manager } = build();
      manager.execute(fakeCommand('flip'));
      manager.undo();
      const spy = vi.fn();
      bus.on('history:change', spy);

      manager.redo();

      expect(spy).toHaveBeenCalledWith({ canUndo: true, canRedo: false, label: 'Undo: flip' });
    });
  });

  describe('clear', () => {
    it('empties both stacks and emits history:change with the empty-state labels', () => {
      const { bus, manager } = build();
      manager.execute(fakeCommand('a'));
      manager.execute(fakeCommand('b'));
      manager.undo();
      expect(manager.canUndo).toBe(true);
      expect(manager.canRedo).toBe(true);

      const spy = vi.fn();
      bus.on('history:change', spy);
      manager.clear();

      expect(manager.canUndo).toBe(false);
      expect(manager.canRedo).toBe(false);
      expect(manager.undoLabel).toBe('Nothing to undo');
      expect(spy).toHaveBeenCalledWith({ canUndo: false, canRedo: false, label: 'Nothing to redo' });
    });
  });
});
