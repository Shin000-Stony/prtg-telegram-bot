export const MONITOR_TYPES = ['prtg', 'icmp', 'pic', 'disabled'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const MAPPING_METHODS = ['auto', 'manual', 'import'] as const;
export type MappingMethod = (typeof MAPPING_METHODS)[number];

export const MAPPING_DECISION_KINDS = ['automatic', 'suggestions', 'unresolved'] as const;
export type MappingDecisionKind = (typeof MAPPING_DECISION_KINDS)[number];

export const CHAT_TYPES = ['private', 'group', 'supergroup', 'channel'] as const;
export type ChatType = (typeof CHAT_TYPES)[number];

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;