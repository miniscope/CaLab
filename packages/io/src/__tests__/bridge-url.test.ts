import { afterEach, describe, it, expect, vi } from 'vitest';
import { getBridgeUrl } from '../bridge.ts';

function withLocationSearch(search: string): void {
  vi.stubGlobal('window', { location: { search } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getBridgeUrl', () => {
  it('returns null when ?bridge= is not present', () => {
    withLocationSearch('');
    expect(getBridgeUrl()).toBeNull();
  });

  it('accepts an http://127.0.0.1:PORT URL', () => {
    withLocationSearch('?bridge=http://127.0.0.1:8765');
    expect(getBridgeUrl()).toBe('http://127.0.0.1:8765');
  });

  it('accepts localhost', () => {
    withLocationSearch('?bridge=http://localhost:8765');
    expect(getBridgeUrl()).toBe('http://localhost:8765');
  });

  it('accepts IPv6 loopback', () => {
    withLocationSearch('?bridge=http://[::1]:8765');
    expect(getBridgeUrl()).toBe('http://[::1]:8765');
  });

  it('accepts bare host:port (assumed http://)', () => {
    withLocationSearch('?bridge=127.0.0.1:8765');
    expect(getBridgeUrl()).toBe('http://127.0.0.1:8765');
  });

  it('rejects a non-loopback target — exfiltration vector', () => {
    // The primary CRIT-3 concern: an attacker who controls the link
    // must not be able to point the bridge mechanism at their own host.
    withLocationSearch('?bridge=http://evil.example/collect');
    expect(getBridgeUrl()).toBeNull();
  });

  it('rejects an https:// target', () => {
    // Bridge traffic is local + plain http. An https target is either
    // a typo or an attempt to smuggle the bridge through a third party.
    withLocationSearch('?bridge=https://127.0.0.1:8765');
    expect(getBridgeUrl()).toBeNull();
  });

  it('rejects javascript: pseudo-protocol', () => {
    withLocationSearch('?bridge=javascript:alert(1)');
    expect(getBridgeUrl()).toBeNull();
  });

  it('rejects a public IP that looks loopback-ish', () => {
    withLocationSearch('?bridge=http://127.0.0.1.evil.example/');
    expect(getBridgeUrl()).toBeNull();
  });

  it('rejects a URL that fails to parse', () => {
    withLocationSearch('?bridge=http:///');
    expect(getBridgeUrl()).toBeNull();
  });

  it('normalizes trailing slash to origin', () => {
    withLocationSearch('?bridge=http://127.0.0.1:8765/');
    expect(getBridgeUrl()).toBe('http://127.0.0.1:8765');
  });

  it('ignores the bridge_secret parameter in the returned URL', () => {
    withLocationSearch('?bridge=http://127.0.0.1:8765&bridge_secret=abc123');
    expect(getBridgeUrl()).toBe('http://127.0.0.1:8765');
  });
});
