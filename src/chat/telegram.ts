import { TelegramConfig } from "../types.js";

/**
 * A ultra-lightweight Telegram bot client for long-polling.
 * We use `fetch` instead of pulling in a heavy dependency like `node-telegram-bot-api`
 * because we only need basic text receive/send capabilities.
 */
export class TelegramService {
    private botToken: string;
    private allowedChatId?: string | number;
    private lastUpdateId = 0;
    private isPolling = false;
    private messageQueue: string[] = [];
    private activeChatId?: number; // Where to send replies

    constructor(config: TelegramConfig) {
        this.botToken = config.bot_token;
        this.allowedChatId = config.allowed_chat_id;
    }

    /**
     * Start long-polling in the background.
     */
    start(): void {
        if (this.isPolling) return;
        this.isPolling = true;

        // We don't await this, it runs in the background
        this.pollLoop().catch((err) => {
            console.error("[Telegram] Fatal polling error:", err);
            this.isPolling = false;
        });
    }

    stop(): void {
        this.isPolling = false;
    }

    /**
     * Drain any live messages received from the user.
     */
    popMessages(): string[] {
        if (this.messageQueue.length === 0) return [];
        const messages = [...this.messageQueue];
        this.messageQueue = [];
        return messages;
    }

    /**
     * Send a message to the active chat (wherever the last command came from,
     * or the specifically configured allowed_chat_id).
     */
    async sendMessage(text: string): Promise<void> {
        const targetChatId = this.allowedChatId || this.activeChatId;
        if (!targetChatId) {
            return; // Nowhere to send
        }

        try {
            await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: targetChatId,
                    text,
                    parse_mode: "Markdown",
                }),
            });
        } catch (e) {
            console.error("[Telegram] Failed to send message:", e);
        }
    }

    private async pollLoop() {
        while (this.isPolling) {
            try {
                const res = await fetch(
                    `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
                    {
                        signal: AbortSignal.timeout?.(35000) || undefined,
                    }
                );

                if (!res.ok) {
                    // If 401 Unauthorized, the token is bad — stop polling completely.
                    if (res.status === 401) {
                        console.error("\n⚠️ [Telegram] Invalid bot token. Disabling Telegram integration.");
                        this.isPolling = false;
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 2000));
                    continue;
                }

                const data: any = await res.json();

                if (data.ok && Array.isArray(data.result)) {
                    for (const update of data.result) {
                        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

                        const msg = update.message;
                        if (!msg || !msg.text) continue;

                        const chatId = msg.chat.id;

                        // Filter by allowed chat ID if configured
                        if (this.allowedChatId && String(chatId) !== String(this.allowedChatId)) {
                            continue;
                        }

                        this.activeChatId = chatId;
                        console.log(`\n💬 [Telegram] Received live instruction: "${msg.text}"`);
                        this.messageQueue.push(msg.text.trim());
                    }
                }
            } catch (err: any) {
                // Only log non-abort errors
                if (err.name !== "AbortError" && err.name !== "TimeoutError") {
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
        }
    }
}
