import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce an 11-character URL-safe ID', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should not repeat across 10k generations', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));

    expect(ids.size).toBe(10_000);
  });

  it('should only use URL-safe characters across many generations', () => {
    const joined = Array.from({ length: 1_000 }, generatePublicId).join('');

    expect(joined).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
