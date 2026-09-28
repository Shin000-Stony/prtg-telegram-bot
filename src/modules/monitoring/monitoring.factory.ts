import type { EnvConfig } from '@/config/env';
import { MonitoringEngine, type MonitoringEngineDeps } from './monitoring.engine';
import { MonitoringRepository } from './monitoring.repository';
import { IcmpAdapter, createIcmpPingRunner, type IcmpResult } from './icmp.adapter';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { customerService } from '@/modules/customers/customer.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { getLogger } from '@/core/logger';
import type { MonitoringConfig } from '@/modules/monitoring/monitoring.types';
import type { AlertingMonitoringRepositoryPort } from './monitoring.types';

export function createMonitoringConfig(config: EnvConfig): MonitoringConfig {
  return {
    enabled: config.MONITORING_ENABLED,
    prtgPollIntervalMs: config.PRTG_POLL_INTERVAL_MS,
    icmpPollIntervalMs: config.ICMP_POLL_INTERVAL_MS,
    icmpTimeoutMs: config.ICMP_TIMEOUT_MS,
    icmpConcurrency: config.ICMP_CONCURRENCY,
  };
}

export { MonitoringConfig } from './monitoring.types';
export { createIcmpPingRunner } from './icmp.adapter';

export function createMonitoringEngine(config: EnvConfig, clock: () => number = Date.now): MonitoringEngine {
  return createMonitoringEngineWithDeps(config, clock, createIcmpPingRunner());
}

export function createMonitoringEngineWithDeps(
  config: EnvConfig,
  clock: () => number,
  runPing: (host: string, timeoutMs: number, signal?: AbortSignal) => Promise<IcmpResult>,
): MonitoringEngine {
  return createMonitoringEngineWithAlerting(config, clock, runPing, null);
}

export function createMonitoringEngineWithAlerting(
  config: EnvConfig,
  clock: () => number,
  runPing: (host: string, timeoutMs: number, signal?: AbortSignal) => Promise<IcmpResult>,
  alertingRepo: AlertingMonitoringRepositoryPort | null,
): MonitoringEngine {
  const log = getLogger().child({ module: 'MonitoringFactory' });

  const monitoringConfig = createMonitoringConfig(config);

  let icmpAdapter: IcmpAdapter | null = null;
  if (monitoringConfig.enabled) {
    icmpAdapter = new IcmpAdapter({
      runPing,
      clock,
    });
  }

  const baseRepo = new MonitoringRepository();
  const repository: AlertingMonitoringRepositoryPort = alertingRepo ?? baseRepo;

  const deps: MonitoringEngineDeps = {
    customerService: {
      listAll(filters?: { enabled?: boolean; monitorType?: string }) {
        return customerService.listAll(filters);
      },
      getByClientId(clientId: string) {
        return customerService.getByClientId(clientId);
      },
    },
    mappingService: {
      getByCustomerId(customerId: number) {
        return mappingService.getByCustomerId(customerId);
      },
    },
    cache: hasPrtgInventoryCache() ? getPrtgInventoryCache()! : null,
    icmpAdapter,
    repository,
    clock,
    setTimeout: (cb: () => void, ms: number) => {
      const timer = setTimeout(cb, ms);
      return {
        cancel() {
          clearTimeout(timer);
        },
      };
    },
  };

  log.info({ enabled: monitoringConfig.enabled, alerting: !!alertingRepo }, 'Monitoring engine factory created');
  return new MonitoringEngine(deps, monitoringConfig);
}
