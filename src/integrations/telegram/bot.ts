import type { Context, MiddlewareFn } from 'telegraf';
import { Telegraf } from 'telegraf';
import { getConfig } from '../../config/env';
import { getLogger } from '../../core/logger';
import { accessService } from '../../modules/groups/access.service';
import { AppError, isAppError } from '../../core/errors/app-error';

export interface BotContext extends Context {
  userId?: string;
  chatId?: string;
  chatType?: string;
  isAdmin?: boolean;
  isGlobalGroup?: boolean;
}

export function createBot(): Telegraf<BotContext> {
  const _config = getConfig();
  const logger = getLogger().child({ module: 'TelegramBot' });

  if (!_config.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const bot = new Telegraf<BotContext>(_config.TELEGRAM_BOT_TOKEN);

  // Error boundary must be OUTERMOST to catch errors from auth middleware and commands
  bot.use(errorMiddleware(logger));
  bot.use(authMiddleware());

  bot.catch((err, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, 'Unhandled error in bot');
  });

  return bot;
}

function authMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const _config = getConfig();

    if (ctx.from) {
      ctx.userId = String(ctx.from.id);
      ctx.isAdmin = accessService.isAdmin(ctx.userId);
    }

    if (ctx.chat) {
      ctx.chatId = String(ctx.chat.id);
      ctx.chatType = ctx.chat.type;
      ctx.isGlobalGroup = accessService.isGlobalGroup(ctx.chatId);
    }

    return next();
  };
}

function errorMiddleware(logger: ReturnType<typeof getLogger>): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      logger.error({ err: error, updateType: ctx.updateType }, 'Command error');

      let message = '❌ Request failed. Please try again or contact the operator.';

      if (isAppError(error)) {
        if (error.code === 'VALIDATION_ERROR') {
          message = `❌ ${error.message}`;
        } else if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
          message = '❌ You are not authorized to perform this action.';
        } else if (error.code === 'NOT_FOUND') {
          message = `❌ ${error.message}`;
        }
      }

      try {
        await ctx.reply(message);
      } catch (replyError) {
        logger.error({ err: replyError }, 'Failed to send error reply');
      }
    }
  };
}

export function requireAdmin(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.isAdmin) {
      throw AppError.forbidden('Admin access required');
    }
    return next();
  };
}

export function requirePrivateChat(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.chatId || !ctx.chatType || !accessService.isPrivateChat(ctx.chatType)) {
      throw AppError.forbidden('This command only works in private chat');
    }
    return next();
  };
}

export function requireGroupChat(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!ctx.chatId || !ctx.chatType || !accessService.isGroupChat(ctx.chatType)) {
      throw AppError.forbidden('This command only works in groups');
    }
    return next();
  };
}