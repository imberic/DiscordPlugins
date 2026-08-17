/**
 * @name ServerListCleanup
 * @author tiny
 * @version 1.2.1
 * @description Sort, search, review, and safely leave servers from one clean menu.
 */

"use strict";

const PLUGIN_NAME = "ServerListCleanup";
const STYLE_ID = "tiny-server-list-cleanup-styles";
const DISCORD_EPOCH = 1420070400000n;

const DEFAULT_SETTINGS = Object.freeze({
    showQuickButton: true,
    sortBy: "joined-new"
});

module.exports = class ServerListCleanup {
    constructor() {
        this.api = null;
        this.webpack = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.stores = {};
        this.guildActions = null;
        this.rest = null;
        this.quickButton = null;
        this.modal = null;
        this.servers = [];
        this.query = "";
        this.busyGuildId = "";
        this.selected = new Set();
        this.bulkBusy = false;
        this.started = false;
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.settings = this.sanitizeSettings(this.load("settings"));
        this.findModules();
        this.addStyles();
        this.ensureQuickButton();
    }

    stop() {
        this.started = false;
        this.busyGuildId = "";
        this.bulkBusy = false;
        this.selected.clear();
        this.closeManager();
        this.quickButton?.remove();
        this.quickButton = null;
        this.removeStyles();
    }

    initializeApi() {
        try { if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME); }
        catch (error) { console.warn(`[${PLUGIN_NAME}] Could not initialize BdApi:`, error); }
        this.webpack = this.api?.Webpack || globalThis.BdApi?.Webpack || null;
    }

    sanitizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const allowedSorts = new Set(["discord", "joined-new", "joined-old", "active-new", "active-old", "name", "members-high", "members-low"]);
        return {
            showQuickButton: source.showQuickButton ?? DEFAULT_SETTINGS.showQuickButton,
            sortBy: allowedSorts.has(source.sortBy) ? source.sortBy : DEFAULT_SETTINGS.sortBy
        };
    }

    findModules() {
        const getStore = name => {
            try { return this.webpack?.getStore?.(name) || null; }
            catch (_) { return null; }
        };
        this.stores = {
            guild: getStore("GuildStore"),
            guildMember: getStore("GuildMemberStore"),
            memberCount: getStore("GuildMemberCountStore"),
            channel: getStore("ChannelStore"),
            guildChannel: getStore("GuildChannelStore"),
            message: getStore("MessageStore"),
            readState: getStore("ReadStateStore"),
            sortedGuild: getStore("SortedGuildStore"),
            user: getStore("UserStore")
        };
        try {
            this.guildActions = this.webpack?.getByKeys?.("leaveGuild")
                || this.webpack?.getModule?.(value => typeof value?.leaveGuild === "function", {searchExports: true})
                || null;
        } catch (_) { this.guildActions = null; }
        try {
            this.rest = this.webpack?.getByKeys?.("get", "post", "put", "patch", "del")
                || this.webpack?.getModule?.(value => typeof value?.get === "function" && (typeof value?.del === "function" || typeof value?.delete === "function"), {searchExports: true})
                || null;
        } catch (_) { this.rest = null; }
        if (!this.stores.guild) this.toast("Discord's server list was not found. Reload Discord and try again.", "error");
    }

    ensureQuickButton() {
        this.quickButton?.remove();
        this.quickButton = null;
        if (!this.settings.showQuickButton) return;
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.quickButton = library.register({id: "server-list-cleanup", name: "Server List Cleanup", description: "Review and leave servers in bulk", icon: "🗑️", order: 60, open: () => this.openManager()});
    }

    scanServers() {
        let guilds = {};
        try { guilds = this.stores.guild?.getGuilds?.() || {}; }
        catch (error) { console.debug(`[${PLUGIN_NAME}] Could not scan servers:`, error); }
        const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
        const discordOrder = this.discordGuildOrder();
        const orderIndex = new Map(discordOrder.map((id, index) => [String(id), index]));
        return this.normalizeCollection(guilds).filter(guild => guild?.id).map(guild => {
            const id = String(guild.id);
            return {
                id,
                guild,
                name: String(guild.name || `Server ${id.slice(-4)}`),
                icon: this.guildIconUrl(guild),
                owner: Boolean(selfId && String(guild.ownerId || guild.owner_id || "") === selfId),
                joinedAt: this.guildJoinedAt(id, selfId),
                activeAt: this.guildLastActivity(id),
                memberCount: this.guildMemberCount(guild),
                discordPosition: orderIndex.has(id) ? orderIndex.get(id) : Number.MAX_SAFE_INTEGER
            };
        });
    }

    discordGuildOrder() {
        try {
            const ids = this.stores.sortedGuild?.getFlattenedGuildIds?.()
                || this.stores.sortedGuild?.getGuildIds?.()
                || [];
            return this.normalizeCollection(ids).map(String);
        } catch (_) { return []; }
    }

    guildJoinedAt(guildId, selfId) {
        if (!selfId) return 0;
        let member = null;
        try { member = this.stores.guildMember?.getMember?.(guildId, selfId) || null; }
        catch (_) {}
        const values = [member?.joinedAt, member?.joined_at, member?.joinedAtTimestamp, member?.joined_at_timestamp];
        for (const value of values) {
            const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value || "");
            if (Number.isFinite(time) && time > 0) return time;
        }
        return 0;
    }

    guildLastActivity(guildId) {
        let newest = 0;
        for (const channel of this.guildChannels(guildId)) {
            const ids = [channel?.lastMessageId, channel?.last_message_id];
            try { ids.push(this.stores.readState?.getLastMessageId?.(String(channel.id))); }
            catch (_) {}
            try {
                const messages = this.stores.message?.getMessages?.(String(channel.id));
                const last = messages?.last?.() || messages?.toArray?.()?.at?.(-1) || messages?._array?.at?.(-1);
                ids.push(last?.id);
            } catch (_) {}
            for (const id of ids) newest = Math.max(newest, this.snowflakeTime(id));
        }
        return newest;
    }

    guildChannels(guildId) {
        let source = null;
        try { source = this.stores.channel?.getMutableGuildChannelsForGuild?.(guildId); }
        catch (_) {}
        if (!source) {
            try { source = this.stores.guildChannel?.getChannels?.(guildId); }
            catch (_) {}
        }
        const found = new Map();
        const seen = new Set();
        const walk = (value, depth = 0) => {
            if (!value || depth > 5) return;
            if (typeof value === "object") {
                if (seen.has(value)) return;
                seen.add(value);
            }
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
        const direct = Number(guild?.memberCount ?? guild?.member_count ?? guild?.approximateMemberCount ?? guild?.approximate_member_count);
        if (Number.isFinite(direct) && direct >= 0) return direct;
        try {
            const stored = Number(this.stores.memberCount?.getMemberCount?.(String(guild.id)));
            return Number.isFinite(stored) && stored >= 0 ? stored : 0;
        } catch (_) { return 0; }
    }

    guildIconUrl(guild) {
        try {
            const url = guild?.getIconURL?.(64, true);
            if (url) return url;
        } catch (_) {}
        if (!guild?.icon) return "";
        const format = String(guild.icon).startsWith("a_") ? "gif" : "webp";
        return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${format}?size=64`;
    }

    snowflakeTime(id) {
        if (!id) return 0;
        try {
            const time = Number((BigInt(String(id)) >> 22n) + DISCORD_EPOCH);
            return Number.isFinite(time) && time > Number(DISCORD_EPOCH) ? time : 0;
        } catch (_) { return 0; }
    }

    openManager() {
        this.closeManager();
        this.servers = this.scanServers();
        this.query = "";
        this.selected.clear();

        const backdrop = this.el("div", {className: "tiny-slc-backdrop"});
        const panel = this.el("section", {className: "tiny-slc-modal", role: "dialog", "aria-modal": "true", "aria-label": "Server List Cleanup"});
        const header = this.el("header", {className: "tiny-slc-header"});
        const heading = this.el("div");
        heading.append(this.el("h1", {textContent: "Server List Cleanup"}), this.el("p", {textContent: "Sort every server, review the details, and leave the ones you no longer want"}));
        const close = this.el("button", {className: "tiny-slc-close", type: "button", textContent: "×", title: "Close"});
        close.addEventListener("click", () => this.closeManager());
        header.append(heading, close);

        const controls = this.el("div", {className: "tiny-slc-controls"});
        const search = this.el("input", {className: "tiny-slc-search", type: "search", placeholder: "Search servers…", "aria-label": "Search servers"});
        search.addEventListener("keydown", event => event.stopPropagation());
        search.addEventListener("input", () => { this.query = search.value.trim().toLowerCase(); this.renderServers(); });
        const sort = this.el("select", {className: "tiny-slc-sort", "aria-label": "Sort servers"});
        const options = [
            ["joined-new", "Recently joined"], ["joined-old", "Joined longest ago"],
            ["active-new", "Recently active"], ["active-old", "Inactive longest"],
            ["name", "Name A–Z"], ["members-high", "Most members"],
            ["members-low", "Fewest members"], ["discord", "Discord order"]
        ];
        for (const [value, label] of options) sort.append(this.el("option", {value, textContent: label}));
        sort.value = this.settings.sortBy;
        sort.addEventListener("change", () => {
            this.settings.sortBy = sort.value;
            this.save("settings", this.settings);
            this.renderServers();
        });
        const selection = this.el("div", {className: "tiny-slc-selection"});
        const selectShown = this.el("button", {type: "button", textContent: "Select all shown"});
        selectShown.addEventListener("click", () => {
            for (const server of this.visibleServers()) if (!server.owner) this.selected.add(server.id);
            this.renderServers();
        });
        const clearSelection = this.el("button", {type: "button", textContent: "Clear"});
        clearSelection.addEventListener("click", () => { this.selected.clear(); this.renderServers(); });
        selection.append(selectShown, clearSelection);
        controls.append(search, sort, selection);

        const summary = this.el("div", {className: "tiny-slc-summary"});
        const list = this.el("div", {className: "tiny-slc-list"});
        const footer = this.el("footer", {className: "tiny-slc-footer"});
        footer.append(
            this.el("span", {textContent: "Leaving is permanent until someone invites you back. Owned servers are protected."}),
            this.el("button", {className: "tiny-slc-leave-selected", type: "button", textContent: "Leave selected", disabled: true})
        );
        footer.querySelector("button").addEventListener("click", () => this.executeSelected());
        panel.append(header, controls, summary, list, footer);
        backdrop.append(panel);
        backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) this.closeManager(); });
        document.addEventListener("keydown", this.escapeHandler = event => { if (event.key === "Escape") this.closeManager(); }, true);
        document.body.append(backdrop);
        this.modal = backdrop;
        this.renderServers();
        setTimeout(() => search.focus(), 0);
    }

    closeManager() {
        if (this.escapeHandler) document.removeEventListener("keydown", this.escapeHandler, true);
        this.escapeHandler = null;
        this.modal?.remove();
        this.modal = null;
    }

    visibleServers() {
        const filtered = this.servers.filter(server => !this.query || server.name.toLowerCase().includes(this.query));
        const unknownLast = (a, b, direction) => {
            if (!a && !b) return 0;
            if (!a) return 1;
            if (!b) return -1;
            return direction * (a - b);
        };
        const name = (a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"});
        const comparators = {
            discord: (a, b) => a.discordPosition - b.discordPosition || name(a, b),
            "joined-new": (a, b) => unknownLast(a.joinedAt, b.joinedAt, -1) || name(a, b),
            "joined-old": (a, b) => unknownLast(a.joinedAt, b.joinedAt, 1) || name(a, b),
            "active-new": (a, b) => unknownLast(a.activeAt, b.activeAt, -1) || name(a, b),
            "active-old": (a, b) => unknownLast(a.activeAt, b.activeAt, 1) || name(a, b),
            name,
            "members-high": (a, b) => b.memberCount - a.memberCount || name(a, b),
            "members-low": (a, b) => a.memberCount - b.memberCount || name(a, b)
        };
        return [...filtered].sort(comparators[this.settings.sortBy] || comparators[DEFAULT_SETTINGS.sortBy]);
    }

    renderServers() {
        if (!this.modal) return;
        const list = this.modal.querySelector(".tiny-slc-list");
        const summary = this.modal.querySelector(".tiny-slc-summary");
        if (!list || !summary) return;
        const visible = this.visibleServers();
        const knownJoined = this.servers.filter(server => server.joinedAt).length;
        const selectedCount = this.servers.filter(server => this.selected.has(server.id) && !server.owner).length;
        summary.textContent = "";
        summary.append(
            this.el("strong", {textContent: `${visible.length} server${visible.length === 1 ? "" : "s"}`}),
            this.el("span", {textContent: this.query ? `${this.servers.length} total` : `${knownJoined} with a cached join date`}),
            this.el("span", {textContent: `${selectedCount} selected`})
        );
        const bulkButton = this.modal.querySelector(".tiny-slc-leave-selected");
        if (bulkButton) {
            bulkButton.textContent = this.bulkBusy ? `Leaving ${selectedCount} remaining…` : `Leave ${selectedCount || ""} selected`.replace("  ", " ");
            bulkButton.disabled = !selectedCount || this.bulkBusy || Boolean(this.busyGuildId);
        }
        list.textContent = "";
        if (!visible.length) {
            list.append(this.el("div", {className: "tiny-slc-empty", textContent: this.query ? "No servers match that search." : "No servers were found."}));
            return;
        }
        for (const server of visible) list.append(this.serverRow(server));
    }

    serverRow(server) {
        const row = this.el("article", {className: "tiny-slc-row", "data-guild-id": server.id});
        if (this.selected.has(server.id)) row.classList.add("selected");
        const checkbox = this.el("input", {className: "tiny-slc-check", type: "checkbox", disabled: server.owner || this.bulkBusy || Boolean(this.busyGuildId), "aria-label": `Select ${server.name}`});
        checkbox.checked = this.selected.has(server.id);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selected.add(server.id);
            else this.selected.delete(server.id);
            this.renderServers();
        });
        const iconWrap = this.el("div", {className: "tiny-slc-icon"});
        if (server.icon) iconWrap.append(this.el("img", {src: server.icon, alt: ""}));
        else iconWrap.append(this.el("span", {textContent: this.initials(server.name)}));
        const info = this.el("div", {className: "tiny-slc-info"});
        const title = this.el("div", {className: "tiny-slc-row-title"});
        title.append(this.el("strong", {textContent: server.name}));
        if (server.owner) title.append(this.el("span", {textContent: "OWNER"}));
        const details = this.el("div", {className: "tiny-slc-details"});
        details.append(
            this.detail("Joined", server.joinedAt ? this.formatDate(server.joinedAt) : "not cached"),
            this.detail("Active", server.activeAt ? this.timeAgo(server.activeAt) : "not cached"),
            this.detail("Members", server.memberCount ? server.memberCount.toLocaleString() : "unknown")
        );
        info.append(title, details);
        const leaving = this.busyGuildId === server.id;
        const leave = this.el("button", {
            className: "tiny-slc-leave",
            type: "button",
            textContent: server.owner ? "Owned" : leaving ? "Leaving…" : "Leave",
            disabled: server.owner || this.bulkBusy || Boolean(this.busyGuildId),
            title: server.owner ? "Transfer ownership or delete this server through Discord first" : `Leave ${server.name}`
        });
        leave.addEventListener("click", () => this.executeLeave(server));
        row.append(checkbox, iconWrap, info, leave);
        return row;
    }

    detail(label, value) {
        const node = this.el("span");
        node.append(this.el("small", {textContent: label}), document.createTextNode(value));
        return node;
    }

    async executeLeave(server) {
        if (this.busyGuildId || this.bulkBusy || server.owner) return false;
        this.busyGuildId = server.id;
        this.renderServers();
        try {
            await this.leaveServer(server.id);
            this.servers = this.servers.filter(item => item.id !== server.id);
            this.selected.delete(server.id);
            this.toast(`Left ${server.name}.`, "success");
            return true;
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not leave ${server.name}:`, error);
            this.toast(`Could not leave ${server.name}: ${error?.message || "Discord rejected the request"}`, "error");
            return false;
        } finally {
            this.busyGuildId = "";
            this.renderServers();
        }
    }

    async executeSelected() {
        if (this.bulkBusy || this.busyGuildId) return;
        const chosen = this.servers.filter(server => this.selected.has(server.id) && !server.owner);
        if (!chosen.length) return;
        this.bulkBusy = true;
        let completed = 0;
        const failures = [];
        this.renderServers();
        for (const server of chosen) {
            this.busyGuildId = server.id;
            this.renderServers();
            try {
                await this.leaveServer(server.id);
                completed++;
                this.selected.delete(server.id);
                this.servers = this.servers.filter(item => item.id !== server.id);
            } catch (error) {
                failures.push(`${server.name}: ${error?.message || "Discord rejected the request"}`);
                console.error(`[${PLUGIN_NAME}] Could not leave ${server.name}:`, error);
            }
            this.busyGuildId = "";
            this.renderServers();
            if (completed + failures.length < chosen.length) await new Promise(resolve => setTimeout(resolve, 500));
        }
        this.bulkBusy = false;
        this.renderServers();
        if (failures.length) this.toast(`Left ${completed}; ${failures.length} failed and stayed selected.`, "error");
        else this.toast(`Left all ${completed} selected servers.`, "success");
    }

    async leaveServer(guildId) {
        let nativeError = null;
        if (typeof this.guildActions?.leaveGuild === "function") {
            try {
                const result = this.guildActions.leaveGuild(guildId);
                if (result?.then) await result;
                if (await this.waitUntilGuildIsGone(guildId, 3500)) return;
            } catch (error) {
                nativeError = error;
                console.debug(`[${PLUGIN_NAME}] Native leave action failed:`, error);
            }
        }
        const remove = typeof this.rest?.del === "function" ? this.rest.del.bind(this.rest)
            : typeof this.rest?.delete === "function" ? this.rest.delete.bind(this.rest) : null;
        if (remove) {
            const result = await Promise.resolve(remove({url: `/users/@me/guilds/${guildId}`, body: {lurking: false}, oldFormErrors: true, retries: 2}));
            const status = Number(result?.status ?? result?.statusCode ?? result?.body?.status);
            if (Number.isFinite(status) && status >= 400) throw new Error(`Discord returned error ${status}`);
            if (await this.waitUntilGuildIsGone(guildId, 7000)) return;
            throw new Error("Discord accepted the request but kept the server in your list");
        }
        if (nativeError) throw nativeError;
        throw new Error("Discord's leave-server action is unavailable; reload Discord and try again");
    }

    guildStillExists(guildId) {
        try { return Boolean(this.stores.guild?.getGuild?.(guildId) || this.stores.guild?.getGuilds?.()?.[guildId]); }
        catch (_) { return true; }
    }

    async waitUntilGuildIsGone(guildId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        do {
            if (!this.guildStillExists(guildId)) return true;
            await new Promise(resolve => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        return !this.guildStillExists(guildId);
    }

    initials(name) {
        return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "?";
    }

    formatDate(timestamp) {
        try { return new Date(timestamp).toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"}); }
        catch (_) { return "unknown"; }
    }

    timeAgo(timestamp) {
        const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
        if (seconds < 60) return "just now";
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 60) return `${days}d ago`;
        const months = Math.floor(days / 30);
        if (months < 24) return `${months}mo ago`;
        return `${Math.floor(days / 365)}y ago`;
    }

    getSettingsPanel() {
        const panel = this.el("div", {className: "tiny-slc-settings"});
        panel.append(
            this.el("h2", {textContent: "Server List Cleanup"}),
            this.el("p", {textContent: "Open the manager or control its small on-screen button."})
        );
        const open = this.el("button", {className: "tiny-slc-open", type: "button", textContent: "Open Server Manager"});
        open.addEventListener("click", () => this.openManager());
        const setting = this.el("label", {className: "tiny-slc-setting"});
        const input = this.el("input", {type: "checkbox"});
        input.checked = Boolean(this.settings.showQuickButton);
        input.addEventListener("change", () => {
            this.settings.showQuickButton = input.checked;
            this.save("settings", this.settings);
            this.ensureQuickButton();
        });
        setting.append(this.el("span", {textContent: "Show in Tiny Plugin Library"}), input);
        panel.append(open, setting);
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
            .tiny-slc-button{position:fixed!important;right:6px!important;top:212px!important;z-index:1001!important;width:31px!important;height:27px!important;padding:0!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:7px!important;background:rgba(30,31,36,.76)!important;color:#b5bac1!important;opacity:.5!important;cursor:pointer!important;font:900 8px var(--font-primary,Arial,sans-serif)!important}.tiny-slc-button:hover{opacity:1!important;background:#2b2d31!important;color:white!important}
            .tiny-slc-backdrop{position:fixed!important;inset:0!important;z-index:2147483000!important;display:grid!important;place-items:center!important;padding:28px!important;background:rgba(0,0,0,.7)!important;backdrop-filter:blur(2px)!important;font-family:var(--font-primary,Arial,sans-serif)!important}.tiny-slc-modal{display:flex!important;flex-direction:column!important;width:min(820px,96vw)!important;height:min(820px,93vh)!important;overflow:hidden!important;border:1px solid #36383e!important;border-radius:14px!important;background:#111214!important;color:#f2f3f5!important;box-shadow:0 24px 80px rgba(0,0,0,.62)!important}
            .tiny-slc-header{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:18px 21px!important;border-bottom:1px solid #2e3035!important;background:#191a1e!important}.tiny-slc-header h1{margin:0!important;font-size:21px!important}.tiny-slc-header p{margin:4px 0 0!important;color:#949ba4!important;font-size:10px!important}.tiny-slc-close{width:35px!important;height:35px!important;border:0!important;border-radius:6px!important;background:transparent!important;color:#b5bac1!important;font-size:27px!important;cursor:pointer!important}.tiny-slc-close:hover{background:#2b2d31!important;color:white!important}
            .tiny-slc-controls{display:flex!important;align-items:center!important;gap:8px!important;padding:13px 15px!important;border-bottom:1px solid #292b30!important}.tiny-slc-search{min-width:0!important;flex:1!important;height:36px!important;box-sizing:border-box!important;padding:0 11px!important;border:1px solid #3a3c42!important;border-radius:7px!important;background:#0d0e10!important;color:#f2f3f5!important;outline:none!important}.tiny-slc-search:focus{border-color:#5865f2!important}.tiny-slc-sort{width:180px!important;height:36px!important;padding:0 9px!important;border:1px solid #3a3c42!important;border-radius:7px!important;background:#26282d!important;color:#dbdee1!important;outline:none!important;cursor:pointer!important}.tiny-slc-selection{display:flex!important;gap:5px!important}.tiny-slc-selection button{height:32px!important;padding:0 8px!important;border:0!important;border-radius:5px!important;background:#303239!important;color:#dbdee1!important;font-size:8px!important;font-weight:700!important;white-space:nowrap!important;cursor:pointer!important}.tiny-slc-selection button:hover{background:#404249!important;color:white!important}
            .tiny-slc-summary{display:flex!important;align-items:center!important;gap:14px!important;padding:10px 17px!important;background:#15161a!important;color:#949ba4!important;font-size:9px!important}.tiny-slc-summary strong{color:#f2f3f5!important;font-size:12px!important}.tiny-slc-list{flex:1!important;overflow:auto!important;padding:9px 12px!important}.tiny-slc-row{display:flex!important;align-items:center!important;gap:12px!important;margin-bottom:7px!important;padding:11px 12px!important;border:1px solid #2d2f34!important;border-radius:9px!important;background:#191a1e!important}.tiny-slc-row:hover{border-color:#41434a!important;background:#1d1e23!important}.tiny-slc-row.selected{border-color:rgba(88,101,242,.72)!important;background:#1c1e29!important}.tiny-slc-check{flex:none!important;width:15px!important;height:15px!important;accent-color:#5865f2!important;cursor:pointer!important}.tiny-slc-icon{display:grid!important;place-items:center!important;flex:none!important;width:42px!important;height:42px!important;border-radius:13px!important;overflow:hidden!important;background:#2b2d31!important;color:#dbdee1!important;font-size:11px!important;font-weight:900!important}.tiny-slc-icon img{width:100%!important;height:100%!important;object-fit:cover!important}.tiny-slc-info{min-width:0!important;flex:1!important}.tiny-slc-row-title{display:flex!important;align-items:center!important;gap:7px!important}.tiny-slc-row-title strong{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;font-size:13px!important}.tiny-slc-row-title span{padding:2px 5px!important;border-radius:4px!important;background:#7a4b16!important;color:#ffd9a3!important;font-size:7px!important;font-weight:900!important}.tiny-slc-details{display:flex!important;gap:15px!important;margin-top:7px!important;color:#b5bac1!important;font-size:9px!important}.tiny-slc-details>span{display:flex!important;gap:4px!important}.tiny-slc-details small{color:#737982!important;font:inherit!important}.tiny-slc-leave{flex:none!important;min-width:64px!important;height:31px!important;padding:0 10px!important;border:0!important;border-radius:5px!important;background:#da373c!important;color:white!important;font-size:9px!important;font-weight:800!important;cursor:pointer!important}.tiny-slc-leave:hover{background:#a1282c!important}.tiny-slc-leave:disabled{background:#3b3d43!important;color:#858b94!important;cursor:not-allowed!important}.tiny-slc-empty{display:grid!important;place-items:center!important;height:100%!important;min-height:260px!important;color:#949ba4!important;font-size:12px!important}.tiny-slc-footer{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;padding:11px 17px!important;border-top:1px solid #2e3035!important;background:#17181c!important;color:#949ba4!important;font-size:9px!important}.tiny-slc-leave-selected{flex:none!important;padding:9px 13px!important;border:0!important;border-radius:5px!important;background:#da373c!important;color:white!important;font-size:10px!important;font-weight:800!important;cursor:pointer!important}.tiny-slc-leave-selected:hover{background:#a1282c!important}.tiny-slc-leave-selected:disabled{opacity:.4!important;cursor:not-allowed!important}
            .tiny-slc-settings{padding:8px 4px 30px!important;color:var(--text-normal)!important}.tiny-slc-settings h2{margin:0 0 5px!important}.tiny-slc-settings>p{margin:0 0 14px!important;color:var(--text-muted)!important}.tiny-slc-open{margin:4px 0 15px!important;padding:9px 12px!important;border:0!important;border-radius:5px!important;background:#5865f2!important;color:white!important;font-weight:700!important;cursor:pointer!important}.tiny-slc-setting{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:13px 0!important;border-top:1px solid var(--background-modifier-accent)!important;cursor:pointer!important}
            @media(max-width:650px){.tiny-slc-backdrop{padding:7px!important}.tiny-slc-modal{width:100%!important;height:97vh!important}.tiny-slc-controls{align-items:stretch!important;flex-direction:column!important}.tiny-slc-sort{width:100%!important}.tiny-slc-selection button{flex:1!important}.tiny-slc-summary{flex-wrap:wrap!important}.tiny-slc-details{gap:5px!important;flex-direction:column!important}.tiny-slc-row{align-items:flex-start!important}.tiny-slc-leave{align-self:center!important}.tiny-slc-footer{align-items:flex-start!important;flex-direction:column!important}.tiny-slc-leave-selected{width:100%!important}}
        `;
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.addStyle) dom.addStyle(STYLE_ID, css);
        else if (globalThis.document?.head) {
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

    toast(message, type = "info") {
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showToast) ui.showToast(message, {type});
        else console.log(`[${PLUGIN_NAME}] ${message}`);
    }

    load(key) {
        try { return this.api?.Data?.load ? this.api.Data.load(key) : globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key); }
        catch (_) { return undefined; }
    }

    save(key, value) {
        try {
            if (this.api?.Data?.save) this.api.Data.save(key, value);
            else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value);
        } catch (error) { console.warn(`[${PLUGIN_NAME}] Could not save ${key}:`, error); }
    }
};
