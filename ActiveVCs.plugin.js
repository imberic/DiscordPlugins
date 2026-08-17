/**
 * @name ActiveVCs
 * @author tiny
 * @version 1.1.1
 * @description Shows active voice channels across your servers and lets you join them with one click.
 */

"use strict";

const PLUGIN_NAME = "ActiveVCs";
const STYLE_ID = "tiny-active-vcs-styles";

const DEFAULT_SETTINGS = Object.freeze({
    showQuickButton: true,
    showBots: true,
    currentServerFirst: true
});

const PERMISSIONS = Object.freeze({
    VIEW_CHANNEL: 1024n,
    CONNECT: 1048576n,
    MOVE_MEMBERS: 16777216n
});

module.exports = class ActiveVCs {
    constructor() {
        this.api = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.stores = {};
        this.voiceActions = null;
        this.started = false;
        this.quickButton = null;
        this.panel = null;
        this.entries = [];
        this.lastSignature = "";
        this.refreshTimer = null;
        this.pendingRefresh = null;
        this.filterMode = "all";
        this.onStoreChange = this.onStoreChange.bind(this);
        this.onDocumentMouseDown = this.onDocumentMouseDown.bind(this);
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.settings = this.sanitizeSettings(this.load("settings"));
        this.findModules();
        this.addStyles();
        this.subscribe();
        this.ensureQuickButton();
        this.refresh(true);
        this.refreshTimer = setInterval(() => this.refresh(), 2000);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        if (this.pendingRefresh) clearTimeout(this.pendingRefresh);
        this.refreshTimer = null;
        this.pendingRefresh = null;
        this.unsubscribe();
        this.closePanel();
        this.quickButton?.remove();
        this.quickButton = null;
        this.removeStyles();
    }

    initializeApi() {
        try {
            if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not initialize BdApi:`, error);
        }
    }

    sanitizeSettings(value) {
        const source = value && typeof value === "object" ? value : {};
        return {
            showQuickButton: source.showQuickButton ?? DEFAULT_SETTINGS.showQuickButton,
            showBots: source.showBots ?? DEFAULT_SETTINGS.showBots,
            currentServerFirst: source.currentServerFirst ?? DEFAULT_SETTINGS.currentServerFirst
        };
    }

    findModules() {
        const webpack = this.api?.Webpack || globalThis.BdApi?.Webpack;
        const getStore = name => {
            try { return webpack?.getStore?.(name) || null; }
            catch (error) { console.debug(`[${PLUGIN_NAME}] Could not find ${name}:`, error); return null; }
        };

        this.stores = {
            voiceState: getStore("VoiceStateStore"),
            guild: getStore("GuildStore"),
            guildChannel: getStore("GuildChannelStore"),
            channel: getStore("ChannelStore"),
            user: getStore("UserStore"),
            guildMember: getStore("GuildMemberStore"),
            permission: getStore("PermissionStore"),
            selectedGuild: getStore("SelectedGuildStore")
        };

        try {
            this.voiceActions = webpack?.getByKeys?.("selectVoiceChannel") ||
                webpack?.getModule?.(item => typeof item?.selectVoiceChannel === "function", {searchExports: true}) || null;
        } catch (error) {
            console.debug(`[${PLUGIN_NAME}] Could not find Discord's voice action:`, error);
        }

        if (!this.stores.voiceState || !this.stores.guild || (!this.stores.guildChannel && !this.stores.channel)) {
            this.toast("Discord's voice-channel data is unavailable. Reload Discord and try again.", "error");
        }
    }

    subscribe() {
        for (const store of Object.values(this.stores)) {
            try { store?.addChangeListener?.(this.onStoreChange); }
            catch (error) { console.debug(`[${PLUGIN_NAME}] Could not subscribe to a store:`, error); }
        }
    }

    unsubscribe() {
        for (const store of Object.values(this.stores)) {
            try { store?.removeChangeListener?.(this.onStoreChange); }
            catch (error) { console.debug(`[${PLUGIN_NAME}] Could not unsubscribe from a store:`, error); }
        }
    }

    onStoreChange() {
        if (this.pendingRefresh) return;
        this.pendingRefresh = setTimeout(() => {
            this.pendingRefresh = null;
            if (this.started) this.refresh();
        }, 60);
    }

    refresh(force = false) {
        const entries = this.scanActiveVoiceChannels();
        const signature = entries.map(entry => `${entry.channel.id}:${entry.members.map(member => member.id).sort().join(",")}:${entry.joinable}`).join("|");
        this.entries = entries;
        this.updateQuickButton();
        if (force || signature !== this.lastSignature) {
            this.lastSignature = signature;
            if (this.panel) this.renderPanel();
        }
    }

    scanActiveVoiceChannels() {
        const guilds = this.getGuilds();
        const currentGuildId = String(this.stores.selectedGuild?.getGuildId?.() || "");
        const entries = [];

        for (const guild of guilds) {
            const channels = this.getGuildChannels(guild.id);
            for (const channel of channels) {
                if (!this.isVoiceChannel(channel)) continue;
                const states = this.getVoiceStates(channel.id, guild.id);
                if (!states.length) continue;
                const members = states.map(state => this.getMember(state.userId, guild.id)).filter(Boolean);
                if (!members.length) continue;
                const displayedMembers = this.settings.showBots ? members : members.filter(member => !member.bot);
                const humans = members.filter(member => !member.bot).length;
                const bots = members.length - humans;
                const canView = this.can(PERMISSIONS.VIEW_CHANNEL, channel);
                const canConnect = this.can(PERMISSIONS.CONNECT, channel);
                if (!canView) continue;
                const limit = Number(channel.userLimit ?? channel.user_limit ?? 0) || 0;
                const full = limit > 0 && members.length >= limit && !this.can(PERMISSIONS.MOVE_MEMBERS, channel);
                if (!canConnect || full) continue;
                entries.push({
                    guild,
                    channel,
                    members: displayedMembers,
                    totalMembers: members.length,
                    humans,
                    bots,
                    limit,
                    full,
                    joinable: true,
                    currentGuild: String(guild.id) === currentGuildId
                });
            }
        }

        return this.sortEntries(entries, currentGuildId);
    }

    getGuilds() {
        try {
            const raw = this.stores.guild?.getGuilds?.() || {};
            return this.normalizeCollection(raw).filter(guild => guild?.id);
        } catch (error) {
            console.debug(`[${PLUGIN_NAME}] Could not read servers:`, error);
            return [];
        }
    }

    getGuildChannels(guildId) {
        let raw = null;
        try { raw = this.stores.guildChannel?.getChannels?.(guildId); }
        catch (error) { console.debug(`[${PLUGIN_NAME}] GuildChannelStore failed for ${guildId}:`, error); }
        if (!raw) {
            try { raw = this.stores.channel?.getMutableGuildChannelsForGuild?.(guildId); }
            catch (error) { console.debug(`[${PLUGIN_NAME}] ChannelStore failed for ${guildId}:`, error); }
        }
        return this.extractChannels(raw, guildId);
    }

    extractChannels(raw, guildId) {
        const found = new Map();
        const visited = new Set();
        const walk = (value, depth = 0) => {
            if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
            visited.add(value);
            const candidate = value.channel && typeof value.channel === "object" ? value.channel : value;
            const candidateGuildId = candidate.guild_id ?? candidate.guildId;
            if (candidate.id && candidate.type !== undefined && (!candidateGuildId || String(candidateGuildId) === String(guildId))) {
                found.set(String(candidate.id), candidate);
            }
            if (value instanceof Map) for (const child of value.values()) walk(child, depth + 1);
            else if (value instanceof Set || Array.isArray(value)) for (const child of value) walk(child, depth + 1);
            else for (const child of Object.values(value)) walk(child, depth + 1);
        };
        walk(raw);
        return [...found.values()];
    }

    isVoiceChannel(channel) {
        try { if (channel?.isGuildVoice?.()) return true; }
        catch (_) {}
        return Number(channel?.type) === 2;
    }

    getVoiceStates(channelId, guildId) {
        let raw = null;
        try { raw = this.stores.voiceState?.getVoiceStatesForChannel?.(channelId); }
        catch (_) {}
        let states = this.extractVoiceStates(raw, channelId, true);
        if (!states.length) {
            try { raw = this.stores.voiceState?.getVoiceStatesForGuild?.(guildId); }
            catch (_) {}
            states = this.extractVoiceStates(raw, channelId, false);
        }
        return states;
    }

    extractVoiceStates(raw, channelId, allowMissingChannel = false) {
        const found = new Map();
        const visited = new Set();
        const walk = (value, depth = 0, hintedUserId = null) => {
            if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
            visited.add(value);
            const userId = value.userId ?? value.user_id ?? hintedUserId;
            const stateChannelId = value.channelId ?? value.channel_id;
            const hasSession = value.sessionId || value.session_id;
            if (userId && (String(stateChannelId || "") === String(channelId) || (allowMissingChannel && !stateChannelId)) && (stateChannelId || hasSession)) {
                found.set(String(userId), {...value, userId: String(userId), channelId: String(channelId)});
            }
            if (value instanceof Map) {
                for (const [key, child] of value.entries()) walk(child, depth + 1, /^\d{10,}$/.test(String(key)) ? String(key) : hintedUserId);
            } else if (value instanceof Set || Array.isArray(value)) {
                for (const child of value) walk(child, depth + 1, hintedUserId);
            } else {
                for (const [key, child] of Object.entries(value)) walk(child, depth + 1, /^\d{10,}$/.test(key) ? key : hintedUserId);
            }
        };
        walk(raw);
        return [...found.values()];
    }

    getMember(userId, guildId) {
        if (!userId) return null;
        let user = null, guildMember = null;
        try { user = this.stores.user?.getUser?.(userId) || null; }
        catch (_) {}
        try { guildMember = this.stores.guildMember?.getMember?.(guildId, userId) || null; }
        catch (_) {}
        const name = guildMember?.nick || user?.globalName || user?.displayName || user?.username || `User ${String(userId).slice(-4)}`;
        return {
            id: String(userId),
            name,
            bot: Boolean(user?.bot),
            avatar: this.getAvatarUrl(user, guildId, userId)
        };
    }

    getAvatarUrl(user, guildId, userId) {
        try {
            const url = user?.getAvatarURL?.(guildId, 64, true) || user?.getAvatarURL?.(null, 64, true);
            if (url) return url;
        } catch (_) {}
        if (user?.avatar) {
            const format = String(user.avatar).startsWith("a_") ? "gif" : "webp";
            return `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${format}?size=64`;
        }
        const index = Number((BigInt(String(userId || 0)) >> 22n) % 6n);
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }

    can(permission, channel) {
        try {
            const result = this.stores.permission?.can?.(permission, channel);
            return result === undefined ? true : Boolean(result);
        } catch (_) {
            return true;
        }
    }

    sortEntries(entries, currentGuildId = "") {
        return [...entries].sort((a, b) => {
            if (this.settings.currentServerFirst && currentGuildId) {
                const currentDifference = Number(String(b.guild.id) === String(currentGuildId)) - Number(String(a.guild.id) === String(currentGuildId));
                if (currentDifference) return currentDifference;
            }
            return b.totalMembers - a.totalMembers ||
                String(a.guild.name).localeCompare(String(b.guild.name)) ||
                String(a.channel.name).localeCompare(String(b.channel.name));
        });
    }

    normalizeCollection(value) {
        if (!value) return [];
        if (value instanceof Map || value instanceof Set) return [...value.values()];
        if (Array.isArray(value)) return value;
        if (typeof value === "object") return Object.values(value);
        return [];
    }

    ensureQuickButton() {
        this.quickButton?.remove();
        this.quickButton = null;
        if (!this.settings.showQuickButton) return;
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.quickButton = library.register({id: "active-vcs", name: "Active VCs", description: "Voice channels you can join now", icon: "🎙️", order: 20, open: () => this.openPanel()});
        this.updateQuickButton();
    }

    updateQuickButton() {
        const count = this.entries.filter(entry => entry.joinable).length;
        this.quickButton?.update?.({badge: count > 99 ? "99+" : String(count), status: `${count} active voice channel${count === 1 ? "" : "s"}`});
    }

    openPanel() {
        this.closePanel();
        const panel = this.el("section", {className: "tiny-active-vcs-panel", role: "dialog", "aria-label": "Active voice channels"});
        const header = this.el("header", {className: "tiny-active-vcs-header"});
        const title = this.el("div");
        title.append(this.el("h2", {textContent: "Active Voice Channels"}), this.el("p", {className: "tiny-active-vcs-subtitle", textContent: "Voice chats you can join right now"}));
        const close = this.el("button", {className: "tiny-active-vcs-close", type: "button", textContent: "\u00D7", title: "Close"});
        close.addEventListener("click", () => this.closePanel());
        header.append(title, close);

        const controls = this.el("div", {className: "tiny-active-vcs-controls"});
        const search = this.el("input", {className: "tiny-active-vcs-search", type: "search", placeholder: "Search server, channel, or person...", "aria-label": "Search active voice channels"});
        search.addEventListener("input", () => this.renderPanel());
        const filter = this.el("select", {className: "tiny-active-vcs-filter", "aria-label": "Server filter"});
        filter.append(this.el("option", {value: "all", textContent: "All servers"}), this.el("option", {value: "current", textContent: "This server"}));
        filter.value = this.filterMode;
        filter.addEventListener("change", () => { this.filterMode = filter.value; this.renderPanel(); });
        controls.append(search, filter);

        panel.append(header, controls, this.el("div", {className: "tiny-active-vcs-list"}));
        panel.addEventListener("mousedown", event => event.stopPropagation());
        document.body.append(panel);
        this.panel = panel;
        document.addEventListener("mousedown", this.onDocumentMouseDown, true);
        this.refresh(true);
        search.focus();
    }

    renderPanel() {
        if (!this.panel) return;
        const list = this.panel.querySelector(".tiny-active-vcs-list");
        const search = this.panel.querySelector(".tiny-active-vcs-search");
        const filter = this.panel.querySelector(".tiny-active-vcs-filter");
        if (!list || !search || !filter) return;
        const scrollTop = list.scrollTop;
        const query = search.value.trim().toLowerCase();
        const visible = this.entries.filter(entry => {
            if (this.filterMode === "current" && !entry.currentGuild) return false;
            if (!query) return true;
            const names = entry.members.map(member => member.name).join(" ");
            return `${entry.guild.name} ${entry.channel.name} ${names}`.toLowerCase().includes(query);
        });

        const subtitle = this.panel.querySelector(".tiny-active-vcs-subtitle");
        if (subtitle) subtitle.textContent = `${visible.length} active voice chat${visible.length === 1 ? "" : "s"}`;
        list.replaceChildren();
        if (!visible.length) {
            list.append(this.el("div", {className: "tiny-active-vcs-empty", textContent: query ? "No active voice chats match your search." : "No active voice chats are available right now."}));
            return;
        }
        for (const entry of visible) list.append(this.buildChannelCard(entry));
        list.scrollTop = scrollTop;
    }

    buildChannelCard(entry) {
        const card = this.el("article", {className: "tiny-active-vcs-card"});
        const main = this.el("div", {className: "tiny-active-vcs-main"});
        const heading = this.el("div", {className: "tiny-active-vcs-card-heading"});
        heading.append(
            this.el("strong", {textContent: entry.channel.name || "Unnamed voice channel"}),
            this.el("span", {textContent: entry.guild.name || "Unknown server"})
        );
        const people = this.el("div", {className: "tiny-active-vcs-people"});
        const avatars = this.el("div", {className: "tiny-active-vcs-avatars"});
        for (const member of entry.members.slice(0, 5)) {
            const avatar = this.el("img", {src: member.avatar, alt: "", title: `${member.name}${member.bot ? " (bot)" : ""}`});
            avatars.append(avatar);
        }
        const hidden = Math.max(0, entry.members.length - 5);
        if (hidden) avatars.append(this.el("span", {className: "tiny-active-vcs-more", textContent: `+${hidden}`}));
        const memberNames = entry.members.length ? entry.members.slice(0, 4).map(member => member.name).join(", ") + (entry.members.length > 4 ? ` +${entry.members.length - 4}` : "") : `${entry.totalMembers} member${entry.totalMembers === 1 ? "" : "s"}`;
        const countText = `${entry.totalMembers}${entry.limit ? `/${entry.limit}` : ""}`;
        people.append(avatars, this.el("span", {className: "tiny-active-vcs-names", textContent: memberNames}), this.el("span", {className: "tiny-active-vcs-member-count", textContent: countText}));
        main.append(heading, people);

        const join = this.el("button", {className: "tiny-active-vcs-join", type: "button", textContent: entry.full ? "Full" : entry.joinable ? "Join" : "No access"});
        join.disabled = !entry.joinable;
        join.addEventListener("click", () => this.joinChannel(entry));
        card.append(main, join);
        return card;
    }

    async joinChannel(entry) {
        if (!entry?.joinable) return;
        const action = this.voiceActions?.selectVoiceChannel;
        if (typeof action !== "function") {
            this.toast("Discord's Join VC action was not found. Reload Discord and try again.", "error");
            return;
        }
        try {
            const result = action(entry.channel.id);
            if (result?.then) await result;
            this.toast(`Joining ${entry.channel.name} in ${entry.guild.name}...`, "success");
            this.closePanel();
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not join voice channel:`, error);
            this.toast("Discord could not join that voice channel.", "error");
        }
    }

    onDocumentMouseDown(event) {
        if (this.panel && !this.panel.contains(event.target)) this.closePanel();
    }

    closePanel() {
        document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
        this.panel?.remove();
        this.panel = null;
    }

    getSettingsPanel() {
        const panel = this.el("div", {className: "tiny-active-vcs-settings"});
        panel.append(this.el("h2", {textContent: "Active VCs"}), this.el("p", {textContent: "Shows voice channels that currently have people inside."}));
        panel.append(
            this.settingToggle("Show in Tiny Plugin Library", "showQuickButton", () => this.ensureQuickButton()),
            this.settingToggle("Show bots in the people list", "showBots", () => this.refresh(true)),
            this.settingToggle("Put the server I am viewing first", "currentServerFirst", () => this.refresh(true))
        );
        return panel;
    }

    settingToggle(label, key, afterChange) {
        const row = this.el("label", {className: "tiny-active-vcs-setting"});
        const input = this.el("input", {type: "checkbox"});
        input.checked = Boolean(this.settings[key]);
        input.addEventListener("change", () => {
            this.settings[key] = input.checked;
            this.save("settings", this.settings);
            afterChange?.();
        });
        row.append(this.el("span", {textContent: label}), input);
        return row;
    }

    el(tag, properties = {}) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === "className") node.className = value;
            else if (key === "textContent") node.textContent = value;
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        return node;
    }

    addStyles() {
        const css = `
            .tiny-active-vcs-button{position:fixed!important;right:6px!important;top:110px!important;z-index:1001!important;display:flex!important;align-items:center!important;gap:3px!important;height:27px!important;padding:0 5px!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:7px!important;background:rgba(30,31,36,.76)!important;color:#b5bac1!important;opacity:.52!important;cursor:pointer!important;font-family:var(--font-primary,Arial,sans-serif)!important;transition:.14s ease!important}.tiny-active-vcs-button:hover{opacity:1!important;background:#2b2d31!important}.tiny-active-vcs-icon{font-size:9px!important;font-weight:900!important}.tiny-active-vcs-count{display:grid!important;place-items:center!important;min-width:15px!important;height:15px!important;padding:0 3px!important;border-radius:8px!important;background:#23a55a!important;color:white!important;font-size:9px!important;font-weight:800!important}
            .tiny-active-vcs-panel{position:fixed!important;right:40px!important;top:104px!important;z-index:2147483000!important;display:flex!important;flex-direction:column!important;width:min(430px,calc(100vw - 56px))!important;max-height:min(680px,calc(100vh - 125px))!important;overflow:hidden!important;border:1px solid #36383e!important;border-radius:12px!important;background:#111214!important;color:#f2f3f5!important;box-shadow:0 18px 60px rgba(0,0,0,.55)!important;font-family:var(--font-primary,Arial,sans-serif)!important}
            .tiny-active-vcs-header{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:15px 16px 12px!important;border-bottom:1px solid #2e3035!important;background:#191a1e!important}.tiny-active-vcs-header h2{margin:0!important;font-size:17px!important}.tiny-active-vcs-header p{margin:3px 0 0!important;color:#949ba4!important;font-size:10px!important}.tiny-active-vcs-close{width:31px!important;height:31px!important;border:0!important;border-radius:6px!important;background:transparent!important;color:#b5bac1!important;font-size:24px!important;cursor:pointer!important}.tiny-active-vcs-close:hover{background:#2b2d31!important;color:white!important}
            .tiny-active-vcs-controls{display:flex!important;gap:7px!important;padding:10px 12px!important;border-bottom:1px solid #292b30!important}.tiny-active-vcs-search,.tiny-active-vcs-filter{height:34px!important;border:1px solid #3a3c42!important;border-radius:6px!important;background:#0d0e10!important;color:#f2f3f5!important;outline:none!important}.tiny-active-vcs-search{min-width:0!important;flex:1!important;padding:0 10px!important}.tiny-active-vcs-search:focus,.tiny-active-vcs-filter:focus{border-color:#5865f2!important}.tiny-active-vcs-filter{padding:0 7px!important;font-size:10px!important}
            .tiny-active-vcs-list{overflow:auto!important;padding:8px!important}.tiny-active-vcs-card{display:flex!important;align-items:center!important;gap:10px!important;margin-bottom:6px!important;padding:11px!important;border:1px solid #2d2f34!important;border-radius:9px!important;background:#191a1e!important}.tiny-active-vcs-card:hover{border-color:#41434a!important;background:#1d1e23!important}.tiny-active-vcs-main{min-width:0!important;flex:1!important}.tiny-active-vcs-card-heading{display:flex!important;align-items:baseline!important;gap:7px!important;min-width:0!important}.tiny-active-vcs-card-heading strong{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;font-size:13px!important}.tiny-active-vcs-card-heading span{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;color:#949ba4!important;font-size:9px!important}.tiny-active-vcs-people{display:flex!important;align-items:center!important;gap:8px!important;margin-top:8px!important;min-width:0!important}.tiny-active-vcs-avatars{display:flex!important;align-items:center!important;flex:none!important}.tiny-active-vcs-avatars img,.tiny-active-vcs-more{width:23px!important;height:23px!important;margin-left:-5px!important;border:2px solid #191a1e!important;border-radius:50%!important;background:#2b2d31!important;object-fit:cover!important}.tiny-active-vcs-avatars img:first-child{margin-left:0!important}.tiny-active-vcs-more{display:grid!important;place-items:center!important;color:#dbdee1!important;font-size:8px!important;font-weight:800!important}.tiny-active-vcs-names{min-width:0!important;flex:1!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;color:#b5bac1!important;font-size:10px!important}.tiny-active-vcs-member-count{flex:none!important;color:#949ba4!important;font-size:9px!important}.tiny-active-vcs-join{flex:none!important;padding:7px 12px!important;border:0!important;border-radius:5px!important;background:#248046!important;color:white!important;font-size:11px!important;font-weight:800!important;cursor:pointer!important}.tiny-active-vcs-join:hover{background:#1a6334!important}.tiny-active-vcs-join:disabled{background:#303239!important;color:#949ba4!important;cursor:not-allowed!important}.tiny-active-vcs-empty{padding:42px 20px!important;text-align:center!important;color:#949ba4!important;font-size:12px!important}
            .tiny-active-vcs-settings{padding:8px 4px 30px!important;color:var(--text-normal)!important}.tiny-active-vcs-settings h2{margin:0 0 5px!important}.tiny-active-vcs-settings>p{margin:0 0 15px!important;color:var(--text-muted)!important}.tiny-active-vcs-setting{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:13px 0!important;border-top:1px solid var(--background-modifier-accent)!important;cursor:pointer!important}
            @media(max-width:520px){.tiny-active-vcs-panel{right:8px!important;top:72px!important;width:calc(100vw - 16px)!important;max-height:calc(100vh - 82px)!important}.tiny-active-vcs-controls{flex-direction:column!important}.tiny-active-vcs-filter{width:100%!important}}
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

    load(key) {
        try { return this.api?.Data?.load ? this.api.Data.load(key) : globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key); }
        catch (_) { return undefined; }
    }

    save(key, value) {
        try {
            if (this.api?.Data?.save) this.api.Data.save(key, value);
            else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value);
        } catch (_) {}
    }

    toast(message, type = "info") {
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showToast) ui.showToast(message, {type, timeout: 4500});
        else console.log(`[${PLUGIN_NAME}] ${message}`);
    }
};
