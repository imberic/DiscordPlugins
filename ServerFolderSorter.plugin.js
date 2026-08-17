/**
 * @name ServerFolderSorter
 * @author tiny
 * @version 1.2.2
 * @description Automatically sorts your Discord servers into real named folders with preview and undo.
 */

"use strict";

const PLUGIN_NAME = "ServerFolderSorter";
const STYLE_ID = "tiny-server-folder-sorter-styles";
const DISCORD_EPOCH = 1420070400000n;
const COLORS = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0x9b84ee];
const DEFAULT_SETTINGS = Object.freeze({showQuickButton: true, preset: "alphabetical"});

module.exports = class ServerFolderSorter {
    constructor() {
        this.api = null;
        this.webpack = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.stores = {};
        this.settingsUpdater = null;
        this.rest = null;
        this.quickButton = null;
        this.modal = null;
        this.servers = [];
        this.preview = [];
        this.activityData = {guilds: {}};
        this.dispatcher = null;
        this.messageCreateHandler = null;
        this.voiceStateHandler = null;
        this.voiceHeartbeat = null;
        this.serverWheelHandler = null;
        this.busy = false;
        this.started = false;
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.settings = this.sanitizeSettings(this.load("settings"));
        this.activityData = this.sanitizeActivityData(this.load("activity"));
        this.findModules();
        this.subscribeActivity();
        this.addStyles();
        this.enableServerRailScrolling();
        this.ensureQuickButton();
    }

    stop() {
        this.started = false;
        this.busy = false;
        if (this.dispatcher && this.messageCreateHandler) {
            try { this.dispatcher.unsubscribe("MESSAGE_CREATE", this.messageCreateHandler); } catch (_) {}
        }
        if (this.dispatcher && this.voiceStateHandler) {
            for (const event of ["VOICE_STATE_UPDATE", "VOICE_STATE_UPDATES"]) {
                try { this.dispatcher.unsubscribe(event, this.voiceStateHandler); } catch (_) {}
            }
        }
        this.messageCreateHandler = null;
        this.voiceStateHandler = null;
        if (this.voiceHeartbeat) clearInterval(this.voiceHeartbeat);
        this.voiceHeartbeat = null;
        if (this.serverWheelHandler && globalThis.document) document.removeEventListener("wheel", this.serverWheelHandler, {capture: true});
        this.serverWheelHandler = null;
        this.closeManager();
        this.quickButton?.remove();
        this.quickButton = null;
        this.removeStyles();
    }

    initializeApi() {
        try { if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME); }
        catch (_) {}
        this.webpack = this.api?.Webpack || globalThis.BdApi?.Webpack || null;
    }

    sanitizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const presets = new Set(["alphabetical", "activity", "size", "ownership", "custom"]);
        const manualAssignments = {};
        for (const preset of presets) {
            const entries = Object.entries(source.manualAssignments?.[preset] || {}).slice(0, 1000);
            if (entries.length) manualAssignments[preset] = Object.fromEntries(entries.map(([guildId, folderName]) => [String(guildId), String(folderName)]));
        }
        const customFolders = [];
        const seenCustomIds = new Set();
        for (const [index, folder] of (Array.isArray(source.customFolders) ? source.customFolders : []).slice(0, 50).entries()) {
            const id = String(folder?.id || `custom-${index + 1}`);
            const name = String(folder?.name || "").trim().slice(0, 40);
            if (!name || seenCustomIds.has(id)) continue;
            seenCustomIds.add(id);
            customFolders.push({id, name, color: Number(folder?.color) || COLORS[index % COLORS.length]});
        }
        if (!customFolders.length) customFolders.push({id: "custom-unsorted", name: "Unsorted", color: COLORS[0]});
        return {
            showQuickButton: source.showQuickButton ?? DEFAULT_SETTINGS.showQuickButton,
            preset: presets.has(source.preset) ? source.preset : DEFAULT_SETTINGS.preset,
            manualAssignments,
            customFolders
        };
    }

    sanitizeActivityData(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const guilds = {};
        const cutoff = Date.now() - 90 * 86400000;
        for (const [guildId, record] of Object.entries(source.guilds || {})) {
            const messages = (Array.isArray(record?.messages) ? record.messages : [])
                .map(event => ({id: String(event?.id || ""), timestamp: Number(event?.timestamp) || 0}))
                .filter(event => event.id && event.timestamp >= cutoff)
                .slice(-3000);
            const voice = (Array.isArray(record?.voice) ? record.voice : [])
                .map(timestamp => Number(timestamp) || 0)
                .filter(timestamp => timestamp >= cutoff)
                .slice(-3000);
            if (messages.length || voice.length) guilds[String(guildId)] = {messages, voice};
        }
        return {guilds};
    }

    findModules() {
        const getStore = name => { try { return this.webpack?.getStore?.(name) || null; } catch (_) { return null; } };
        this.stores = {
            guild: getStore("GuildStore"),
            sortedGuild: getStore("SortedGuildStore"),
            guildMember: getStore("GuildMemberStore"),
            memberCount: getStore("GuildMemberCountStore"),
            channel: getStore("ChannelStore"),
            guildChannel: getStore("GuildChannelStore"),
            message: getStore("MessageStore"),
            readState: getStore("ReadStateStore"),
            user: getStore("UserStore"),
            selectedChannel: getStore("SelectedChannelStore")
        };
        try {
            this.dispatcher = this.webpack?.getByKeys?.("dispatch", "subscribe", "unsubscribe")
                || this.webpack?.getModule?.(value => typeof value?.dispatch === "function" && typeof value?.subscribe === "function" && typeof value?.unsubscribe === "function", {searchExports: true})
                || null;
        } catch (_) { this.dispatcher = null; }
        try { this.settingsUpdater = this.webpack?.getByKeys?.("updateRemoteSettings") || null; }
        catch (_) { this.settingsUpdater = null; }
        try {
            this.rest = this.webpack?.getModule?.(value => this.isDiscordRequestModule(value), {searchExports: true}) || null;
        } catch (_) { this.rest = null; }
        if (!this.stores.guild || !this.stores.sortedGuild) this.toast("Discord's server-folder store was not found. Reload Discord and try again.", "error");
    }

    isDiscordRequestModule(value) {
        return Boolean(value
            && typeof value.get === "function"
            && typeof value.post === "function"
            && typeof value.put === "function"
            && typeof value.patch === "function"
            && (typeof value.del === "function" || typeof value.delete === "function")
            && value.get.length <= 1
            && value.patch.length <= 1);
    }

    subscribeActivity() {
        if (!this.dispatcher?.subscribe) return;
        this.messageCreateHandler = event => this.handleMessageCreate(event?.message || event);
        try { this.dispatcher.subscribe("MESSAGE_CREATE", this.messageCreateHandler); }
        catch (_) { this.messageCreateHandler = null; }
        this.voiceStateHandler = event => this.handleVoiceStateEvent(event);
        for (const event of ["VOICE_STATE_UPDATE", "VOICE_STATE_UPDATES"]) {
            try { this.dispatcher.subscribe(event, this.voiceStateHandler); } catch (_) {}
        }
        this.recordCurrentVoiceActivity();
        this.voiceHeartbeat = setInterval(() => this.recordCurrentVoiceActivity(), 60000);
    }

    handleVoiceStateEvent(event) {
        const source = event?.voiceStates || event?.voice_states || event?.updates || event?.voiceState || event;
        const isSingleState = source && (source.userId || source.user_id || source.channelId || source.channel_id);
        const states = isSingleState ? [source] : this.normalizeCollection(source);
        const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
        let changed = false;
        for (const state of states) {
            const userId = String(state?.userId || state?.user_id || state?.user?.id || "");
            const channelId = String(state?.channelId || state?.channel_id || "");
            if (!selfId || userId !== selfId || !channelId) continue;
            let channel = null;
            try { channel = this.stores.channel?.getChannel?.(channelId); } catch (_) {}
            const guildId = String(state?.guildId || state?.guild_id || channel?.guild_id || channel?.guildId || "");
            changed = this.recordVoiceActivity(guildId) || changed;
        }
        if (changed) this.save("activity", this.activityData);
    }

    recordCurrentVoiceActivity() {
        let channelId = "";
        try { channelId = String(this.stores.selectedChannel?.getVoiceChannelId?.() || ""); } catch (_) {}
        if (!channelId) return;
        let channel = null;
        try { channel = this.stores.channel?.getChannel?.(channelId); } catch (_) {}
        const guildId = String(channel?.guild_id || channel?.guildId || "");
        if (this.recordVoiceActivity(guildId)) this.save("activity", this.activityData);
    }

    recordVoiceActivity(guildId, timestamp = Date.now()) {
        if (!guildId) return false;
        const record = this.activityData.guilds[guildId] ||= {messages: [], voice: []};
        record.messages ||= [];
        record.voice ||= [];
        const time = Number(timestamp) || Date.now();
        if (record.voice.length && time - record.voice[record.voice.length - 1] < 5 * 60000) return false;
        record.voice.push(time);
        const cutoff = Date.now() - 90 * 86400000;
        record.voice = record.voice.filter(value => value >= cutoff).slice(-3000);
        return true;
    }

    enableServerRailScrolling() {
        if (!globalThis.document?.addEventListener) return;
        if (this.serverWheelHandler) document.removeEventListener("wheel", this.serverWheelHandler, {capture: true});
        this.serverWheelHandler = event => {
            const target = event.target;
            const guildList = target?.closest?.('[data-list-id="guildsnav"]')
                || target?.closest?.('nav[aria-label="Servers"]')?.querySelector?.('[data-list-id="guildsnav"]');
            if (!guildList) return;
            const descendants = typeof guildList.querySelectorAll === "function" ? [...guildList.querySelectorAll("*")] : [];
            const scroller = [guildList, ...descendants].find(element => Number(element?.scrollHeight) > Number(element?.clientHeight) + 2);
            if (!scroller) return;
            let delta = Number(event.deltaY) || 0;
            if (event.deltaMode === 1) delta *= 40;
            else if (event.deltaMode === 2) delta *= Math.max(1, Number(scroller.clientHeight) || 1);
            if (!delta) return;
            const current = Number(scroller.scrollTop) || 0;
            const maximum = Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight));
            const next = Math.max(0, Math.min(maximum, current + delta));
            if (next === current) return;
            if (event.cancelable) event.preventDefault();
            scroller.scrollTop = next;
        };
        document.addEventListener("wheel", this.serverWheelHandler, {capture: true, passive: false});
    }

    handleMessageCreate(message) {
        const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
        const authorId = String(message?.author?.id || message?.author_id || message?.authorId || "");
        if (!selfId || authorId !== selfId || !message?.id) return;
        const channelId = String(message.channel_id || message.channelId || "");
        let channel = null;
        try { channel = this.stores.channel?.getChannel?.(channelId); } catch (_) {}
        const guildId = String(message.guild_id || message.guildId || channel?.guild_id || channel?.guildId || "");
        if (!guildId) return;
        this.recordOwnMessage(guildId, String(message.id), this.messageTime(message));
        this.save("activity", this.activityData);
    }

    recordOwnMessage(guildId, messageId, timestamp) {
        if (!guildId || !messageId) return false;
        const record = this.activityData.guilds[guildId] ||= {messages: [], voice: []};
        record.messages ||= [];
        record.voice ||= [];
        if (record.messages.some(event => event.id === messageId)) return false;
        record.messages.push({id: messageId, timestamp: Number(timestamp) || Date.now()});
        const cutoff = Date.now() - 90 * 86400000;
        record.messages = record.messages.filter(event => event.timestamp >= cutoff).slice(-3000);
        return true;
    }

    messageTime(message) {
        const direct = message?.timestamp instanceof Date ? message.timestamp.getTime() : Date.parse(message?.timestamp || "");
        return Number.isFinite(direct) ? direct : this.snowflakeTime(message?.id) || Date.now();
    }

    ensureQuickButton() {
        this.quickButton?.remove();
        this.quickButton = null;
        if (!this.settings.showQuickButton) return;
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.quickButton = library.register({
            id: "server-folder-sorter",
            name: "Server Folder Sorter",
            description: "Sort and customize your server folders",
            icon: "📁",
            order: 70,
            open: () => this.openManager()
        });
    }

    scanServers() {
        let guilds = {};
        try { guilds = this.stores.guild?.getGuilds?.() || {}; } catch (_) {}
        const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
        let seeded = false;
        const servers = this.normalizeCollection(guilds).filter(guild => guild?.id).map(guild => {
            const id = String(guild.id);
            seeded = this.seedCachedOwnMessages(id, selfId) || seeded;
            const activity = this.myActivity(id);
            return {
                id,
                name: String(guild.name || `Server ${id.slice(-4)}`),
                icon: this.guildIconUrl(guild),
                owner: Boolean(selfId && String(guild.ownerId || guild.owner_id || "") === selfId),
                joinedAt: this.guildJoinedAt(id, selfId),
                memberCount: this.guildMemberCount(guild),
                myActivityScore: activity.score,
                myMessages30d: activity.messages30d,
                myLastActive: activity.lastActive
            };
        });
        if (seeded) this.save("activity", this.activityData);
        return servers;
    }

    seedCachedOwnMessages(guildId, selfId) {
        if (!guildId || !selfId) return false;
        let changed = false;
        for (const channel of this.guildChannels(guildId)) {
            let collection = null;
            try { collection = this.stores.message?.getMessages?.(String(channel.id)); } catch (_) {}
            let messages = [];
            try {
                if (Array.isArray(collection)) messages = collection;
                else if (typeof collection?.toArray === "function") messages = collection.toArray();
                else if (Array.isArray(collection?._array)) messages = collection._array;
                else if (collection?._map instanceof Map) messages = [...collection._map.values()];
            } catch (_) {}
            for (const message of messages) {
                const authorId = String(message?.author?.id || message?.author_id || message?.authorId || "");
                if (authorId !== selfId || !message?.id) continue;
                changed = this.recordOwnMessage(guildId, String(message.id), this.messageTime(message)) || changed;
            }
        }
        return changed;
    }

    myActivity(guildId) {
        const record = this.activityData.guilds[guildId] || {};
        const events = record.messages || [];
        const voice = record.voice || [];
        const now = Date.now();
        let score = 0, messages30d = 0, lastActive = 0;
        for (const event of events) {
            const ageDays = Math.max(0, (now - event.timestamp) / 86400000);
            if (ageDays <= 7) score += 5;
            else if (ageDays <= 30) score += 2;
            else if (ageDays <= 90) score += 0.5;
            if (ageDays <= 30) messages30d++;
            lastActive = Math.max(lastActive, event.timestamp);
        }
        for (const timestamp of voice) {
            const ageDays = Math.max(0, (now - timestamp) / 86400000);
            if (ageDays <= 7) score += 1;
            else if (ageDays <= 30) score += 0.4;
            else if (ageDays <= 90) score += 0.1;
            lastActive = Math.max(lastActive, timestamp);
        }
        return {score, messages30d, lastActive};
    }

    buildPlan(preset = this.settings.preset) {
        const byName = (a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"});
        if (preset === "custom") {
            const sorted = [...this.servers].sort(byName);
            const folders = this.settings.customFolders.map(folder => ({...folder, assignmentKey: folder.id, servers: [], guildIds: []}));
            const validIds = new Set(folders.map(folder => folder.id));
            const fallbackId = folders[0]?.id;
            const assignments = this.settings.manualAssignments.custom || {};
            for (const server of sorted) {
                const targetId = validIds.has(assignments[server.id]) ? assignments[server.id] : fallbackId;
                const folder = folders.find(item => item.id === targetId);
                if (!folder) continue;
                folder.servers.push(server);
                folder.guildIds.push(server.id);
            }
            return folders;
        }
        const thirtyDaysAgo = Date.now() - 30 * 86400000;
        const sorted = [...this.servers].sort(preset === "activity" ? (a, b) => b.myActivityScore - a.myActivityScore || b.myLastActive - a.myLastActive || byName(a, b) : byName);
        const definitions = preset === "activity" ? [
            ["Very active", server => server.myActivityScore >= 75],
            ["Active", server => server.myActivityScore >= 25],
            ["Sometimes", server => server.myLastActive >= thirtyDaysAgo],
            ["Barely active", server => server.myActivityScore > 0],
            ["No activity yet", () => true]
        ] : preset === "size" ? [
            ["Small · under 1K", server => server.memberCount > 0 && server.memberCount < 1000],
            ["Medium · 1K–10K", server => server.memberCount >= 1000 && server.memberCount < 10000],
            ["Large · 10K–100K", server => server.memberCount >= 10000 && server.memberCount < 100000],
            ["Huge · 100K+", server => server.memberCount >= 100000],
            ["Size unknown", () => true]
        ] : preset === "ownership" ? [
            ["My servers", server => server.owner],
            ["Joined servers", () => true]
        ] : [
            ["A–F", server => /^[a-f]/i.test(server.name)],
            ["G–L", server => /^[g-l]/i.test(server.name)],
            ["M–R", server => /^[m-r]/i.test(server.name)],
            ["S–Z", server => /^[s-z]/i.test(server.name)],
            ["Other", () => true]
        ];
        const allowedFolders = new Set(definitions.map(([name]) => name));
        const assignments = this.settings.manualAssignments[preset] || {};
        const unused = new Set(sorted.map(server => server.id));
        const folders = [];
        for (const [name, matches] of definitions) {
            const servers = sorted.filter(server => {
                if (!unused.has(server.id)) return false;
                const assigned = allowedFolders.has(assignments[server.id]) ? assignments[server.id] : "";
                return assigned ? assigned === name : matches(server);
            });
            if (!servers.length) continue;
            for (const server of servers) unused.delete(server.id);
            folders.push({name, assignmentKey: name, color: COLORS[folders.length % COLORS.length], servers, guildIds: servers.map(server => server.id)});
        }
        return folders;
    }

    folderOptions(preset = this.settings.preset) {
        if (preset === "custom") return this.settings.customFolders.map(folder => ({value: folder.id, label: folder.name}));
        const names = preset === "activity"
            ? ["Very active", "Active", "Sometimes", "Barely active", "No activity yet"]
            : preset === "size"
                ? ["Small · under 1K", "Medium · 1K–10K", "Large · 10K–100K", "Huge · 100K+", "Size unknown"]
                : preset === "ownership"
                    ? ["My servers", "Joined servers"]
                    : ["A–F", "G–L", "M–R", "S–Z", "Other"];
        return names.map(name => ({value: name, label: name}));
    }

    setManualAssignment(serverId, target) {
        const preset = this.settings.preset;
        const assignments = this.settings.manualAssignments[preset] ||= {};
        if (target) assignments[String(serverId)] = String(target);
        else delete assignments[String(serverId)];
        this.save("settings", this.settings);
        this.preview = this.buildPlan();
        this.renderPreview();
    }

    addCustomFolder(name) {
        const cleanName = String(name || "").trim().slice(0, 40);
        if (!cleanName) return false;
        if (this.settings.customFolders.some(folder => folder.name.toLowerCase() === cleanName.toLowerCase())) {
            this.toast("A custom folder already has that name.", "error");
            return false;
        }
        const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        this.settings.customFolders.push({id, name: cleanName, color: COLORS[this.settings.customFolders.length % COLORS.length]});
        this.save("settings", this.settings);
        this.preview = this.buildPlan("custom");
        this.renderPreview();
        return true;
    }

    renameCustomFolder(id, name) {
        const folder = this.settings.customFolders.find(item => item.id === id);
        const cleanName = String(name || "").trim().slice(0, 40);
        if (!folder || !cleanName) return false;
        folder.name = cleanName;
        this.save("settings", this.settings);
        this.preview = this.buildPlan("custom");
        this.renderPreview();
        return true;
    }

    deleteCustomFolder(id) {
        if (this.settings.customFolders.length <= 1) return this.toast("Custom mode needs at least one folder.", "error");
        this.settings.customFolders = this.settings.customFolders.filter(folder => folder.id !== id);
        const assignments = this.settings.manualAssignments.custom || {};
        for (const [guildId, folderId] of Object.entries(assignments)) if (folderId === id) delete assignments[guildId];
        this.save("settings", this.settings);
        this.preview = this.buildPlan("custom");
        this.renderPreview();
    }

    openManager() {
        this.closeManager();
        this.servers = this.scanServers();
        this.preview = this.buildPlan();
        const backdrop = this.el("div", {className: "tiny-sfs-backdrop"});
        const panel = this.el("section", {className: "tiny-sfs-modal", role: "dialog", "aria-modal": "true", "aria-label": "Server Folder Sorter"});
        const header = this.el("header", {className: "tiny-sfs-header"});
        const heading = this.el("div");
        heading.append(this.el("h1", {textContent: "Server Folder Sorter"}), this.el("p", {textContent: "Organize real Discord folders—including by how active you personally are"}));
        const close = this.el("button", {className: "tiny-sfs-close", type: "button", textContent: "×"});
        close.addEventListener("click", () => this.closeManager());
        header.append(heading, close);
        const controls = this.el("div", {className: "tiny-sfs-controls"});
        const select = this.el("select", {"aria-label": "Folder layout"});
        for (const [value, label] of [["alphabetical", "Alphabetical groups"], ["activity", "My activity"], ["size", "Server size"], ["ownership", "Owned vs joined"], ["custom", "Custom folders"]]) select.append(this.el("option", {value, textContent: label}));
        select.value = this.settings.preset;
        select.addEventListener("change", () => {
            this.settings.preset = select.value;
            this.save("settings", this.settings);
            this.preview = this.buildPlan(select.value);
            this.renderPreview();
        });
        const refresh = this.el("button", {type: "button", textContent: "Refresh preview"});
        refresh.addEventListener("click", () => { this.servers = this.scanServers(); this.preview = this.buildPlan(); this.renderPreview(); });
        const resetMoves = this.el("button", {type: "button", textContent: "Reset moves", title: "Return every server to automatic placement in this mode"});
        resetMoves.addEventListener("click", () => {
            delete this.settings.manualAssignments[this.settings.preset];
            this.save("settings", this.settings);
            this.preview = this.buildPlan();
            this.renderPreview();
        });
        const customTools = this.el("div", {className: "tiny-sfs-custom-tools"});
        const customName = this.el("input", {type: "text", maxLength: 40, placeholder: "New folder name", "aria-label": "New custom folder name"});
        const addCustom = this.el("button", {type: "button", textContent: "Add folder"});
        const createFolder = () => { if (this.addCustomFolder(customName.value)) customName.value = ""; };
        addCustom.addEventListener("click", createFolder);
        customName.addEventListener("keydown", event => { if (event.key === "Enter") createFolder(); });
        customTools.append(customName, addCustom);
        controls.append(select, refresh, resetMoves, customTools);
        const summary = this.el("div", {className: "tiny-sfs-summary"});
        const list = this.el("div", {className: "tiny-sfs-list"});
        const footer = this.el("footer", {className: "tiny-sfs-footer"});
        const restore = this.el("button", {className: "tiny-sfs-restore", type: "button", textContent: "Undo last sort", disabled: !this.load("backup")});
        restore.addEventListener("click", () => this.restoreBackup());
        const apply = this.el("button", {className: "tiny-sfs-apply", type: "button", textContent: "Apply folders"});
        apply.addEventListener("click", () => this.applyPreview());
        footer.append(restore, this.el("span", {textContent: "This replaces the current server-folder layout. Undo saves the layout from right before Apply."}), apply);
        panel.append(header, controls, summary, list, footer);
        backdrop.append(panel);
        backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) this.closeManager(); });
        document.addEventListener("keydown", this.escapeHandler = event => { if (event.key === "Escape" && !this.busy) this.closeManager(); }, true);
        document.body.append(backdrop);
        this.modal = backdrop;
        this.renderPreview();
    }

    renderPreview() {
        if (!this.modal) return;
        const list = this.modal.querySelector(".tiny-sfs-list");
        const summary = this.modal.querySelector(".tiny-sfs-summary");
        const apply = this.modal.querySelector(".tiny-sfs-apply");
        const customTools = this.modal.querySelector(".tiny-sfs-custom-tools");
        if (!list || !summary || !apply) return;
        if (customTools) customTools.hidden = this.settings.preset !== "custom";
        const nonEmptyFolders = this.preview.filter(folder => folder.guildIds.length);
        summary.textContent = this.settings.preset === "activity"
            ? `${this.servers.length} servers → ${nonEmptyFolders.length} folders · based on messages you send and time in voice channels`
            : `${this.servers.length} servers → ${nonEmptyFolders.length} folders · use each server's dropdown to move it`;
        apply.disabled = this.busy || !nonEmptyFolders.length;
        apply.textContent = this.busy ? "Applying…" : "Apply folders";
        list.textContent = "";
        for (const folder of this.preview) {
            const card = this.el("section", {className: "tiny-sfs-folder"});
            const top = this.el("div", {className: "tiny-sfs-folder-top"});
            const dot = this.el("span", {className: "tiny-sfs-dot"});
            dot.style.background = `#${folder.color.toString(16).padStart(6, "0")}`;
            if (this.settings.preset === "custom") {
                const nameInput = this.el("input", {className: "tiny-sfs-folder-name", type: "text", maxLength: 40, value: folder.name, "aria-label": "Custom folder name"});
                nameInput.addEventListener("change", () => this.renameCustomFolder(folder.id, nameInput.value));
                const remove = this.el("button", {className: "tiny-sfs-delete-folder", type: "button", textContent: "Delete", title: `Delete ${folder.name}`});
                remove.addEventListener("click", () => this.deleteCustomFolder(folder.id));
                top.append(dot, nameInput, this.el("span", {className: "tiny-sfs-folder-count", textContent: `${folder.servers.length} server${folder.servers.length === 1 ? "" : "s"}`}), remove);
            } else {
                top.append(dot, this.el("strong", {textContent: folder.name}), this.el("span", {className: "tiny-sfs-folder-count", textContent: `${folder.servers.length} server${folder.servers.length === 1 ? "" : "s"}`}));
            }
            const icons = this.el("div", {className: "tiny-sfs-servers"});
            for (const server of folder.servers) {
                const activityDetail = this.settings.preset === "activity" ? ` · ${server.myMessages30d} messages in the last 30 days${server.myLastActive ? ` · last active ${this.timeAgo(server.myLastActive)}` : ""}` : "";
                const item = this.el("div", {title: `${server.name}${activityDetail}`});
                if (server.icon) item.append(this.el("img", {src: server.icon, alt: ""}));
                else item.append(this.el("span", {textContent: this.initials(server.name)}));
                item.append(this.el("small", {textContent: server.name}));
                const assignment = this.el("select", {className: "tiny-sfs-server-folder", "aria-label": `Folder for ${server.name}`});
                const savedTarget = this.settings.manualAssignments[this.settings.preset]?.[server.id] || "";
                if (this.settings.preset !== "custom") assignment.append(this.el("option", {value: "", textContent: `Auto (${folder.name})`}));
                for (const option of this.folderOptions()) assignment.append(this.el("option", {value: option.value, textContent: option.label}));
                assignment.value = this.settings.preset === "custom" ? (savedTarget || folder.assignmentKey) : savedTarget;
                assignment.addEventListener("change", () => this.setManualAssignment(server.id, assignment.value));
                item.append(assignment);
                icons.append(item);
            }
            card.append(top, icons);
            list.append(card);
        }
    }

    async applyPreview() {
        if (this.busy || !this.preview.length) return;
        const current = this.captureLayout();
        if (current) this.save("backup", current);
        this.busy = true;
        this.renderPreview();
        try {
            await this.writeLayout(this.serializedPlan(this.preview));
            this.toast("Server folders sorted. Discord may take a moment to sync the icons.", "success");
            const restore = this.modal?.querySelector(".tiny-sfs-restore");
            if (restore) restore.disabled = false;
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not apply folder layout:`, error);
            this.toast(`Could not apply folders: ${error?.message || "Discord rejected the update"}`, "error");
        } finally {
            this.busy = false;
            this.renderPreview();
        }
    }

    async restoreBackup() {
        if (this.busy) return;
        const backup = this.load("backup");
        if (!backup?.guildPositions || !Array.isArray(backup.guildFolders)) return this.toast("No usable folder backup was found.", "error");
        this.busy = true;
        this.renderPreview();
        try {
            await this.writeLayout(backup);
            this.toast("Previous server-folder layout restored.", "success");
        } catch (error) {
            this.toast(`Could not restore folders: ${error?.message || "Discord rejected the update"}`, "error");
        } finally {
            this.busy = false;
            this.renderPreview();
        }
    }

    serializedPlan(folders) {
        const baseId = Date.now();
        const guildFolders = folders.filter(folder => folder.guildIds.length).map((folder, index) => ({
            id: baseId + index,
            name: folder.name,
            color: folder.color,
            guildIds: [...folder.guildIds]
        }));
        return {guildFolders, guildPositions: guildFolders.flatMap(folder => folder.guildIds)};
    }

    captureLayout() {
        try {
            const positions = this.currentPositions();
            const rawFolders = this.stores.sortedGuild?.getGuildFolders?.() || [];
            const guildFolders = this.normalizeCollection(rawFolders).filter(folder => folder?.folderId || folder?.id).map(folder => ({
                id: Number(folder.folderId ?? folder.id),
                name: String(folder.folderName ?? folder.name ?? ""),
                color: Number(folder.folderColor ?? folder.color ?? 0),
                guildIds: this.normalizeCollection(folder.guildIds || folder.guild_ids).map(String)
            })).filter(folder => folder.guildIds.length > 0);
            return positions.length ? {guildPositions: positions, guildFolders} : null;
        } catch (_) { return null; }
    }

    currentPositions() {
        try {
            const positions = this.stores.sortedGuild?.getFlattenedGuildIds?.() || this.stores.sortedGuild?.getGuildIds?.() || [];
            return this.normalizeCollection(positions).map(String);
        } catch (_) { return []; }
    }

    async writeLayout(layout) {
        if (typeof this.rest?.patch === "function") {
            const body = {
                guild_positions: layout.guildPositions.map(String),
                guild_folders: layout.guildFolders.map(folder => ({id: folder.id, name: folder.name, color: folder.color, guild_ids: folder.guildIds.map(String)}))
            };
            let requestError = null;
            try {
                const request = this.rest.patch({url: "/users/@me/settings", body, oldFormErrors: true, retries: 0});
                Promise.resolve(request).catch(error => { requestError = error; });
            } catch (error) { requestError = error; }
            if (await this.waitForLayout(layout, 7000)) return;
            if (requestError) throw requestError;
            throw new Error("Discord did not finish applying the folder layout. Reload Discord and try once more");
        }
        if (typeof this.settingsUpdater?.updateRemoteSettings === "function") {
            const nativeFolders = layout.guildFolders.map(folder => ({
                id: folder.id, folderId: folder.id,
                name: folder.name, folderName: folder.name,
                color: folder.color, folderColor: folder.color,
                guildIds: folder.guildIds.map(String)
            }));
            let requestError = null;
            try {
                const request = this.settingsUpdater.updateRemoteSettings({guildFolders: nativeFolders, guildPositions: layout.guildPositions.map(String)});
                Promise.resolve(request).catch(error => { requestError = error; });
            } catch (error) { requestError = error; }
            if (await this.waitForLayout(layout, 7000)) return;
            if (requestError) throw requestError;
        }
        throw new Error("Discord's folder updater was not found. Reload Discord and try again");
    }

    async waitForLayout(layout, milliseconds) {
        const deadline = Date.now() + milliseconds;
        do {
            if (this.layoutMatches(layout)) return true;
            await new Promise(resolve => setTimeout(resolve, 120));
        } while (Date.now() < deadline);
        return this.layoutMatches(layout);
    }

    layoutMatches(expected) {
        if (!this.positionsMatch(expected.guildPositions)) return false;
        try {
            const actual = this.normalizeCollection(this.stores.sortedGuild?.getGuildFolders?.() || []).map(folder => ({
                name: String(folder?.folderName ?? folder?.name ?? ""),
                guildIds: this.normalizeCollection(folder?.guildIds || folder?.guild_ids).map(String)
            }));
            const wanted = expected.guildFolders.map(folder => ({name: String(folder.name || ""), guildIds: folder.guildIds.map(String)}));
            return actual.length === wanted.length && wanted.every((folder, index) => {
                const current = actual[index];
                return current?.name === folder.name
                    && current.guildIds.length === folder.guildIds.length
                    && folder.guildIds.every((id, guildIndex) => id === current.guildIds[guildIndex]);
            });
        } catch (_) { return false; }
    }

    positionsMatch(expected) {
        const current = this.currentPositions();
        return current.length === expected.length && expected.every((id, index) => String(id) === String(current[index]));
    }

    closeManager() {
        if (this.escapeHandler) document.removeEventListener("keydown", this.escapeHandler, true);
        this.escapeHandler = null;
        this.modal?.remove();
        this.modal = null;
    }

    guildJoinedAt(guildId, selfId) {
        let member = null;
        try { member = this.stores.guildMember?.getMember?.(guildId, selfId); } catch (_) {}
        for (const value of [member?.joinedAt, member?.joined_at, member?.joinedAtTimestamp]) {
            const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
            if (Number.isFinite(time) && time > 0) return time;
        }
        return 0;
    }

    guildLastActivity(guildId) {
        let newest = 0;
        for (const channel of this.guildChannels(guildId)) {
            const ids = [channel?.lastMessageId, channel?.last_message_id];
            try { ids.push(this.stores.readState?.getLastMessageId?.(String(channel.id))); } catch (_) {}
            try {
                const messages = this.stores.message?.getMessages?.(String(channel.id));
                ids.push(messages?.last?.()?.id || messages?.toArray?.()?.at?.(-1)?.id || messages?._array?.at?.(-1)?.id);
            } catch (_) {}
            for (const id of ids) newest = Math.max(newest, this.snowflakeTime(id));
        }
        return newest;
    }

    guildChannels(guildId) {
        let source = null;
        try { source = this.stores.channel?.getMutableGuildChannelsForGuild?.(guildId) || this.stores.guildChannel?.getChannels?.(guildId); } catch (_) {}
        const found = new Map(), seen = new Set();
        const walk = (value, depth = 0) => {
            if (!value || depth > 5) return;
            if (typeof value === "object") { if (seen.has(value)) return; seen.add(value); }
            const channel = value?.channel || value;
            if (channel?.id && String(channel.guild_id || channel.guildId || "") === guildId) found.set(String(channel.id), channel);
            if (Array.isArray(value)) for (const child of value) walk(child, depth + 1);
            else if (value instanceof Map || value instanceof Set) for (const child of value.values()) walk(child, depth + 1);
            else if (typeof value === "object" && !channel?.id) for (const child of Object.values(value)) walk(child, depth + 1);
        };
        walk(source);
        return [...found.values()];
    }

    guildMemberCount(guild) {
        const direct = Number(guild?.memberCount ?? guild?.member_count ?? guild?.approximateMemberCount);
        if (Number.isFinite(direct) && direct >= 0) return direct;
        try { const value = Number(this.stores.memberCount?.getMemberCount?.(String(guild.id))); return Number.isFinite(value) ? value : 0; }
        catch (_) { return 0; }
    }

    guildIconUrl(guild) {
        try { const url = guild?.getIconURL?.(64, true); if (url) return url; } catch (_) {}
        if (!guild?.icon) return "";
        return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${String(guild.icon).startsWith("a_") ? "gif" : "webp"}?size=64`;
    }

    snowflakeTime(id) {
        if (!id) return 0;
        try { const time = Number((BigInt(String(id)) >> 22n) + DISCORD_EPOCH); return Number.isFinite(time) ? time : 0; }
        catch (_) { return 0; }
    }

    ageDays(timestamp) { return timestamp ? Math.max(0, (Date.now() - timestamp) / 86400000) : Infinity; }
    timeAgo(timestamp) {
        const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
        if (minutes < 1) return "just now";
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return days < 60 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
    }
    initials(name) { return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "?"; }

    getSettingsPanel() {
        const panel = this.el("div", {className: "tiny-sfs-settings"});
        panel.append(this.el("h2", {textContent: "Server Folder Sorter"}), this.el("p", {textContent: "Create and preview automatic server-folder layouts."}));
        const open = this.el("button", {className: "tiny-sfs-open", type: "button", textContent: "Open Folder Sorter"});
        open.addEventListener("click", () => this.openManager());
        const row = this.el("label", {className: "tiny-sfs-setting"});
        const input = this.el("input", {type: "checkbox"});
        input.checked = Boolean(this.settings.showQuickButton);
        input.addEventListener("change", () => { this.settings.showQuickButton = input.checked; this.save("settings", this.settings); this.ensureQuickButton(); });
        row.append(this.el("span", {textContent: "Show in Tiny Plugin Library"}), input);
        panel.append(open, row);
        return panel;
    }

    normalizeCollection(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (value instanceof Map || value instanceof Set) return [...value.values()];
        if (typeof value === "object") return Object.values(value);
        return [];
    }

    el(tag, properties = {}) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === "className") node.className = value;
            else if (key === "textContent") node.textContent = value;
            else if (key === "value") node.value = value;
            else if (key === "disabled") node.disabled = Boolean(value);
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        return node;
    }

    addStyles() {
        const css = `
            .tiny-sfs-button{position:fixed!important;right:6px!important;top:246px!important;z-index:1001!important;width:33px!important;height:27px!important;padding:0!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:7px!important;background:rgba(30,31,36,.76)!important;color:#b5bac1!important;opacity:.5!important;cursor:pointer!important;font:900 7px var(--font-primary,Arial,sans-serif)!important}.tiny-sfs-button:hover{opacity:1!important;background:#2b2d31!important;color:white!important}
            .tiny-sfs-backdrop{position:fixed!important;inset:0!important;z-index:2147483000!important;display:grid!important;place-items:center!important;padding:28px!important;background:rgba(0,0,0,.7)!important;backdrop-filter:blur(2px)!important;font-family:var(--font-primary,Arial,sans-serif)!important}.tiny-sfs-modal{display:flex!important;flex-direction:column!important;width:min(850px,96vw)!important;height:min(830px,93vh)!important;overflow:hidden!important;border:1px solid #36383e!important;border-radius:14px!important;background:#111214!important;color:#f2f3f5!important;box-shadow:0 24px 80px rgba(0,0,0,.62)!important}.tiny-sfs-header{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:18px 21px!important;border-bottom:1px solid #2e3035!important;background:#191a1e!important}.tiny-sfs-header h1{margin:0!important;font-size:21px!important}.tiny-sfs-header p{margin:4px 0 0!important;color:#949ba4!important;font-size:10px!important}.tiny-sfs-close{width:35px!important;height:35px!important;border:0!important;border-radius:6px!important;background:transparent!important;color:#b5bac1!important;font-size:27px!important;cursor:pointer!important}.tiny-sfs-close:hover{background:#2b2d31!important;color:white!important}
            .tiny-sfs-controls{display:flex!important;gap:8px!important;padding:13px 16px!important;border-bottom:1px solid #292b30!important}.tiny-sfs-controls select{min-width:220px!important;height:36px!important;padding:0 9px!important;border:1px solid #3a3c42!important;border-radius:7px!important;background:#26282d!important;color:#dbdee1!important}.tiny-sfs-controls button{height:36px!important;padding:0 11px!important;border:0!important;border-radius:6px!important;background:#303239!important;color:#dbdee1!important;font-size:9px!important;font-weight:700!important;cursor:pointer!important}.tiny-sfs-summary{padding:10px 17px!important;background:#15161a!important;color:#949ba4!important;font-size:9px!important}.tiny-sfs-list{flex:1!important;overflow:auto!important;padding:10px 12px!important}.tiny-sfs-folder{margin-bottom:9px!important;padding:12px!important;border:1px solid #2d2f34!important;border-radius:10px!important;background:#191a1e!important}.tiny-sfs-folder-top{display:flex!important;align-items:center!important;gap:8px!important;margin-bottom:10px!important}.tiny-sfs-folder-top strong{font-size:13px!important}.tiny-sfs-folder-top>span:last-child{margin-left:auto!important;color:#949ba4!important;font-size:9px!important}.tiny-sfs-dot{width:10px!important;height:10px!important;border-radius:50%!important}.tiny-sfs-servers{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))!important;gap:6px!important}.tiny-sfs-servers>div{display:flex!important;align-items:center!important;gap:7px!important;min-width:0!important;padding:6px!important;border-radius:6px!important;background:#121316!important}.tiny-sfs-servers img,.tiny-sfs-servers>div>span{display:grid!important;place-items:center!important;flex:none!important;width:27px!important;height:27px!important;border-radius:9px!important;background:#2b2d31!important;object-fit:cover!important;color:#dbdee1!important;font-size:8px!important;font-weight:900!important}.tiny-sfs-servers small{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;color:#c8cbd0!important;font-size:9px!important}.tiny-sfs-footer{display:flex!important;align-items:center!important;gap:12px!important;padding:12px 16px!important;border-top:1px solid #2e3035!important;background:#17181c!important}.tiny-sfs-footer span{min-width:0!important;flex:1!important;color:#949ba4!important;font-size:9px!important}.tiny-sfs-footer button{flex:none!important;padding:9px 12px!important;border:0!important;border-radius:5px!important;color:white!important;font-size:9px!important;font-weight:800!important;cursor:pointer!important}.tiny-sfs-restore{background:#3a3c43!important}.tiny-sfs-apply{background:#5865f2!important}.tiny-sfs-footer button:disabled{opacity:.4!important;cursor:not-allowed!important}
            .tiny-sfs-controls{flex-wrap:wrap!important}.tiny-sfs-custom-tools{display:flex!important;gap:8px!important;flex:1 1 250px!important}.tiny-sfs-custom-tools[hidden]{display:none!important}.tiny-sfs-custom-tools input,.tiny-sfs-folder-name{min-width:0!important;height:34px!important;padding:0 9px!important;border:1px solid #3a3c42!important;border-radius:6px!important;background:#101114!important;color:#f2f3f5!important}.tiny-sfs-custom-tools input{flex:1!important}.tiny-sfs-folder-name{width:180px!important;font-weight:700!important}.tiny-sfs-folder-count{margin-left:auto!important;color:#949ba4!important;font-size:9px!important}.tiny-sfs-delete-folder{height:28px!important;padding:0 8px!important;border:0!important;border-radius:5px!important;background:#3b1d22!important;color:#ff8a93!important;font-size:8px!important;font-weight:800!important;cursor:pointer!important}.tiny-sfs-servers{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))!important}.tiny-sfs-servers small{flex:1!important;min-width:0!important}.tiny-sfs-server-folder{flex:none!important;width:108px!important;height:29px!important;padding:0 5px!important;border:1px solid #34363c!important;border-radius:5px!important;background:#202226!important;color:#c8cbd0!important;font-size:8px!important}
            .tiny-sfs-settings{padding:8px 4px 30px!important;color:var(--text-normal)!important}.tiny-sfs-settings h2{margin:0 0 5px!important}.tiny-sfs-settings>p{margin:0 0 14px!important;color:var(--text-muted)!important}.tiny-sfs-open{margin:4px 0 15px!important;padding:9px 12px!important;border:0!important;border-radius:5px!important;background:#5865f2!important;color:white!important;font-weight:700!important;cursor:pointer!important}.tiny-sfs-setting{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:13px 0!important;border-top:1px solid var(--background-modifier-accent)!important;cursor:pointer!important}@media(max-width:650px){.tiny-sfs-backdrop{padding:7px!important}.tiny-sfs-modal{width:100%!important;height:97vh!important}.tiny-sfs-controls{flex-direction:column!important}.tiny-sfs-controls select{width:100%!important}.tiny-sfs-footer{align-items:stretch!important;flex-direction:column!important}.tiny-sfs-footer button{width:100%!important}}
        `;
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.addStyle) dom.addStyle(STYLE_ID, css);
        else if (globalThis.document?.head) { const style = document.createElement("style"); style.id = STYLE_ID; style.textContent = css; document.head.append(style); }
    }

    removeStyles() {
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.removeStyle) dom.removeStyle(STYLE_ID);
        document.getElementById(STYLE_ID)?.remove();
    }

    toast(message, type = "info") {
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showToast) ui.showToast(message, {type}); else console.log(`[${PLUGIN_NAME}] ${message}`);
    }
    load(key) { try { return this.api?.Data?.load ? this.api.Data.load(key) : globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key); } catch (_) { return undefined; } }
    save(key, value) { try { if (this.api?.Data?.save) this.api.Data.save(key, value); else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value); } catch (_) {} }
};
