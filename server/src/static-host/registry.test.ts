import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStaticHostRegistry, type StaticHostRegistration } from './registry.js';

function reg(over: Partial<StaticHostRegistration> = {}): StaticHostRegistration {
  return {
    slug: 'demo',
    folderPath: '/tmp/demo',
    sessionId: 'sess-1',
    cardMetadata: { title: 'Demo' },
    ...over,
  };
}

describe('InMemoryStaticHostRegistry', () => {
  let r: InMemoryStaticHostRegistry;
  beforeEach(() => {
    r = new InMemoryStaticHostRegistry();
  });

  describe('register / lookup / has', () => {
    it('makes a registration retrievable by slug after register', () => {
      const entry = reg({ slug: 'one' });
      r.register(entry);
      expect(r.has('one')).toBe(true);
      expect(r.lookup('one')).toEqual(entry);
    });

    it('reports unknown slugs as absent', () => {
      expect(r.has('nope')).toBe(false);
      expect(r.lookup('nope')).toBeUndefined();
    });

    it('throws when registering a duplicate slug', () => {
      r.register(reg({ slug: 'dup' }));
      expect(() => r.register(reg({ slug: 'dup', sessionId: 'other' }))).toThrow();
    });

    it('allows the same slug to be re-registered after unregister', () => {
      r.register(reg({ slug: 're' }));
      r.unregister('re');
      expect(() => r.register(reg({ slug: 're' }))).not.toThrow();
      expect(r.has('re')).toBe(true);
    });
  });

  describe('unregister', () => {
    it('removes a registration by slug', () => {
      r.register(reg({ slug: 'a' }));
      r.unregister('a');
      expect(r.has('a')).toBe(false);
      expect(r.lookup('a')).toBeUndefined();
    });

    it('is a no-op for an unknown slug', () => {
      expect(() => r.unregister('ghost')).not.toThrow();
    });
  });

  describe('unregisterAllForSession', () => {
    it('removes every registration owned by the given session', () => {
      r.register(reg({ slug: 'a', sessionId: 's1' }));
      r.register(reg({ slug: 'b', sessionId: 's1' }));
      r.register(reg({ slug: 'c', sessionId: 's2' }));

      r.unregisterAllForSession('s1');

      expect(r.has('a')).toBe(false);
      expect(r.has('b')).toBe(false);
      expect(r.has('c')).toBe(true);
    });

    it('is a no-op for a session with no registrations', () => {
      r.register(reg({ slug: 'x', sessionId: 's1' }));
      expect(() => r.unregisterAllForSession('unknown')).not.toThrow();
      expect(r.has('x')).toBe(true);
    });
  });

  describe('listForSession', () => {
    it('returns every registration owned by the session', () => {
      const a = reg({ slug: 'a', sessionId: 's1' });
      const b = reg({ slug: 'b', sessionId: 's1' });
      r.register(a);
      r.register(b);
      r.register(reg({ slug: 'c', sessionId: 's2' }));

      const out = r.listForSession('s1');
      expect(out).toHaveLength(2);
      expect(out).toEqual(expect.arrayContaining([a, b]));
    });

    it('returns an empty array for a session with no registrations', () => {
      expect(r.listForSession('s-unknown')).toEqual([]);
    });
  });
});
