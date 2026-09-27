import { describe, expect, it } from 'vitest';

describe('JustShare', () => {
  it('core modules are importable', async () => {
    const api = await import('./services/api');
    expect(api.createDevice).toBeDefined();
    const device = await import('./services/device');
    expect(device.getOrCreateDevice).toBeDefined();
  });
});
