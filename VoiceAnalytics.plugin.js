/**
 * @name VoiceAnalytics
 * @author tiny
 * @version 1.5.1
 * @description Combines personal call analytics, live voice-member timers, and mobile private-call backfilling in one plugin.
 */

"use strict";

const PLUGIN_NAME = "VoiceAnalytics";
const STYLE_ID = "tiny-voice-analytics-styles";
const DATA_VERSION = 1;
const DISCORD_EPOCH = 1420070400000n;
const MESSAGE_EVENTS = ["MESSAGE_CREATE", "MESSAGE_UPDATE", "LOAD_MESSAGES_SUCCESS"];
const DEFAULT_SETTINGS = Object.freeze({showQuickButton: true, retentionDays: 400});

module.exports = class VoiceAnalytics {
    constructor() {
        this.api = null;
        this.webpack = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.data = this.emptyData();
        this.stores = {};
        this.dispatcher = null;
        this.quickButton = null;
        this.dashboard = null;
        this.dashboardTimer = null;
        this.dashboardTab = "mine";
        this.dashboardMode = "daily";
        this.timer = null;
        this.currentChannelId = null;
        this.memberMissingSince = new Map();
        this.pendingSelfDisconnectAt = null;
        this.pendingChannelLossAt = null;
        this.lastCheckpointAt = 0;
        this.lastCallBackfillAt = 0;
        this.started = false;
        this.onVoiceChange = this.onVoiceChange.bind(this);
        this.messageHandlers = {
            MESSAGE_CREATE: event => this.ingestCallMessage(event?.message || event),
            MESSAGE_UPDATE: event => this.ingestCallMessage(event?.message || event),
            LOAD_MESSAGES_SUCCESS: event => this.ingestCallMessages(event?.messages || event?.messageRecords || [])
        };
    }

    emptyData() {
        return {version: DATA_VERSION, selfSessions: [], selfActive: null, memberSessions: [], memberActive: {}, migratedLegacy: false};
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.settings = {...DEFAULT_SETTINGS, ...(this.load("settings") || {})};
        this.data = this.sanitizeData(this.load("voice-analytics"));
        this.recoverSavedSessions();
        this.saveData();
        this.migrateLegacyData();
        this.findStores();
        this.addStyles();
        this.subscribe();
        this.syncAll();
        this.scanCachedCallMessages();
        this.timer = setInterval(() => this.tick(), 1000);
        this.ensureQuickButton();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.unsubscribe();
        this.finalizeSelf(Date.now());
        this.finalizeAllMembers(Date.now());
        this.saveData();
        this.closeDashboard();
        this.quickButton?.remove();
        this.quickButton = null;
        this.removeStyles();
    }

    initializeApi() {
        try { if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME); }
        catch (error) { console.warn(`[${PLUGIN_NAME}] Could not initialize BdApi:`, error); }
        this.webpack = this.api?.Webpack || globalThis.BdApi?.Webpack || null;
    }

    findStores() {
        const getStore = name => {
            try { return this.webpack?.getStore?.(name) || null; }
            catch (error) { console.debug(`[${PLUGIN_NAME}] Could not find ${name}:`, error); return null; }
        };
        this.stores = {
            voiceState: getStore("VoiceStateStore"), rtc: getStore("RTCConnectionStore"),
            selectedChannel: getStore("SelectedChannelStore"), channel: getStore("ChannelStore"),
            guild: getStore("GuildStore"), guildMember: getStore("GuildMemberStore"),
            user: getStore("UserStore"), message: getStore("MessageStore")
        };
        try {
            this.dispatcher = this.webpack?.getByKeys?.("dispatch", "subscribe", "unsubscribe")
                || this.webpack?.getModule?.(module => typeof module?.dispatch === "function" && typeof module?.subscribe === "function" && typeof module?.unsubscribe === "function", {searchExports: true}) || null;
        } catch (_) { this.dispatcher = null; }
        if (!this.stores.voiceState) this.toast("Discord's voice-state store was not found. Reload Discord to retry.", "error");
    }

    subscribe() {
        for (const store of [this.stores.voiceState, this.stores.rtc, this.stores.selectedChannel]) {
            try { store?.addChangeListener?.(this.onVoiceChange); } catch (_) {}
        }
        for (const event of MESSAGE_EVENTS) {
            try { this.dispatcher?.subscribe?.(event, this.messageHandlers[event]); } catch (_) {}
        }
    }

    unsubscribe() {
        for (const store of [this.stores.voiceState, this.stores.rtc, this.stores.selectedChannel]) {
            try { store?.removeChangeListener?.(this.onVoiceChange); } catch (_) {}
        }
        for (const event of MESSAGE_EVENTS) {
            try { this.dispatcher?.unsubscribe?.(event, this.messageHandlers[event]); } catch (_) {}
        }
    }

    onVoiceChange() {
        queueMicrotask(() => this.started && this.syncAll());
    }

    tick() {
        const now = Date.now();
        this.syncAll(now);
        if (now - this.lastCheckpointAt >= 15000 && (this.data.selfActive || Object.keys(this.data.memberActive).length)) {
            if (this.data.selfActive) this.data.selfActive.lastSeen = now;
            for (const session of Object.values(this.data.memberActive)) session.lastSeen = now;
            this.lastCheckpointAt = now;
            this.saveData();
        }
        if (now - this.lastCallBackfillAt >= 10000) this.scanCachedCallMessages(now);
        this.updateQuickButton();
    }

    syncAll(now = Date.now()) {
        const channelId = this.getCurrentVoiceChannelId();
        this.syncSelf(channelId, now);
        this.syncMembers(channelId, now);
    }

    getCurrentVoiceChannelId() {
        try { const id = this.stores.voiceState?.getCurrentClientVoiceChannelId?.(); if (id) return String(id); } catch (_) {}
        try {
            if (this.stores.rtc?.isConnected?.()) return String(this.stores.rtc.getChannelId?.() || this.stores.rtc.getLastSessionVoiceChannelId?.() || "") || null;
            if (this.stores.rtc?.isDisconnected?.()) return null;
        } catch (_) {}
        try { return String(this.stores.selectedChannel?.getVoiceChannelId?.() || "") || null; } catch (_) { return null; }
    }

    syncSelf(channelId, now) {
        const active = this.data.selfActive;
        if (channelId) {
            this.pendingSelfDisconnectAt = null;
            if (!active) this.beginSelf(channelId, now);
            else if (active.channelId !== channelId) { this.finalizeSelf(now); this.beginSelf(channelId, now); }
            else active.lastSeen = now;
            return;
        }
        if (!active) { this.pendingSelfDisconnectAt = null; return; }
        if (this.pendingSelfDisconnectAt === null) this.pendingSelfDisconnectAt = now;
        if (now - this.pendingSelfDisconnectAt >= 3000) {
            this.finalizeSelf(this.pendingSelfDisconnectAt);
            this.pendingSelfDisconnectAt = null;
            this.saveData();
        }
    }

    beginSelf(channelId, now) {
        const details = this.getChannelDetails(channelId);
        this.data.selfActive = {start: now, lastSeen: now, channelId, ...details, source: "voice-state", sourceId: null};
        this.lastCheckpointAt = now;
        this.saveData();
    }

    finalizeSelf(end = Date.now()) {
        const active = this.data.selfActive;
        if (!active) return;
        const safeEnd = Math.max(active.start, Number(end) || active.lastSeen || Date.now());
        if (safeEnd - active.start >= 1000) this.data.selfSessions.push({...active, end: safeEnd});
        this.data.selfActive = null;
        this.prune();
    }

    syncMembers(channelId, now) {
        if (!channelId) {
            if (!Object.keys(this.data.memberActive).length) { this.pendingChannelLossAt = null; this.currentChannelId = null; return; }
            if (this.pendingChannelLossAt === null) this.pendingChannelLossAt = now;
            if (now - this.pendingChannelLossAt >= 3000) {
                this.finalizeAllMembers(this.pendingChannelLossAt);
                this.pendingChannelLossAt = null;
                this.currentChannelId = null;
                this.saveData();
            }
            return;
        }
        this.pendingChannelLossAt = null;
        if (this.currentChannelId && this.currentChannelId !== channelId) {
            this.finalizeAllMembers(now);
            this.memberMissingSince.clear();
        }
        this.currentChannelId = channelId;
        const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
        const states = this.getVoiceStatesForChannel(channelId).filter(state => String(state.userId) !== selfId);
        const seen = new Set();
        for (const state of states) {
            const userId = String(state.userId);
            const key = this.memberKey(channelId, userId);
            const details = this.getMemberDetails(userId, channelId, state);
            seen.add(key);
            this.memberMissingSince.delete(key);
            if (!this.data.memberActive[key]) {
                this.data.memberActive[key] = {userId, channelId, ...details, start: now, lastSeen: now, source: "voice-state", sourceId: null, estimated: false};
                this.saveData();
            } else Object.assign(this.data.memberActive[key], details, {lastSeen: now});
        }
        for (const key of Object.keys(this.data.memberActive)) {
            const active = this.data.memberActive[key];
            if (active.channelId !== channelId || seen.has(key)) continue;
            if (!this.memberMissingSince.has(key)) this.memberMissingSince.set(key, now);
            const missingAt = this.memberMissingSince.get(key);
            if (now - missingAt >= 3000) {
                this.finalizeMember(key, missingAt);
                this.memberMissingSince.delete(key);
                this.saveData();
            }
        }
    }

    getVoiceStatesForChannel(channelId) {
        let raw = null;
        try { raw = this.stores.voiceState?.getVoiceStatesForChannel?.(channelId) ?? this.stores.voiceState?.getVoiceStates?.(channelId); }
        catch (_) { return []; }
        const found = new Map(), visited = new Set();
        const walk = (value, depth = 0, hint = null) => {
            if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
            visited.add(value);
            const userId = value.userId ?? value.user_id ?? hint;
            const stateChannelId = value.channelId ?? value.channel_id;
            if (userId && (!stateChannelId || String(stateChannelId) === channelId) && (value.sessionId || value.session_id || stateChannelId)) found.set(String(userId), {...value, userId: String(userId)});
            if (value instanceof Map) for (const [key, child] of value.entries()) walk(child, depth + 1, /^\d{10,}$/.test(String(key)) ? String(key) : hint);
            else if (value instanceof Set || Array.isArray(value)) for (const child of value) walk(child, depth + 1, hint);
            else for (const [key, child] of Object.entries(value)) walk(child, depth + 1, /^\d{10,}$/.test(key) ? key : hint);
        };
        walk(raw);
        return [...found.values()];
    }

    memberKey(channelId, userId) { return `${channelId}:${userId}`; }

    finalizeMember(key, end = Date.now()) {
        const active = this.data.memberActive[key];
        if (!active) return;
        const safeEnd = Math.max(active.start, Number(end) || active.lastSeen || Date.now());
        if (safeEnd - active.start >= 1000) this.data.memberSessions.push({...active, end: safeEnd});
        delete this.data.memberActive[key];
        this.prune();
    }

    finalizeAllMembers(end = Date.now()) {
        for (const key of Object.keys(this.data.memberActive)) this.finalizeMember(key, end);
        this.memberMissingSince.clear();
    }

    getChannelDetails(channelId) {
        try {
            const channel = this.stores.channel?.getChannel?.(channelId);
            const guildId = channel?.guild_id || channel?.getGuildId?.() || null;
            const guild = guildId ? this.stores.guild?.getGuild?.(guildId) : null;
            return {guildId, channelName: channel?.name || (guildId ? "Voice Channel" : "Direct Message Call"), guildName: guild?.name || (guildId ? "Unknown Server" : "Direct Messages")};
        } catch (_) { return {guildId: null, channelName: "Voice Channel", guildName: "Unknown Server"}; }
    }

    getMemberDetails(userId, channelId, state = {}) {
        try {
            const channel = this.stores.channel?.getChannel?.(channelId) || null;
            const guildId = channel?.guild_id || channel?.getGuildId?.() || state.guildId || state.guild_id || null;
            const guild = guildId ? this.stores.guild?.getGuild?.(guildId) : null;
            const member = guildId ? this.stores.guildMember?.getMember?.(guildId, userId) : null;
            const user = this.stores.user?.getUser?.(userId) || null;
            return {guildId, userName: member?.nick || user?.globalName || user?.displayName || user?.username || `User ${String(userId).slice(-4)}`, channelName: channel?.name || (guildId ? "Voice Channel" : "Direct Message Call"), guildName: guild?.name || (guildId ? "Unknown Server" : "Direct Messages"), isBot: Boolean(user?.bot)};
        } catch (_) { return {guildId: null, userName: `User ${String(userId).slice(-4)}`, channelName: "Voice Channel", guildName: "Unknown Server", isBot: false}; }
    }

    scanCachedCallMessages(now = Date.now()) {
        this.lastCallBackfillAt = now;
        let added = 0;
        for (const channel of this.getPrivateChannels()) {
            try { added += this.ingestCallMessages(this.messageArray(this.stores.message?.getMessages?.(String(channel.id))), false); } catch (_) {}
        }
        if (added) { this.saveData(); this.updateQuickButton(); if (this.dashboard) this.renderDashboard(); }
    }

    getPrivateChannels() {
        try {
            const raw = this.stores.channel?.getMutablePrivateChannels?.() || this.stores.channel?.getSortedPrivateChannels?.() || {};
            return this.normalize(raw).map(value => value?.channel || value).filter(channel => this.isPrivateChannel(channel));
        } catch (_) { return []; }
    }

    isPrivateChannel(channel) {
        if (!channel) return false;
        try { if (channel.isDM?.() || channel.isGroupDM?.()) return true; } catch (_) {}
        return Number(channel.type) === 1 || Number(channel.type) === 3;
    }

    messageArray(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        try { if (typeof value.toArray === "function") return value.toArray(); } catch (_) {}
        if (Array.isArray(value._array)) return value._array;
        if (value._map instanceof Map) return [...value._map.values()];
        return this.normalize(value._messages || value._map || value);
    }

    ingestCallMessages(messages, saveAfter = true) {
        let added = 0;
        for (const message of this.messageArray(messages)) added += this.ingestCallMessage(message, false);
        if (added && saveAfter) { this.saveData(); this.updateQuickButton(); if (this.dashboard) this.renderDashboard(); }
        return added;
    }

    ingestCallMessage(message, saveAfter = true) {
        if (Number(message?.type) !== 3 || !message?.call) return 0;
        const channelId = String(message.channel_id ?? message.channelId ?? ""), messageId = String(message.id || "");
        if (!channelId || !messageId) return 0;
        const channel = this.stores.channel?.getChannel?.(channelId);
        if (!this.isPrivateChannel(channel)) return 0;
        const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
        const participants = this.normalize(message.call.participants).map(value => String(value?.id || value)).filter(Boolean);
        if (!selfId || !participants.includes(selfId)) return 0;
        const start = this.toTimestamp(message.timestamp ?? message.createdAt) || this.snowflakeTimestamp(messageId);
        const end = this.toTimestamp(message.call.ended_timestamp ?? message.call.endedTimestamp);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1000 || end > Date.now() + 60000) return 0;
        let added = 0;
        const selfSourceId = `call-message:${messageId}`;
        if (!this.isDuplicateSelf(selfSourceId, channelId, start, end)) {
            const details = this.getChannelDetails(channelId);
            this.data.selfSessions.push({start, end, channelId, ...details, source: "call-message", sourceId: selfSourceId});
            added++;
        }
        for (const userId of [...new Set(participants.filter(id => id !== selfId))]) {
            const sourceId = `call-message:${messageId}:${userId}`;
            if (this.isDuplicateMember(sourceId, channelId, userId, start, end)) continue;
            const details = this.getMemberDetails(userId, channelId);
            this.data.memberSessions.push({userId, channelId, ...details, start, lastSeen: end, end, source: "call-message", sourceId, estimated: true});
            added++;
        }
        if (added) this.prune();
        if (added && saveAfter) { this.saveData(); this.updateQuickButton(); if (this.dashboard) this.renderDashboard(); }
        return added;
    }

    isDuplicateSelf(sourceId, channelId, start, end) {
        return this.isDuplicateRange(this.data.selfSessions.concat(this.data.selfActive ? [{...this.data.selfActive, end: Date.now()}] : []), sourceId, channelId, null, start, end);
    }

    isDuplicateMember(sourceId, channelId, userId, start, end) {
        return this.isDuplicateRange(this.data.memberSessions.concat(Object.values(this.data.memberActive).map(session => ({...session, end: Date.now()}))), sourceId, channelId, userId, start, end);
    }

    isDuplicateRange(sessions, sourceId, channelId, userId, start, end) {
        for (const session of sessions) {
            if (sourceId && session.sourceId === sourceId) return true;
            if (String(session.channelId || "") !== String(channelId) || (userId && String(session.userId || "") !== String(userId))) continue;
            const a = Number(session.start), b = Number(session.end);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            const overlap = Math.max(0, Math.min(end, b) - Math.max(start, a));
            const shorter = Math.min(end - start, b - a);
            if (shorter > 0 && overlap / shorter >= .8) return true;
        }
        return false;
    }

    toTimestamp(value) {
        if (value == null) return NaN;
        if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
        if (typeof value === "bigint") return Number(value);
        if (typeof value?.valueOf === "function") { const primitive = value.valueOf(); if (typeof primitive === "number" && Number.isFinite(primitive)) return primitive < 100000000000 ? primitive * 1000 : primitive; }
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    snowflakeTimestamp(id) {
        try { return Number((BigInt(String(id)) >> 22n) + DISCORD_EPOCH); } catch (_) { return NaN; }
    }

    normalize(value) {
        if (!value) return [];
        if (value instanceof Map || value instanceof Set) return [...value.values()];
        if (Array.isArray(value)) return value;
        if (typeof value === "object") return Object.values(value);
        return [];
    }

    recoverSavedSessions() {
        const self = this.data.selfActive;
        if (self) {
            const end = Math.min(Date.now(), Number(self.lastSeen) || Number(self.start));
            if (end - self.start >= 1000) this.data.selfSessions.push({...self, end});
            this.data.selfActive = null;
        }
        for (const [key, session] of Object.entries(this.data.memberActive)) {
            const end = Math.min(Date.now(), Number(session.lastSeen) || Number(session.start));
            if (end - session.start >= 1000) this.data.memberSessions.push({...session, end});
            delete this.data.memberActive[key];
        }
        this.prune();
    }

    migrateLegacyData() {
        if (this.data.migratedLegacy) return;
        const oldCalls = this.loadExternal("CallDurationAnalytics", "analytics");
        const oldCallSessions = [...(oldCalls?.sessions || [])];
        if (oldCalls?.active && Number.isFinite(Number(oldCalls.active.start))) {
            const end = Math.min(Date.now(), Number(oldCalls.active.lastSeen) || Number(oldCalls.active.start));
            if (end > Number(oldCalls.active.start)) oldCallSessions.push({...oldCalls.active, end});
        }
        for (const session of oldCallSessions) {
            if (!this.validRange(session)) continue;
            const clean = this.cleanSelfSession(session);
            if (!this.isDuplicateSelf(clean.sourceId, clean.channelId, clean.start, clean.end)) this.data.selfSessions.push(clean);
        }
        const oldMembers = this.loadExternal("VoiceMemberTimers", "timers");
        const oldMemberSessions = [...(oldMembers?.sessions || [])];
        for (const active of Object.values(oldMembers?.active || {})) {
            const end = Math.min(Date.now(), Number(active?.lastSeen) || Number(active?.start));
            if (active?.userId && end > Number(active.start)) oldMemberSessions.push({...active, end});
        }
        for (const session of oldMemberSessions) {
            if (!this.validRange(session) || !session.userId) continue;
            const clean = this.cleanMemberSession(session);
            if (!this.isDuplicateMember(clean.sourceId, clean.channelId, clean.userId, clean.start, clean.end)) this.data.memberSessions.push(clean);
        }
        this.data.migratedLegacy = true;
        this.prune();
        this.saveData();
    }

    sanitizeData(raw) {
        const data = this.emptyData();
        data.selfSessions = Array.isArray(raw?.selfSessions) ? raw.selfSessions.filter(session => this.validRange(session)).map(session => this.cleanSelfSession(session)) : [];
        data.memberSessions = Array.isArray(raw?.memberSessions) ? raw.memberSessions.filter(session => this.validRange(session) && session.userId).map(session => this.cleanMemberSession(session)) : [];
        if (raw?.selfActive && Number.isFinite(Number(raw.selfActive.start))) data.selfActive = this.cleanSelfActive(raw.selfActive);
        if (raw?.memberActive && typeof raw.memberActive === "object") for (const [key, session] of Object.entries(raw.memberActive)) if (session?.userId && Number.isFinite(Number(session.start))) data.memberActive[key] = this.cleanMemberSession(session, false);
        data.migratedLegacy = Boolean(raw?.migratedLegacy);
        return data;
    }

    cleanSelfSession(session) {
        return {start: Number(session.start), end: Number(session.end), channelId: session.channelId || null, guildId: session.guildId || null, channelName: String(session.channelName || "Voice Channel"), guildName: String(session.guildName || "Unknown Server"), source: String(session.source || "voice-state"), sourceId: session.sourceId ? String(session.sourceId) : null};
    }

    cleanSelfActive(session) {
        const clean = this.cleanSelfSession({...session, end: Number(session.lastSeen) || Number(session.start)});
        delete clean.end;
        clean.lastSeen = Number(session.lastSeen) || Number(session.start);
        return clean;
    }

    cleanMemberSession(session, includeEnd = true) {
        const clean = {userId: String(session.userId || ""), channelId: String(session.channelId || ""), guildId: session.guildId ? String(session.guildId) : null, userName: String(session.userName || "Unknown User"), channelName: String(session.channelName || "Voice Channel"), guildName: String(session.guildName || "Unknown Server"), isBot: Boolean(session.isBot), start: Number(session.start), lastSeen: Number(session.lastSeen) || Number(session.end) || Number(session.start), source: String(session.source || "voice-state"), sourceId: session.sourceId ? String(session.sourceId) : null, estimated: Boolean(session.estimated)};
        if (includeEnd && session.end) clean.end = Number(session.end);
        return clean;
    }

    validRange(session) {
        const start = Number(session?.start), end = Number(session?.end);
        return Number.isFinite(start) && Number.isFinite(end) && end > start;
    }

    prune(now = Date.now()) {
        const days = Math.max(7, Math.min(3650, Number(this.settings.retentionDays) || DEFAULT_SETTINGS.retentionDays));
        const cutoff = now - days * 86400000;
        this.data.selfSessions = this.data.selfSessions.filter(session => session.end >= cutoff);
        this.data.memberSessions = this.data.memberSessions.filter(session => session.end >= cutoff);
    }

    selfSessions(now = Date.now()) { return this.data.selfSessions.concat(this.data.selfActive ? [{...this.data.selfActive, end: now, isActive: true}] : []); }
    currentMembers(now = Date.now()) { return Object.values(this.data.memberActive).filter(session => session.channelId === this.currentChannelId).map(session => ({...session, end: now, isActive: true})).sort((a, b) => a.start - b.start); }

    memberTotals(now = Date.now()) {
        const totals = new Map();
        for (const session of this.data.memberSessions.concat(Object.values(this.data.memberActive).map(value => ({...value, end: now})))) {
            const entry = totals.get(session.userId) || {userId: session.userId, userName: session.userName, duration: 0, sessions: 0, estimatedSessions: 0};
            entry.userName = session.userName || entry.userName;
            entry.duration += Math.max(0, Number(session.end) - Number(session.start));
            entry.sessions++;
            if (session.estimated) entry.estimatedSessions++;
            totals.set(session.userId, entry);
        }
        return [...totals.values()].sort((a, b) => b.duration - a.duration);
    }

    ensureQuickButton() {
        this.quickButton?.remove();
        this.quickButton = null;
        if (!this.settings.showQuickButton || !this.started) return;
        this.quickButton = globalThis.TinyPluginLibrary.register({id: "voice-analytics", name: "Voice Analytics", description: "Call analytics and member timers together", icon: "📈", order: 30, open: () => this.openDashboard()});
        this.updateQuickButton();
    }

    updateQuickButton() {
        const count = this.currentMembers().length;
        this.quickButton?.update?.({badge: count ? String(count) : "", status: count ? `${count} other ${count === 1 ? "person" : "people"} in your VC` : "Tracking calls and voice time"});
    }

    openDashboard() {
        this.closeDashboard();
        const overlay = this.el("div", {className: "va-overlay"});
        const panel = this.el("section", {className: "va-panel", role: "dialog", "aria-modal": "true", "aria-label": "Voice Analytics"});
        const header = this.el("header", {className: "va-header"});
        const heading = this.el("div", {className: "va-heading"});
        const brandMark = this.sessionIcon(false);
        brandMark.className = "va-brand-mark";
        heading.append(brandMark);
        const headingCopy = this.el("div", {className: "va-heading-copy"});
        headingCopy.append(this.el("h1", {textContent: "Voice Analytics"}), this.el("p", {textContent: "Your voice activity, all in one place"}));
        heading.append(headingCopy);
        const headerActions = this.el("div", {className: "va-header-actions"});
        const livePill = this.el("span", {className: `va-live-pill${this.currentChannelId ? " is-live" : ""}`, textContent: this.currentChannelId ? "●  LIVE" : "OFFLINE"});
        const close = this.el("button", {className: "va-close", type: "button", textContent: "×", title: "Close"});
        close.addEventListener("click", () => this.closeDashboard());
        headerActions.append(livePill, close);
        header.append(heading, headerActions);
        panel.append(header, this.el("div", {className: "va-body"}));
        overlay.append(panel);
        overlay.addEventListener("mousedown", event => { if (event.target === overlay) this.closeDashboard(); });
        document.body.append(overlay);
        this.dashboard = overlay;
        this.renderDashboard();
        this.dashboardTimer = setInterval(() => this.renderDashboard(), 1000);
    }

    closeDashboard() {
        if (this.dashboardTimer) clearInterval(this.dashboardTimer);
        this.dashboardTimer = null;
        this.dashboard?.remove();
        this.dashboard = null;
    }

    renderDashboard() {
        const body = this.dashboard?.querySelector(".va-body");
        if (!body) return;
        const livePill = this.dashboard?.querySelector(".va-live-pill");
        if (livePill) {
            livePill.className = `va-live-pill${this.currentChannelId ? " is-live" : ""}`;
            livePill.textContent = this.currentChannelId ? "●  LIVE" : "OFFLINE";
        }
        const scrollTop = body.scrollTop;
        body.replaceChildren();
        const tabs = this.el("nav", {className: "va-tabs"});
        for (const [id, label] of [["mine", "My call time"], ["people", "People timers"]]) {
            const button = this.el("button", {type: "button", textContent: label, className: this.dashboardTab === id ? "active" : ""});
            button.addEventListener("click", () => { this.dashboardTab = id; this.renderDashboard(); });
            tabs.append(button);
        }
        body.append(tabs, this.dashboardTab === "mine" ? this.buildMineView() : this.buildPeopleView());
        body.scrollTop = scrollTop;
    }

    buildMineView() {
        const view = this.el("div", {className: "va-view"});
        const now = Date.now(), sessions = this.selfSessions(now), summary = this.summary(now, sessions);
        const completed = sessions.filter(session => !session.isActive);
        const completedTotal = completed.reduce((sum, session) => sum + Math.max(0, Number(session.end) - Number(session.start)), 0);
        const average = completed.length ? completedTotal / completed.length : 0;
        const longestSession = completed.reduce((best, session) => !best || Number(session.end) - Number(session.start) > Number(best.end) - Number(best.start) ? session : best, null);
        const longest = longestSession ? Number(longestSession.end) - Number(longestSession.start) : 0;
        const longestWith = longestSession ? this.callPartnerLabel(longestSession, now) : "no completed calls yet";
        const weekStart = this.startOfWeek(new Date(now)).getTime();
        const previousWeek = this.rangeTotal(weekStart - 7 * 86400000, weekStart, sessions);
        const change = previousWeek ? Math.round((summary.week - previousWeek) / previousWeek * 100) : null;
        const active = this.data.selfActive;

        const hero = this.el("section", {className: `va-mine-hero${active ? " is-active" : ""}`});
        const heroCopy = this.el("div", {className: "va-mine-hero-copy"});
        heroCopy.append(this.el("span", {className: "va-eyebrow", textContent: active ? "CURRENT CALL" : "THIS WEEK"}));
        heroCopy.append(this.el("strong", {textContent: active ? this.formatDuration(now - Number(active.start), true) : this.formatDuration(summary.week, false)}));
        heroCopy.append(this.el("p", {textContent: active ? `${active.guildName}  ·  ${active.channelName}` : change === null ? "Your weekly total will build as you join calls" : `${change >= 0 ? "+" : ""}${change}% compared with last week`}));
        const heroSide = this.el("div", {className: "va-mine-hero-side"});
        const weekSessions = sessions.filter(session => Number(session.end) > weekStart).length;
        for (const [label, value] of [["Sessions", String(weekSessions)], ["Daily average", this.formatDuration(summary.week / Math.max(1, Math.min(7, Math.floor((now - weekStart) / 86400000) + 1)), false)]]) {
            const metric = this.el("div"); metric.append(this.el("span", {textContent: label}), this.el("b", {textContent: value})); heroSide.append(metric);
        }
        hero.append(heroCopy, heroSide);

        const cards = this.el("div", {className: "va-summary"});
        for (const [label, value, detail] of [["Today", summary.today, "since midnight"], ["This month", summary.month, "current month"], ["Average call", average, `${completed.length} completed`], ["Longest call", longest, longestWith]]) {
            const card = this.el("article");
            card.append(this.el("span", {textContent: label}), this.el("strong", {textContent: this.formatDuration(value, true)}), this.el("small", {textContent: detail}));
            cards.append(card);
        }
        const graphCard = this.el("section", {className: "va-card"});
        const graphHead = this.el("div", {className: "va-card-head"});
        const graphTitle = this.el("div", {className: "va-card-title"});
        graphTitle.append(this.el("h2", {textContent: this.dashboardMode === "daily" ? "Last 7 days" : this.dashboardMode === "weekly" ? "Last 8 weeks" : "Last 6 months"}), this.el("span", {textContent: "Voice time by period"}));
        graphHead.append(graphTitle);
        const modes = this.el("div", {className: "va-mode"});
        for (const [id, label] of [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]]) {
            const button = this.el("button", {type: "button", textContent: label, className: this.dashboardMode === id ? "active" : ""});
            button.addEventListener("click", () => { this.dashboardMode = id; this.renderDashboard(); }); modes.append(button);
        }
        graphHead.append(modes); graphCard.append(graphHead, this.buildGraph(this.buckets(this.dashboardMode, now, sessions)));
        const recent = this.el("section", {className: "va-card"});
        const recentHead = this.el("div", {className: "va-card-head"});
        const recentTitle = this.el("div", {className: "va-card-title"});
        recentTitle.append(this.el("h2", {textContent: "Recent sessions"}), this.el("span", {textContent: `${sessions.length} recorded calls` }));
        recentHead.append(recentTitle);
        const exportButton = this.el("button", {className: "va-export", type: "button", textContent: "Export CSV"});
        exportButton.addEventListener("click", () => this.exportCsv()); recentHead.append(exportButton); recent.append(recentHead);
        const list = this.el("div", {className: "va-session-list"});
        const ordered = sessions.slice().sort((a, b) => b.start - a.start).slice(0, 20);
        if (!ordered.length) list.append(this.el("div", {className: "va-empty", textContent: "No call time recorded yet."}));
        for (const session of ordered) {
            const row = this.el("div", {className: `va-session-row${session.isActive ? " is-active" : ""}`});
            row.append(this.sessionIcon(session.source === "call-message"));
            const copy = this.el("div");
            copy.append(this.el("strong", {textContent: session.channelName}), this.el("span", {textContent: `${session.guildName}  ·  ${this.sessionDate(session.start)}`}));
            if (session.isActive) copy.append(this.el("small", {className: "va-source-tag is-live", textContent: "live now"}));
            if (session.source === "call-message") copy.append(this.el("small", {className: "va-source-tag", textContent: "synced from call history"}));
            row.append(copy, this.el("strong", {textContent: this.formatDuration(Number(session.end) - Number(session.start), true)})); list.append(row);
        }
        recent.append(list); view.append(hero, cards, graphCard, recent); return view;
    }

    sessionDate(timestamp) {
        const date = new Date(Number(timestamp)), today = this.startOfDay(new Date()), target = this.startOfDay(date);
        const days = Math.round((today - target) / 86400000);
        const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : date.toLocaleDateString(undefined, {month: "short", day: "numeric"});
        return `${day} at ${date.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}`;
    }

    callPartnerLabel(call, now = Date.now()) {
        const callStart = Number(call?.start), callEnd = Number(call?.end);
        if (!Number.isFinite(callStart) || !Number.isFinite(callEnd)) return "person unavailable";
        const overlapByUser = new Map();
        const memberSessions = this.data.memberSessions.concat(Object.values(this.data.memberActive).map(session => ({...session, end: now})));
        for (const member of memberSessions) {
            if (String(member.channelId || "") !== String(call.channelId || "")) continue;
            const overlap = Math.max(0, Math.min(callEnd, Number(member.end)) - Math.max(callStart, Number(member.start)));
            if (overlap < 1000) continue;
            const id = String(member.userId || member.userName || "unknown");
            const current = overlapByUser.get(id) || {name: member.userName || "Unknown user", overlap: 0};
            current.name = member.userName || current.name;
            current.overlap += overlap;
            overlapByUser.set(id, current);
        }
        const people = [...overlapByUser.values()].sort((a, b) => b.overlap - a.overlap);
        if (!people.length) return call.channelName ? `in ${call.channelName}` : "person unavailable";
        return people.length === 1 ? `with ${people[0].name}` : `with ${people[0].name} +${people.length - 1}`;
    }

    sessionIcon(synced = false) {
        const wrap = this.el("span", {className: `va-session-icon${synced ? " is-synced" : ""}`});
        if (typeof document.createElementNS !== "function") return wrap;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        const paths = synced
            ? ["M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.56 2.81.69A2 2 0 0 1 22 16.92z"]
            : ["M4 14a8 8 0 0 1 16 0", "M18 19c0 1.1-.9 2-2 2h-1", "M4 14v3a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 1z", "M20 14v3a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 1z"];
        for (const data of paths) {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", data);
            svg.append(path);
        }
        wrap.append(svg);
        return wrap;
    }

    buildPeopleView() {
        const view = this.el("div", {className: "va-view"});
        const totals = this.memberTotals();
        const sharedTime = totals.reduce((sum, person) => sum + person.duration, 0);
        const peopleSummary = this.el("div", {className: "va-people-summary"});
        for (const [label, value, detail] of [
            ["People tracked", String(totals.length), "across your calls"],
            ["Shared voice time", this.formatDuration(sharedTime, false), "combined member time"],
            ["Most time with", totals[0]?.userName || "Nobody yet", totals[0] ? this.formatDuration(totals[0].duration, false) : "start joining calls"]
        ]) {
            const card = this.el("article");
            card.append(this.el("span", {textContent: label}), this.el("strong", {textContent: value}), this.el("small", {textContent: detail}));
            peopleSummary.append(card);
        }
        const live = this.el("section", {className: "va-card"});
        const liveHead = this.el("div", {className: "va-card-head"});
        const liveList = this.el("div", {className: "va-member-list"}), current = this.currentMembers();
        const liveTitle = this.el("div", {className: "va-card-title"});
        const currentLocation = this.currentChannelId ? this.getChannelDetails(this.currentChannelId) : null;
        liveTitle.append(this.el("h2", {textContent: "Current voice channel"}), this.el("span", {textContent: currentLocation ? `${currentLocation.guildName} · ${currentLocation.channelName}` : "You are not connected"}));
        liveHead.append(liveTitle);
        liveHead.append(this.el("span", {className: `va-count-pill${current.length ? " active" : ""}`, textContent: `${current.length} ${current.length === 1 ? "person" : "people"}`}));
        live.append(liveHead);
        if (!current.length) liveList.append(this.el("div", {className: "va-empty", textContent: this.currentChannelId ? "Nobody else is currently in your voice channel." : "Join a voice channel to begin live member timers."}));
        for (const session of current) liveList.append(this.memberRow(session));
        live.append(liveList);
        const totalsCard = this.el("section", {className: "va-card"});
        const totalsHead = this.el("div", {className: "va-card-head"});
        const totalsTitle = this.el("div", {className: "va-card-title"});
        totalsTitle.append(this.el("h2", {textContent: "People you talk with"}), this.el("span", {textContent: "Ranked by total voice time"}));
        totalsHead.append(totalsTitle);
        totalsCard.append(totalsHead);
        const totalsList = this.el("div", {className: "va-total-list"}), visibleTotals = totals.slice(0, 25);
        if (!visibleTotals.length) totalsList.append(this.el("div", {className: "va-empty", textContent: "People will appear here after you share a voice channel or private call."}));
        for (const [index, total] of visibleTotals.entries()) {
            const row = this.el("div", {className: "va-total-row"});
            const estimate = total.estimatedSessions ? ` · ${total.estimatedSessions} estimated` : "";
            const totalCopy = this.el("div", {className: "va-total-copy"});
            totalCopy.append(this.el("strong", {textContent: total.userName}), this.el("span", {textContent: `${total.sessions} sessions${estimate}`}));
            row.append(this.el("span", {className: "va-rank", textContent: String(index + 1)}), this.avatar(total.userName, total.userId), totalCopy, this.el("b", {textContent: this.formatDuration(total.duration, false)})); totalsList.append(row);
        }
        const notice = this.el("div", {className: "va-notice", textContent: "Live VC timers are exact while observed. Private-call participant time is estimated from the full call duration."});
        totalsCard.append(totalsList); view.append(peopleSummary, live, totalsCard, notice); return view;
    }

    memberRow(session) {
        const row = this.el("div", {className: "va-member-row"}), copy = this.el("div");
        copy.append(this.el("strong", {textContent: session.userName}), this.el("span", {textContent: `Observed since ${new Date(session.start).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}`}));
        row.append(this.avatar(session.userName, session.userId), copy, this.el("strong", {textContent: this.formatDuration(Number(session.end) - Number(session.start), true)})); return row;
    }

    avatar(name, userId = null) {
        let url = "";
        try { url = this.stores.user?.getUser?.(userId)?.getAvatarURL?.(null, 64, true) || ""; } catch (_) {}
        if (url) return this.el("img", {className: "va-avatar", src: url, alt: ""});
        return this.el("span", {className: "va-avatar", textContent: String(name || "?").trim().charAt(0).toUpperCase() || "?"});
    }

    summary(now, sessions) {
        const day = this.startOfDay(new Date(now)).getTime(), week = this.startOfWeek(new Date(now)).getTime(), month = this.startOfMonth(new Date(now)).getTime();
        return {today: this.rangeTotal(day, now, sessions), week: this.rangeTotal(week, now, sessions), month: this.rangeTotal(month, now, sessions), all: sessions.reduce((sum, session) => sum + Math.max(0, session.end - session.start), 0)};
    }

    rangeTotal(start, end, sessions) { return sessions.reduce((sum, session) => sum + Math.max(0, Math.min(end, session.end) - Math.max(start, session.start)), 0); }
    startOfDay(date) { const value = new Date(date); value.setHours(0, 0, 0, 0); return value; }
    startOfWeek(date) { const value = this.startOfDay(date), day = value.getDay(); value.setDate(value.getDate() - ((day + 6) % 7)); return value; }
    startOfMonth(date) { const value = this.startOfDay(date); value.setDate(1); return value; }

    buckets(mode, now, sessions) {
        const out = [], current = new Date(now);
        if (mode === "monthly") {
            const first = this.startOfMonth(current); first.setMonth(first.getMonth() - 5);
            for (let i = 0; i < 6; i++) { const start = new Date(first.getFullYear(), first.getMonth() + i, 1), end = new Date(first.getFullYear(), first.getMonth() + i + 1, 1); out.push({start: +start, end: +end, label: start.toLocaleDateString(undefined, {month: "short"})}); }
        } else if (mode === "weekly") {
            const first = this.startOfWeek(current); first.setDate(first.getDate() - 7 * 7);
            for (let i = 0; i < 8; i++) { const start = new Date(first); start.setDate(first.getDate() + i * 7); const end = new Date(start); end.setDate(start.getDate() + 7); out.push({start: +start, end: +end, label: start.toLocaleDateString(undefined, {month: "short", day: "numeric"})}); }
        } else {
            const first = this.startOfDay(current); first.setDate(first.getDate() - 6);
            for (let i = 0; i < 7; i++) { const start = new Date(first); start.setDate(first.getDate() + i); const end = new Date(start); end.setDate(start.getDate() + 1); out.push({start: +start, end: +end, label: start.toLocaleDateString(undefined, {weekday: "short"})}); }
        }
        return out.map(bucket => ({...bucket, duration: this.rangeTotal(bucket.start, bucket.end, sessions)}));
    }

    buildGraph(buckets) {
        const chart = this.el("div", {className: "va-chart"});
        const total = buckets.reduce((sum, bucket) => sum + bucket.duration, 0);
        const peak = buckets.reduce((best, bucket) => !best || bucket.duration > best.duration ? bucket : best, null);
        const meta = this.el("div", {className: "va-chart-meta"});
        const totalBlock = this.el("div");
        totalBlock.append(this.el("span", {textContent: "Total shown"}), this.el("strong", {textContent: this.formatDuration(total, false)}));
        const peakBlock = this.el("div");
        peakBlock.append(this.el("span", {textContent: "Peak"}), this.el("strong", {textContent: peak?.duration ? `${peak.label} · ${this.formatDuration(peak.duration, false)}` : "No time yet"}));
        meta.append(totalBlock, peakBlock);

        const plot = this.el("div", {className: "va-chart-plot"});
        const max = Math.max(...buckets.map(bucket => bucket.duration), 60000);
        const axis = this.el("div", {className: "va-chart-axis"});
        axis.append(this.el("span", {textContent: this.formatDuration(max, true)}), this.el("span", {textContent: this.formatDuration(max / 2, true)}), this.el("span", {textContent: "0:00"}));
        const graph = this.el("div", {className: "va-graph"});
        graph.style.setProperty("--columns", String(buckets.length));
        for (const bucket of buckets) {
            const isPeak = Boolean(bucket.duration && peak && bucket === peak);
            const item = this.el("div", {className: `va-bar-item${isPeak ? " is-peak" : ""}`}), value = this.el("span", {textContent: bucket.duration ? this.formatDuration(bucket.duration, true) : ""}), track = this.el("div", {className: "va-bar-track"}), bar = this.el("div", {className: "va-bar"});
            track.setAttribute("title", `${bucket.label}: ${this.formatDuration(bucket.duration, false)}`);
            bar.style.height = bucket.duration ? `${Math.max(4, bucket.duration / max * 100)}%` : "0"; track.append(bar); item.append(value, track, this.el("small", {textContent: bucket.label})); graph.append(item);
        }
        plot.append(axis, graph);
        chart.append(meta, plot);
        return chart;
    }

    formatDuration(ms, seconds = true) {
        const total = Math.max(0, Math.floor(Number(ms) / 1000)), days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600), minutes = Math.floor(total % 3600 / 60), secs = total % 60;
        if (days) return `${days}d ${hours}h ${minutes}m`;
        if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
        return seconds ? `${minutes}:${String(secs).padStart(2, "0")}` : `${minutes}m`;
    }

    exportCsv() {
        const escape = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const rows = [["Start", "End", "Minutes", "Location", "Channel", "Source"]];
        for (const session of this.selfSessions().sort((a, b) => a.start - b.start)) rows.push([new Date(session.start).toISOString(), new Date(session.end).toISOString(), ((session.end - session.start) / 60000).toFixed(2), session.guildName, session.channelName, session.source === "call-message" ? "Private call history" : "Live voice state"]);
        const url = URL.createObjectURL(new Blob([rows.map(row => row.map(escape).join(",")).join("\r\n")], {type: "text/csv;charset=utf-8"}));
        const link = document.createElement("a"); link.href = url; link.download = `discord-voice-analytics-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    getSettingsPanel() {
        const panel = this.el("div", {className: "va-settings"});
        panel.append(this.el("h2", {textContent: "Voice Analytics"}), this.el("p", {textContent: "Combines your call analytics and voice-member timers. Existing data from both older plugins is imported once and kept locally."}));
        const open = this.el("button", {type: "button", textContent: "Open Voice Analytics"}); open.addEventListener("click", () => this.openDashboard()); panel.append(open);
        const label = this.el("label"); label.append(this.el("span", {textContent: "Keep history for (days)"}));
        const number = this.el("input", {type: "number", min: 7, max: 3650, value: this.settings.retentionDays});
        number.addEventListener("change", () => { this.settings.retentionDays = Math.max(7, Math.min(3650, Number(number.value) || DEFAULT_SETTINGS.retentionDays)); number.value = this.settings.retentionDays; this.save("settings", this.settings); this.prune(); this.saveData(); });
        label.append(number); panel.append(label); return panel;
    }

    addStyles() {
        const css = `
            .va-overlay{position:fixed!important;inset:0!important;z-index:2147483001!important;display:grid!important;place-items:center!important;padding:24px!important;background:rgba(0,0,0,.68)!important;font-family:var(--font-primary,Arial,sans-serif)!important}.va-panel{display:flex!important;flex-direction:column!important;width:min(920px,calc(100vw - 48px))!important;max-height:min(820px,calc(100vh - 48px))!important;overflow:hidden!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))!important;border-radius:12px!important;background:var(--background-primary,#313338)!important;color:var(--text-normal,#dbdee1)!important;box-shadow:0 20px 70px rgba(0,0,0,.6)!important}.va-header{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:18px 21px!important;border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))!important;background:var(--background-secondary,#2b2d31)!important}.va-header h1{margin:0!important;color:var(--header-primary,#f2f3f5)!important;font-size:21px!important}.va-header p{margin:4px 0 0!important;color:var(--text-muted,#949ba4)!important;font-size:12px!important}.va-close{display:grid!important;place-items:center!important;width:32px!important;height:32px!important;padding:0!important;border:0!important;border-radius:7px!important;background:transparent!important;color:var(--interactive-normal,#b5bac1)!important;font-size:24px!important;cursor:pointer!important}.va-close:hover{background:var(--background-modifier-hover,rgba(255,255,255,.06))!important;color:white!important}.va-body{overflow:auto!important;padding:15px 17px 20px!important}.va-tabs{display:flex!important;gap:4px!important;margin-bottom:14px!important;padding:4px!important;border-radius:8px!important;background:var(--background-secondary,#2b2d31)!important}.va-tabs button,.va-mode button{padding:8px 12px!important;border:0!important;border-radius:6px!important;background:transparent!important;color:var(--interactive-normal,#b5bac1)!important;font-weight:650!important;cursor:pointer!important}.va-tabs button.active,.va-mode button.active{background:var(--brand-500,#5865f2)!important;color:white!important}.va-view{display:flex!important;flex-direction:column!important;gap:12px!important}.va-summary{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:9px!important}.va-summary article,.va-card{border:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important;border-radius:9px!important;background:var(--background-secondary,#2b2d31)!important}.va-summary article{display:flex!important;flex-direction:column!important;gap:7px!important;padding:13px!important}.va-summary span{color:var(--text-muted,#949ba4)!important;font-size:11px!important}.va-summary strong{color:var(--header-primary,#f2f3f5)!important;font-size:19px!important}.va-card{overflow:hidden!important}.va-card-head{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;padding:12px 14px!important;border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important}.va-card-head h2{margin:0!important;font-size:14px!important}.va-mode{display:flex!important;gap:2px!important}.va-mode button{padding:6px 9px!important;font-size:11px!important}.va-graph{display:grid!important;grid-template-columns:repeat(var(--columns),minmax(0,1fr))!important;align-items:end!important;gap:8px!important;height:210px!important;padding:18px 15px 13px!important}.va-bar-item{display:grid!important;grid-template-rows:18px 1fr 18px!important;align-items:end!important;gap:4px!important;height:100%!important;text-align:center!important}.va-bar-item>span,.va-bar-item small{overflow:hidden!important;color:var(--text-muted,#949ba4)!important;font-size:9px!important;text-overflow:ellipsis!important;white-space:nowrap!important}.va-bar-track{display:flex!important;align-items:flex-end!important;height:100%!important;overflow:hidden!important;border-radius:5px 5px 2px 2px!important;background:var(--background-tertiary,#1e1f22)!important}.va-bar{width:100%!important;border-radius:5px 5px 2px 2px!important;background:var(--brand-500,#5865f2)!important}.va-export{padding:6px 9px!important;border:0!important;border-radius:5px!important;background:var(--brand-500,#5865f2)!important;color:white!important;font-weight:700!important;cursor:pointer!important}.va-session-list,.va-member-list,.va-total-list{display:flex!important;flex-direction:column!important}.va-session-row,.va-member-row,.va-total-row{display:flex!important;align-items:center!important;gap:10px!important;padding:10px 13px!important;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.06))!important}.va-session-row:first-child,.va-member-row:first-child,.va-total-row:first-child{border-top:0!important}.va-session-row>div,.va-member-row>div{display:flex!important;flex:1!important;min-width:0!important;flex-direction:column!important;gap:3px!important}.va-session-row span,.va-member-row span,.va-total-row span{overflow:hidden!important;color:var(--text-muted,#949ba4)!important;font-size:11px!important;text-overflow:ellipsis!important;white-space:nowrap!important}.va-session-row>strong,.va-member-row>strong{margin-left:auto!important;color:#c7d0ff!important;font-variant-numeric:tabular-nums!important}.va-avatar{display:grid!important;place-items:center!important;flex:none!important;width:34px!important;height:34px!important;border-radius:50%!important;background:var(--brand-500,#5865f2)!important;color:white!important;font-weight:800!important}.va-total-row>strong{min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}.va-total-row>span{margin-left:auto!important}.va-notice{padding:10px 12px!important;border:1px solid rgba(88,101,242,.3)!important;border-radius:7px!important;background:rgba(88,101,242,.09)!important;color:var(--text-normal,#dbdee1)!important;font-size:12px!important}.va-empty{padding:24px!important;color:var(--text-muted,#949ba4)!important;text-align:center!important}.va-settings{padding:10px 4px 28px!important;color:var(--text-normal,#dbdee1)!important}.va-settings p{color:var(--text-muted,#949ba4)!important}.va-settings>button{padding:9px 12px!important;border:0!important;border-radius:6px!important;background:var(--brand-500,#5865f2)!important;color:white!important;font-weight:700!important;cursor:pointer!important}.va-settings label{display:flex!important;align-items:center!important;justify-content:space-between!important;max-width:440px!important;margin-top:16px!important;padding:11px 0!important;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))!important}.va-settings input{width:90px!important;padding:7px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))!important;border-radius:5px!important;background:var(--input-background,#1e1f22)!important;color:var(--text-normal,#dbdee1)!important}@media(max-width:650px){.va-overlay{padding:8px!important}.va-panel{width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)!important}.va-summary{grid-template-columns:repeat(2,minmax(0,1fr))!important}.va-card-head{align-items:flex-start!important;flex-direction:column!important}.va-graph{gap:3px!important;padding-inline:7px!important}}
        `;
        const polish = `
            .va-overlay{background:radial-gradient(circle at 50% 15%,rgba(88,101,242,.16),transparent 36%),rgba(8,9,12,.78)!important;backdrop-filter:blur(3px)!important}
            .va-panel{width:min(940px,calc(100vw - 48px))!important;border-color:rgba(255,255,255,.1)!important;border-radius:16px!important;background:var(--background-primary,#313338)!important;box-shadow:0 28px 90px rgba(0,0,0,.7)!important}
            .va-header{padding:17px 20px!important;background:linear-gradient(115deg,rgba(88,101,242,.14),transparent 44%),var(--background-secondary,#2b2d31)!important}
            .va-heading,.va-header-actions{display:flex!important;align-items:center!important;gap:12px!important}.va-heading{min-width:0!important}.va-heading-copy{min-width:0!important}.va-brand-mark{display:grid!important;place-items:center!important;flex:none!important;width:42px!important;height:42px!important;border:1px solid rgba(255,255,255,.13)!important;border-radius:12px!important;background:linear-gradient(145deg,#6d78f7,#4752c4)!important;box-shadow:0 8px 22px rgba(71,82,196,.32)!important;font-size:21px!important}.va-heading-copy h1{letter-spacing:-.3px!important}.va-heading-copy p{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
            .va-live-pill,.va-count-pill{display:inline-flex!important;align-items:center!important;justify-content:center!important;height:24px!important;padding:0 9px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.09))!important;border-radius:999px!important;background:var(--background-tertiary,#1e1f22)!important;color:var(--text-muted,#949ba4)!important;font-size:10px!important;font-weight:800!important;letter-spacing:.35px!important}.va-live-pill.is-live,.va-count-pill.active{border-color:rgba(35,165,90,.32)!important;background:rgba(35,165,90,.12)!important;color:#52d487!important}
            .va-close{border-radius:9px!important}.va-body{padding:16px 18px 21px!important;scrollbar-color:var(--background-modifier-accent) transparent!important}.va-tabs{width:max-content!important;margin-bottom:16px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.06))!important;border-radius:10px!important}.va-tabs button{min-width:122px!important;border-radius:7px!important}.va-tabs button.active{box-shadow:0 4px 12px rgba(88,101,242,.25)!important}
            .va-summary{gap:10px!important}.va-summary article{position:relative!important;gap:5px!important;overflow:hidden!important;padding:15px 15px 13px!important;border-radius:10px!important;background:linear-gradient(145deg,rgba(255,255,255,.025),transparent),var(--background-secondary,#2b2d31)!important}.va-summary article:before{position:absolute!important;inset:0 auto 0 0!important;width:3px!important;background:var(--brand-500,#5865f2)!important;content:""!important}.va-summary article:nth-child(2):before{background:#57f287!important}.va-summary article:nth-child(3):before{background:#f0b232!important}.va-summary article:nth-child(4):before{background:#eb459e!important}.va-summary strong{font-size:21px!important;letter-spacing:-.4px!important}.va-summary small{color:var(--text-muted,#949ba4)!important;font-size:10px!important}
            .va-card{border-radius:11px!important;box-shadow:0 3px 12px rgba(0,0,0,.1)!important}.va-card-head{min-height:26px!important;padding:13px 15px!important}.va-card-head h2{font-size:14px!important;letter-spacing:-.1px!important}.va-mode{padding:3px!important;border-radius:7px!important;background:var(--background-tertiary,#1e1f22)!important}.va-mode button.active{box-shadow:none!important}
            .va-graph{position:relative!important;background:repeating-linear-gradient(to top,transparent 0,transparent calc(25% - 1px),rgba(255,255,255,.035) 25%)!important}.va-bar-track{border:1px solid rgba(255,255,255,.025)!important}.va-bar{min-height:0!important;background:linear-gradient(to top,#4752c4,#7289da)!important;box-shadow:0 -4px 13px rgba(88,101,242,.22)!important}
            .va-session-row,.va-member-row{min-height:50px!important;padding:11px 14px!important;transition:background .14s ease!important}.va-session-row:hover,.va-member-row:hover{background:var(--background-modifier-hover,rgba(255,255,255,.035))!important}.va-session-icon{display:grid!important;place-items:center!important;flex:none!important;width:32px!important;height:32px!important;border-radius:9px!important;background:rgba(88,101,242,.13)!important;color:#aab1ff!important;font-size:15px!important}.va-source-tag{align-self:flex-start!important;margin-top:2px!important;padding:2px 6px!important;border-radius:4px!important;background:rgba(88,101,242,.12)!important;color:#aeb5ff!important;font-size:9px!important;font-weight:700!important}
            .va-avatar{width:36px!important;height:36px!important;border:2px solid rgba(255,255,255,.08)!important;box-sizing:border-box!important;object-fit:cover!important}.va-notice{border-color:rgba(88,101,242,.26)!important;border-left:3px solid var(--brand-500,#5865f2)!important;background:linear-gradient(90deg,rgba(88,101,242,.12),rgba(88,101,242,.04))!important}
            .va-total-list{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important;padding:11px!important}.va-total-row{min-width:0!important;padding:10px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important;border-radius:9px!important;background:var(--background-tertiary,#1e1f22)!important}.va-total-row:first-child{border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important}.va-total-row>.va-avatar{margin-left:0!important}.va-total-copy{display:flex!important;min-width:0!important;flex:1!important;flex-direction:column!important;gap:3px!important}.va-total-copy strong,.va-total-copy span{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}.va-total-copy span{color:var(--text-muted,#949ba4)!important;font-size:10px!important}.va-total-row>b{flex:none!important;margin-left:auto!important;color:#cbd0ff!important;font-size:12px!important;font-variant-numeric:tabular-nums!important}.va-empty{border-radius:8px!important;background:rgba(0,0,0,.06)!important}
            @media(max-width:650px){.va-header{padding:14px!important}.va-brand-mark{width:36px!important;height:36px!important}.va-live-pill{display:none!important}.va-body{padding:12px!important}.va-tabs{width:100%!important}.va-tabs button{flex:1!important;min-width:0!important}.va-total-list{grid-template-columns:1fr!important}.va-summary article{padding:12px!important}}
        `;
        const minePolish = `
            .va-mine-hero{display:flex!important;align-items:stretch!important;justify-content:space-between!important;gap:20px!important;min-height:112px!important;padding:18px 20px!important;border:1px solid rgba(88,101,242,.24)!important;border-radius:12px!important;background:radial-gradient(circle at 85% 20%,rgba(88,101,242,.22),transparent 38%),linear-gradient(125deg,rgba(88,101,242,.16),rgba(35,37,44,.65))!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)!important}.va-mine-hero.is-active{border-color:rgba(35,165,90,.32)!important;background:radial-gradient(circle at 85% 20%,rgba(35,165,90,.2),transparent 38%),linear-gradient(125deg,rgba(35,165,90,.14),rgba(35,37,44,.65))!important}.va-mine-hero-copy{display:flex!important;min-width:0!important;flex-direction:column!important;justify-content:center!important}.va-eyebrow{margin-bottom:3px!important;color:#aeb5ff!important;font-size:9px!important;font-weight:850!important;letter-spacing:1.2px!important}.va-mine-hero.is-active .va-eyebrow{color:#66dc94!important}.va-mine-hero-copy>strong{color:var(--header-primary,#f2f3f5)!important;font-size:32px!important;line-height:1.1!important;letter-spacing:-1px!important}.va-mine-hero-copy>p{overflow:hidden!important;margin:7px 0 0!important;color:var(--text-muted,#949ba4)!important;font-size:11px!important;text-overflow:ellipsis!important;white-space:nowrap!important}.va-mine-hero-side{display:grid!important;grid-template-columns:repeat(2,minmax(92px,1fr))!important;align-self:stretch!important;gap:8px!important}.va-mine-hero-side>div{display:flex!important;min-width:92px!important;flex-direction:column!important;justify-content:center!important;gap:5px!important;padding:10px 12px!important;border:1px solid rgba(255,255,255,.06)!important;border-radius:9px!important;background:rgba(0,0,0,.15)!important}.va-mine-hero-side span{color:var(--text-muted,#949ba4)!important;font-size:9px!important;text-transform:uppercase!important}.va-mine-hero-side b{color:var(--header-primary,#f2f3f5)!important;font-size:15px!important}
            .va-card-title{display:flex!important;min-width:0!important;flex-direction:column!important;gap:3px!important}.va-card-title>span{color:var(--text-muted,#949ba4)!important;font-size:10px!important}.va-session-row.is-active{background:linear-gradient(90deg,rgba(35,165,90,.09),transparent)!important}.va-session-row.is-active .va-session-icon{background:rgba(35,165,90,.15)!important;color:#66dc94!important}.va-source-tag.is-live{background:rgba(35,165,90,.14)!important;color:#66dc94!important}.va-bar-track{cursor:default!important;transition:filter .15s ease!important}.va-bar-track:hover{filter:brightness(1.22)!important}.va-bar{transition:height .28s ease,filter .15s ease!important}
            @media(max-width:650px){.va-mine-hero{flex-direction:column!important;gap:13px!important;padding:15px!important}.va-mine-hero-side{grid-template-columns:repeat(2,minmax(0,1fr))!important}.va-mine-hero-copy>strong{font-size:28px!important}}
        `;
        const cleanMine = `
            .va-panel{border-radius:12px!important}.va-header{background:var(--background-secondary,#2b2d31)!important}.va-brand-mark{width:38px!important;height:38px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.09))!important;border-radius:9px!important;background:var(--background-tertiary,#1e1f22)!important;box-shadow:none!important;color:var(--interactive-normal,#b5bac1)!important}.va-brand-mark svg{width:18px!important;height:18px!important}
            .va-view{gap:10px!important}.va-mine-hero{min-height:94px!important;padding:16px 18px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))!important;border-left:3px solid var(--brand-500,#5865f2)!important;border-radius:9px!important;background:var(--background-secondary,#2b2d31)!important;box-shadow:none!important}.va-mine-hero.is-active{border-color:var(--background-modifier-accent,rgba(255,255,255,.08))!important;border-left-color:#23a55a!important;background:var(--background-secondary,#2b2d31)!important}.va-eyebrow{display:flex!important;align-items:center!important;gap:6px!important;margin-bottom:5px!important;color:var(--text-muted,#949ba4)!important;font-size:9px!important;letter-spacing:.9px!important}.va-eyebrow:before{display:block!important;width:6px!important;height:6px!important;border-radius:50%!important;background:var(--brand-500,#5865f2)!important;content:""!important}.va-mine-hero.is-active .va-eyebrow{color:#57c97d!important}.va-mine-hero.is-active .va-eyebrow:before{background:#23a55a!important;box-shadow:0 0 0 3px rgba(35,165,90,.12)!important}.va-mine-hero-copy>strong{font-size:29px!important;letter-spacing:-.65px!important}.va-mine-hero-copy>p{margin-top:6px!important}.va-mine-hero-side{display:flex!important;align-items:center!important;align-self:center!important;gap:0!important}.va-mine-hero-side>div{min-width:108px!important;min-height:46px!important;padding:2px 16px!important;border:0!important;border-left:1px solid var(--background-modifier-accent,rgba(255,255,255,.09))!important;border-radius:0!important;background:transparent!important}.va-mine-hero-side span{font-size:9px!important;letter-spacing:.3px!important}.va-mine-hero-side b{font-size:15px!important}
            .va-summary{gap:8px!important}.va-summary article{gap:4px!important;padding:12px 13px!important;border-radius:8px!important;background:var(--background-secondary,#2b2d31)!important;box-shadow:none!important}.va-summary article:before{display:none!important}.va-summary strong{font-size:18px!important;letter-spacing:-.2px!important}.va-summary small{font-size:9px!important}.va-card{border-radius:9px!important;box-shadow:none!important}.va-card-head{padding:12px 14px!important}.va-mode{border:1px solid var(--background-modifier-accent,rgba(255,255,255,.06))!important;background:var(--background-primary,#313338)!important}.va-mode button{font-size:10px!important}.va-mode button.active{background:var(--background-modifier-selected,rgba(255,255,255,.1))!important;color:var(--header-primary,#f2f3f5)!important}
            .va-graph{height:195px!important;padding:18px 14px 12px!important;background:repeating-linear-gradient(to top,transparent 0,transparent calc(25% - 1px),rgba(255,255,255,.028) 25%)!important}.va-bar-track{justify-content:center!important;overflow:visible!important;border:0!important;border-radius:0!important;background:transparent!important}.va-bar{width:min(68%,34px)!important;border-radius:4px 4px 2px 2px!important;background:var(--brand-500,#5865f2)!important;box-shadow:none!important}.va-bar-item>span,.va-bar-item small{font-size:9px!important}
            .va-session-row{min-height:52px!important;padding:10px 14px!important}.va-session-row:hover{background:var(--background-modifier-hover,rgba(255,255,255,.035))!important}.va-session-row.is-active{border-left:2px solid #23a55a!important;background:rgba(35,165,90,.045)!important}.va-session-icon{width:32px!important;height:32px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important;border-radius:8px!important;background:var(--background-tertiary,#1e1f22)!important;color:var(--interactive-normal,#b5bac1)!important}.va-session-icon.is-synced{color:#aeb5ff!important}.va-session-icon svg{width:16px!important;height:16px!important}.va-session-row.is-active .va-session-icon{border-color:rgba(35,165,90,.18)!important;background:rgba(35,165,90,.08)!important;color:#57c97d!important}.va-source-tag{padding:1px 5px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.06))!important;border-radius:3px!important;background:transparent!important;color:var(--text-muted,#949ba4)!important;font-size:8px!important;font-weight:650!important}.va-source-tag.is-live{border-color:rgba(35,165,90,.2)!important;background:rgba(35,165,90,.06)!important;color:#57c97d!important}
            @media(max-width:650px){.va-mine-hero{padding:14px!important}.va-mine-hero-side{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;width:100%!important}.va-mine-hero-side>div{min-width:0!important;padding:8px 10px!important;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important;border-radius:7px!important}.va-mine-hero-side>div+div{margin-left:6px!important}}
        `;
        const graphRedesign = `
            .va-chart{display:flex!important;flex-direction:column!important}.va-chart-meta{display:flex!important;align-items:center!important;gap:24px!important;padding:12px 15px 10px!important;border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,.06))!important}.va-chart-meta>div{display:flex!important;align-items:baseline!important;gap:7px!important}.va-chart-meta span{color:var(--text-muted,#949ba4)!important;font-size:9px!important;text-transform:uppercase!important;letter-spacing:.35px!important}.va-chart-meta strong{color:var(--header-primary,#f2f3f5)!important;font-size:12px!important}.va-chart-meta>div+div{padding-left:24px!important;border-left:1px solid var(--background-modifier-accent,rgba(255,255,255,.07))!important}
            .va-chart-plot{display:grid!important;grid-template-columns:42px minmax(0,1fr)!important;gap:8px!important;height:220px!important;padding:15px 14px 12px 8px!important}.va-chart-axis{display:flex!important;flex-direction:column!important;justify-content:space-between!important;padding:19px 0 19px!important;text-align:right!important}.va-chart-axis span{color:var(--text-muted,#949ba4)!important;font-size:8px!important;font-variant-numeric:tabular-nums!important}.va-graph{height:100%!important;padding:0!important;background:repeating-linear-gradient(to top,transparent 0,transparent calc(50% - 1px),rgba(255,255,255,.035) 50%)!important}.va-bar-item{grid-template-rows:18px minmax(0,1fr) 18px!important;gap:3px!important}.va-bar-track{height:100%!important}.va-bar{width:min(56%,28px)!important;border-radius:4px 4px 1px 1px!important;background:#5865f2!important;opacity:.82!important}.va-bar-item:hover .va-bar{opacity:1!important}.va-bar-item.is-peak .va-bar{background:#7983f5!important;opacity:1!important}.va-bar-item.is-peak>span,.va-bar-item.is-peak>small{color:#c9cdff!important}.va-bar-item>span{font-variant-numeric:tabular-nums!important}
            @media(max-width:650px){.va-chart-meta{gap:12px!important}.va-chart-meta>div+div{padding-left:12px!important}.va-chart-plot{grid-template-columns:35px minmax(0,1fr)!important;padding-right:8px!important}.va-bar{width:min(70%,24px)!important}}
        `;
        const finalTheme = `
            .va-overlay{padding:20px!important;background:rgba(0,0,0,.72)!important;backdrop-filter:blur(2px)!important}.va-panel{width:min(900px,calc(100vw - 40px))!important;max-height:min(840px,calc(100vh - 40px))!important;border:1px solid rgba(255,255,255,.09)!important;border-radius:10px!important;background:var(--background-primary,#313338)!important;box-shadow:0 24px 80px rgba(0,0,0,.62)!important}.va-header{min-height:64px!important;padding:13px 17px!important;border-bottom-color:rgba(255,255,255,.07)!important;background:var(--background-secondary,#2b2d31)!important}.va-heading{gap:11px!important}.va-brand-mark{width:36px!important;height:36px!important;border-radius:8px!important}.va-heading-copy h1{font-size:18px!important;letter-spacing:-.2px!important}.va-heading-copy p{margin-top:2px!important;font-size:11px!important}.va-header-actions{gap:8px!important}.va-live-pill{height:22px!important;padding:0 8px!important;border-radius:5px!important;font-size:9px!important}.va-close{width:30px!important;height:30px!important;border-radius:6px!important;font-size:21px!important}.va-body{padding:0 18px 18px!important;background:var(--background-primary,#313338)!important}
            .va-tabs{position:sticky!important;top:0!important;z-index:2!important;display:flex!important;width:100%!important;margin:0 0 14px!important;padding:0!important;border:0!important;border-bottom:1px solid rgba(255,255,255,.07)!important;border-radius:0!important;background:var(--background-primary,#313338)!important}.va-tabs button{position:relative!important;min-width:0!important;padding:14px 2px 11px!important;border-radius:0!important;background:transparent!important;color:var(--interactive-normal,#b5bac1)!important;font-size:12px!important}.va-tabs button+button{margin-left:22px!important}.va-tabs button.active{background:transparent!important;color:var(--header-primary,#f2f3f5)!important;box-shadow:none!important}.va-tabs button.active:after{position:absolute!important;right:0!important;bottom:-1px!important;left:0!important;height:2px!important;border-radius:2px 2px 0 0!important;background:var(--brand-500,#5865f2)!important;content:""!important}
            .va-view{gap:10px!important}.va-card{border:1px solid rgba(255,255,255,.07)!important;border-radius:8px!important;background:var(--background-secondary,#2b2d31)!important;box-shadow:none!important}.va-card-head{min-height:38px!important;padding:11px 13px!important;border-bottom-color:rgba(255,255,255,.06)!important}.va-card-title{gap:2px!important}.va-card-title h2{font-size:13px!important}.va-card-title>span{font-size:9px!important}.va-export{padding:6px 9px!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:5px!important;background:var(--background-primary,#313338)!important;color:var(--interactive-normal,#b5bac1)!important;font-size:10px!important}.va-export:hover{background:var(--background-modifier-hover,rgba(255,255,255,.06))!important;color:var(--header-primary,#f2f3f5)!important}
            .va-mine-hero{min-height:88px!important;padding:14px 16px!important;border:1px solid rgba(255,255,255,.07)!important;border-left:3px solid var(--brand-500,#5865f2)!important;border-radius:8px!important;background:var(--background-secondary,#2b2d31)!important}.va-mine-hero.is-active{border-color:rgba(255,255,255,.07)!important;border-left-color:#23a55a!important}.va-mine-hero-copy>strong{font-size:27px!important}.va-mine-hero-copy>p{font-size:10px!important}.va-mine-hero-side>div{min-width:104px!important;min-height:42px!important}.va-summary,.va-people-summary{display:grid!important;gap:8px!important}.va-summary{grid-template-columns:repeat(4,minmax(0,1fr))!important}.va-people-summary{grid-template-columns:repeat(3,minmax(0,1fr))!important}.va-summary article,.va-people-summary article{display:flex!important;min-width:0!important;flex-direction:column!important;gap:4px!important;padding:11px 12px!important;border:1px solid rgba(255,255,255,.07)!important;border-radius:7px!important;background:var(--background-secondary,#2b2d31)!important}.va-summary article:before{display:none!important}.va-summary article>span,.va-people-summary article>span{color:var(--text-muted,#949ba4)!important;font-size:9px!important;text-transform:uppercase!important;letter-spacing:.3px!important}.va-summary article>strong,.va-people-summary article>strong{overflow:hidden!important;color:var(--header-primary,#f2f3f5)!important;font-size:17px!important;line-height:1.25!important;text-overflow:ellipsis!important;white-space:nowrap!important}.va-summary article>small,.va-people-summary article>small{overflow:hidden!important;color:var(--text-muted,#949ba4)!important;font-size:9px!important;text-overflow:ellipsis!important;white-space:nowrap!important}
            .va-mode{padding:2px!important;border:1px solid rgba(255,255,255,.06)!important;border-radius:6px!important;background:var(--background-primary,#313338)!important}.va-mode button{padding:5px 8px!important;border-radius:4px!important;font-size:9px!important}.va-mode button.active{background:var(--background-modifier-selected,rgba(255,255,255,.1))!important;color:var(--header-primary,#f2f3f5)!important}.va-chart-meta{padding:10px 13px 9px!important}.va-chart-plot{height:205px!important;padding-top:12px!important}.va-graph{background:repeating-linear-gradient(to top,transparent 0,transparent calc(50% - 1px),rgba(255,255,255,.03) 50%)!important}.va-bar{width:min(78%,48px)!important;border-radius:5px 5px 2px 2px!important}.va-bar-item>span,.va-bar-item small{font-size:8px!important}
            .va-session-row,.va-member-row{min-height:50px!important;padding:9px 12px!important;border-top-color:rgba(255,255,255,.055)!important}.va-session-icon{width:30px!important;height:30px!important;border-radius:7px!important}.va-session-icon svg{width:15px!important;height:15px!important}.va-session-row>div>strong,.va-member-row>div>strong{font-size:12px!important}.va-session-row>div>span,.va-member-row>div>span{font-size:9px!important}.va-session-row>strong,.va-member-row>strong{font-size:11px!important}.va-avatar{width:34px!important;height:34px!important}.va-count-pill{height:21px!important;padding:0 8px!important;border-radius:5px!important;font-size:9px!important}
            .va-total-list{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:7px!important;padding:10px!important}.va-total-row{gap:9px!important;padding:9px!important;border-color:rgba(255,255,255,.065)!important;border-radius:7px!important;background:var(--background-primary,#313338)!important}.va-total-row:first-child{border-top-color:rgba(255,255,255,.065)!important}.va-rank{display:grid!important;place-items:center!important;flex:none!important;width:18px!important;height:18px!important;margin:0!important;border-radius:4px!important;background:var(--background-secondary,#2b2d31)!important;color:var(--text-muted,#949ba4)!important;font-size:8px!important;font-weight:800!important}.va-total-copy strong{font-size:11px!important}.va-total-copy span{font-size:9px!important}.va-total-row>b{font-size:10px!important}.va-notice{padding:9px 11px!important;border:1px solid rgba(255,255,255,.06)!important;border-left:2px solid var(--interactive-muted,#4e5058)!important;border-radius:6px!important;background:var(--background-secondary,#2b2d31)!important;color:var(--text-muted,#949ba4)!important;font-size:9px!important}.va-empty{margin:8px!important;padding:20px!important;border:1px dashed rgba(255,255,255,.07)!important;border-radius:6px!important;background:transparent!important;font-size:11px!important}
            .va-settings{max-width:620px!important;padding:16px!important;border:1px solid rgba(255,255,255,.07)!important;border-radius:8px!important;background:var(--background-secondary,#2b2d31)!important}.va-settings h2{margin:0 0 5px!important;font-size:17px!important}.va-settings p{margin:0 0 15px!important;font-size:11px!important}.va-settings>button{padding:8px 11px!important;border-radius:5px!important;font-size:11px!important}.va-settings label{margin-top:14px!important;padding-top:12px!important;font-size:11px!important}
            @media(max-width:650px){.va-overlay{padding:8px!important}.va-panel{width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)!important}.va-body{padding:0 10px 12px!important}.va-heading-copy p{display:none!important}.va-summary{grid-template-columns:repeat(2,minmax(0,1fr))!important}.va-people-summary{grid-template-columns:1fr!important}.va-total-list{grid-template-columns:1fr!important}.va-chart-meta{align-items:flex-start!important;flex-direction:column!important;gap:4px!important}.va-chart-meta>div+div{padding-left:0!important;border-left:0!important}.va-card-head{align-items:center!important;flex-direction:row!important}.va-mine-hero-side>div{min-width:0!important}.va-bar{width:min(82%,36px)!important}}
        `;
        const combinedCss = css + polish + minePolish + cleanMine + graphRedesign + finalTheme;
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.addStyle) dom.addStyle(STYLE_ID, combinedCss);
        else if (globalThis.document?.head) { const style = document.createElement("style"); style.id = STYLE_ID; style.textContent = combinedCss; document.head.append(style); }
    }

    removeStyles() {
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.removeStyle) dom.removeStyle(STYLE_ID);
        globalThis.document?.getElementById?.(STYLE_ID)?.remove();
    }

    loadExternal(plugin, key) {
        try { return globalThis.BdApi?.Data?.load?.(plugin, key); } catch (_) { return null; }
    }

    load(key) {
        try { if (this.api?.Data?.load) return this.api.Data.load(key); return globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key); } catch (_) { return null; }
    }

    save(key, value) {
        try { if (this.api?.Data?.save) this.api.Data.save(key, value); else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value); } catch (_) {}
    }

    saveData() { this.save("voice-analytics", this.data); }

    el(tag, properties = {}) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === "className") node.className = value;
            else if (key === "textContent") node.textContent = value;
            else if (key === "disabled") node.disabled = Boolean(value);
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        return node;
    }

    toast(message, type = "info") {
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showToast) ui.showToast(message, {type});
    }
};
