import { describe, it, expect } from 'vitest';
import { STATIC_TOKEN_METHODS, isStaticTokenMethodAllowed } from '../static-token';

describe('static token method allowlist', () => {
  it('allows the catalog discovery methods', () => {
    expect(isStaticTokenMethodAllowed('list_tools')).toBe(true);
    expect(isStaticTokenMethodAllowed('list_prompts')).toBe(true);
    expect(isStaticTokenMethodAllowed('list_resource_templates')).toBe(true);
  });

  it('allows get_snapshot (aggregated, non-identifying by contract)', () => {
    expect(isStaticTokenMethodAllowed('get_snapshot')).toBe(true);
  });

  it('refuses data methods', () => {
    expect(isStaticTokenMethodAllowed('list_files')).toBe(false);
    expect(isStaticTokenMethodAllowed('read_resource')).toBe(false);
    expect(isStaticTokenMethodAllowed('get_help')).toBe(false);
    expect(isStaticTokenMethodAllowed('whoami')).toBe(false);
    expect(isStaticTokenMethodAllowed('report_missing_capability')).toBe(false);
  });

  it('exposes a frozen, minimal allowlist', () => {
    expect(Array.from(STATIC_TOKEN_METHODS).sort()).toEqual([
      'get_snapshot',
      'list_prompts',
      'list_resource_templates',
      'list_tools',
    ]);
  });
});
