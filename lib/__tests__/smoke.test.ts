// lib/__tests__/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('vitest smoke test', () => {
  it('runs arithmetic', () => {
    expect(1 + 1).toBe(2);
  });

  it('has the indexedDB polyfill installed', async () => {
    expect(typeof indexedDB).toBe('object');

    const req = indexedDB.open('smoke-test', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('test');
      };
    });
    expect(db.objectStoreNames.contains('test')).toBe(true);
    db.close();
  });
});
