import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgMapping } from '@/modules/mapping/mapping.types';
import type { PrtgSensor, PrtgInventorySnapshot } from '@/integrations/prtg/prtg.types';
import type { AccessContext } from '@/modules/groups/access.service';
import type {
  StatusDetail,
  SummaryResult,
  DownResult,
  StatusContext,
  EffectiveStatus,
} from './status.types';
import { normalizeSensorStatus, resolveStatusDetail } from './status.normalizer';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { MappingService } from '@/modules/mapping/mapping.service';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { monitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { getConfig } from '@/config/env';

const DOWN_PAGE_SIZE = 20;

export class StatusService {
  private mappingService: MappingService;
  private clock: () => number;
  private icmpFreshThresholdMs: number;

  constructor(mappingService?: MappingService, clock: () => number = Date.now) {
    this.mappingService = mappingService ?? new MappingService();
    this.clock = clock;
    try {
      const config = getConfig();
      this.icmpFreshThresholdMs = config.ICMP_POLL_INTERVAL_MS * 2;
    } catch {
      this.icmpFreshThresholdMs = 60000;
    }
  }

  private resolveSnapshot(): { snap: PrtgInventorySnapshot | null; quality: 'fresh' | 'stale' | 'unavailable'; fetchedAt: string | null } {
    if (!hasPrtgInventoryCache()) {
      return { snap: null, quality: 'unavailable', fetchedAt: null };
    }
    const cache = getPrtgInventoryCache()!;
    const fresh = cache.getFresh();
    if (fresh) {
      return { snap: fresh, quality: 'fresh', fetchedAt: fresh.fetchedAt };
    }
    const stale = cache.getStale();
    if (stale) {
      return { snap: stale, quality: 'stale', fetchedAt: stale.fetchedAt };
    }
    return { snap: null, quality: 'unavailable', fetchedAt: null };
  }

  private findSensor(snap: PrtgInventorySnapshot | null, objectId: number): PrtgSensor | null {
    return snap ? snap.sensors.find((s: PrtgSensor) => s.objectId === objectId) ?? null : null;
  }

  getCustomerStatus(context: StatusContext, clientId: string): StatusDetail {
    const ctx: AccessContext = { userId: context.userId, chatId: context.chatId, chatType: context.chatType };

    const scope = accessService.getCustomerAccessScope(ctx);
    if (scope.kind === 'none') {
      return this.buildDeniedStatus();
    }

    const customer = customerService.getByClientId(clientId);
    if (!customer) {
      return this.buildDeniedStatus();
    }

    if (!accessService.canViewCustomer(ctx, customer.id)) {
      return this.buildDeniedStatus();
    }

    const mapping = this.mappingService.getByCustomerId(customer.id);
    const { snap, quality, fetchedAt } = this.resolveSnapshot();

    let lastKnownStatus: EffectiveStatus | null = null;
    if (quality === 'stale' && snap && mapping) {
      const prevSensor = this.findSensor(snap, mapping.prtgObjectId);
      if (prevSensor && prevSensor.sensorType.toLowerCase() === 'ping') {
        lastKnownStatus = normalizeSensorStatus(prevSensor.statusRaw).status;
      }
    }

    const monitoringState = customer.monitorType === 'icmp'
      ? monitoringRepository.findById(customer.id)
      : null;

    return resolveStatusDetail({
      customer,
      sensor: mapping ? this.findSensor(snap, mapping.prtgObjectId) : null,
      mapping,
      dataQuality: quality,
      fetchedAt,
      lastKnownStatus,
      monitoringState,
      icmpFreshThresholdMs: this.icmpFreshThresholdMs,
      icmpNow: this.clock,
    });
  }

  getCustomerStatuses(context: StatusContext): StatusDetail[] {
    const ctx: AccessContext = { userId: context.userId, chatId: context.chatId, chatType: context.chatType };

    const scope = accessService.getCustomerAccessScope(ctx);
    if (scope.kind === 'none') {
      return [];
    }

    let customers: Customer[];
    if (scope.kind === 'all') {
      customers = customerService.listAll({});
    } else {
      const ids = scope.customerIds;
      customers = customerService.listAll({}).filter(c => ids.includes(c.id));
    }

    const { snap, quality, fetchedAt } = this.resolveSnapshot();

    return customers.map((customer) => {
      const mapping = this.mappingService.getByCustomerId(customer.id);
      const monitoringState = customer.monitorType === 'icmp'
        ? monitoringRepository.findById(customer.id)
        : null;
      return resolveStatusDetail({
        customer,
        sensor: mapping ? this.findSensor(snap, mapping.prtgObjectId) : null,
        mapping,
        dataQuality: quality,
        fetchedAt,
        lastKnownStatus: null,
        monitoringState,
        icmpFreshThresholdMs: this.icmpFreshThresholdMs,
        icmpNow: this.clock,
      });
    });
  }

  getSummary(context: StatusContext): SummaryResult {
    const ctx: AccessContext = { userId: context.userId, chatId: context.chatId, chatType: context.chatType };

    const scope = accessService.getCustomerAccessScope(ctx);
    if (scope.kind === 'none') {
      return { total: 0, buckets: [], dataQuality: { fresh: 0, stale: 0, unavailable: 0, notApplicable: 0 }, fetchedAt: null };
    }

    let customers: Customer[];
    if (scope.kind === 'all') {
      customers = customerService.listAll({});
    } else {
      const ids = scope.customerIds;
      customers = customerService.listAll({}).filter(c => ids.includes(c.id));
    }

    return this.buildSummaryResult(customers);
  }

  listDown(context: StatusContext, page: number): DownResult {
    const ctx: AccessContext = { userId: context.userId, chatId: context.chatId, chatType: context.chatType };

    const scope = accessService.getCustomerAccessScope(ctx);
    if (scope.kind === 'none') {
      return { items: [], total: 0, page, totalPages: 0, fetchedAt: null, dataQuality: 'unavailable', uncertainCount: 0, pageOutOfRange: false };
    }

    let customers: Customer[];
    if (scope.kind === 'all') {
      customers = customerService.listAll({});
    } else {
      const ids = scope.customerIds;
      customers = customerService.listAll({}).filter(c => ids.includes(c.id));
    }

    return this.buildDownResult(customers, page);
  }

  private buildSummaryResult(customers: Customer[]): SummaryResult {
    const { snap, quality: globalQuality, fetchedAt } = this.resolveSnapshot();

    const buckets: Record<string, number> = {};
    const dq = { fresh: 0, stale: 0, unavailable: 0, notApplicable: 0 };

    for (const customer of customers) {
      const mapping = this.mappingService.getByCustomerId(customer.id);
      const monitoringState = customer.monitorType === 'icmp'
        ? monitoringRepository.findById(customer.id)
        : null;
      const detail = resolveStatusDetail({
        customer,
        sensor: mapping ? this.findSensor(snap, mapping.prtgObjectId) : null,
        mapping,
        dataQuality: globalQuality,
        fetchedAt,
        lastKnownStatus: null,
        monitoringState,
        icmpFreshThresholdMs: this.icmpFreshThresholdMs,
        icmpNow: this.clock,
      });

      const bucketKey = detail.status;
      buckets[bucketKey] = (buckets[bucketKey] ?? 0) + 1;

      if (detail.dataQuality === 'fresh') {
        dq.fresh += 1;
      } else if (detail.dataQuality === 'stale') {
        dq.stale += 1;
      } else if (detail.dataQuality === 'unavailable') {
        dq.unavailable += 1;
      } else {
        dq.notApplicable += 1;
      }
    }

    return {
      total: customers.length,
      buckets: Object.entries(buckets).map(([status, count]) => ({ status: status as StatusDetail['status'], count })),
      dataQuality: dq,
      fetchedAt,
    };
  }

  private buildDownResult(customers: Customer[], page: number): DownResult {
    const { snap, quality, fetchedAt } = this.resolveSnapshot();

    const downCustomers: Array<{ customer: Customer; mapping: PrtgMapping | null; sensor: PrtgSensor | null }> = [];
    let uncertainCount = 0;

    for (const customer of customers) {
      if (!customer.enabled || customer.monitorType !== 'prtg' && customer.monitorType !== 'icmp') {
        continue;
      }

      const mapping = customer.monitorType === 'prtg' ? this.mappingService.getByCustomerId(customer.id) : null;
      if (customer.monitorType === 'prtg' && !mapping) {
        continue;
      }

      const monitoringState = customer.monitorType === 'icmp'
        ? monitoringRepository.findById(customer.id)
        : null;

      const detail = resolveStatusDetail({
        customer,
        sensor: mapping ? this.findSensor(snap, mapping.prtgObjectId) : null,
        mapping,
        dataQuality: quality,
        fetchedAt,
        lastKnownStatus: null,
        monitoringState,
        icmpFreshThresholdMs: this.icmpFreshThresholdMs,
        icmpNow: this.clock,
      });

      if (detail.dataQuality === 'fresh') {
        if (detail.status === 'DOWN') {
          downCustomers.push({ customer, mapping, sensor: mapping ? this.findSensor(snap, mapping.prtgObjectId) : null });
        } else if (detail.status === 'UNKNOWN') {
          uncertainCount += 1;
        }
      } else {
        uncertainCount += 1;
      }
    }

    downCustomers.sort((a, b) => a.customer.clientId.localeCompare(b.customer.clientId));

    const total = downCustomers.length;
    const totalPages = Math.max(1, Math.ceil(total / DOWN_PAGE_SIZE));

    if (page < 1 || page > totalPages || page === 0) {
      return {
        items: [],
        total,
        page,
        totalPages,
        fetchedAt,
        dataQuality: quality,
        uncertainCount,
        pageOutOfRange: true,
      };
    }

    const start = (page - 1) * DOWN_PAGE_SIZE;

    return {
      items: downCustomers.slice(start, start + DOWN_PAGE_SIZE).map(item => ({
        clientId: item.customer.clientId,
        customerName: item.customer.name,
        objectId: item.mapping?.prtgObjectId ?? null,
        deviceName: item.sensor?.deviceName ?? null,
        sensorName: item.sensor?.sensorName ?? null,
        lastValue: item.sensor?.lastValue ?? null,
      })),
      total,
      page,
      totalPages,
      fetchedAt,
      dataQuality: quality,
      uncertainCount,
      pageOutOfRange: false,
    };
  }

  private buildDeniedStatus(): StatusDetail {
    return {
      status: 'UNKNOWN' as const,
      reason: 'unknown',
      dataQuality: 'unavailable',
      lastValue: null,
      statusDisplay: null,
      rawStatus: null,
      fetchedAt: null,
      customer: { id: 0, clientId: '', name: '', monitorType: '', enabled: false },
      mapping: null,
      autoUnverified: false,
      lastKnownStatus: null,
    };
  }
}

export const statusService = new StatusService();
