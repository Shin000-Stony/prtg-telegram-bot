import type { MonitoringState, Observation, ObservationStatus, MonitoringCycleResult, MonitoringConfig, AlertingMonitoringRepositoryPort } from './monitoring.types';
import type { PrtgInventoryCache, InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';
import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgMapping } from '@/modules/mapping/mapping.types';
import { reduceState, fingerprintToString, createObservationId } from './monitoring.reducer';
import type { IcmpAdapter, IcmpResult } from './icmp.adapter';
import { getLogger } from '@/core/logger';
import { normalizeSensorStatus } from '@/modules/status/status.normalizer';
import type { PrtgSensor } from '@/integrations/prtg/prtg.types';

export interface MonitoringEngineDeps {
  customerService: {
    listAll(filters?: { enabled?: boolean; monitorType?: string }): Customer[];
    getByClientId(clientId: string): Customer | null;
  };
  mappingService: {
    getByCustomerId(customerId: number): PrtgMapping | null;
  };
  cache: PrtgInventoryCache | null;
  icmpAdapter: IcmpAdapter | null;
  repository: AlertingMonitoringRepositoryPort;
  clock: () => number;
  setTimeout: (cb: () => void, ms: number) => { cancel(): void };
}

interface CapturedTarget {
  customerId: number;
  clientId: string;
  objectId: number | null;
  fingerprint: string;
  host: string | null;
  monitorType: string;
}

export class MonitoringEngine {
  private readonly log = getLogger().child({ module: 'MonitoringEngine', service: 'prtg-telegram-bot' });
  private readonly deps: MonitoringEngineDeps;
  private readonly config: MonitoringConfig;
  private prtgTimer: { cancel(): void } | null = null;
  private icmpTimer: { cancel(): void } | null = null;
  private running = false;
  private stopped = false;
  private lastPrtgGeneration = -1;
  private lastPrtgFetchedAt: string | null = null;
  private activePrtgPromise: Promise<void> | null = null;
  private activeIcmpPromise: Promise<void> | null = null;
  private icmpAbortController: AbortController | null = null;
  private stopPromise: Promise<void> | null = null;
  private isStopping = false;

  constructor(deps: MonitoringEngineDeps, config: MonitoringConfig) {
    this.deps = deps;
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      this.log.info('Monitoring engine disabled via config');
      return;
    }

    this.running = true;
    this.stopped = false;
    this.isStopping = false;
    this.stopPromise = null;

    this.resetCandidateOnStart();

    this.log.info({
      prtgInterval: this.config.prtgPollIntervalMs,
      icmpInterval: this.config.icmpPollIntervalMs,
      icmpConcurrency: this.config.icmpConcurrency,
    }, 'Monitoring engine started');

    this.schedulePrtgCycle(0);
    this.scheduleIcmpCycle(0);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.isStopping = true;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    if (this.prtgTimer) { this.prtgTimer.cancel(); this.prtgTimer = null; }
    if (this.icmpTimer) { this.icmpTimer.cancel(); this.icmpTimer = null; }
    this.icmpAbortController?.abort();
    this.icmpAbortController = null;

    if (this.activePrtgPromise) {
      const p = this.activePrtgPromise;
      await p.catch(() => undefined);
    }
    if (this.activeIcmpPromise) {
      const p = this.activeIcmpPromise;
      await p.catch(() => undefined);
    }

    this.running = false;
    this.isStopping = false;
    this.log.info('Monitoring engine stopped');
  }

  private resetCandidateOnStart(): void {
    try {
      const allStates = this.deps.repository.findAll();
      for (const state of allStates) {
        if (state.consecutiveCount > 0) {
          this.deps.repository.upsert({
            ...state,
            consecutiveCount: 0,
          });
        }
      }
    } catch (error) {
      this.log.warn({ err: error }, 'Failed to reset candidate state on start');
    }
  }

  private schedulePrtgCycle(delayMs: number): void {
    if (!this.running || this.stopped || this.isStopping) return;

    this.prtgTimer = this.deps.setTimeout(() => {
      this.prtgTimer = null;
      if (!this.running || this.stopped || this.isStopping) return;

      const cyclePromise = this.runPrtgCycle();
      this.activePrtgPromise = cyclePromise.catch(() => undefined).then(() => {
        this.activePrtgPromise = null;
        if (this.running && !this.stopped && !this.isStopping) {
          this.schedulePrtgCycle(this.config.prtgPollIntervalMs);
        }
      });
    }, delayMs);
  }

  private scheduleIcmpCycle(delayMs: number): void {
    if (!this.running || this.stopped || this.isStopping) return;

    this.icmpTimer = this.deps.setTimeout(() => {
      this.icmpTimer = null;
      if (!this.running || this.stopped || this.isStopping) return;

      const cyclePromise = this.runIcmpCycle();
      this.activeIcmpPromise = cyclePromise.catch(() => undefined).then(() => {
        this.activeIcmpPromise = null;
        if (this.running && !this.stopped && !this.isStopping) {
          this.scheduleIcmpCycle(this.config.icmpPollIntervalMs);
        }
      });
    }, delayMs);
  }

  async runOncePrtg(): Promise<MonitoringCycleResult> {
    if (this.isStopping || this.stopped) {
      return { cycle: 'prtg', generatedAt: this.deps.clock(), observations: 0, errors: 0 };
    }
    if (this.activePrtgPromise !== null) {
      return { cycle: 'prtg', generatedAt: this.deps.clock(), observations: 0, errors: 0 };
    }
    return this.runPrtgCycle();
  }

  async runOnceIcmp(): Promise<MonitoringCycleResult> {
    if (this.isStopping || this.stopped) {
      return { cycle: 'icmp', generatedAt: this.deps.clock(), observations: 0, errors: 0 };
    }
    if (this.activeIcmpPromise !== null) {
      return { cycle: 'icmp', generatedAt: this.deps.clock(), observations: 0, errors: 0 };
    }
    return this.runIcmpCycle();
  }

  async runPrtgCycle(): Promise<MonitoringCycleResult> {
    if (this.activePrtgPromise !== null) {
      return { cycle: 'prtg', generatedAt: this.deps.clock(), observations: 0, errors: 0 };
    }

    const cyclePromise = this.executePrtgCycle();
    this.activePrtgPromise = cyclePromise.catch(() => undefined).then(() => undefined);
    return cyclePromise.catch((error) => {
      this.log.error({ err: error }, 'PRTG cycle threw unhandled error');
      return { cycle: 'prtg', generatedAt: this.deps.clock(), observations: 0, errors: 1 } as MonitoringCycleResult;
    }).finally(() => { this.activePrtgPromise = null; });
  }

  private async executePrtgCycle(): Promise<MonitoringCycleResult> {
    const startTime = this.deps.clock();
    let observations = 0;
    let errors = 0;

    if (!this.deps.cache) {
      return { cycle: 'prtg', generatedAt: startTime, observations: 0, errors: 0 };
    }

    const customers = this.deps.customerService.listAll({ enabled: true, monitorType: 'prtg' });
    const mappedCustomers = customers.filter(c => {
      const m = this.deps.mappingService.getByCustomerId(c.id);
      return !!m;
    });
    if (mappedCustomers.length === 0) {
      return { cycle: 'prtg', generatedAt: startTime, observations: 0, errors: 0 };
    }

    const capturedTargets: CapturedTarget[] = [];
    for (const c of mappedCustomers) {
      const m = this.deps.mappingService.getByCustomerId(c.id);
      if (!m) continue;
      capturedTargets.push({
        customerId: c.id,
        clientId: c.clientId,
        objectId: m.prtgObjectId,
        fingerprint: fingerprintToString('prtg', c.enabled, c.pingHost, m.prtgObjectId),
        host: null,
        monitorType: c.monitorType,
      });
    }

    let snap: InventorySnapshot | null = null;
    let refreshFailed = false;
    try {
      snap = await this.deps.cache.forceRefresh();
    } catch (error) {
      this.log.warn({ err: error }, 'PRTG refresh failed; keeping existing cache');
      errors++;
      refreshFailed = true;
    }

    if (this.stopped) {
      return { cycle: 'prtg', generatedAt: startTime, observations: 0, errors };
    }

    if (refreshFailed) {
      return { cycle: 'prtg', generatedAt: startTime, observations: 0, errors };
    }

    const generation = snap!.generation;
    const fetchedAt = snap!.fetchedAt;
    if (generation === this.lastPrtgGeneration && fetchedAt === this.lastPrtgFetchedAt) {
      return { cycle: 'prtg', generatedAt: startTime, observations: 0, errors: 0 };
    }

    const sourceTime = new Date(fetchedAt).getTime();
    const statesToUpsert: MonitoringState[] = [];

    for (const target of capturedTargets) {
      if (this.stopped) break;

      const currentCustomer = this.deps.customerService.getByClientId(target.clientId);
      if (!currentCustomer || currentCustomer.id !== target.customerId) {
        continue;
      }
      if (!currentCustomer.enabled || currentCustomer.monitorType !== 'prtg') {
        continue;
      }
      const currentMapping = this.deps.mappingService.getByCustomerId(target.customerId);
      if (!currentMapping || currentMapping.prtgObjectId !== target.objectId) {
        continue;
      }

      const sensor = snap!.sensors.find((s: PrtgSensor) => s.objectId === target.objectId) ?? null;
      const fingerprint = fingerprintToString('prtg', currentCustomer.enabled, currentCustomer.pingHost, currentMapping.prtgObjectId);
      const prevState = this.deps.repository.findById(target.customerId);

      let observation: Observation;
      if (sensor && sensor.sensorType.toLowerCase() === 'ping') {
        const normalized = normalizeSensorStatus(sensor.statusRaw);
        let status: ObservationStatus;
        if (normalized.status === 'UP') {
          status = 'UP';
        } else if (normalized.status === 'DOWN') {
          status = 'DOWN';
        } else {
          status = normalized.status as ObservationStatus;
        }
        observation = {
          status,
          reason: normalized.reason,
          rawStatus: sensor.statusRaw,
          source: 'prtg',
          generation,
          attemptAt: sourceTime,
          completionAt: sourceTime,
          observationId: createObservationId('prtg', generation, fetchedAt, target.objectId),
          rtt: null,
        };
      } else if (!sensor) {
        observation = {
          status: 'UNKNOWN', reason: 'sensor_not_found', rawStatus: null, source: 'prtg',
          generation, attemptAt: sourceTime, completionAt: sourceTime,
          observationId: createObservationId('prtg', generation, fetchedAt, target.objectId),
          rtt: null,
        };
      } else {
        observation = {
          status: 'UNKNOWN', reason: 'target_not_ping', rawStatus: null, source: 'prtg',
          generation, attemptAt: sourceTime, completionAt: sourceTime,
          observationId: createObservationId('prtg', generation, fetchedAt, target.objectId),
          rtt: null,
        };
      }

      const newState = reduceState({
        prev: prevState,
        observation,
        now: sourceTime,
        fingerprint,
        gapThresholdMs: this.config.prtgPollIntervalMs * 2,
        monitorType: 'prtg',
        customerId: target.customerId,
      });

      statesToUpsert.push(newState);
      observations++;
    }

    if (statesToUpsert.length > 0 && !this.stopped) {
      try {
        this.deps.repository.upsertBatch(statesToUpsert);
        this.lastPrtgGeneration = generation;
        this.lastPrtgFetchedAt = fetchedAt;
      } catch (error) {
        this.log.warn({ err: error }, 'Failed to persist PRTG monitoring states');
        errors++;
      }
    }

    const elapsed = this.deps.clock() - startTime;
    this.log.info({
      customers: capturedTargets.length,
      observations,
      errors,
      elapsedMs: elapsed,
      cycle: 'prtg',
      generation,
    }, 'Monitoring cycle completed');

    return { cycle: 'prtg', generatedAt: startTime, observations, errors };
  }

  async runIcmpCycle(): Promise<MonitoringCycleResult> {
    if (this.activeIcmpPromise !== null) {
      return { cycle: 'icmp', generatedAt: this.deps.clock(), observations: 0, errors: 0 };
    }

    const cyclePromise = this.executeIcmpCycle();
    this.activeIcmpPromise = cyclePromise.catch(() => undefined).then(() => undefined);
    return cyclePromise.catch((error) => {
      this.log.error({ err: error }, 'ICMP cycle threw unhandled error');
      return { cycle: 'icmp', generatedAt: this.deps.clock(), observations: 0, errors: 1 } as MonitoringCycleResult;
    }).finally(() => { this.activeIcmpPromise = null; });
  }

  private async executeIcmpCycle(): Promise<MonitoringCycleResult> {
    const startTime = this.deps.clock();
    let observations = 0;
    let errors = 0;

    if (!this.deps.icmpAdapter) {
      return { cycle: 'icmp', generatedAt: startTime, observations: 0, errors: 0 };
    }

    const customers = this.deps.customerService.listAll({ enabled: true, monitorType: 'icmp' });
    if (customers.length === 0) {
      return { cycle: 'icmp', generatedAt: startTime, observations: 0, errors: 0 };
    }

    const capturedTargets: CapturedTarget[] = [];
    for (const c of customers) {
      if (c.pingHost) {
        capturedTargets.push({
          customerId: c.id,
          clientId: c.clientId,
          objectId: null,
          fingerprint: fingerprintToString('icmp', c.enabled, c.pingHost, null),
          host: c.pingHost,
          monitorType: c.monitorType,
        });
      }
    }

    if (capturedTargets.length === 0) {
      return { cycle: 'icmp', generatedAt: startTime, observations: 0, errors: 0 };
    }

    if (this.icmpAbortController) {
      this.icmpAbortController.abort();
    }
    this.icmpAbortController = new AbortController();
    const signal = this.icmpAbortController.signal;

    const probeStartTime = this.deps.clock();
    let results: Map<string, IcmpResult>;
    try {
      results = await this.deps.icmpAdapter.probeEligible(
        capturedTargets.map(ct => ({ host: ct.host!, generation: 1 })),
        this.config.icmpConcurrency,
        this.config.icmpTimeoutMs,
        signal,
      );
    } catch {
      return { cycle: 'icmp', generatedAt: startTime, observations: 0, errors };
    }

    const statesToUpsert: MonitoringState[] = [];

    for (const target of capturedTargets) {
      if (this.stopped) break;

      const currentCustomer = this.deps.customerService.getByClientId(target.clientId);
      if (!currentCustomer || currentCustomer.id !== target.customerId) {
        continue;
      }
      if (!currentCustomer.enabled || currentCustomer.monitorType !== 'icmp') {
        continue;
      }
      if (currentCustomer.pingHost !== target.host) {
        continue;
      }

      const fingerprint = fingerprintToString('icmp', currentCustomer.enabled, currentCustomer.pingHost, null);
      const prevState = this.deps.repository.findById(target.customerId);
      const result = results.get(target.host!);

      let observation: Observation;
      if (result) {
        let status: ObservationStatus;
        if (result.status === 'UP') {
          status = 'UP';
        } else if (result.status === 'DOWN') {
          status = 'DOWN';
        } else {
          status = 'UNKNOWN';
        }
        observation = {
          status,
          reason: result.reason,
          rawStatus: result.rtt,
          source: 'icmp',
          generation: 1,
          attemptAt: result.attemptAt,
          completionAt: result.completionAt,
          observationId: createObservationId('icmp', 1, target.host!, result.completionAt),
          rtt: result.rtt,
        };
      } else {
        const now = this.deps.clock();
        observation = {
          status: 'UNKNOWN', reason: 'no_result', rawStatus: null, source: 'icmp',
          generation: 1, attemptAt: probeStartTime, completionAt: now,
          observationId: createObservationId('icmp', 1, target.host!, now),
          rtt: null,
        };
      }

      const newState = reduceState({
        prev: prevState,
        observation,
        now: observation.completionAt,
        fingerprint,
        gapThresholdMs: this.config.icmpPollIntervalMs * 2,
        monitorType: 'icmp',
        customerId: target.customerId,
      });

      statesToUpsert.push(newState);
      observations++;
    }

    if (statesToUpsert.length > 0 && !this.stopped) {
      try {
        this.deps.repository.upsertBatch(statesToUpsert);
      } catch (error) {
        this.log.warn({ err: error }, 'Failed to persist ICMP monitoring states');
        errors++;
      }
    }

    const elapsed = this.deps.clock() - startTime;
    this.log.info({
      customers: capturedTargets.length,
      observations,
      errors,
      elapsedMs: elapsed,
      cycle: 'icmp',
    }, 'Monitoring cycle completed');

    return { cycle: 'icmp', generatedAt: startTime, observations, errors };
  }

  isRunning(): boolean {
    return this.running;
  }
}
