/**
 * PartyScreen (design/05/15 PvP squad follow-up). Driven with a fake `PartyApi` (no
 * network) — mirrors this project's standing DI convention (Matchmaker/PartyService/
 * findMatch). Pixi Container/Text/Graphics construct and mutate fine under plain
 * vitest with no renderer attached (same finding TouchControlsView.test.ts made) —
 * asserted here via `.visible`/`.text`, not pixel output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PartyScreen, type PartyApi } from './PartyScreen';
import type { PartyInfo } from '../../net/party';
import { setLocale, resetLocaleForTests } from '../../i18n';

function fakeApi(overrides: Partial<PartyApi> = {}): PartyApi {
  return {
    createParty: vi.fn(),
    joinParty: vi.fn(),
    leaveParty: vi.fn(),
    startPartyMatching: vi.fn(),
    getParty: vi.fn(),
    ...overrides,
  };
}

const PARTY: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'me', members: ['me'], matching: false };

function makeScreen(api: PartyApi, playerId = 'me') {
  const screen = new PartyScreen({ matchBaseUrl: 'http://mm', playerId, api });
  screen.show(800, 600);
  return screen;
}

// Reach private state via the same escape hatch tests elsewhere in this repo use for
// Pixi widgets with no public getters — `as any` on a private-only surface, never on
// engine/sim state.
function privateOf(s: PartyScreen) {
  return s as unknown as {
    title: { text: string };
    createBtn: { view: { visible: boolean }; label: { text: string } };
    joinBtn: { view: { visible: boolean }; label: { text: string } };
    startBtn: { view: { visible: boolean }; label: { text: string } };
    leaveBtn: { view: { visible: boolean }; label: { text: string } };
    codeText: { text: string };
    membersText: { text: string };
    statusText: { text: string };
    doCreate(): Promise<void>;
    doJoin(code: string): Promise<void>;
    doStart(): Promise<void>;
    doLeave(): Promise<void>;
    pollOnce(): Promise<void>;
  };
}

afterEach(() => resetLocaleForTests());

describe('PartyScreen — no party yet', () => {
  it('shows create/join, hides start/leave, before any party exists', () => {
    const s = makeScreen(fakeApi());
    const p = privateOf(s);
    expect(p.createBtn.view.visible).toBe(true);
    expect(p.joinBtn.view.visible).toBe(true);
    expect(p.startBtn.view.visible).toBe(false);
    expect(p.leaveBtn.view.visible).toBe(false);
  });
});

describe('PartyScreen — create', () => {
  it('creating a party shows the code and switches to leave/start (as leader)', async () => {
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(PARTY) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    expect(api.createParty).toHaveBeenCalledWith('http://mm', 'me');
    expect(p.codeText.text).toContain('ABCDE');
    expect(p.startBtn.view.visible).toBe(true); // leader
    expect(p.leaveBtn.view.visible).toBe(true);
    expect(p.createBtn.view.visible).toBe(false);
  });

  it('a failed create shows a status message and leaves the screen in the pre-party state', async () => {
    const api = fakeApi({ createParty: vi.fn().mockRejectedValue(new Error('boom')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    expect(p.statusText.text).toMatch(/could not create/i);
    expect(p.createBtn.view.visible).toBe(true); // still in the pre-party state
  });
});

describe('PartyScreen — join', () => {
  it('joining shows the roster and hides start (not leader)', async () => {
    const joined: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'alice', members: ['alice', 'me'] , matching: false };
    const api = fakeApi({ joinParty: vi.fn().mockResolvedValue(joined) });
    const s = makeScreen(api, 'me');
    const p = privateOf(s);
    await p.doJoin('ABCDE');
    expect(api.joinParty).toHaveBeenCalledWith('http://mm', 'me', 'ABCDE');
    expect(p.membersText.text).toContain('alice');
    expect(p.membersText.text).toContain('you'); // self labeled "you", not its raw id
    expect(p.startBtn.view.visible).toBe(false); // alice is leader, not me
    expect(p.leaveBtn.view.visible).toBe(true);
  });

  it('an invalid code surfaces a status message without joining', async () => {
    const api = fakeApi({ joinParty: vi.fn().mockRejectedValue(new Error('not found')) });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doJoin('NOPE1');
    expect(p.statusText.text).toMatch(/invalid or full/i);
    expect(p.leaveBtn.view.visible).toBe(false);
  });
});

describe('PartyScreen — start matching', () => {
  it('the leader starting matching fires onStartMatch with the partyId', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      startPartyMatching: vi.fn().mockResolvedValue({ ...PARTY, matching: true }),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onStart = vi.fn();
    s.onStartMatch = onStart;
    await p.doCreate();
    await p.doStart();
    expect(api.startPartyMatching).toHaveBeenCalledWith('http://mm', 'p1', 'me');
    expect(onStart).toHaveBeenCalledWith('p1');
  });

  it('a non-leader polling and seeing matching flip to true also fires onStartMatch, without tapping anything', async () => {
    const joined: PartyInfo = { partyId: 'p1', code: 'ABCDE', leaderId: 'alice', members: ['alice', 'me'], matching: false };
    const nowMatching: PartyInfo = { ...joined, matching: true };
    const api = fakeApi({
      joinParty: vi.fn().mockResolvedValue(joined),
      getParty: vi.fn().mockResolvedValue(nowMatching),
    });
    const s = makeScreen(api, 'me');
    const p = privateOf(s);
    const onStart = vi.fn();
    s.onStartMatch = onStart;
    await p.doJoin('ABCDE');
    await p.pollOnce(); // simulates the periodic poll observing the leader's flip
    expect(onStart).toHaveBeenCalledWith('p1');
  });

  it('polling again after already-matching does not re-fire onStartMatch', async () => {
    const already: PartyInfo = { ...PARTY, matching: true };
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(already),
      getParty: vi.fn().mockResolvedValue(already),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    const onStart = vi.fn();
    await p.doCreate();
    s.onStartMatch = onStart; // wired AFTER create, so create's own fire (if any) isn't counted
    await p.pollOnce();
    await p.pollOnce();
    expect(onStart).toHaveBeenCalledTimes(0); // wasMatching was already true both times
  });
});

describe('PartyScreen — leave', () => {
  it('leaving clears the party and reverts to create/join', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      leaveParty: vi.fn().mockResolvedValue(null),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    await p.doLeave();
    expect(api.leaveParty).toHaveBeenCalledWith('http://mm', 'p1', 'me');
    expect(p.createBtn.view.visible).toBe(true);
    expect(p.leaveBtn.view.visible).toBe(false);
    expect(p.codeText.text).toBe('');
  });
});

describe('PartyScreen — poll observing the party dissolve', () => {
  it('a null poll result (party closed) reverts to the pre-party state with a status message', async () => {
    const api = fakeApi({
      createParty: vi.fn().mockResolvedValue(PARTY),
      getParty: vi.fn().mockResolvedValue(null),
    });
    const s = makeScreen(api);
    const p = privateOf(s);
    await p.doCreate();
    await p.pollOnce();
    expect(p.statusText.text).toMatch(/closed/i);
    expect(p.createBtn.view.visible).toBe(true);
  });
});

describe('PartyScreen — hide()', () => {
  it('hides the view without throwing even with no open input overlay', () => {
    const s = makeScreen(fakeApi());
    expect(() => s.hide()).not.toThrow();
  });
});

describe('PartyScreen — i18n (design/17-i18n.md)', () => {
  it('retexts on show() under zh', () => {
    const s = makeScreen(fakeApi());
    setLocale('zh');
    s.show(800, 600);
    const p = privateOf(s);
    expect(p.title.text).toBe('组队');
    expect(p.createBtn.label.text).toBe('创建队伍');
    expect(p.joinBtn.label.text).toBe('输入邀请码加入');
  });

  it('translates the code line, member "you" label, and status messages under zh', async () => {
    const api = fakeApi({ createParty: vi.fn().mockResolvedValue(PARTY) });
    setLocale('zh');
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    const p = privateOf(s);
    expect(p.codeText.text).toBe('邀请码：ABCDE');
    expect(p.membersText.text).toContain('你');
  });

  it('a failed create under zh surfaces the translated error', async () => {
    const api = fakeApi({ createParty: vi.fn().mockRejectedValue(new Error('boom')) });
    setLocale('zh');
    const s = makeScreen(api);
    await privateOf(s).doCreate();
    expect(privateOf(s).statusText.text).toBe('创建队伍失败，请重试。');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const s = makeScreen(fakeApi());
    setLocale('zh');
    s.show(800, 600);
    setLocale('en');
    s.show(800, 600);
    expect(privateOf(s).title.text).toBe('SQUAD');
  });
});
