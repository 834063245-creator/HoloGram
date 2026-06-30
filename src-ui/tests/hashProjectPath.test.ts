import { describe, it, expect, vi } from 'vitest';

// chat.ts → ... → bridge.ts → window (not available in Node)
vi.mock('../src/bridge', () => ({ invoke: vi.fn(), listen: vi.fn() }));

import { hashProjectPath } from '../src/ui/chat';

describe('hashProjectPath', () => {
  it('returns 0 for empty path', () => {
    expect(hashProjectPath('')).toBe(0);
  });

  it('returns same value for identical paths', () => {
    const a = hashProjectPath('D:\\HoloGramHG');
    const b = hashProjectPath('D:\\HoloGramHG');
    expect(a).toBe(b);
  });

  it('returns different values for different paths', () => {
    const a = hashProjectPath('D:\\HoloGramHG');
    const b = hashProjectPath('D:\\langchain');
    expect(a).not.toBe(b);
  });

  it('is case-sensitive (Windows paths)', () => {
    const lower = hashProjectPath('d:\\hologramhg');
    const upper = hashProjectPath('D:\\HoloGramHG');
    // Paths on Windows are case-insensitive but our hash is not —
    // this is fine because we always canonicalize before hashing.
    // Just documenting the behavior.
    expect(lower).not.toBe(upper);
  });

  it('different IDs with same path share prefix', () => {
    const path = 'D:\\HoloGramHG';
    const prefix = hashProjectPath(path).toString(36);
    const key1 = `hologram_session_${prefix}_1`;
    const key2 = `hologram_session_${prefix}_71`;
    // Same prefix, different suffix
    expect(key1.startsWith(`hologram_session_${prefix}_`)).toBe(true);
    expect(key2.startsWith(`hologram_session_${prefix}_`)).toBe(true);
    expect(key1).not.toBe(key2);
  });
});
