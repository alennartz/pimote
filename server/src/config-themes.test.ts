import { describe, expect, it } from 'vitest';
import { ConfigRuntime } from './config-runtime.js';
import { parseConfig, type PimoteConfig } from './config.js';

const base: PimoteConfig = {
  roots: ['/workspace'],
  managerRoot: '/workspace/manager',
  port: 3000,
  idleTimeout: 1000,
  bufferSize: 100,
};

describe('native theme configuration', () => {
  it('defaults the native theme to Pimote Light', () => {
    expect(parseConfig('{"roots":["/workspace"]}', '/tmp/config.json', '/home/user').defaultTheme).toBe('pimote/light');
  });

  it('accepts a configured default theme ID', () => {
    expect(parseConfig('{"roots":["/workspace"],"defaultTheme":"nord/nord"}', '/tmp/config.json', '/home/user').defaultTheme).toBe('nord/nord');
  });

  it('keeps the live default theme when unrelated native fields reload', () => {
    const runtime = new ConfigRuntime({ configPath: '/tmp/config.json', config: { ...base, defaultTheme: 'pimote/light' } });

    runtime.apply({ ...base, defaultTheme: 'nord/nord', tagSnippets: ['context'] });

    expect(runtime.snapshot().defaultTheme).toBe('nord/nord');
  });
});
