import type { PrtgInventoryCache } from '@/integrations/prtg/prtg.inventory.cache';

let cacheInstance: PrtgInventoryCache | null = null;

export function setPrtgInventoryCache(cache: PrtgInventoryCache): void {
  cacheInstance = cache;
}

export function getPrtgInventoryCache(): PrtgInventoryCache | null {
  return cacheInstance;
}

export function hasPrtgInventoryCache(): boolean {
  return cacheInstance !== null;
}