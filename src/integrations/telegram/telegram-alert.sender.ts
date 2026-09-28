import { getLogger } from '@/core/logger';
import type { AlertSenderPort, AlertSenderResult, AlertErrorCode } from '@/modules/alerts/alert.types';

const logger = getLogger();

interface TelegrafError extends Error {
    code?: string;
    response?: {
        status?: number;
        error_code?: number;
        parameters?: {
            retry_after?: number;
        };
        retry_after?: number;
    };
}

function classifyTelegramError(error: unknown): { errorCode: AlertErrorCode; errorReason: string; retryAfterSeconds?: number } {
    const telegrafError = error as TelegrafError;

    // Check for abort first
    if (telegrafError.name === 'AbortError' || telegrafError.code === 'ABORT_ERR') {
        return { errorCode: 'transient', errorReason: 'Aborted' };
    }

    // Check Telegraf response structure
    const response = telegrafError.response;
    const status = response?.status;

    // Check for specific error_code in response
    const errorCode = response?.error_code;

    // Rate limited (429)
    if (status === 429 || errorCode === 429) {
        const retryAfter = response?.parameters?.retry_after ?? response?.retry_after;
        // Validate retry_after as finite positive number; if invalid, return undefined so dispatcher uses its configured backoff
        const validRetryAfter: number | undefined = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
        return { errorCode: 'rate_limited', errorReason: 'Rate limited', retryAfterSeconds: validRetryAfter };
    }

    // Authentication failure (401)
    if (status === 401 || errorCode === 401) {
        return { errorCode: 'auth_failure', errorReason: 'Bot token invalid or revoked' };
    }

    // Forbidden (403) - bot blocked, chat not found, etc.
    if (status === 403 || errorCode === 403) {
        return { errorCode: 'permanent', errorReason: 'Bot blocked or chat not found' };
    }

    // Bad request (400) - formatting errors, invalid payload
    if (status === 400 || errorCode === 400) {
        return { errorCode: 'formatting', errorReason: 'Bad request - formatting error' };
    }

    // Server errors (5xx) and network errors
    if ((status !== undefined && status >= 500) || 
        telegrafError.code === 'ECONNREFUSED' || 
        telegrafError.code === 'ETIMEDOUT' ||
        telegrafError.code === 'ENOTFOUND' ||
        telegrafError.code === 'ENETUNREACH') {
        return { errorCode: 'transient', errorReason: 'Network or server error' };
    }

    // Unknown error - classify as transient with safe reason
    return { errorCode: 'transient', errorReason: 'Unknown error' };
}

export class TelegramAlertSender implements AlertSenderPort {
    private readonly bot: any;

    constructor(bot: any) {
        this.bot = bot;
    }

    async send(chatId: string, html: string, signal: AbortSignal): Promise<AlertSenderResult> {
        if (signal.aborted) {
            return { success: false, errorCode: 'transient', errorReason: 'Aborted before send' };
        }

        const payload = {
            chat_id: chatId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        };

        try {
            const result = await this.bot.telegram.callApi('sendMessage', payload, { signal });
            return { success: true, messageId: result.message_id };
        } catch (error: unknown) {
            if (signal.aborted) {
                return { success: false, errorCode: 'transient', errorReason: 'Aborted during send' };
            }

            const classification = classifyTelegramError(error);

            // Log with safe metadata only
            logger.warn({ 
                chatId, 
                errorCode: classification.errorCode, 
                errorReason: classification.errorReason 
            }, 'Telegram send failed');

            return { 
                success: false, 
                errorCode: classification.errorCode, 
                errorReason: classification.errorReason,
                retryAfterSeconds: classification.retryAfterSeconds
            };
        }
    }
}

export function createTelegramAlertSender(bot: any): AlertSenderPort {
    return new TelegramAlertSender(bot);
}