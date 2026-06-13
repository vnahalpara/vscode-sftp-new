import { PlatformAdapter } from '../types';
import { magentoAdapter } from './magentoAdapter';

// WordPress adapter is deferred; only Magento is implemented in Phase 1.
export function getAdapter(platform: string): PlatformAdapter | undefined {
  if (platform === 'magento2') {
    return magentoAdapter;
  }
  return undefined;
}
