export interface TelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface TelegramChat {
  id: string;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramContext {
  from: TelegramUser | undefined;
  chat: TelegramChat;
}

export type DatabaseRow = Record<string, unknown>;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}