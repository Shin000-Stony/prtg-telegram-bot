import { bootstrap, shutdown, getDependencies } from './bootstrap';
import { createBot } from './integrations/telegram/bot';
import { helpCommand } from './integrations/telegram/commands/help.command';
import { chatIdCommand } from './integrations/telegram/commands/chatid.command';
import { clientsCommand } from './integrations/telegram/commands/clients.command';
import { clientCommand } from './integrations/telegram/commands/client.command';
import { addClientCommand } from './integrations/telegram/commands/add-client.command';
import { enableClientCommand, disableClientCommand } from './integrations/telegram/commands/client-state.command';
import { registerGroupCommand } from './integrations/telegram/commands/register-group.command';
import { unregisterGroupCommand } from './integrations/telegram/commands/unregister-group.command';
import { groupClientsCommand } from './integrations/telegram/commands/group-clients.command';
import { assignClientCommand } from './integrations/telegram/commands/assign-client.command';
import { unassignClientCommand } from './integrations/telegram/commands/unassign-client.command';
import { groupAlertsCommand } from './integrations/telegram/commands/group-alerts.command';
import { prtgInventoryCommand } from './integrations/telegram/commands/prtg-inventory.command';
import { prtgSearchCommand } from './integrations/telegram/commands/prtg-search.command';
import { mapClientCommand } from './integrations/telegram/commands/map-client.command';
import { statusCommand, summaryCommand, downCommand } from './integrations/telegram/commands/status.command';
import { csvUploadCommand } from './integrations/telegram/commands/csv-upload.command';
import { deleteClientCommand } from './integrations/telegram/commands/delete-client.command';
import { autoMapCommand } from './integrations/telegram/commands/auto-map.command';
import { unmapClientCommand } from './integrations/telegram/commands/unmap-client.command';
import { mappingsCommand } from './integrations/telegram/commands/mappings.command';
import { handleCsvDocument, handleCsvConfirm, handleCsvCancel } from './integrations/telegram/handlers/csv-import.handler';
import { handleUnregisterConfirm, handleUnregisterCancel } from './integrations/telegram/handlers/unregister-group.handler';
import { handleDeleteConfirm, handleDeleteCancel } from './integrations/telegram/handlers/delete-confirm.handler';
import { handleMapConfirm, handleMapCancel, handleMapSearch, handleMapSelect, handleMapVerify, handleAutoMapApply, handleAutoMapCancel, handleUnmapConfirm, handleUnmapCancel, handleSearchPagination } from './integrations/telegram/handlers/mapping-callbacks';
import { handleGroupAlertsToggle, handleGroupAlertsPage, handleGroupAlertsBulk, handleGroupAlertsBulkConfirm, handleGroupAlertsBulkCancel, handleGroupAlertsClose } from './integrations/telegram/handlers/group-alerts-callbacks';
import { handleClientsPagination } from './integrations/telegram/commands/clients.command';
import { setPrtgInventoryCache } from './integrations/prtg/prtg-inventory.shared';
import { getLogger } from './core/logger';
import { createPrtgClient } from './integrations/prtg/prtg.client';
import { HttpsPrtgTransport } from './integrations/prtg/prtg.transport';
import { createPrtgInventoryCache } from './integrations/prtg/prtg.inventory.cache';
import { getPrtgConfig, getConfig } from './config/env';
import { createMonitoringConfig, createMonitoringEngineWithAlerting, createIcmpPingRunner } from './modules/monitoring/monitoring.factory';
import { MonitoringRepository } from './modules/monitoring/monitoring.repository';
import { createAlertingMonitoringRepository } from '@/modules/alerts/alerting-monitoring.repository';
import { createAlertDispatcher } from '@/modules/alerts/alert.dispatcher';
import { createTelegramAlertSender } from '@/integrations/telegram/telegram-alert.sender';
import type { AlertDispatcher } from '@/modules/alerts/alert.dispatcher';
import type { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

let shutdownPromise: Promise<void> | null = null;
let bot: Telegraf<Context> | null = null;
let alertDispatcher: AlertDispatcher | null = null;
let monitoringEngine: { stop: () => Promise<void>; start: () => void; isRunning: () => boolean } | null = null;

async function handleShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  // We need to access the module-level variables from doShutdown
  // They will be set when main() runs
  shutdownPromise = doShutdown(signal);
  return shutdownPromise;
}

async function main(): Promise<void> {
  const _deps = bootstrap();
  const logger = getLogger();

  logger.info('Initializing Telegram bot');

  // Initialize PRTG inventory cache if configured
  let inventoryCache: ReturnType<typeof createPrtgInventoryCache> | null = null;
  try {
    const prtgConfig = getPrtgConfig();
    if (prtgConfig) {
      const transport = new HttpsPrtgTransport(prtgConfig);
      const client = createPrtgClient({ config: prtgConfig, transport });
      inventoryCache = createPrtgInventoryCache(client);
      logger.info('PRTG inventory cache initialized');
    } else {
      logger.info('PRTG not configured; inventory features disabled');
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to initialize PRTG inventory cache');
  }

  // Inject inventory cache into commands
  if (inventoryCache) {
    setPrtgInventoryCache(inventoryCache);
  }

  bot = createBot();

  // V1 commands
  bot!.command('help', helpCommand);
  bot.command('chatid', chatIdCommand);

  // V2 commands
  bot.command('clients', clientsCommand);
  bot.command('client', clientCommand);
  bot.command('add_client', addClientCommand);
  bot.command('enable_client', enableClientCommand);
  bot.command('disable_client', disableClientCommand);
  bot.command('delete_client', deleteClientCommand);

  // V3 commands
  bot.command('register_group', registerGroupCommand);
  bot.command('unregister_group', unregisterGroupCommand);
  bot.command('group_clients', groupClientsCommand);
  bot.command('assign_client', assignClientCommand);
  bot.command('unassign_client', unassignClientCommand);
  bot.command('group_alerts', groupAlertsCommand);

  // V4 PRTG commands
  bot.command('prtg_inventory', prtgInventoryCommand);
  bot.command('prtg_search', prtgSearchCommand);
  bot.command('map_client', mapClientCommand);
  bot.command('auto_map', autoMapCommand);
  bot.command('unmap_client', unmapClientCommand);
  bot.command('mappings', mappingsCommand);

  // V5 Status commands
  bot.command('status', statusCommand);
  bot.command('summary', summaryCommand);
  bot.command('down', downCommand);

  // CSV import
  bot.command('csv_upload', csvUploadCommand);

  // CSV import handlers
  bot.on('document', handleCsvDocument);
  bot.action(/csv_confirm:.+/, handleCsvConfirm);
  bot.action(/csv_cancel:.+/, handleCsvCancel);

  // Unregister group callback handlers
  bot.action(/group_unregister_confirm:.+/, handleUnregisterConfirm);
  bot.action(/group_unregister_cancel:.+/, handleUnregisterCancel);

  // Delete client callback handlers
  bot.action(/^delete_confirm:.+$/, handleDeleteConfirm);
  bot.action(/^delete_cancel:.+$/, handleDeleteCancel);

  // V4 Mapping callback handlers
  bot.action(/^map_confirm:.+$/, handleMapConfirm);
  bot.action(/^map_cancel:.+$/, handleMapCancel);
  bot.action(/^map_search:.+$/, handleMapSearch);
  bot.action(/^map:[a-f0-9-]+:\d+:\d+$/i, handleMapSelect);
  bot.action(/^map_verify:.+$/, handleMapVerify);
  bot.action(/^auto_apply:.+$/, handleAutoMapApply);
  bot.action(/^auto_cancel:.+$/, handleAutoMapCancel);
  bot.action(/^unmap_confirm:.+$/, handleUnmapConfirm);
  bot.action(/^unmap_cancel:.+$/, handleUnmapCancel);
  bot.action(/^search_page:.+$/, handleSearchPagination);
  bot.action(/^clients_page:[^:]+:[^:]+$/i, handleClientsPagination);

  // V3 Group alerts callback handlers
  bot.action(/^alerts_toggle:[^:]+:\d+:(on|off)$/i, handleGroupAlertsToggle);
  bot.action(/^alerts_page:[^:]+:\d+$/i, handleGroupAlertsPage);
  bot.action(/^alerts_bulk:[^:]+:(enable_all|disable_all)$/i, handleGroupAlertsBulk);
  bot.action(/^ga_confirm:[^:]+:[^:]+$/i, handleGroupAlertsBulkConfirm);
  bot.action(/^ga_cancel:[^:]+:[^:]+$/i, handleGroupAlertsBulkCancel);
  bot.action(/^alerts_close:[^:]+$/i, handleGroupAlertsClose);

  const monitoringConfig = createMonitoringConfig(getConfig());

  if (monitoringConfig.enabled) {
    let alertingRepo = null;
    const config = getConfig();
    if (config.ALERTS_ENABLED) {
      const baseRepo = new MonitoringRepository();
      alertingRepo = createAlertingMonitoringRepository(baseRepo, {
        clock: Date.now,
        prtgPollIntervalMs: config.PRTG_POLL_INTERVAL_MS,
        icmpPollIntervalMs: config.ICMP_POLL_INTERVAL_MS,
        maxEventAgeMs: config.ALERT_MAX_EVENT_AGE_MS,
        enabled: true,
        globalChatId: config.TELEGRAM_GLOBAL_GROUP_ID || '',
      });
    }
    monitoringEngine = createMonitoringEngineWithAlerting(getConfig(), Date.now, createIcmpPingRunner(), alertingRepo);
    monitoringEngine.start();
    logger.info('Monitoring engine started');

if (alertingRepo) {
      const sender = createTelegramAlertSender(bot);
      alertDispatcher = createAlertDispatcher(
        {
          sender,
          dispatchIntervalMs: config.ALERT_DISPATCH_INTERVAL_MS,
          maxEventAgeMs: config.ALERT_MAX_EVENT_AGE_MS,
          maxAttempts: config.ALERT_MAX_ATTEMPTS,
          globalMinIntervalMs: 1000,
          sameGroupMinIntervalMs: 3500,
          senderTimeoutMs: 10000,
          globalChatId: config.TELEGRAM_GLOBAL_GROUP_ID || '',
          prtgPollIntervalMs: config.PRTG_POLL_INTERVAL_MS,
          icmpPollIntervalMs: config.ICMP_POLL_INTERVAL_MS,
        },
        Date.now
      );
      alertDispatcher.start();
      logger.info('Alert dispatcher started');
    }
  } else {
    logger.info('Monitoring engine disabled (MONITORING_ENABLED=false)');
  }

  // Register signal handlers BEFORE launch so they can catch signals during startup
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, () => {
      // Attach catch to prevent unhandled rejection from shutdown promise
      void handleShutdown(signal).catch((err) => {
        logger.error({ err }, 'Shutdown promise rejected');
      });
    });
  }

  // Single launch with proper error handling
  try {
    await bot.launch();
    logger.info('Bot started successfully');
  } catch (error) {
    logger.error({ err: error }, 'Bot launch failed, initiating shutdown');
    // Route through handleShutdown to use shared shutdownPromise
    await handleShutdown('SIGTERM');
    throw error;
  }
}

async function doShutdown(signal: NodeJS.Signals): Promise<void> {
  const logger = getLogger();
  logger.info({ signal }, 'Received shutdown signal');
  if (alertDispatcher) {
    await alertDispatcher.stop();
  }
  if (monitoringEngine) {
    await monitoringEngine.stop();
  }
  if (bot) {
    try {
      bot.stop(signal);
    } catch (err) {
      logger.warn({ err }, 'bot.stop failed during shutdown');
    }
  }
  shutdown();
}

export { getDependencies, handleShutdown };

main().catch((error) => {
  const logger = getLogger();
  logger.fatal({ err: error }, 'Application failed to start');
  process.exit(1);
});