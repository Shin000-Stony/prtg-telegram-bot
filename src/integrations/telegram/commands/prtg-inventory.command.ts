import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { formatError, formatInfo, formatWarning, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'PrtgInventoryCommand' });

function getCache(): PrtgInventoryCache | null {
  return getPrtgInventoryCache();
}

function hasCache(): boolean {
  return hasPrtgInventoryCache();
}

export async function prtgInventoryCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!hasCache()) {
    await ctx.reply(formatError('PRTG inventory cache not initialized'));
    return;
  }

  const cache = getCache()!;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const forceRefresh = parts.includes('refresh');

  if (forceRefresh) {
    await ctx.reply(formatInfo('Refreshing PRTG inventory...'));
    try {
      const snap = await cache.forceRefresh();
      await ctx.reply(
        formatInventorySummary(snap),
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      logger.error({ err: error }, 'PRTG inventory refresh failed');
      await ctx.reply(formatError('Failed to refresh inventory: see logs for details'));
    }
   } else {
    const snap = cache.getFresh();
    if (!snap) {
      const staleSnap = cache.getStale();
      if (staleSnap) {
        const isStale = cache.isStale();
        const isExpired = cache.isExpired();
        await ctx.reply(
          `${formatInventorySummary(staleSnap, isStale)}\n\n⚠️ Cache is ${isExpired ? 'EXPIRED' : 'stale'}. Use /prtg_inventory refresh.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.reply(formatWarning('No inventory cached. Use /prtg_inventory refresh to fetch.'));
      }
      return;
    }
    await ctx.reply(
      formatInventorySummary(snap),
      { parse_mode: 'HTML' }
    );
  }
}

function formatInventorySummary(snap: { sensors: Array<{ sensorType: string }>; devices: Array<{ deviceName: string }>; generation: number; fetchedAt: string }, isStale = false): string {
  const pingCount = snap.sensors.filter(s => s.sensorType.toLowerCase() === 'ping').length;
  const otherCount = snap.sensors.length - pingCount;

  const lines = [
    '📡 <b>PRTG INVENTORY</b>',
    '',
    `Generation : ${snap.generation}`,
    `Fetched    : ${snap.fetchedAt}`,
    `Status     : ${isStale ? '⚠️ STALE (older than 5 min)' : '✅ Fresh'}`,
    '',
    `Devices    : ${snap.devices.length}`,
    `Sensors    : ${snap.sensors.length} (${pingCount} Ping, ${otherCount} other)`,
  ];

  return lines.join('\n');
}

// Need to import PrtgInventoryCache for the function signature
import type { PrtgInventoryCache } from '@/integrations/prtg/prtg.inventory.cache';