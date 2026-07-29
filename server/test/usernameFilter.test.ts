/**
 * Local username blacklist (design/16-accounts.md) — pure, no DB/network.
 */
import { describe, it, expect } from 'vitest';
import { isBlockedUsername } from '../src/usernameFilter';

describe('isBlockedUsername', () => {
  it('blocks reserved system names', () => {
    expect(isBlockedUsername('admin')).toBe(true);
    expect(isBlockedUsername('root')).toBe(true);
    expect(isBlockedUsername('moderator')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isBlockedUsername('Admin')).toBe(true);
    expect(isBlockedUsername('ADMINISTRATOR')).toBe(true);
  });

  it('blocks a reserved word appearing as a substring', () => {
    expect(isBlockedUsername('xxadminxx')).toBe(true);
    expect(isBlockedUsername('the_real_gm')).toBe(true);
  });

  it('blocks banned words', () => {
    expect(isBlockedUsername('shitlord')).toBe(true);
  });

  it('allows an ordinary username', () => {
    expect(isBlockedUsername('alice')).toBe(false);
    expect(isBlockedUsername('player_42')).toBe(false);
  });
});
