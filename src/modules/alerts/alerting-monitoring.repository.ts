import { runInTransaction } from '@/infrastructure/database/database';
import { alertRepository, eligibleRecipientQuery } from './alert.repository';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MonitoringRepository } from '../monitoring/monitoring.repository';
import { shouldCreateEvent } from './alert.policy';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import type { AlertingMonitoringRepositoryPort } from '../monitoring/monitoring.types';
import type { MonitoringState } from '../monitoring/monitoring.types';

export class AlertingMonitoringRepository implements AlertingMonitoringRepositoryPort {
    private readonly stateRepo: MonitoringRepository;
    private readonly alertRepo = alertRepository;
    private readonly recipientQuery = eligibleRecipientQuery;
    private readonly clock: () => number;
    private readonly prtgPollIntervalMs: number;
    private readonly icmpPollIntervalMs: number;
    private readonly maxEventAgeMs: number;
    private readonly enabled: boolean;
    private readonly globalChatId: string;

    constructor(
        stateRepo: MonitoringRepository,
        config: {
            clock: () => number;
            prtgPollIntervalMs: number;
            icmpPollIntervalMs: number;
            maxEventAgeMs: number;
            enabled: boolean;
            globalChatId: string;
        }
    ) {
        this.stateRepo = stateRepo;
        this.clock = config.clock;
        this.prtgPollIntervalMs = config.prtgPollIntervalMs;
        this.icmpPollIntervalMs = config.icmpPollIntervalMs;
        this.maxEventAgeMs = config.maxEventAgeMs;
        this.enabled = config.enabled;
        this.globalChatId = config.globalChatId;
    }

    upsert(state: MonitoringState): void {
        this.stateRepo.upsert(state);
    }

    findById(customerId: number): MonitoringState | null {
        return this.stateRepo.findById(customerId);
    }

    findAll(): MonitoringState[] {
        return this.stateRepo.findAll();
    }

    upsertBatch(states: MonitoringState[]): void {
        if (!this.enabled || states.length === 0) {
            this.stateRepo.upsertBatch(states);
            return;
        }

        const previousStates = new Map<number, MonitoringState | null>();

        runInTransaction(() => {
            for (const state of states) {
                const prev = this.stateRepo.findById(state.customerId);
                previousStates.set(state.customerId, prev);
            }

            this.stateRepo.upsertBatch(states);

            if (!this.enabled) return;

            for (const state of states) {
                const prev = previousStates.get(state.customerId) ?? null;
                if (!prev) continue;

                const customer = customerRepository.findById(state.customerId);
                if (!customer || !customer.enabled) continue;

                const mapping = mappingRepository.findByCustomerId(state.customerId);
                const prtgMapping: { prtgObjectId: number; deviceName: string | null; sensorName: string | null } | null = mapping
                    ? {
                        prtgObjectId: mapping.prtgObjectId,
                        deviceName: mapping.prtgDeviceName,
                        sensorName: mapping.prtgSensorName,
                    }
                    : null;

                const captureInput = {
                    prevState: prev,
                    nextState: state,
                    customer: {
                        id: customer.id,
                        clientId: customer.clientId,
                        name: customer.name,
                        monitorType: customer.monitorType as 'prtg' | 'icmp' | 'pic' | 'disabled',
                        pingHost: customer.pingHost,
                        enabled: customer.enabled,
                    },
                    mapping: prtgMapping,
                    clock: this.clock,
                    prtgPollIntervalMs: this.prtgPollIntervalMs,
                    icmpPollIntervalMs: this.icmpPollIntervalMs,
                };

                const { event } = shouldCreateEvent(captureInput);
                if (!event) continue;

                const eligibleRecipients = eligibleRecipientQuery.findAllForCustomer(state.customerId, this.globalChatId);
                // Global group is already handled in findAllForCustomer - it's included if subscribed regardless of enabled state
                const eligible = eligibleRecipients.filter(r => r.receiveAlerts);

                if (eligible.length === 0) continue;

                const expiresAt = Math.min(this.clock() + this.maxEventAgeMs, this.clock() + 86400000);

                this.alertRepo.insertEvent(
                    event,
                    eligible.map(r => ({ groupChatId: r.groupChatId, customerId: r.customerId })),
                    expiresAt,
                    this.clock
                );
            }
        });
    }
}

export function createAlertingMonitoringRepository(
    stateRepo: MonitoringRepository,
    config: {
        clock: () => number;
        prtgPollIntervalMs: number;
        icmpPollIntervalMs: number;
        maxEventAgeMs: number;
        enabled: boolean;
        globalChatId: string;
    }
): AlertingMonitoringRepositoryPort {
    return new AlertingMonitoringRepository(stateRepo, config);
}