/**
 * @name TinyMessageLogger
 * @author tiny
 * @version 2.1.1
 * @description Locally records received Discord messages, edits, and deletions in a searchable dashboard.
 */

"use strict";

const PLUGIN_NAME = "TinyMessageLogger";
const STYLE_ID = "tiny-message-logger-styles";
const DATA_VERSION = 1;
const EVENTS = ["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK", "LOAD_MESSAGES_SUCCESS"];

const DEFAULT_SETTINGS = Object.freeze({
    showQuickButton: true,
    showDeletedInline: true,
    showEditedInline: true,
    logDMs: true,
    logServers: true,
    logBots: true,
    logOwnMessages: true,
    retentionDays: 30,
    maxRecords: 10000
});

module.exports = class TinyMessageLogger {
    constructor() {
        this.api = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.records = new Map();
        this.stores = {};
        this.dispatcher = null;
        this.navigation = null;
        this.dashboard = null;
        this.dashboardSection = "all";
        this.dashboardSearch = "";
        this.dashboardSummaryTimer = null;
        this.quickButton = null;
        this.saveTimer = null;
        this.inlineObserver = null;
        this.inlineRestoreTimer = null;
        this.inlineRestoreSuppressedUntil = 0;
        this.fastRestoreIds = new Set();
        this.visibleEditSyncInterval = null;
        this.visibleEditAnimationFrame = null;
        this.visibleEditSyncQueued = false;
        this.renderedContentCache = new Map();
        this.pendingRenderedEdits = new Map();
        this.deletedPlacements = new Map();
        this.unpatchDeleteCapture = null;
        this.jumpToken = 0;
        this.mediaViewer = null;
        this.started = false;
        this.onSelectedChannelChange = this.onSelectedChannelChange.bind(this);

        this.handlers = {
            MESSAGE_CREATE: event => this.handleCreate(event?.message || event),
            MESSAGE_UPDATE: event => this.handleUpdate(event?.message || event),
            MESSAGE_DELETE: event => this.handleDelete(event),
            MESSAGE_DELETE_BULK: event => this.handleBulkDelete(event),
            LOAD_MESSAGES_SUCCESS: event => this.handleLoadedMessages(event)
        };
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.settings = this.sanitizeSettings(this.load("settings"));
        this.records = new Map(this.sanitizeRecords(this.load("records")).map(record => [record.id, record]));
        this.repairFalseGifEdits();
        this.repairDuplicateCurrentEditVersions();
        this.findModules();
        this.addStyles();
        this.patchDeleteCapture();
        this.subscribe();
        this.startInlineObserver();
        this.ensureQuickButton();
        this.pruneRecords();
        this.scheduleSave();
    }

    stop() {
        this.started = false;
        this.unsubscribe();
        this.unpatchDeleteCapture?.();
        this.unpatchDeleteCapture = null;
        this.jumpToken++;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (this.dashboardSummaryTimer) clearTimeout(this.dashboardSummaryTimer);
        this.dashboardSummaryTimer = null;
        this.saveRecords();
        this.closeDashboard();
        this.closeMediaViewer();
        this.removeQuickButton();
        this.stopInlineObserver();
        this.removeInlineDeletedMessages();
        this.removeInlineEditedMessages();
        this.removeStyles();
    }

    initializeApi() {
        try {
            if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not create a scoped BdApi instance:`, error);
        }
    }

    findModules() {
        const webpack = this.api?.Webpack || globalThis.BdApi?.Webpack;
        const getStore = name => {
            try {
                return webpack?.getStore?.(name) || null;
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}] Could not load ${name}:`, error);
                return null;
            }
        };
        this.stores = {
            user: getStore("UserStore"),
            channel: getStore("ChannelStore"),
            guild: getStore("GuildStore"),
            selectedChannel: getStore("SelectedChannelStore"),
            message: getStore("MessageStore")
        };
        try {
            this.dispatcher = webpack?.getByKeys?.("dispatch", "subscribe", "unsubscribe")
                || webpack?.getModule?.(
                    module => typeof module?.dispatch === "function" && typeof module?.subscribe === "function" && typeof module?.unsubscribe === "function",
                    {searchExports: true}
                )
                || null;
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not load Discord's message dispatcher:`, error);
        }
        this.navigation = this.findNavigationModule(webpack);
        if (!this.dispatcher) this.toast("Message dispatcher not found. Reload Discord to retry.", "error");
    }

    findNavigationModule(webpack = this.api?.Webpack || globalThis.BdApi?.Webpack) {
        try {
            return webpack?.getByKeys?.("transitionTo", "replaceWith")
                || webpack?.getByKeys?.("transitionTo")
                || webpack?.getModule?.(
                    module => typeof module?.transitionTo === "function",
                    {searchExports: true}
                )
                || null;
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not load Discord's channel navigator:`, error);
            return null;
        }
    }

    patchDeleteCapture() {
        if (!this.dispatcher?.dispatch) return;
        const beforeDispatch = (_thisObject, args) => {
            const action = args?.[0];
            if (action?.type === "MESSAGE_CREATE") {
                this.captureIncomingMessage(action?.message || action);
            } else if (action?.type === "MESSAGE_UPDATE") {
                this.captureIncomingUpdate(action?.message || action);
            } else if (action?.type === "MESSAGE_DELETE") {
                this.captureDeleteAction(action);
            } else if (action?.type === "MESSAGE_DELETE_BULK") {
                const channelId = String(action.channelId || action.channel_id || "");
                for (const id of action.ids || action.messageIds || action.message_ids || []) {
                    this.captureDeleteAction({...action, id, channelId});
                }
            }
        };
        try {
            if (this.api?.Patcher?.before) {
                const unpatch = this.api.Patcher.before(this.dispatcher, "dispatch", beforeDispatch);
                this.unpatchDeleteCapture = typeof unpatch === "function" ? unpatch : () => this.api?.Patcher?.unpatchAll?.();
            } else if (globalThis.BdApi?.Patcher?.before) {
                const unpatch = globalThis.BdApi.Patcher.before(PLUGIN_NAME, this.dispatcher, "dispatch", beforeDispatch);
                this.unpatchDeleteCapture = typeof unpatch === "function" ? unpatch : () => globalThis.BdApi?.Patcher?.unpatchAll?.(PLUGIN_NAME);
            }
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not install early delete capture:`, error);
        }
    }

    captureDeleteAction(action) {
        const id = String(action?.id || action?.messageId || action?.message_id || "");
        const channelId = String(action?.channelId || action?.channel_id || "");
        if (!id) return;
        this.captureCachedMessageBeforeDelete(action, id, channelId);
        if (this.deletedPlacements.has(id)) return;
        const placement = this.deletedPlacements.get(id) || this.captureVisibleMessage(id, channelId);
        if (placement) this.deletedPlacements.set(id, placement);
    }

    captureIncomingMessage(message) {
        if (!message?.id || this.records.has(String(message.id))) return;
        try {
            this.handleCreate(message);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not capture an incoming message early:`, error);
        }
    }

    captureIncomingUpdate(message) {
        if (!message?.id) return;
        const id = String(message.id);
        const channelId = String(message.channel_id || message.channelId || this.records.get(id)?.channelId || "");
        try {
            if (!this.records.has(id) && channelId) {
                const cached = this.getCachedMessage(channelId, id);
                if (cached) this.handleCreate(cached);
            }
            this.handleUpdate(message);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not capture a message edit early:`, error);
        }
    }

    captureCachedMessageBeforeDelete(action, id, channelId) {
        if (this.records.has(id) || !channelId) return;
        const cached = this.getCachedMessage(channelId, id, action);
        if (!cached) return;
        const channel = this.stores.channel?.getChannel?.(channelId) || null;
        if (!this.shouldLogMessage(cached, channel)) return;
        try {
            const snapshot = this.snapshotMessage(cached, channel);
            if (!snapshot.content && !snapshot.attachments.length && !cached.author) return;
            this.records.set(id, snapshot);
            this.scheduleSave();
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not preserve a cached message before deletion:`, error);
        }
    }

    getCachedMessage(channelId, messageId, action = null) {
        const actionMessage = action?.message || action?.cachedMessage || action?.deletedMessage || null;
        if (actionMessage?.id && String(actionMessage.id) === String(messageId)) return actionMessage;
        const store = this.stores.message;
        try {
            const direct = store?.getMessage?.(channelId, messageId);
            if (direct) return direct;
        } catch (_) {}
        try {
            const messages = store?.getMessages?.(channelId);
            const direct = messages?.get?.(messageId)
                || messages?._map?.get?.(messageId)
                || messages?._messages?.get?.(messageId);
            if (direct) return direct;
            return this.extractMessageArray(messages).find(message => String(message.id) === String(messageId)) || null;
        } catch (_) {
            return null;
        }
    }

    subscribe() {
        for (const eventName of EVENTS) {
            try {
                this.dispatcher?.subscribe?.(eventName, this.handlers[eventName]);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}] Could not subscribe to ${eventName}:`, error);
            }
        }
        try {
            this.stores.selectedChannel?.addChangeListener?.(this.onSelectedChannelChange);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not watch channel changes:`, error);
        }
    }

    unsubscribe() {
        for (const eventName of EVENTS) {
            try {
                this.dispatcher?.unsubscribe?.(eventName, this.handlers[eventName]);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}] Could not unsubscribe from ${eventName}:`, error);
            }
        }
        try {
            this.stores.selectedChannel?.removeChangeListener?.(this.onSelectedChannelChange);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not stop watching channel changes:`, error);
        }
    }

    onSelectedChannelChange() {
        this.renderedContentCache.clear();
        this.removeInlineDeletedMessages();
        this.removeInlineEditedMessages();
        setTimeout(() => this.started && this.restoreVisibleInlineMessages(), 250);
        setTimeout(() => this.started && this.restoreVisibleInlineMessages(), 700);
    }

    sanitizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        return {
            showQuickButton: source.showQuickButton ?? DEFAULT_SETTINGS.showQuickButton,
            showDeletedInline: source.showDeletedInline ?? DEFAULT_SETTINGS.showDeletedInline,
            showEditedInline: source.showEditedInline ?? DEFAULT_SETTINGS.showEditedInline,
            logDMs: source.logDMs ?? DEFAULT_SETTINGS.logDMs,
            logServers: source.logServers ?? DEFAULT_SETTINGS.logServers,
            logBots: source.logBots ?? DEFAULT_SETTINGS.logBots,
            logOwnMessages: source.logOwnMessages ?? DEFAULT_SETTINGS.logOwnMessages,
            retentionDays: Math.max(1, Math.min(3650, Number(source.retentionDays ?? DEFAULT_SETTINGS.retentionDays))),
            maxRecords: Math.max(100, Math.min(100000, Number(source.maxRecords ?? DEFAULT_SETTINGS.maxRecords)))
        };
    }

    sanitizeRecords(raw) {
        if (!Array.isArray(raw)) return [];
        const records = [];
        for (const item of raw) {
            if (!item?.id || !item?.channelId) continue;
            const timestamp = Number(item.timestamp);
            if (!Number.isFinite(timestamp)) continue;
            records.push({
                id: String(item.id),
                channelId: String(item.channelId),
                guildId: item.guildId ? String(item.guildId) : null,
                channelName: String(item.channelName || "Unknown channel").slice(0, 150),
                guildName: String(item.guildName || (item.guildId ? "Unknown server" : "Direct Messages")).slice(0, 150),
                authorId: String(item.authorId || "unknown"),
                authorName: String(item.authorName || "Unknown user").slice(0, 150),
                authorBot: Boolean(item.authorBot),
                avatarUrl: this.sanitizeUrl(item.avatarUrl),
                content: String(item.content || "").slice(0, 10000),
                attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 20).map(attachment => ({
                    filename: String(attachment?.filename || "attachment").slice(0, 300),
                    size: Math.max(0, Number(attachment?.size) || 0),
                    url: this.sanitizeUrl(attachment?.url),
                    proxyUrl: this.sanitizeUrl(attachment?.proxyUrl),
                    contentType: String(attachment?.contentType || "").slice(0, 100)
                })) : [],
                media: Array.isArray(item.media) ? item.media.slice(0, 20).map(media => ({
                    url: this.sanitizeUrl(media?.url),
                    kind: media?.kind === "video" ? "video" : "image",
                    alt: String(media?.alt || "Deleted message media").slice(0, 300)
                })).filter(media => media.url) : [],
                inlineEligible: item.inlineEligible === true,
                inlineDismissed: item.inlineDismissed === true,
                inlinePreviousId: item.inlinePreviousId ? String(item.inlinePreviousId) : null,
                inlineNextId: item.inlineNextId ? String(item.inlineNextId) : null,
                inlineEditEligible: Array.isArray(item.editHistory) && item.editHistory.length > 0 && item.inlineEditEligible !== false,
                inlineEditDismissed: item.inlineEditDismissed === true,
                timestamp,
                editedAt: Number(item.editedAt) || null,
                deletedAt: Number(item.deletedAt) || null,
                editHistory: Array.isArray(item.editHistory) ? item.editHistory.slice(-20).map(version => ({
                    content: String(version?.content || "").slice(0, 10000),
                    timestamp: Number(version?.timestamp) || timestamp
                })) : []
            });
        }
        return records;
    }

    sanitizeUrl(value) {
        if (!value) return "";
        try {
            const url = new URL(String(value));
            return ["https:", "http:"].includes(url.protocol) ? url.toString().slice(0, 4000) : "";
        } catch (_) {
            return "";
        }
    }

    shouldLogMessage(message, channel = null) {
        if (!message) return false;
        const guildId = message.guild_id || message.guildId || channel?.guild_id || channel?.guildId || null;
        if (guildId && !this.settings.logServers) return false;
        if (!guildId && !this.settings.logDMs) return false;
        const author = message.author || this.stores.user?.getUser?.(message.author_id || message.authorId);
        if (author?.bot && !this.settings.logBots) return false;
        const selfId = this.stores.user?.getCurrentUser?.()?.id;
        const authorId = author?.id || message.author_id || message.authorId;
        if (selfId && String(authorId) === String(selfId) && !this.settings.logOwnMessages) return false;
        return true;
    }

    handleCreate(message) {
        if (!message?.id) return;
        const channelId = message.channel_id || message.channelId;
        const channel = this.stores.channel?.getChannel?.(channelId) || null;
        if (!channelId || !this.shouldLogMessage(message, channel)) return;
        const existing = this.records.get(String(message.id));
        const snapshot = this.snapshotMessage(message, channel, existing);
        this.repairRecordEditHistory(snapshot);
        this.records.set(snapshot.id, snapshot);
        this.pruneRecords();
        this.scheduleSave();
        this.scheduleDashboardSummaryUpdate();
    }

    handleLoadedMessages(event) {
        const messages = this.extractMessageArray(event);
        if (!messages.length) return;
        for (const message of messages) this.handleCreate(message);
    }

    extractMessageArray(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value.filter(item => item?.id);
        if (value instanceof Map) return [...value.values()].flatMap(item => this.extractMessageArray(item));
        if (value instanceof Set) return [...value.values()].flatMap(item => this.extractMessageArray(item));
        if (Array.isArray(value._array)) return value._array.filter(item => item?.id);
        if (typeof value.toArray === "function") {
            try {
                const converted = value.toArray();
                if (Array.isArray(converted)) return converted.filter(item => item?.id);
            } catch (_) {}
        }
        if (Array.isArray(value.messages)) return value.messages.filter(item => item?.id);
        if (value.messages && typeof value.messages === "object") return this.extractMessageArray(value.messages);
        return [];
    }

    handleUpdate(message, source = "event") {
        if (!message?.id) return;
        const id = String(message.id);
        const channelId = message.channel_id || message.channelId || this.records.get(id)?.channelId;
        const channel = this.stores.channel?.getChannel?.(channelId) || null;
        const existing = this.records.get(id);
        if (!existing) {
            if (this.shouldLogMessage(message, channel)) this.handleCreate(message);
            return;
        }

        const hasContent = message != null && "content" in Object(message) && message.content !== undefined;
        const nextContent = hasContent ? String(message.content || "") : existing.content;
        const suppliedEditedAt = this.parseTimestamp(message.edited_timestamp || message.editedTimestamp);
        const hasRealEditSignal = source === "dom" || suppliedEditedAt > 0;
        const pendingRendered = this.pendingRenderedEdits.get(id);
        const isRawReconciliation = source !== "dom"
            && pendingRendered
            && existing.content === pendingRendered.renderedContent
            && hasContent
            && nextContent !== existing.content;
        let contentChanged = hasContent && nextContent !== existing.content && hasRealEditSignal;
        if (isRawReconciliation) {
            existing.content = nextContent.slice(0, 10000);
            this.pendingRenderedEdits.delete(id);
            contentChanged = false;
        }
        if (contentChanged) {
            existing.editHistory.push({content: existing.content, timestamp: Date.now()});
            existing.editHistory = existing.editHistory.slice(-20);
            existing.content = nextContent.slice(0, 10000);
            existing.editedAt = suppliedEditedAt || Date.now();
            existing.inlineEditEligible = true;
            existing.inlineEditDismissed = false;
        }
        const merged = this.snapshotMessage(message, channel, existing);
        merged.content = existing.content;
        merged.editHistory = existing.editHistory;
        merged.editedAt = existing.editedAt;
        merged.deletedAt = existing.deletedAt;
        this.repairRecordEditHistory(merged);
        this.records.set(id, merged);
        this.scheduleSave();
        if (contentChanged) this.scheduleDashboardSummaryUpdate();
        if (contentChanged && this.settings.showEditedInline) this.scheduleInlineEditedRestore(id);
    }

    handleDelete(event) {
        const id = String(event?.id || event?.messageId || event?.message_id || "");
        const channelId = String(event?.channelId || event?.channel_id || "");
        if (!id) return;
        this.captureCachedMessageBeforeDelete(event, id, channelId);
        const placement = this.deletedPlacements.get(id) || this.captureVisibleMessage(id, channelId);
        if (placement) this.deletedPlacements.set(id, placement);
        let record = this.records.get(id);
        if (!record && channelId) {
            const channel = this.stores.channel?.getChannel?.(channelId) || null;
            const guildId = event?.guildId || event?.guild_id || channel?.guild_id || null;
            if ((guildId && !this.settings.logServers) || (!guildId && !this.settings.logDMs)) return;
            record = this.placeholderRecord(id, channelId, guildId, channel);
            if (placement?.content) record.content = placement.content.slice(0, 10000);
            if (placement?.authorName) record.authorName = placement.authorName.slice(0, 150);
        }
        if (!record) return;
        if (!record.avatarUrl && placement?.avatarUrl) record.avatarUrl = placement.avatarUrl;
        record.deletedAt = Date.now();
        record.inlineEligible = true;
        record.inlineDismissed = false;
        record.inlinePreviousId = placement?.previousMessageId || record.inlinePreviousId || null;
        record.inlineNextId = placement?.nextMessageId || record.inlineNextId || null;
        this.records.set(id, record);
        this.pruneRecords();
        this.scheduleSave();
        this.scheduleDashboardSummaryUpdate();
        if (this.settings.showDeletedInline) setTimeout(() => this.restoreInlineDeletedMessage(id), 60);
    }

    handleBulkDelete(event) {
        const ids = event?.ids || event?.messageIds || event?.message_ids || [];
        const channelId = event?.channelId || event?.channel_id;
        for (const id of ids) this.handleDelete({...event, id, channelId});
    }

    startInlineObserver() {
        if (this.inlineObserver || typeof globalThis.MutationObserver !== "function" || !globalThis.document?.body) return;
        this.inlineObserver = new MutationObserver(mutations => {
            this.queueVisibleEditSync();
            if (!this.settings.showDeletedInline && !this.settings.showEditedInline) return;
            this.queueFastInlineRestores(mutations);
            if (this.inlineRestoreTimer) return;
            this.inlineRestoreTimer = setTimeout(() => {
                this.inlineRestoreTimer = null;
                this.restoreVisibleInlineMessages();
            }, 60);
        });
        this.inlineObserver.observe(document.getElementById("app-mount") || document.body, {childList: true, characterData: true, subtree: true});
        if (typeof globalThis.requestAnimationFrame === "function") {
            const syncEveryFrame = () => {
                if (!this.started) return;
                this.syncVisibleMessageEdits();
                this.visibleEditAnimationFrame = globalThis.requestAnimationFrame(syncEveryFrame);
            };
            this.visibleEditAnimationFrame = globalThis.requestAnimationFrame(syncEveryFrame);
        } else {
            this.visibleEditSyncInterval = setInterval(() => this.syncVisibleMessageEdits(), 50);
        }
        this.syncVisibleMessageEdits();
        setTimeout(() => this.started && this.restoreVisibleInlineMessages(), 300);
    }

    stopInlineObserver() {
        this.inlineObserver?.disconnect();
        this.inlineObserver = null;
        if (this.inlineRestoreTimer) clearTimeout(this.inlineRestoreTimer);
        this.inlineRestoreTimer = null;
        if (this.visibleEditSyncInterval) clearInterval(this.visibleEditSyncInterval);
        this.visibleEditSyncInterval = null;
        if (this.visibleEditAnimationFrame !== null && typeof globalThis.cancelAnimationFrame === "function") {
            globalThis.cancelAnimationFrame(this.visibleEditAnimationFrame);
        }
        this.visibleEditAnimationFrame = null;
        this.visibleEditSyncQueued = false;
        this.renderedContentCache.clear();
        this.pendingRenderedEdits.clear();
        this.fastRestoreIds.clear();
        this.deletedPlacements.clear();
    }

    queueVisibleEditSync() {
        if (this.visibleEditSyncQueued) return;
        this.visibleEditSyncQueued = true;
        const sync = () => {
            this.visibleEditSyncQueued = false;
            this.syncVisibleMessageEdits();
        };
        if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(sync);
        else setTimeout(sync, 0);
    }

    syncVisibleMessageEdits() {
        if (!this.started || !globalThis.document) return;
        const channelId = this.getSelectedChannelId();
        if (!channelId) return;
        const seen = new Set();
        for (const node of document.querySelectorAll('[id^="chat-messages-"], [data-list-item-id*="chat-messages"]')) {
            const identifier = node.id || node.getAttribute("data-list-item-id") || "";
            const messageId = identifier.match(/(\d{10,25})$/)?.[1] || "";
            if (!messageId || seen.has(messageId)) continue;
            seen.add(messageId);
            const existing = this.records.get(messageId);
            if (!existing || existing.deletedAt || existing.channelId !== channelId) continue;
            const row = node.closest("li") || node;
            const contentNode = row.querySelector(`[id^="message-content-${channelId}-"][id$="-${messageId}"]`)
                || row.querySelector(`[id^="message-content-"][id$="-${messageId}"]`)
                || row.querySelector('[id^="message-content-"]')
                || row.querySelector('[class*="messageContent"] [class*="markup"]')
                || row.querySelector('[class*="messageContent"]');
            let renderedContent = contentNode
                ? String(contentNode.innerText ?? contentNode.textContent ?? "")
                : null;
            if (renderedContent !== null && row.querySelector('[class*="edited"]')) {
                renderedContent = renderedContent.replace(/\s*\(edited\)\s*$/i, "");
            }
            const previousRendered = this.renderedContentCache.get(messageId);
            if (renderedContent !== null) this.renderedContentCache.set(messageId, renderedContent);
            if (previousRendered !== undefined && previousRendered === renderedContent) continue;

            const renderedMessage = this.getMessageFromReactNode(row, messageId);
            const cachedMessage = this.getCachedMessage(channelId, messageId);
            const current = renderedMessage || cachedMessage;
            if (current && "content" in Object(current) && current.content !== undefined && String(current.content || "") !== existing.content) {
                if (renderedContent !== null) this.renderedContentCache.set(messageId, renderedContent);
                this.handleUpdate(current);
                continue;
            }

            if (renderedContent === null) continue;
            if (previousRendered === undefined) continue;
            if (existing.editedAt && Date.now() - existing.editedAt < 2000) continue;
            const latestHistoryAt = Number(existing.editHistory?.[existing.editHistory.length - 1]?.timestamp) || 0;
            if (latestHistoryAt && Date.now() - latestHistoryAt < 2000) continue;
            const mediaRenderingChange = Boolean(existing.media?.length)
                || Boolean(existing.attachments?.length)
                || /https?:\/\/\S+/i.test(existing.content);
            if (mediaRenderingChange) continue;

            this.handleUpdate({
                id: messageId,
                channel_id: channelId,
                content: renderedContent,
                edited_timestamp: new Date().toISOString()
            }, "dom");
            this.pendingRenderedEdits.set(messageId, {renderedContent, detectedAt: Date.now()});
        }
    }

    getSelectedChannelId() {
        const storeId = this.stores.selectedChannel?.getChannelId?.()
            || this.stores.selectedChannel?.getLastSelectedChannelId?.();
        if (storeId) return String(storeId);
        const match = String(globalThis.location?.pathname || "").match(/^\/channels\/(?:@me|\d+)\/(\d+)/);
        return match?.[1] || "";
    }

    getMessageFromReactNode(node, messageId) {
        const reactUtils = this.api?.ReactUtils || globalThis.BdApi?.ReactUtils;
        const findInProps = props => {
            if (!props || typeof props !== "object") return null;
            const direct = props.message;
            if (direct?.id && String(direct.id) === String(messageId)) return direct;
            for (const value of Object.values(props)) {
                if (value?.id && String(value.id) === String(messageId) && "content" in Object(value)) return value;
                if (value?.message?.id && String(value.message.id) === String(messageId)) return value.message;
            }
            return null;
        };
        try {
            const owner = reactUtils?.getOwnerInstance?.(node);
            const ownerMessage = findInProps(owner?.props);
            if (ownerMessage) return ownerMessage;
        } catch (_) {}
        try {
            let fiber = reactUtils?.getInternalInstance?.(node) || null;
            for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
                const message = findInProps(fiber.memoizedProps) || findInProps(fiber.pendingProps);
                if (message) return message;
            }
        } catch (_) {}
        return null;
    }

    queueFastInlineRestores(mutations) {
        if (Date.now() < this.inlineRestoreSuppressedUntil) return;
        for (const mutation of mutations || []) {
            for (const removed of mutation.removedNodes || []) {
                if (removed?.nodeType !== 1) continue;
                if (removed.matches?.("[data-tml-deleted-message]")) {
                    this.fastRestoreIds.add(`deleted:${removed.getAttribute("data-tml-deleted-message")}`);
                }
                for (const ghost of removed.querySelectorAll?.("[data-tml-deleted-message]") || []) {
                    this.fastRestoreIds.add(`deleted:${ghost.getAttribute("data-tml-deleted-message")}`);
                }
                if (removed.matches?.("[data-tml-edited-message]")) {
                    this.fastRestoreIds.add(`edited:${removed.getAttribute("data-tml-edited-message")}`);
                }
                for (const ghost of removed.querySelectorAll?.("[data-tml-edited-message]") || []) {
                    this.fastRestoreIds.add(`edited:${ghost.getAttribute("data-tml-edited-message")}`);
                }
            }
        }
        if (!this.fastRestoreIds.size) return;
        const restore = () => {
            if (!this.started || Date.now() < this.inlineRestoreSuppressedUntil) {
                this.fastRestoreIds.clear();
                return;
            }
            const ids = [...this.fastRestoreIds];
            this.fastRestoreIds.clear();
            const selectedChannelId = this.getSelectedChannelId();
            for (const key of ids) {
                const separator = key.indexOf(":");
                const kind = key.slice(0, separator);
                const id = key.slice(separator + 1);
                const record = this.records.get(id);
                if (!record) continue;
                if (selectedChannelId && record.channelId !== selectedChannelId) continue;
                if (kind === "deleted" && this.settings.showDeletedInline && record.deletedAt && record.inlineEligible && !record.inlineDismissed) {
                    this.restoreInlineDeletedMessage(id);
                } else if (kind === "edited" && this.settings.showEditedInline && record.editedAt && record.inlineEditEligible && !record.inlineEditDismissed) {
                    this.restoreInlineEditedMessage(id);
                }
            }
        };
        if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(restore);
        else setTimeout(restore, 0);
    }

    restoreVisibleInlineMessages() {
        this.restoreVisibleDeletedMessages();
        this.restoreVisibleEditedMessages();
    }

    captureVisibleMessage(messageId, channelId) {
        if (!globalThis.document) return null;
        const selectors = [
            `[data-list-item-id$="${messageId}"]:not([data-tml-deleted-message])`,
            `[id^="chat-messages-"][id$="-${messageId}"]:not([data-tml-deleted-message])`,
            `[id="chat-messages-${messageId}"]:not([data-tml-deleted-message])`,
            `[data-message-id="${messageId}"]:not([data-tml-deleted-message])`
        ];
        const source = selectors.map(selector => document.querySelector(selector)).find(Boolean);
        if (!source) return null;
        const row = source.matches?.("li")
            ? source
            : source.closest('li[class*="messageListItem"], li[data-list-item-id], li')
                || source.closest('[class*="messageListItem"]')
                || source;
        if (!row.parentElement) return null;
        const contentNode = row.querySelector('[class*="markup"]') || row.querySelector('[class*="messageContent"]');
        const authorNode = row.querySelector('[class*="username"]');
        const avatarNode = row.querySelector('img[class*="avatar"], img[src*="/avatars/"], img[src*="/embed/avatars/"]');
        const clone = row.cloneNode(true);
        this.prepareClonedDeletedMessage(clone, messageId, channelId);
        return {
            channelId,
            parent: row.parentElement,
            previous: row.previousElementSibling,
            next: row.nextElementSibling,
            content: contentNode?.innerText || "",
            authorName: authorNode?.textContent?.trim() || "",
            avatarUrl: this.sanitizeUrl(avatarNode?.currentSrc || avatarNode?.src),
            previousMessageId: this.findAdjacentMessageId(row, "previousElementSibling"),
            nextMessageId: this.findAdjacentMessageId(row, "nextElementSibling"),
            clone
        };
    }

    findAdjacentMessageId(row, direction) {
        let sibling = row?.[direction] || null;
        for (let steps = 0; sibling && steps < 20; steps++, sibling = sibling[direction]) {
            const messageNode = sibling.matches?.('[id^="chat-messages-"]')
                ? sibling
                : sibling.querySelector?.('[id^="chat-messages-"]');
            if (!messageNode?.id) continue;
            const id = messageNode.id.slice(messageNode.id.lastIndexOf("-") + 1);
            if (/^\d{10,25}$/.test(id)) return id;
        }
        return null;
    }

    prepareClonedDeletedMessage(clone, messageId, channelId) {
        clone.classList.add("tml-inline-deleted-clone");
        clone.setAttribute("data-tml-deleted-message", String(messageId));
        clone.setAttribute("data-channel-id", String(channelId));
        clone.removeAttribute("id");
        clone.removeAttribute("data-list-item-id");
        for (const node of clone.querySelectorAll("[id]")) node.removeAttribute("id");
        for (const node of clone.querySelectorAll('[class*="buttonsInner"], [class*="buttonContainer"]')) node.remove();
        for (const button of clone.querySelectorAll("button")) button.tabIndex = -1;
        let badge = clone.querySelector(".tml-inline-clone-badge");
        if (!badge) {
            badge = this.element("span", {className: "tml-inline-clone-badge", textContent: "DELETED"});
            const header = clone.querySelector('[class*="header"]') || clone.querySelector('[class*="timestamp"]')?.parentElement;
            (header || clone).append(badge);
        }
        let dismiss = clone.querySelector(".tml-inline-dismiss");
        let copy = clone.querySelector(".tml-inline-copy");
        if (!copy) {
            copy = this.element("button", {
                className: "tml-inline-copy",
                type: "button",
                textContent: "Copy",
                title: "Copy deleted message text",
                "aria-label": "Copy deleted message text"
            });
            badge.insertAdjacentElement("afterend", copy);
        }
        copy.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.copyMessageText(messageId);
        });
        if (!dismiss) {
            dismiss = this.element("button", {
                className: "tml-inline-dismiss",
                type: "button",
                textContent: "×",
                title: "Remove from chat (keep in logs)",
                "aria-label": "Remove deleted message from chat but keep it in logs"
            });
            copy.insertAdjacentElement("afterend", dismiss);
        }
        dismiss.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.dismissInlineDeletedMessage(messageId);
        });
        this.prepareInteractiveMedia(clone);
    }

    restoreVisibleDeletedMessages() {
        if (!this.started || !this.settings.showDeletedInline || !globalThis.document) return;
        const selectedChannelId = this.getSelectedChannelId();
        for (const ghost of document.querySelectorAll("[data-tml-deleted-message]")) {
            const record = this.records.get(ghost.getAttribute("data-tml-deleted-message"));
            if (!record?.inlineEligible || record.inlineDismissed || (selectedChannelId && ghost.getAttribute("data-channel-id") !== selectedChannelId)) ghost.remove();
        }
        if (!selectedChannelId) return;
        const deleted = [...this.records.values()]
            .filter(record => record.deletedAt && record.inlineEligible && !record.inlineDismissed && record.channelId === selectedChannelId)
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, 100);
        for (const record of deleted) this.restoreInlineDeletedMessage(record.id);
    }

    restoreInlineDeletedMessage(messageId) {
        if (!this.started || !this.settings.showDeletedInline || !globalThis.document) return;
        const record = this.records.get(String(messageId));
        if (!record?.deletedAt || !record.inlineEligible || record.inlineDismissed) return;
        const existing = document.querySelector(`[data-tml-deleted-message="${record.id}"]`);
        if (existing) return;

        const selectedChannelId = this.getSelectedChannelId() || record.channelId;
        if (selectedChannelId !== record.channelId) return;
        const placement = this.deletedPlacements.get(record.id);
        const ghost = this.createInlineDeletedMessage(record, placement?.clone);

        if (placement?.parent?.isConnected) {
            if (placement.next?.isConnected && placement.next.parentElement === placement.parent) {
                placement.parent.insertBefore(ghost, placement.next);
            } else if (placement.previous?.isConnected && placement.previous.parentElement === placement.parent) {
                placement.previous.insertAdjacentElement("afterend", ghost);
            } else {
                placement.parent.append(ghost);
            }
            return;
        }

        const nextAnchor = this.findRenderedMessageRow(record.channelId, record.inlineNextId);
        if (nextAnchor?.parentElement) {
            nextAnchor.parentElement.insertBefore(ghost, nextAnchor);
            return;
        }
        const previousAnchor = this.findRenderedMessageRow(record.channelId, record.inlinePreviousId);
        if (previousAnchor?.parentElement) {
            previousAnchor.insertAdjacentElement("afterend", ghost);
            return;
        }

        const visibleRows = this.getVisibleMessageRows(record.channelId);
        if (!visibleRows.length) return;
        const targetId = this.snowflakeValue(record.id);
        const comparable = visibleRows.filter(item => item.value !== null);
        if (!comparable.length || targetId === null) return;
        const minimum = comparable.reduce((minimumValue, item) => item.value < minimumValue ? item.value : minimumValue, comparable[0].value);
        const maximum = comparable.reduce((maximumValue, item) => item.value > maximumValue ? item.value : maximumValue, comparable[0].value);
        if (targetId < minimum || targetId > maximum + 4194304n * 600000n) return;
        const nextRow = comparable.find(item => item.value > targetId)?.node;
        const parent = comparable[0].node.parentElement;
        if (!parent) return;
        if (nextRow?.parentElement === parent) parent.insertBefore(ghost, nextRow);
        else parent.append(ghost);
    }

    restoreVisibleEditedMessages() {
        if (!this.started || !this.settings.showEditedInline || !globalThis.document) return;
        const selectedChannelId = this.getSelectedChannelId();
        for (const ghost of document.querySelectorAll("[data-tml-edited-message]")) {
            const record = this.records.get(ghost.getAttribute("data-tml-edited-message"));
            if (!record?.editedAt || !record.inlineEditEligible || record.inlineEditDismissed || (selectedChannelId && ghost.getAttribute("data-channel-id") !== selectedChannelId)) ghost.remove();
        }
        if (!selectedChannelId) return;
        const edited = [...this.records.values()]
            .filter(record => record.editedAt && record.inlineEditEligible && !record.inlineEditDismissed && record.channelId === selectedChannelId)
            .sort((left, right) => right.timestamp - left.timestamp)
            .slice(0, 100);
        for (const record of edited) this.restoreInlineEditedMessage(record.id);
    }

    scheduleInlineEditedRestore(messageId) {
        const restore = () => this.started && this.settings.showEditedInline && this.restoreInlineEditedMessage(messageId);
        if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(restore);
        else setTimeout(restore, 0);
        if (typeof globalThis.requestAnimationFrame === "function") {
            globalThis.requestAnimationFrame(() => {
                restore();
                globalThis.requestAnimationFrame(restore);
            });
        } else {
            setTimeout(restore, 16);
        }
        setTimeout(restore, 30);
        setTimeout(restore, 75);
        setTimeout(restore, 150);
    }

    restoreInlineEditedMessage(messageId) {
        if (!this.started || !this.settings.showEditedInline || !globalThis.document) return;
        const record = this.records.get(String(messageId));
        if (!record?.editedAt || !record.editHistory?.length || !record.inlineEditEligible || record.inlineEditDismissed) return;
        const signature = this.getInlineEditSignature(record);
        const existingGhost = document.querySelector(`[data-tml-edited-message="${record.id}"]`);
        if (existingGhost?.getAttribute("data-edit-signature") === signature) return;
        const selectedChannelId = this.getSelectedChannelId() || record.channelId;
        if (selectedChannelId !== record.channelId) return;
        if (existingGhost?.parentElement) {
            const replacement = this.createInlineEditedMessage(record);
            existingGhost.replaceWith(replacement);
            this.fitInlineEditScroller(replacement);
            return;
        }
        const messageRow = this.findRenderedMessageRow(record.channelId, record.id)
            || document.querySelector(`[data-tml-deleted-message="${record.id}"]`);
        if (!messageRow?.parentElement) return;
        const ghost = this.createInlineEditedMessage(record);
        messageRow.insertAdjacentElement("afterend", ghost);
        this.fitInlineEditScroller(ghost);
    }

    getInlineEditSignature(record) {
        const latest = record.editHistory?.[record.editHistory.length - 1];
        return `${record.editHistory?.length || 0}:${record.editedAt || 0}:${latest?.timestamp || 0}:${String(latest?.content || "").length}`;
    }

    fitInlineEditScroller(ghost) {
        const fit = () => {
            if (!ghost?.isConnected) return;
            const list = ghost.querySelector(".tml-inline-edit-versions.has-overflow");
            const cards = list ? [...list.querySelectorAll(".tml-inline-edit-version")] : [];
            if (cards.length <= 2) return;
            const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 7;
            const twoCardHeight = cards[0].getBoundingClientRect().height + cards[1].getBoundingClientRect().height + gap;
            list.style.setProperty("max-height", `${Math.min(260, Math.max(90, Math.ceil(twoCardHeight)))}px`, "important");
        };
        if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(fit);
        else setTimeout(fit, 0);
    }

    createInlineEditedMessage(record) {
        const row = this.element("li", {
            className: "tml-inline-edited",
            role: "listitem",
            "data-tml-edited-message": record.id,
            "data-channel-id": record.channelId,
            "data-edit-signature": this.getInlineEditSignature(record)
        });
        const avatar = record.avatarUrl
            ? this.element("img", {className: "tml-inline-avatar tml-inline-avatar-image", src: record.avatarUrl, alt: ""})
            : this.element("span", {className: "tml-inline-avatar", textContent: record.authorName.trim().charAt(0).toUpperCase() || "?"});
        const body = this.element("div", {className: "tml-inline-body"});
        const header = this.element("div", {className: "tml-inline-header tml-inline-edit-header"});
        header.append(
            this.element("strong", {textContent: record.authorName}),
            this.element("span", {textContent: new Date(record.editedAt).toLocaleString()}),
            this.element("b", {textContent: `EDITED · ${record.editHistory.length} ${record.editHistory.length === 1 ? "VERSION" : "VERSIONS"}`})
        );
        const copy = this.element("button", {
            className: "tml-inline-copy tml-inline-edit-copy",
            type: "button",
            textContent: "Copy previous",
            title: "Copy the most recent previous version"
        });
        copy.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.copyPlainText(record.editHistory[record.editHistory.length - 1]?.content || "");
        });
        const dismiss = this.element("button", {
            className: "tml-inline-dismiss tml-inline-edit-dismiss",
            type: "button",
            textContent: "×",
            title: "Hide edit history in chat (keep it in logs)",
            "aria-label": "Hide edit history in chat but keep it in logs"
        });
        dismiss.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.dismissInlineEditedMessage(record.id);
        });
        header.append(copy, dismiss);
        body.append(header);

        const history = record.editHistory.slice().reverse();
        const versions = this.element("div", {className: `tml-inline-edit-versions${history.length > 2 ? " has-overflow" : ""}`});
        for (let index = 0; index < history.length; index++) {
            const version = history[index];
            const versionBlock = this.element("div", {className: "tml-inline-edit-version"});
            versionBlock.append(
                this.element("small", {textContent: index === 0 ? "Previous version" : `Earlier version ${index + 1}`}),
                this.element("div", {className: "tml-inline-content", textContent: this.formatMessageContent(record, version.content, "[No text content]")})
            );
            versions.append(versionBlock);
        }
        body.append(versions);
        row.append(avatar, body);
        return row;
    }

    findRenderedMessageRow(channelId, messageId) {
        if (!channelId || !messageId || !globalThis.document) return null;
        const messageNode = document.getElementById(`chat-messages-${channelId}-${messageId}`)
            || document.getElementById(`chat-messages-${messageId}`)
            || document.querySelector(`[id^="chat-messages-${channelId}-"][id$="-${messageId}"]`)
            || document.querySelector(`[id^="chat-messages-"][id$="-${messageId}"]`)
            || document.querySelector(`[data-list-item-id$="${messageId}"]`);
        return messageNode ? (messageNode.closest("li") || messageNode) : null;
    }

    getVisibleMessageRows(channelId) {
        const rows = [];
        const seen = new Set();
        for (const node of document.querySelectorAll('[id^="chat-messages-"], [data-list-item-id*="chat-messages"]')) {
            const row = node.closest("li") || node;
            if (seen.has(row) || row.hasAttribute("data-tml-deleted-message")) continue;
            seen.add(row);
            const identifier = node.id || node.getAttribute("data-list-item-id") || "";
            const id = identifier.match(/(\d{10,25})$/)?.[1] || "";
            rows.push({node: row, id, value: this.snowflakeValue(id)});
        }
        return rows;
    }

    snowflakeValue(value) {
        try {
            return BigInt(String(value));
        } catch (_) {
            return null;
        }
    }

    createInlineDeletedMessage(record, capturedClone = null) {
        if (capturedClone) {
            const clone = capturedClone.cloneNode(true);
            this.prepareClonedDeletedMessage(clone, record.id, record.channelId);
            setTimeout(() => {
                for (const video of clone.querySelectorAll("video")) {
                    video.muted = true;
                    video.loop = true;
                    video.autoplay = true;
                    video.play?.().catch?.(() => {});
                }
            }, 0);
            return clone;
        }
        const row = this.element("li", {
            className: "tml-inline-deleted",
            role: "listitem",
            "data-tml-deleted-message": record.id,
            "data-channel-id": record.channelId
        });
        const avatar = record.avatarUrl
            ? this.element("img", {className: "tml-inline-avatar tml-inline-avatar-image", src: record.avatarUrl, alt: ""})
            : this.element("span", {className: "tml-inline-avatar", textContent: record.authorName.trim().charAt(0).toUpperCase() || "?"});
        const body = this.element("div", {className: "tml-inline-body"});
        const header = this.element("div", {className: "tml-inline-header"});
        header.append(
            this.element("strong", {textContent: record.authorName}),
            this.element("span", {textContent: new Date(record.timestamp).toLocaleString()}),
            this.element("b", {textContent: "DELETED"})
        );
        const dismiss = this.element("button", {
            className: "tml-inline-dismiss",
            type: "button",
            textContent: "×",
            title: "Remove from chat (keep in logs)",
            "aria-label": "Remove deleted message from chat but keep it in logs"
        });
        dismiss.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.dismissInlineDeletedMessage(record.id);
        });
        const copy = this.element("button", {
            className: "tml-inline-copy",
            type: "button",
            textContent: "Copy",
            title: "Copy deleted message text",
            "aria-label": "Copy deleted message text"
        });
        copy.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.copyMessageText(record.id);
        });
        header.append(copy, dismiss);
        body.append(header, this.element("div", {className: "tml-inline-content", textContent: this.formatMessageContent(record, record.content, "[No text content was cached]")}));
        if (record.attachments.length) {
            body.append(this.element("small", {className: "tml-inline-attachments", textContent: `Attachments: ${record.attachments.map(item => item.filename).join(", ")}`}));
        }
        if (record.media?.length) {
            const mediaWrap = this.element("div", {className: "tml-inline-media"});
            for (const media of record.media) {
                if (media.kind === "video") {
                    const video = this.element("video", {src: media.url, title: media.alt, autoplay: "", loop: "", muted: "", playsinline: ""});
                    video.muted = true;
                    this.makeMediaClickable(video, media.url, "video");
                    mediaWrap.append(video);
                    setTimeout(() => video.play?.().catch?.(() => {}), 0);
                } else {
                    const image = this.element("img", {src: media.url, alt: media.alt, loading: "lazy"});
                    this.makeMediaClickable(image, media.url, "image");
                    mediaWrap.append(image);
                }
            }
            body.append(mediaWrap);
        }
        row.append(avatar, body);
        return row;
    }

    async copyMessageText(messageId, fallbackText = "") {
        const text = this.records.get(String(messageId))?.content || fallbackText || "";
        return this.copyPlainText(text);
    }

    async copyPlainText(text) {
        try {
            await navigator.clipboard.writeText(String(text || ""));
            this.toast("Message copied.", "success");
        } catch (_) {
            this.toast("Could not copy the message.", "error");
        }
    }

    prepareInteractiveMedia(container) {
        if (!container?.querySelectorAll) return;
        const images = container.querySelectorAll('img:not([class*="avatar"]):not([class*="emoji"]):not([class*="reaction"]):not([class*="icon"])');
        for (const image of images) {
            const url = this.sanitizeUrl(image.currentSrc || image.src);
            if (url) this.makeMediaClickable(image, url, "image");
        }
        for (const video of container.querySelectorAll("video")) {
            const source = video.currentSrc || video.src || video.querySelector("source")?.src;
            const url = this.sanitizeUrl(source);
            if (url) this.makeMediaClickable(video, url, "video");
        }
    }

    makeMediaClickable(node, url, kind) {
        if (!node || !url || node.dataset?.tmlMediaReady === "true") return;
        node.dataset.tmlMediaReady = "true";
        node.classList.add("tml-clickable-media");
        node.tabIndex = 0;
        node.setAttribute("role", "button");
        node.setAttribute("aria-label", `Open ${kind === "video" ? "video or GIF" : "image"}`);
        const open = event => {
            event.preventDefault();
            event.stopPropagation();
            this.openMediaViewer(url, kind);
        };
        node.addEventListener("click", open);
        node.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") open(event);
        });
    }

    openMediaViewer(url, kind = "image") {
        if (!globalThis.document || !this.sanitizeUrl(url)) return;
        this.closeMediaViewer();
        const backdrop = this.element("div", {className: "tml-media-viewer", role: "dialog", "aria-modal": "true", "aria-label": "Message media viewer"});
        const close = this.element("button", {className: "tml-media-viewer-close", type: "button", textContent: "×", title: "Close", "aria-label": "Close media viewer"});
        const media = kind === "video"
            ? this.element("video", {src: url, controls: "", autoplay: "", loop: "", playsinline: ""})
            : this.element("img", {src: url, alt: "Full-size message attachment"});
        if (kind === "video") media.play?.().catch?.(() => {});
        close.addEventListener("click", () => this.closeMediaViewer());
        backdrop.addEventListener("click", event => {
            if (event.target === backdrop) this.closeMediaViewer();
        });
        const onKeyDown = event => event.key === "Escape" && this.closeMediaViewer();
        backdrop._tmlKeyDown = onKeyDown;
        document.addEventListener("keydown", onKeyDown);
        backdrop.append(media, close);
        document.body.append(backdrop);
        this.mediaViewer = backdrop;
        close.focus();
    }

    closeMediaViewer() {
        if (!this.mediaViewer) return;
        document.removeEventListener("keydown", this.mediaViewer._tmlKeyDown);
        this.mediaViewer.remove();
        this.mediaViewer = null;
    }

    removeInlineDeletedMessages() {
        if (!globalThis.document) return;
        this.inlineRestoreSuppressedUntil = Date.now() + 450;
        this.fastRestoreIds.clear();
        for (const node of document.querySelectorAll("[data-tml-deleted-message]")) node.remove();
    }

    removeInlineEditedMessages() {
        if (!globalThis.document) return;
        this.inlineRestoreSuppressedUntil = Date.now() + 450;
        this.fastRestoreIds.clear();
        for (const node of document.querySelectorAll("[data-tml-edited-message]")) node.remove();
    }

    dismissInlineDeletedMessage(messageId) {
        const id = String(messageId);
        const record = this.records.get(id);
        if (!record) return;
        record.inlineDismissed = true;
        this.records.set(id, record);
        this.deletedPlacements.delete(id);
        if (globalThis.document) document.querySelector(`[data-tml-deleted-message="${id}"]`)?.remove();
        this.scheduleSave();
        this.toast("Removed from chat; the message is still saved in logs.", "success");
    }

    dismissInlineEditedMessage(messageId) {
        const id = String(messageId);
        const record = this.records.get(id);
        if (!record) return;
        record.inlineEditDismissed = true;
        this.records.set(id, record);
        if (globalThis.document) document.querySelector(`[data-tml-edited-message="${id}"]`)?.remove();
        this.scheduleSave();
        this.toast("Edit history hidden from chat; it is still saved in logs.", "success");
    }

    snapshotMessage(message, channel, existing = null) {
        const id = String(message.id);
        const channelId = String(message.channel_id || message.channelId || existing?.channelId || "");
        const guildId = message.guild_id || message.guildId || channel?.guild_id || channel?.guildId || existing?.guildId || null;
        const guild = guildId ? this.stores.guild?.getGuild?.(guildId) : null;
        const author = message.author || this.stores.user?.getUser?.(message.author_id || message.authorId) || null;
        const authorId = String(author?.id || message.author_id || message.authorId || existing?.authorId || "unknown");
        return {
            id,
            channelId,
            guildId: guildId ? String(guildId) : null,
            channelName: String(channel?.name || existing?.channelName || (guildId ? "Unknown channel" : "Direct Message")),
            guildName: String(guild?.name || existing?.guildName || (guildId ? "Unknown server" : "Direct Messages")),
            authorId,
            authorName: String(author?.globalName || author?.displayName || author?.username || existing?.authorName || `User ${authorId.slice(-4)}`),
            authorBot: Boolean(author?.bot ?? existing?.authorBot),
            avatarUrl: this.getAvatarUrl(author, guildId) || existing?.avatarUrl || "",
            content: String(message.content ?? existing?.content ?? "").slice(0, 10000),
            attachments: this.snapshotAttachments(message.attachments ?? existing?.attachments),
            media: this.snapshotMedia(message, existing),
            inlineEligible: existing?.inlineEligible === true,
            inlineDismissed: existing?.inlineDismissed === true,
            inlinePreviousId: existing?.inlinePreviousId || null,
            inlineNextId: existing?.inlineNextId || null,
            inlineEditEligible: existing?.inlineEditEligible === true,
            inlineEditDismissed: existing?.inlineEditDismissed === true,
            timestamp: this.messageTimestamp(message) || existing?.timestamp || Date.now(),
            editedAt: existing?.editedAt || null,
            deletedAt: existing?.deletedAt || null,
            editHistory: existing?.editHistory || []
        };
    }

    snapshotAttachments(attachments) {
        const list = attachments instanceof Map ? [...attachments.values()] : Array.isArray(attachments) ? attachments : [];
        return list.slice(0, 20).map(attachment => ({
            filename: String(attachment?.filename || attachment?.name || "attachment").slice(0, 300),
            size: Math.max(0, Number(attachment?.size) || 0),
            url: this.sanitizeUrl(attachment?.url),
            proxyUrl: this.sanitizeUrl(attachment?.proxy_url || attachment?.proxyUrl),
            contentType: String(attachment?.content_type || attachment?.contentType || "").slice(0, 100)
        }));
    }

    getAvatarUrl(author, guildId) {
        if (!author) return "";
        try {
            const generated = author.getAvatarURL?.(guildId, 80, true)
                || author.getAvatarSource?.(guildId, 80, true)?.uri
                || author.avatarURL;
            const sanitized = this.sanitizeUrl(generated);
            if (sanitized) return sanitized;
        } catch (_) {}
        const userId = String(author.id || "");
        const avatarHash = String(author.avatar || "");
        if (userId && avatarHash) {
            const extension = avatarHash.startsWith("a_") ? "gif" : "png";
            return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=80`;
        }
        if (userId) {
            try {
                const discriminator = String(author.discriminator || "0");
                const index = discriminator !== "0"
                    ? Number(discriminator) % 5
                    : Number((BigInt(userId) >> 22n) % 6n);
                return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
            } catch (_) {}
        }
        return "";
    }

    snapshotMedia(message, existing = null) {
        const media = [];
        const add = (url, kind, alt) => {
            const cleanUrl = this.sanitizeUrl(url);
            if (!cleanUrl || media.some(item => item.url === cleanUrl)) return;
            media.push({url: cleanUrl, kind: kind === "video" ? "video" : "image", alt: String(alt || "Deleted message media").slice(0, 300)});
        };
        const attachments = this.snapshotAttachments(message.attachments ?? existing?.attachments);
        for (const attachment of attachments) {
            const url = attachment.proxyUrl || attachment.url;
            const type = attachment.contentType.toLowerCase();
            const name = attachment.filename.toLowerCase();
            if (type.startsWith("video/") || /\.(mp4|webm|mov)$/.test(name)) add(url, "video", attachment.filename);
            else if (type.startsWith("image/") || /\.(gif|png|jpe?g|webp|avif)$/.test(name)) add(url, "image", attachment.filename);
        }
        const embeds = message.embeds instanceof Map ? [...message.embeds.values()] : Array.isArray(message.embeds) ? message.embeds : [];
        for (const embed of embeds) {
            const videoUrl = embed?.video?.proxy_url || embed?.video?.proxyUrl || embed?.video?.url;
            const imageUrl = embed?.image?.proxy_url || embed?.image?.proxyUrl || embed?.image?.url;
            const thumbnailUrl = embed?.thumbnail?.proxy_url || embed?.thumbnail?.proxyUrl || embed?.thumbnail?.url;
            if (videoUrl) add(videoUrl, "video", embed?.title || "Animated embed");
            else if (imageUrl) add(imageUrl, "image", embed?.title || "Image embed");
            else if (thumbnailUrl) add(thumbnailUrl, "image", embed?.title || "Embed thumbnail");
        }
        if (!media.length && Array.isArray(existing?.media)) {
            for (const item of existing.media) add(item.url, item.kind, item.alt);
        }
        return media.slice(0, 20);
    }

    placeholderRecord(id, channelId, guildId, channel) {
        const guild = guildId ? this.stores.guild?.getGuild?.(guildId) : null;
        return {
            id,
            channelId,
            guildId: guildId ? String(guildId) : null,
            channelName: channel?.name || (guildId ? "Unknown channel" : "Direct Message"),
            guildName: guild?.name || (guildId ? "Unknown server" : "Direct Messages"),
            authorId: "unknown",
            authorName: "Unknown user",
            authorBot: false,
            avatarUrl: "",
            content: "Message content was not cached before deletion.",
            attachments: [],
            media: [],
            inlineEligible: false,
            inlineDismissed: false,
            inlinePreviousId: null,
            inlineNextId: null,
            inlineEditEligible: false,
            inlineEditDismissed: false,
            timestamp: Date.now(),
            editedAt: null,
            deletedAt: null,
            editHistory: []
        };
    }

    messageTimestamp(message) {
        const direct = this.parseTimestamp(message.timestamp);
        if (direct) return direct;
        try {
            return Number((BigInt(message.id) >> 22n) + 1420070400000n);
        } catch (_) {
            return 0;
        }
    }

    parseTimestamp(value) {
        if (!value) return 0;
        if (typeof value === "number") return Number.isFinite(value) ? value : 0;
        if (value instanceof Date) return value.getTime();
        if (typeof value?.toDate === "function") return value.toDate().getTime();
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : 0;
    }

    pruneRecords(now = Date.now()) {
        const cutoff = now - this.settings.retentionDays * 86400000;
        for (const [id, record] of this.records) {
            const latest = record.deletedAt || record.editedAt || record.timestamp;
            if (latest < cutoff) this.records.delete(id);
        }
        const maximum = Math.floor(this.settings.maxRecords);
        if (this.records.size <= maximum) return;
        const ordered = [...this.records.values()].sort((left, right) => {
            const leftTime = left.deletedAt || left.editedAt || left.timestamp;
            const rightTime = right.deletedAt || right.editedAt || right.timestamp;
            return rightTime - leftTime;
        });
        this.records = new Map(ordered.slice(0, maximum).map(record => [record.id, record]));
    }

    getFilteredRecords(filter = "all", query = "") {
        const needle = String(query).trim().toLowerCase();
        return [...this.records.values()]
            .filter(record => {
                if (filter === "servers") return Boolean(record.guildId);
                if (filter === "dms") return !record.guildId;
                if (filter === "deleted") return Boolean(record.deletedAt);
                if (filter === "edited") return Boolean(record.editedAt);
                if (filter === "deleted-servers") return Boolean(record.deletedAt && record.guildId);
                if (filter === "deleted-dms") return Boolean(record.deletedAt && !record.guildId);
                if (filter === "edited-servers") return Boolean(record.editedAt && record.guildId);
                if (filter === "edited-dms") return Boolean(record.editedAt && !record.guildId);
                return true;
            })
            .filter(record => !needle || [record.content, record.authorName, record.channelName, record.guildName]
                .some(value => String(value).toLowerCase().includes(needle)))
            .sort((left, right) => {
                const leftTime = left.deletedAt || left.editedAt || left.timestamp;
                const rightTime = right.deletedAt || right.editedAt || right.timestamp;
                return rightTime - leftTime;
            });
    }

    formatMessageContent(record, content, emptyFallback = "[No text content]") {
        const text = String(content || "").trim();
        if (!text) return emptyFallback;
        const isSingleUrl = /^https?:\/\/\S+$/i.test(text);
        const isKnownGifUrl = /(?:tenor\.com|giphy\.com|gfycat\.com|media\.discordapp\.net|cdn\.discordapp\.com)/i.test(text)
            && /(?:gif|tenor|giphy|gfycat)/i.test(text);
        if (isSingleUrl && (isKnownGifUrl || record?.media?.length)) return "[GIF]";
        return String(content);
    }

    repairFalseGifEdits() {
        for (const record of this.records.values()) {
            if (!record.editedAt || !record.media?.length || record.editHistory?.length !== 1) continue;
            const previous = String(record.editHistory[0]?.content || "").trim();
            const current = String(record.content || "").trim();
            if (this.formatMessageContent(record, previous) !== "[GIF]") continue;
            if (current && current !== previous && current !== "[GIF]") continue;
            record.editHistory = [];
            record.editedAt = null;
            record.inlineEditEligible = false;
            record.inlineEditDismissed = false;
        }
    }

    repairDuplicateCurrentEditVersions() {
        for (const record of this.records.values()) this.repairRecordEditHistory(record);
    }

    repairRecordEditHistory(record) {
        if (!record?.editHistory?.length) return;
        while (record.editHistory.length && String(record.editHistory[record.editHistory.length - 1]?.content || "") === String(record.content || "")) {
            record.editHistory.pop();
        }
        if (!record.editHistory.length) {
            record.editedAt = null;
            record.inlineEditEligible = false;
            record.inlineEditDismissed = false;
        }
    }

    scheduleSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveRecords();
        }, 500);
    }

    saveRecords() {
        this.save("records", [...this.records.values()]);
        this.quickButton?.update?.({status: `${this.records.size} locally saved messages`});
    }

    ensureQuickButton() {
        this.removeQuickButton();
        if (!this.started || !this.settings.showQuickButton) return;
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.quickButton = library.register({id: "message-logger", name: "Message Logger", description: "Search deleted and edited messages", icon: "📝", order: 5, status: `${this.records.size} locally saved messages`, open: () => this.openDashboard()});
    }

    removeQuickButton() {
        this.quickButton?.remove();
        this.quickButton = null;
    }

    openDashboard() {
        this.closeDashboard();
        const drawer = this.element("aside", {className: "tml-drawer", role: "complementary", "aria-label": "Message Logger"});
        const header = this.element("header", {className: "tml-header"});
        const heading = this.element("div", {className: "tml-title-wrap"});
        const headingCopy = this.element("div", {className: "tml-title-copy"});
        headingCopy.append(
            this.element("h1", {textContent: "Message Logger"}),
            this.element("p", {textContent: "Private logs stored on this device"})
        );
        heading.append(this.element("span", {className: "tml-header-icon", textContent: "ML", "aria-hidden": "true"}), headingCopy);
        const close = this.element("button", {className: "tml-close", type: "button", textContent: "×", title: "Close"});
        close.addEventListener("click", () => this.closeDashboard());
        header.append(heading, close);
        const content = this.element("div", {className: "tml-content"});
        drawer.append(header, content);
        document.body.append(drawer);
        this.dashboard = drawer;
        this.renderDashboard(content);
    }

    closeDashboard() {
        this.dashboard?.remove();
        this.dashboard = null;
    }

    renderDashboard(content) {
        content.replaceChildren();
        const allRecords = [...this.records.values()];
        const deletedCount = allRecords.filter(record => record.deletedAt).length;
        const editedCount = allRecords.filter(record => record.editedAt).length;
        const serverCount = allRecords.filter(record => record.guildId).length;
        const dmCount = allRecords.length - serverCount;
        const summary = this.element("div", {className: "tml-summary"});
        for (const [label, value, tone, title] of [
            ["Server messages", serverCount, "servers", "All unique server messages currently stored"],
            ["DM messages", dmCount, "dms", "All unique direct messages currently stored"],
            ["Deleted", deletedCount, "deleted", "Messages marked as deleted"],
            ["Edited", editedCount, "edited", "Messages with saved edit history"]
        ]) {
            const card = this.element("div", {className: `tml-summary-card ${tone}`, title, "data-tml-summary": tone});
            card.append(this.element("span", {textContent: label}), this.element("strong", {textContent: value}));
            summary.append(card);
        }

        const controls = this.element("div", {className: "tml-controls"});
        const search = this.element("input", {type: "search", placeholder: "Search messages, people, servers, or channels"});
        search.className = "tml-search";
        search.value = this.dashboardSearch;
        const exportButton = this.element("button", {type: "button", textContent: "Export JSON"});
        exportButton.addEventListener("click", () => this.exportRecords());
        controls.append(search, exportButton);

        const filterPanel = this.element("section", {className: "tml-filter-panel", "aria-label": "Filter message logs"});
        const filterHeading = this.element("div", {className: "tml-filter-heading"});
        filterHeading.append(
            this.element("strong", {textContent: "Filter logs"}),
            this.element("span", {textContent: "Choose an activity and location"})
        );
        const filterFields = this.element("div", {className: "tml-filter-fields"});
        const statusField = this.element("label", {className: "tml-filter-field"});
        const status = this.element("select", {"aria-label": "Message activity"});
        status.append(
            this.element("option", {value: "all", textContent: "All messages"}),
            this.element("option", {value: "deleted", textContent: "Deleted messages"}),
            this.element("option", {value: "edited", textContent: "Edited messages"})
        );
        statusField.append(this.element("span", {textContent: "Activity"}), status);
        const locationField = this.element("label", {className: "tml-filter-field"});
        const location = this.element("select", {"aria-label": "Message location"});
        location.append(
            this.element("option", {value: "all", textContent: "Servers and DMs"}),
            this.element("option", {value: "servers", textContent: "Servers only"}),
            this.element("option", {value: "dms", textContent: "DMs only"})
        );
        locationField.append(this.element("span", {textContent: "Location"}), location);
        const selectedFilters = this.getDashboardFilterParts(this.dashboardSection);
        status.value = selectedFilters.status;
        location.value = selectedFilters.location;
        filterFields.append(statusField, locationField);
        filterPanel.append(filterHeading, filterFields);

        const resultInfo = this.element("div", {className: "tml-result-info"});
        const list = this.element("div", {className: "tml-record-list"});
        const refresh = () => {
            this.dashboardSearch = search.value;
            const records = this.getFilteredRecords(this.dashboardSection, this.dashboardSearch);
            resultInfo.textContent = records.length > 500
                ? `Showing the newest 500 of ${records.length} matching records.`
                : `${records.length} matching ${records.length === 1 ? "record" : "records"}.`;
            list.replaceChildren();
            if (!records.length) {
                list.append(this.element("div", {className: "tml-empty", textContent: "No matching messages have been recorded."}));
                return;
            }
            for (const record of records.slice(0, 500)) list.append(this.buildRecordCard(record));
        };
        const applyFilters = () => {
            this.dashboardSection = this.combineDashboardFilters(status.value, location.value);
            refresh();
        };
        status.addEventListener("change", applyFilters);
        location.addEventListener("change", applyFilters);
        search.addEventListener("input", refresh);
        content.append(summary, controls, filterPanel, resultInfo, list);
        refresh();
    }

    updateDashboardSummary() {
        if (!this.dashboard) return;
        const allRecords = [...this.records.values()];
        const counts = {
            servers: allRecords.filter(record => record.guildId).length,
            dms: allRecords.filter(record => !record.guildId).length,
            deleted: allRecords.filter(record => record.deletedAt).length,
            edited: allRecords.filter(record => record.editedAt).length
        };
        for (const [key, value] of Object.entries(counts)) {
            const number = this.dashboard.querySelector(`[data-tml-summary="${key}"] strong`);
            if (number) number.textContent = String(value);
        }
    }

    scheduleDashboardSummaryUpdate() {
        if (!this.dashboard || this.dashboardSummaryTimer) return;
        this.dashboardSummaryTimer = setTimeout(() => {
            this.dashboardSummaryTimer = null;
            this.updateDashboardSummary();
        }, 50);
    }

    getDashboardFilterParts(filter) {
        const value = String(filter || "all");
        const status = value.startsWith("deleted") ? "deleted" : value.startsWith("edited") ? "edited" : "all";
        const location = value.endsWith("servers") || value === "servers"
            ? "servers"
            : value.endsWith("dms") || value === "dms" ? "dms" : "all";
        return {status, location};
    }

    combineDashboardFilters(status, location) {
        if (status === "all") return location === "servers" ? "servers" : location === "dms" ? "dms" : "all";
        if (location === "servers") return `${status}-servers`;
        if (location === "dms") return `${status}-dms`;
        return status;
    }

    buildRecordCard(record) {
        const recordState = record.deletedAt ? " is-deleted" : record.editedAt ? " is-edited" : "";
        const card = this.element("article", {className: `tml-record${recordState}`});
        const top = this.element("div", {className: "tml-record-top"});
        const person = this.element("div", {className: "tml-record-person"});
        const avatar = record.avatarUrl
            ? this.element("img", {className: "tml-record-avatar", src: record.avatarUrl, alt: ""})
            : this.element("span", {className: "tml-record-avatar tml-record-avatar-fallback", textContent: record.authorName.trim().charAt(0).toUpperCase() || "?"});
        const identity = this.element("div", {className: "tml-identity"});
        identity.append(
            this.element("strong", {textContent: record.authorName}),
            this.element("span", {className: "tml-record-location", textContent: record.guildId ? `${record.guildName}  ›  #${record.channelName}` : `Direct Messages  ›  ${record.channelName}`}),
            this.element("time", {className: "tml-record-time", datetime: new Date(record.timestamp).toISOString(), textContent: new Date(record.timestamp).toLocaleString()})
        );
        person.append(avatar, identity);
        const badges = this.element("div", {className: "tml-badges"});
        if (record.deletedAt) badges.append(this.element("span", {className: "deleted", textContent: "DELETED"}));
        if (record.editedAt) badges.append(this.element("span", {className: "edited", textContent: "EDITED"}));
        top.append(person, badges);
        const body = this.element("div", {className: "tml-message", textContent: this.formatMessageContent(record, record.content)});
        card.append(top, body);

        if (record.attachments.length) {
            const attachments = this.element("div", {className: "tml-attachments", textContent: `Attachments: ${record.attachments.map(item => item.filename).join(", ")}`});
            card.append(attachments);
        }
        if (record.media?.length) {
            const mediaGrid = this.element("div", {className: "tml-record-media"});
            for (const item of record.media.slice(0, 8)) {
                if (item.kind === "video") {
                    const video = this.element("video", {src: item.url, muted: "", loop: "", playsinline: "", title: item.alt});
                    video.muted = true;
                    this.makeMediaClickable(video, item.url, "video");
                    mediaGrid.append(video);
                } else {
                    const image = this.element("img", {src: item.url, alt: item.alt, loading: "lazy"});
                    this.makeMediaClickable(image, item.url, "image");
                    mediaGrid.append(image);
                }
            }
            card.append(mediaGrid);
        }
        if (record.editHistory.length) {
            const details = this.element("details", {className: "tml-history"});
            details.append(this.element("summary", {textContent: `${record.editHistory.length} previous ${record.editHistory.length === 1 ? "version" : "versions"}`}));
            for (const version of record.editHistory.slice().reverse()) {
                const item = this.element("div");
                item.append(
                    this.element("small", {textContent: new Date(version.timestamp).toLocaleString()}),
                    this.element("p", {textContent: this.formatMessageContent(record, version.content)})
                );
                details.append(item);
            }
            card.append(details);
        }
        const actions = this.element("div", {className: "tml-actions"});
        const jump = this.element("button", {type: "button", textContent: "Jump to message"});
        jump.addEventListener("click", () => this.jumpToRecord(record));
        const copy = this.element("button", {type: "button", textContent: "Copy text"});
        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(record.content || "");
                this.toast("Message copied.", "success");
            } catch (_) {
                this.toast("Could not copy the message.", "error");
            }
        });
        actions.append(jump, copy);
        card.append(actions);
        return card;
    }

    jumpToRecord(record) {
        if (!record?.channelId) {
            this.toast("This log does not have a channel to open.", "error");
            return;
        }

        const channel = this.stores.channel?.getChannel?.(record.channelId) || null;
        if (this.stores.channel?.getChannel && !channel) {
            this.toast("That channel is no longer available to this Discord account.", "error");
            return;
        }
        const isDeleted = Boolean(record.deletedAt);
        if (isDeleted) {
            record.inlineEligible = true;
            record.inlineDismissed = false;
            this.records.set(record.id, record);
            this.scheduleSave();
        }

        const targetPath = this.getRecordPath(record, channel);
        const channelPath = this.getChannelPath(record, channel);
        const jumpToken = ++this.jumpToken;
        if (!this.navigateToDiscordPath(targetPath, channelPath)) {
            this.toast("Could not safely open that Discord channel.", "error");
            return;
        }
        this.closeDashboard();

        setTimeout(() => this.locateJumpTarget(record, 0, jumpToken), 300);
    }

    getChannelPath(record, channel = null) {
        const guildId = channel?.guild_id || channel?.guildId || record.guildId || "@me";
        return `/channels/${guildId}/${record.channelId}`;
    }

    getRecordPath(record, channel = null) {
        const channelPath = this.getChannelPath(record, channel);
        const targetId = record.deletedAt ? null : record.id;
        return targetId ? `${channelPath}/${targetId}` : channelPath;
    }

    navigateToDiscordPath(targetPath, channelPath = targetPath) {
        this.navigation = this.navigation || this.findNavigationModule();
        if (typeof this.navigation?.transitionTo === "function") {
            try {
                this.navigation.transitionTo(targetPath);
                return true;
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}] Discord's navigator rejected the path:`, error);
                this.navigation = null;
            }
        }

        if (!globalThis.document || !globalThis.history || !globalThis.location) return false;
        const channelLink = [...document.querySelectorAll('a[href^="/channels/"]')].find(link => {
            try {
                return new URL(link.href, location.origin).pathname === channelPath;
            } catch (_) {
                return false;
            }
        });
        if (channelLink) {
            channelLink.click();
            return true;
        }

        try {
            history.pushState(history.state, "", targetPath);
            const navigationEvent = typeof globalThis.PopStateEvent === "function"
                ? new PopStateEvent("popstate", {state: history.state})
                : new Event("popstate");
            globalThis.dispatchEvent(navigationEvent);
            return true;
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Browser-history navigation failed:`, error);
            return false;
        }
    }

    locateJumpTarget(record, attempt, jumpToken = this.jumpToken) {
        if (!this.started || jumpToken !== this.jumpToken || !globalThis.document) return;
        if (record.deletedAt) {
            this.restoreInlineDeletedMessage(record.id);
        }
        const target = record.deletedAt
            ? document.querySelector(`[data-tml-deleted-message="${record.id}"]`)
            : this.findRenderedMessageRow(record.channelId, record.id);
        if (!target) {
            if (attempt >= 5) {
                const authorName = record.authorName && record.authorName !== "Unknown user"
                    ? record.authorName
                    : "Unknown user";
                const locationName = record.guildId
                    ? `#${record.channelName} in ${record.guildName}`
                    : `the DM with ${authorName}`;
                this.toast(
                    record.deletedAt
                        ? `Opened ${locationName}, but ${authorName}'s deleted message is outside the currently loaded area.`
                        : `Opened ${locationName}, but Discord could not load ${authorName}'s message.`,
                    "info"
                );
                return;
            }
            setTimeout(() => this.locateJumpTarget(record, attempt + 1, jumpToken), 300);
            return;
        }
        try {
            target.scrollIntoView?.({behavior: "auto", block: "center"});
        } catch (_) {}
        target.classList.add("tml-jump-target");
        setTimeout(() => target.classList.remove("tml-jump-target"), 2400);
    }

    exportRecords() {
        const payload = JSON.stringify({
            exportedAt: new Date().toISOString(),
            plugin: PLUGIN_NAME,
            records: this.getFilteredRecords("all", "")
        }, null, 2);
        const url = URL.createObjectURL(new Blob([payload], {type: "application/json;charset=utf-8"}));
        const link = document.createElement("a");
        link.href = url;
        link.download = `discord-message-log-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.toast("Message log exported.", "success");
    }

    getSettingsPanel() {
        const panel = this.element("div", {className: "tml-settings"});
        panel.append(
            this.element("h2", {textContent: "Tiny Message Logger"}),
            this.element("p", {textContent: "Messages, edits, and deletion markers stay in BetterDiscord's local plugin storage."})
        );
        const open = this.element("button", {className: "tml-primary", type: "button", textContent: "Open message log"});
        open.addEventListener("click", () => this.openDashboard());
        panel.append(
            open,
            this.checkboxSetting("Show in Tiny Plugin Library", "Keep Message Logger in the shared tiny plugin launcher.", "showQuickButton", () => this.ensureQuickButton()),
            this.checkboxSetting("Keep deleted messages in chat", "Show locally preserved deleted messages inline with a red Deleted marker.", "showDeletedInline", () => {
                if (this.settings.showDeletedInline) this.restoreVisibleDeletedMessages();
                else this.removeInlineDeletedMessages();
            }),
            this.checkboxSetting("Show message edits in chat", "Keep previous message versions visible inline with a yellow Edited marker.", "showEditedInline", () => {
                if (this.settings.showEditedInline) this.restoreVisibleEditedMessages();
                else this.removeInlineEditedMessages();
            }),
            this.checkboxSetting("Log direct messages", "Record DMs and group DMs received by this client.", "logDMs"),
            this.checkboxSetting("Log server messages", "Record messages received from servers.", "logServers"),
            this.checkboxSetting("Log bot messages", "Include messages sent by bot accounts.", "logBots"),
            this.checkboxSetting("Log your own messages", "Include messages sent by your own account.", "logOwnMessages"),
            this.numberSetting("Retention period", "Delete records older than this many days (1 to 3,650).", "retentionDays", 1, 3650),
            this.numberSetting("Maximum records", "Keep at most this many messages (100 to 100,000).", "maxRecords", 100, 100000)
        );
        const clear = this.element("button", {className: "tml-danger", type: "button", textContent: "Clear all message logs"});
        clear.addEventListener("click", () => this.confirmClear());
        panel.append(clear);
        return panel;
    }

    checkboxSetting(title, description, key, afterChange) {
        const row = this.settingRow(title, description);
        const input = this.element("input", {type: "checkbox"});
        input.checked = Boolean(this.settings[key]);
        input.addEventListener("change", () => {
            this.settings[key] = input.checked;
            this.saveSettings();
            afterChange?.();
        });
        row.append(input);
        return row;
    }

    numberSetting(title, description, key, minimum, maximum) {
        const row = this.settingRow(title, description);
        const input = this.element("input", {className: "tml-number", type: "number", min: minimum, max: maximum, step: 1, value: this.settings[key]});
        input.addEventListener("change", () => {
            const parsed = Number(input.value);
            this.settings[key] = Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : DEFAULT_SETTINGS[key];
            input.value = this.settings[key];
            this.pruneRecords();
            this.saveSettings();
            this.scheduleSave();
        });
        row.append(input);
        return row;
    }

    settingRow(title, description) {
        const row = this.element("label", {className: "tml-setting-row"});
        const copy = this.element("span", {className: "tml-setting-copy"});
        copy.append(this.element("strong", {textContent: title}), this.element("small", {textContent: description}));
        row.append(copy);
        return row;
    }

    confirmClear() {
        const clear = () => {
            this.records.clear();
            this.saveRecords();
            this.removeInlineDeletedMessages();
            this.removeInlineEditedMessages();
            this.closeDashboard();
            this.toast("All message logs cleared.", "success");
        };
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showConfirmationModal) {
            ui.showConfirmationModal(
                "Clear all message logs?",
                "This permanently deletes every locally stored message, edit, and deletion record. This cannot be undone.",
                {danger: true, confirmText: "Clear logs", cancelText: "Cancel", onConfirm: clear}
            );
        } else if (globalThis.confirm?.("Permanently clear every message log?")) clear();
    }

    saveSettings() {
        this.save("settings", this.settings);
    }

    load(key) {
        try {
            if (this.api?.Data?.load) return this.api.Data.load(key);
            return globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key);
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not load ${key}:`, error);
            return undefined;
        }
    }

    save(key, value) {
        try {
            if (this.api?.Data?.save) this.api.Data.save(key, value);
            else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value);
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not save ${key}:`, error);
        }
    }

    toast(message, type = "info") {
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showToast) ui.showToast(message, {type, timeout: 5000});
        else console.log(`[${PLUGIN_NAME}] ${message}`);
    }

    element(tag, properties = {}) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === "className") node.className = value;
            else if (key === "textContent") node.textContent = value;
            else if (key === "title") node.title = value;
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        return node;
    }

    addStyles() {
        const css = `
            .tml-quick-button {
                position: fixed !important; right: 6px !important; top: 42px !important; z-index: 1000 !important;
                display: grid !important; place-items: center !important; width: 29px !important; height: 29px !important;
                padding: 0 !important; border: 1px solid rgba(255,255,255,.08) !important; border-radius: 50% !important;
                background: rgba(30,31,36,.72) !important; color: #b5bac1 !important; box-shadow: 0 2px 8px rgba(0,0,0,.2) !important;
                font: 17px/1 var(--font-primary, Arial, sans-serif) !important; cursor: pointer !important; opacity: .34 !important;
                transition: opacity .15s ease, transform .15s ease, background .15s ease !important;
            }
            .tml-quick-button:hover, .tml-quick-button:focus-visible { background: #2b2d31 !important; color: white !important; opacity: 1 !important; transform: scale(1.07) !important; }
            .tml-drawer { position: fixed !important; right: 0 !important; top: 32px !important; bottom: 0 !important; z-index: 2147482800 !important; display: flex !important; flex-direction: column !important; width: min(520px, 48vw) !important; min-width: 380px !important; overflow: hidden !important; border-left: 1px solid #303238 !important; background: linear-gradient(180deg,#121316 0%,#0f1012 100%) !important; color: #f2f3f5 !important; box-shadow: -16px 0 42px rgba(0,0,0,.46) !important; font-family: var(--font-primary, Arial, sans-serif) !important; animation: tml-slide-in .16s ease-out !important; }
            @keyframes tml-slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            .tml-header { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 18px 22px !important; border-bottom: 1px solid #2b2d31 !important; background: rgba(23,24,28,.96) !important; }
            .tml-title-wrap { display: flex !important; align-items: center !important; gap: 12px !important; min-width: 0 !important; }
            .tml-header-icon { display: grid !important; place-items: center !important; flex: 0 0 auto !important; width: 38px !important; height: 38px !important; border-radius: 11px !important; background: linear-gradient(145deg,#6875f5,#4752c4) !important; color: white !important; box-shadow: 0 6px 18px rgba(88,101,242,.25) !important; font-size: 11px !important; font-weight: 900 !important; letter-spacing: .4px !important; }
            .tml-title-copy { min-width: 0 !important; }
            .tml-header h1 { margin: 0 !important; color: #f2f3f5 !important; font-size: 20px !important; line-height: 1.15 !important; }
            .tml-header p { margin: 4px 0 0 !important; color: #8b929c !important; font-size: 11px !important; }
            .tml-close { width: 35px !important; height: 35px !important; padding: 0 !important; border: 0 !important; border-radius: 6px !important; background: transparent !important; color: #b5bac1 !important; font-size: 28px !important; cursor: pointer !important; }
            .tml-close:hover { background: #2b2d31 !important; color: white !important; }
            .tml-content { overflow: auto !important; padding: 18px 20px 30px !important; scrollbar-color: #35373c transparent !important; }
            .tml-summary { display: grid !important; grid-template-columns: repeat(4,1fr) !important; gap: 8px !important; }
            .tml-summary-card { position: relative !important; display: flex !important; flex-direction: column !important; gap: 4px !important; min-width: 0 !important; padding: 12px 13px 11px !important; overflow: hidden !important; border: 1px solid #2d2f34 !important; border-radius: 9px !important; background: #191a1e !important; }
            .tml-summary-card::before { content: "" !important; position: absolute !important; left: 0 !important; top: 0 !important; bottom: 0 !important; width: 3px !important; background: #5865f2 !important; }
            .tml-summary-card.dms::before { background: #3ba55c !important; }
            .tml-summary-card.deleted::before { background: #da373c !important; }
            .tml-summary-card.edited::before { background: #e0a52b !important; }
            .tml-summary-card span { overflow: hidden !important; color: #949ba4 !important; font-size: 9px !important; font-weight: 700 !important; letter-spacing: .45px !important; text-overflow: ellipsis !important; text-transform: uppercase !important; }
            .tml-summary-card strong { color: white !important; font-size: 20px !important; line-height: 1.1 !important; }
            .tml-controls { display: grid !important; grid-template-columns: minmax(160px,1fr) auto !important; gap: 8px !important; margin: 14px 0 10px !important; }
            .tml-controls input, .tml-controls select { padding: 10px 12px !important; border: 1px solid #35373d !important; border-radius: 7px !important; outline: none !important; background: #1a1b1f !important; color: #f2f3f5 !important; }
            .tml-controls input:focus { border-color: #5865f2 !important; }
            .tml-controls button, .tml-actions button { padding: 8px 12px !important; border: 0 !important; border-radius: 6px !important; background: #5865f2 !important; color: white !important; font-weight: 600 !important; cursor: pointer !important; transition: background .14s ease, color .14s ease, transform .14s ease !important; }
            .tml-controls button:hover, .tml-actions button:hover { transform: translateY(-1px) !important; }
            .tml-filter-panel { margin-bottom: 13px !important; padding: 13px !important; border: 1px solid #2d2f34 !important; border-radius: 9px !important; background: #17181c !important; }
            .tml-filter-heading { display: flex !important; align-items: baseline !important; justify-content: space-between !important; gap: 10px !important; margin-bottom: 9px !important; }
            .tml-filter-heading strong { color: #f2f3f5 !important; font-size: 13px !important; }
            .tml-filter-heading span { color: #777e88 !important; font-size: 10px !important; }
            .tml-filter-fields { display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 8px !important; }
            .tml-filter-field { display: flex !important; flex-direction: column !important; gap: 5px !important; min-width: 0 !important; }
            .tml-filter-field > span { color: #949ba4 !important; font-size: 10px !important; font-weight: 700 !important; text-transform: uppercase !important; }
            .tml-filter-field select { width: 100% !important; min-width: 0 !important; padding: 8px 9px !important; border: 1px solid #3f4147 !important; border-radius: 5px !important; outline: none !important; background: #1f2024 !important; color: #f2f3f5 !important; cursor: pointer !important; }
            .tml-filter-field select:focus { border-color: #5865f2 !important; }
            .tml-result-info { margin: 2px 2px 10px !important; color: #838a94 !important; font-size: 10px !important; font-weight: 700 !important; letter-spacing: .25px !important; text-transform: uppercase !important; }
            .tml-record-list { display: flex !important; flex-direction: column !important; gap: 10px !important; }
            .tml-record { position: relative !important; padding: 14px !important; overflow: hidden !important; border: 1px solid #2d2f34 !important; border-radius: 10px !important; background: #191a1e !important; box-shadow: 0 3px 10px rgba(0,0,0,.12) !important; transition: border-color .14s ease, background .14s ease !important; }
            .tml-record:hover { border-color: #3a3d44 !important; background: #1c1d22 !important; }
            .tml-record.is-deleted { border-left: 3px solid #da373c !important; }
            .tml-record.is-edited { border-left: 3px solid #e0a52b !important; }
            .tml-record-top { display: flex !important; align-items: flex-start !important; justify-content: space-between !important; gap: 14px !important; }
            .tml-record-person { display: flex !important; align-items: center !important; gap: 10px !important; min-width: 0 !important; }
            .tml-record-avatar { flex: 0 0 auto !important; width: 34px !important; height: 34px !important; border-radius: 50% !important; object-fit: cover !important; background: #303239 !important; }
            .tml-record-avatar-fallback { display: grid !important; place-items: center !important; color: white !important; font-size: 13px !important; font-weight: 700 !important; }
            .tml-identity { display: flex !important; flex-direction: column !important; gap: 2px !important; min-width: 0 !important; }
            .tml-identity strong { overflow: hidden !important; color: #f2f3f5 !important; font-size: 14px !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
            .tml-record-location { overflow: hidden !important; color: #9ba2ac !important; font-size: 10px !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
            .tml-record-time { color: #707781 !important; font-size: 9px !important; }
            .tml-badges { display: flex !important; gap: 5px !important; }
            .tml-badges span { padding: 2px 5px !important; border-radius: 3px !important; color: white !important; font-size: 8px !important; font-weight: 800 !important; }
            .tml-badges .deleted { background: #da373c !important; }
            .tml-badges .edited { background: #b7791f !important; }
            .tml-message { margin-top: 11px !important; padding: 10px 11px !important; border-radius: 7px !important; background: #141519 !important; color: #dbdee1 !important; font-size: 13px !important; line-height: 1.45 !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; user-select: text !important; cursor: text !important; }
            .tml-attachments { margin-top: 8px !important; color: #949ba4 !important; font-size: 11px !important; }
            .tml-record-media { display: grid !important; grid-template-columns: repeat(2,minmax(0,1fr)) !important; gap: 6px !important; margin-top: 9px !important; }
            .tml-record-media img, .tml-record-media video { width: 100% !important; height: 120px !important; border-radius: 7px !important; object-fit: cover !important; background: #0f1012 !important; }
            .tml-history { margin-top: 10px !important; color: #b5bac1 !important; }
            .tml-history summary { cursor: pointer !important; color: #8e98f5 !important; font-size: 12px !important; }
            .tml-history > div { margin: 7px 0 0 12px !important; padding: 8px !important; border-left: 2px solid #3f4147 !important; }
            .tml-history small { color: #949ba4 !important; }
            .tml-history p { margin: 4px 0 0 !important; white-space: pre-wrap !important; }
            .tml-actions { display: flex !important; justify-content: flex-end !important; gap: 6px !important; margin-top: 10px !important; }
            .tml-actions button { padding: 6px 10px !important; background: #2b2d32 !important; color: #c5c9cf !important; font-size: 10px !important; }
            .tml-actions button:first-child { background: rgba(88,101,242,.2) !important; color: #aeb5ff !important; }
            .tml-actions button:first-child:hover { background: #5865f2 !important; color: white !important; }
            .tml-actions button:last-child:hover { background: #3a3d44 !important; color: white !important; }
            .tml-empty { padding: 35px 10px !important; color: #949ba4 !important; text-align: center !important; }
            .tml-inline-deleted-clone { border-left: 3px solid #da373c !important; background: rgba(218,55,60,.08) !important; box-sizing: border-box !important; user-select: text !important; }
            .tml-inline-deleted-clone [class*="markup"], .tml-inline-deleted-clone [class*="messageContent"] { user-select: text !important; cursor: text !important; }
            .tml-inline-deleted-clone:hover { background: rgba(218,55,60,.12) !important; }
            .tml-jump-target { animation: tml-jump-highlight 2.4s ease-out !important; }
            @keyframes tml-jump-highlight { 0%, 22% { background-color: rgba(88,101,242,.42); box-shadow: inset 3px 0 #8e98f5; } 100% { background-color: transparent; box-shadow: inset 3px 0 transparent; } }
            .tml-inline-clone-badge { display: inline-flex !important; align-items: center !important; margin-left: 7px !important; padding: 2px 5px !important; border-radius: 3px !important; background: #da373c !important; color: white !important; font: 800 8px/1.35 var(--font-primary, Arial, sans-serif) !important; vertical-align: middle !important; }
            .tml-inline-dismiss { display: inline-grid !important; place-items: center !important; width: 18px !important; height: 18px !important; margin-left: 4px !important; padding: 0 !important; border: 0 !important; border-radius: 50% !important; background: rgba(218,55,60,.2) !important; color: #ffb3b6 !important; font: 700 15px/1 var(--font-primary, Arial, sans-serif) !important; cursor: pointer !important; vertical-align: middle !important; opacity: .72 !important; }
            .tml-inline-dismiss:hover, .tml-inline-dismiss:focus-visible { background: #da373c !important; color: white !important; opacity: 1 !important; }
            .tml-inline-copy { display: inline-flex !important; align-items: center !important; height: 18px !important; margin-left: 4px !important; padding: 0 6px !important; border: 0 !important; border-radius: 4px !important; background: rgba(88,101,242,.2) !important; color: #b9c0ff !important; font: 700 9px/1 var(--font-primary, Arial, sans-serif) !important; cursor: pointer !important; vertical-align: middle !important; opacity: .78 !important; user-select: none !important; }
            .tml-inline-copy:hover, .tml-inline-copy:focus-visible { background: #5865f2 !important; color: white !important; opacity: 1 !important; }
            .tml-inline-deleted { display: grid !important; grid-template-columns: 40px minmax(0,1fr) !important; gap: 12px !important; margin: 2px 0 !important; padding: 8px 16px 8px 72px !important; box-sizing: border-box !important; border-left: 3px solid #da373c !important; background: rgba(218,55,60,.08) !important; color: #dbdee1 !important; list-style: none !important; font-family: var(--font-primary, Arial, sans-serif) !important; }
            .tml-inline-avatar { display: grid !important; place-items: center !important; width: 36px !important; height: 36px !important; margin-left: -52px !important; border-radius: 50% !important; background: #41434a !important; color: white !important; font-weight: 700 !important; }
            .tml-inline-avatar-image { object-fit: cover !important; }
            .tml-inline-body { min-width: 0 !important; }
            .tml-inline-header { display: flex !important; align-items: center !important; flex-wrap: wrap !important; gap: 7px !important; }
            .tml-inline-header strong { color: #f2f3f5 !important; }
            .tml-inline-header span { color: #949ba4 !important; font-size: 10px !important; }
            .tml-inline-header b { padding: 2px 5px !important; border-radius: 3px !important; background: #da373c !important; color: white !important; font-size: 8px !important; }
            .tml-inline-content { margin-top: 3px !important; color: #dbdee1 !important; line-height: 1.4 !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; user-select: text !important; cursor: text !important; }
            .tml-inline-attachments { display: block !important; margin-top: 4px !important; color: #949ba4 !important; }
            .tml-inline-media { display: flex !important; flex-direction: column !important; align-items: flex-start !important; gap: 6px !important; margin-top: 7px !important; }
            .tml-inline-media img, .tml-inline-media video { display: block !important; max-width: min(420px, 75vw) !important; max-height: 320px !important; border-radius: 7px !important; object-fit: contain !important; background: #0f1012 !important; }
            .tml-inline-edited { display: grid !important; grid-template-columns: 40px minmax(0,1fr) !important; gap: 12px !important; margin: 2px 0 !important; padding: 9px 16px 10px 72px !important; box-sizing: border-box !important; border-left: 3px solid #e0a52b !important; background: rgba(224,165,43,.075) !important; color: #dbdee1 !important; list-style: none !important; font-family: var(--font-primary, Arial, sans-serif) !important; user-select: text !important; }
            .tml-inline-edited:hover { background: rgba(224,165,43,.11) !important; }
            .tml-inline-edit-header b { background: #b7791f !important; }
            .tml-inline-edit-copy { background: rgba(224,165,43,.16) !important; color: #f1cb78 !important; }
            .tml-inline-edit-copy:hover, .tml-inline-edit-copy:focus-visible { background: #b7791f !important; color: white !important; }
            .tml-inline-edit-dismiss { background: rgba(224,165,43,.14) !important; color: #f1cb78 !important; }
            .tml-inline-edit-dismiss:hover, .tml-inline-edit-dismiss:focus-visible { background: #b7791f !important; color: white !important; }
            .tml-inline-edit-versions { display: flex !important; flex-direction: column !important; gap: 7px !important; margin-top: 7px !important; }
            .tml-inline-edit-versions.has-overflow { max-height: 190px !important; padding-right: 5px !important; overflow-y: auto !important; overscroll-behavior: contain !important; scrollbar-width: thin !important; scrollbar-color: #8d6b29 rgba(0,0,0,.12) !important; }
            .tml-inline-edit-version { flex: 0 0 auto !important; padding: 7px 9px !important; border: 1px solid rgba(224,165,43,.16) !important; border-radius: 6px !important; background: rgba(0,0,0,.12) !important; }
            .tml-inline-edit-version > small { display: block !important; color: #caa95e !important; font-size: 9px !important; font-weight: 700 !important; letter-spacing: .25px !important; text-transform: uppercase !important; user-select: none !important; }
            .tml-inline-edit-version .tml-inline-content { margin-top: 4px !important; }
            .tml-inline-edit-more { color: #949ba4 !important; font-size: 9px !important; }
            .tml-clickable-media { cursor: zoom-in !important; }
            .tml-clickable-media:focus-visible { outline: 2px solid #8e98f5 !important; outline-offset: 2px !important; }
            .tml-media-viewer { position: fixed !important; inset: 0 !important; z-index: 2147483600 !important; display: grid !important; place-items: center !important; padding: 54px !important; box-sizing: border-box !important; background: rgba(0,0,0,.86) !important; backdrop-filter: blur(3px) !important; }
            .tml-media-viewer > img, .tml-media-viewer > video { display: block !important; max-width: 92vw !important; max-height: 88vh !important; border-radius: 8px !important; object-fit: contain !important; box-shadow: 0 16px 60px rgba(0,0,0,.55) !important; }
            .tml-media-viewer-close { position: fixed !important; top: 44px !important; right: 22px !important; display: grid !important; place-items: center !important; width: 38px !important; height: 38px !important; padding: 0 !important; border: 0 !important; border-radius: 50% !important; background: #2b2d31 !important; color: white !important; font-size: 27px !important; cursor: pointer !important; }
            .tml-media-viewer-close:hover, .tml-media-viewer-close:focus-visible { background: #da373c !important; outline: none !important; }
            .tml-settings { padding: 8px 4px 35px; color: var(--text-normal); }
            .tml-settings h2 { margin: 0 0 5px; }
            .tml-settings > p { margin: 0 0 15px; color: var(--text-muted); }
            .tml-primary, .tml-danger { padding: 9px 15px; border: 0; border-radius: 5px; color: white; font-weight: 600; cursor: pointer; }
            .tml-primary { margin-bottom: 16px; background: #5865f2; }
            .tml-danger { margin-top: 16px; background: #da373c; }
            .tml-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 15px 0; border-top: 1px solid var(--background-modifier-accent); cursor: pointer; }
            .tml-setting-copy { display: flex; flex-direction: column; gap: 4px; }
            .tml-setting-copy small { color: var(--text-muted); line-height: 1.35; }
            .tml-setting-row > input[type="checkbox"] { width: 20px; height: 20px; flex: 0 0 auto; }
            .tml-number { width: 100px; padding: 8px; box-sizing: border-box; border: 1px solid var(--input-border); border-radius: 4px; background: var(--input-background); color: var(--text-normal); }
            @media (max-width: 680px) { .tml-drawer { width: calc(100vw - 48px) !important; min-width: 0 !important; } .tml-controls { grid-template-columns: 1fr !important; } .tml-summary { grid-template-columns: repeat(2,1fr) !important; } .tml-filter-fields { grid-template-columns: 1fr !important; } .tml-content { padding: 15px !important; } }
        `;
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.addStyle) dom.addStyle(STYLE_ID, css);
        else {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = css;
            document.head.append(style);
        }
    }

    removeStyles() {
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.removeStyle) dom.removeStyle(STYLE_ID);
        document.getElementById(STYLE_ID)?.remove();
    }
};
