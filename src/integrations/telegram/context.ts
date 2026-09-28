import type { BotContext } from './bot';

export function getUserId(ctx: BotContext): string {
  if (!ctx.userId) {
    throw new Error('User ID not available in context');
  }
  return ctx.userId;
}

export function getChatId(ctx: BotContext): string {
  if (!ctx.chatId) {
    throw new Error('Chat ID not available in context');
  }
  return ctx.chatId;
}

export function getChatType(ctx: BotContext): string {
  if (!ctx.chatType) {
    throw new Error('Chat type not available in context');
  }
  return ctx.chatType;
}

export function isAdmin(ctx: BotContext): boolean {
  return ctx.isAdmin === true;
}

export function isGlobalGroup(ctx: BotContext): boolean {
  return ctx.isGlobalGroup === true;
}

export function createAccessContext(ctx: BotContext) {
  return {
    userId: getUserId(ctx),
    chatId: getChatId(ctx),
    chatType: getChatType(ctx),
  };
}