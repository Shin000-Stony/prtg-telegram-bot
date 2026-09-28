import type { PrtgMapping } from '@/modules/mapping/mapping.types';

export type EffectiveStatus =
  | 'UP'
  | 'DOWN'
  | 'WARNING'
  | 'UNUSUAL'
  | 'PAUSED'
  | 'UNKNOWN'
  | 'UNMAPPED'
  | 'DISABLED'
  | 'PIC_MANAGED'
  | 'NOT_CHECKED';

export type DataQuality = 'fresh' | 'stale' | 'unavailable' | 'not_applicable';

export type StatusReason =
  | 'up'
  | 'down'
  | 'down_acknowledged'
  | 'down_partial'
  | 'warning'
  | 'paused'
  | 'unusual'
  | 'unknown'
  | 'not_checked'
  | 'unmapped'
  | 'disabled'
  | 'pic_managed'
  | 'sensor_not_found'
  | 'target_not_ping'
  | 'no_snapshot'
  | 'snapshot_stale';

export interface StatusDetail {
  status: EffectiveStatus;
  reason: StatusReason;
  dataQuality: DataQuality;
  lastValue: string | null;
  statusDisplay: string | null;
  rawStatus: number | null;
  fetchedAt: string | null;
  customer: {
    id: number;
    clientId: string;
    name: string;
    monitorType: string;
    enabled: boolean;
  };
  mapping: PrtgMapping | null;
  autoUnverified: boolean;
  lastKnownStatus: EffectiveStatus | null;
}

export interface SummaryBucket {
  status: EffectiveStatus;
  count: number;
}

export interface SummaryResult {
  total: number;
  buckets: SummaryBucket[];
  dataQuality: {
    fresh: number;
    stale: number;
    unavailable: number;
    notApplicable: number;
  };
  fetchedAt: string | null;
}

export interface DownItem {
  clientId: string;
  customerName: string;
  objectId: number | null;
  deviceName: string | null;
  sensorName: string | null;
  lastValue: string | null;
}

export interface DownResult {
  items: DownItem[];
  total: number;
  page: number;
  totalPages: number;
  fetchedAt: string | null;
  dataQuality: 'fresh' | 'stale' | 'unavailable';
  uncertainCount: number;
  pageOutOfRange: boolean;
}

export interface StatusContext {
  userId: string;
  chatId: string;
  chatType: string;
}
