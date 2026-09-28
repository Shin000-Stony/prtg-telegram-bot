import type { BotContext } from '@/integrations/telegram/bot';
import { customerService } from '@/modules/customers/customer.service';
import { accessService } from '@/modules/groups/access.service';
import { validateCreateCustomer } from '@/modules/customers/customer.validators';
import { formatSuccess, formatError, formatValidationError, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { AppError } from '@/core/errors/app-error';
import { getLogger } from '@/core/logger';
import { ZodError } from 'zod';

const logger = getLogger().child({ module: 'AddClientCommand' });

export async function addClientCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId!,
    chatId: ctx.chatId!,
    chatType: ctx.chatType || 'private',
  };

  if (!accessService.canManageCustomers(context)) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const text = ctx.message.text.trim();

  // Parse: /add_client <client_id> | <name> | <monitor_type> | [ping_host]
  const commandMatch = text.match(/^\/add_client\s+(.+)$/);
  if (!commandMatch) {
    await ctx.reply(formatValidationError('Usage: /add_client <client_id> | <name> | <monitor_type> | [ping_host]'));
    return;
  }

  const parts = commandMatch[1].split(/\s*\|\s*/);

  if (parts.length < 3 || parts.length > 4) {
    await ctx.reply(formatValidationError('Usage: /add_client <client_id> | <name> | <monitor_type> | [ping_host]'));
    return;
  }

  const [clientId, name, monitorTypeRaw, pingHostRaw] = parts;
  const clientIdTrimmed = clientId.trim();
  const nameTrimmed = name.trim();
  const monitorType = monitorTypeRaw.trim().toLowerCase();
  const pingHost = pingHostRaw?.trim() || null;

  let validated: ReturnType<typeof validateCreateCustomer>;
  try {
    validated = validateCreateCustomer({
      clientId: clientIdTrimmed,
      name: nameTrimmed,
      monitorType: monitorType as 'prtg' | 'icmp' | 'pic' | 'disabled',
      pingHost,
      enabled: true,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      await ctx.reply(formatValidationError(messages));
      return;
    }
    throw error;
  }

  try {
    const created = customerService.create(validated);

    await ctx.reply(
      formatSuccess(
        `Customer created\nClient ID: ${created.clientId}\nName: ${created.name}\nMonitor: ${created.monitorType.toUpperCase()}${created.pingHost ? `\nTarget: ${created.pingHost}` : ''}`
      ),
      { parse_mode: 'HTML' }
    );
    logger.info({ chatId: ctx.chatId, userId: ctx.userId, clientId: created.clientId }, 'Customer created');
  } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR') {
      await ctx.reply(formatValidationError(error.message));
    } else {
      logger.error({ err: error }, 'Failed to create customer');
      await ctx.reply(formatError('Failed to create customer'));
    }
  }
}