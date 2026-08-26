/**
 * THE GATE, applied to shipped content (design/15).
 *
 * `npm run audit:arena` prints a report, and a report cannot fail CI — this is the half that
 * can, which is why it lives in the default `npm test` glob rather than beside the sim. The
 * bar itself, and the reasoning behind every threshold, is `@dd/engine/content/arenaQuality`;
 * this file only decides WHICH maps are held to it, and proves that choice is not vacuous.
 *
 * Three things get asserted, and the second and third are what stop this becoming a rubber
 * stamp the day someone adds a map:
 *
 *   1. every match arena in the catalog clears the bar.
 *   2. the exempt list is exactly the dev fixtures — so a new map is gated by DEFAULT and
 *      exempting one has to be a deliberate, reviewed edit to `DEV_FIXTURE_ARENA_IDS`.
 *   3. the exempt fixture really does FAIL the gate. That is the control: it proves the rules
 *      fire on content from the real catalog, not just on the hand-built fixtures in
 *      `arenaQuality.test.ts`. If `landing_basic` ever starts passing, either the gate has
 *      gone slack or the fixture has quietly become a real map — both worth a failure.
 */
import { describe, it, expect } from 'vitest';
import { auditArenaQuality, formatViolations } from '@dd/engine/content/arenaQuality';
import {
  ARENA_CATALOG,
  ARENA_IDS,
  DEV_FIXTURE_ARENA_IDS,
  MATCH_ARENA_IDS,
} from './arenaCatalog';

describe('arena catalog quality gate', () => {
  it('holds every map a real match can build to the bar', () => {
    // Not a zero-subject sweep: the catalog must contain at least one match arena, or this
    // whole file passes by having nothing to check.
    expect(MATCH_ARENA_IDS.length).toBeGreaterThan(0);
    for (const id of MATCH_ARENA_IDS) {
      const violations = auditArenaQuality(ARENA_CATALOG[id]);
      // The formatted list is the assertion's subject so a failure names what to fix rather
      // than printing a length mismatch.
      expect(`${id}\n${formatViolations(violations)}`).toBe(`${id}\n  (clears the bar)`);
    }
  });

  it('gates by default — the exempt list is exactly the known dev fixtures', () => {
    // A new catalog entry lands in MATCH_ARENA_IDS automatically. This pins the exemption
    // list so growing it is a visible change, and pins the partition so neither side can
    // silently swallow the other.
    expect([...DEV_FIXTURE_ARENA_IDS]).toEqual(['landing_basic']);
    expect([...MATCH_ARENA_IDS, ...DEV_FIXTURE_ARENA_IDS].sort()).toEqual([...ARENA_IDS].sort());
    for (const id of DEV_FIXTURE_ARENA_IDS) expect(MATCH_ARENA_IDS).not.toContain(id);
  });

  it('...and the exempt fixture really does fail it, which is what makes the pass mean something', () => {
    // The control. `landing_basic` is three wall-less rooms with no spawns, so it must trip
    // the defect rules by name — a gate that could not see this could not see anything.
    const fired = auditArenaQuality(ARENA_CATALOG.landing_basic).map((v) => v.rule);
    expect(fired).toContain('no_walls');
    expect(fired).toContain('no_spawns');
    expect(fired).toContain('door_gates_nothing');
    expect(fired).toContain('unenclosed_room');
    // And it is the DEFECT half doing it, not just a design band being fussy.
    const severities = auditArenaQuality(ARENA_CATALOG.landing_basic).map((v) => v.severity);
    expect(severities).toContain('defect');
  });
});
