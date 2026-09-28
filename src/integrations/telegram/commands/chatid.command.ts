import type { BotContext } from '../bot';
import { formatChatInfo } from '../ui/messages';
import { getChatId, getChatType } from '../context';

export async function chatIdCommand(ctx: BotContext): Promise<void> {
  const chatId = getChatId(ctx);
  const chatType = getChatType(ctx);
  const message = formatChatInfo(chatId, chatType);
  await ctx.reply(message);
}