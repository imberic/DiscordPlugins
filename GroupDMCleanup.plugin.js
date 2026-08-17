/**
 * @name GroupDMCleanup
 * @author tiny
 * @version 1.1.1
 * @description Finds old group DMs and lets you safely review and leave them in bulk.
 */

"use strict";

const PLUGIN_NAME = "GroupDMCleanup";
const STYLE_ID = "tiny-group-dm-cleanup-styles";
const DISCORD_EPOCH = 1420070400000n;

const DEFAULT_SETTINGS = Object.freeze({
    showQuickButton: true,
    olderThanDays: 90
});

module.exports = class GroupDMCleanup {
    constructor() {
        this.api = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.stores = {};
        this.rest = null;
        this.privateActions = null;
        this.quickButton = null;
        this.modal = null;
        this.groups = [];
        this.selected = new Set();
        this.started = false;
        this.busy = false;
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
        this.busy = false;
        this.closeCleanup();
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
        const days = Number(source.olderThanDays);
        return {
            showQuickButton: source.showQuickButton ?? DEFAULT_SETTINGS.showQuickButton,
            olderThanDays: Number.isFinite(days) ? Math.max(1, Math.min(3650, Math.round(days))) : DEFAULT_SETTINGS.olderThanDays
        };
    }

    findModules() {
        const webpack = this.api?.Webpack || globalThis.BdApi?.Webpack;
        const getStore = name => {
            try { return webpack?.getStore?.(name) || null; }
            catch (error) { console.debug(`[${PLUGIN_NAME}] Could not find ${name}:`, error); return null; }
        };
        this.stores = {
            channel: getStore("ChannelStore"),
            user: getStore("UserStore")
        };
        try {
            this.privateActions = webpack?.getByKeys?.("closePrivateChannel", "openPrivateChannel") ||
                webpack?.getByKeys?.("closePrivateChannel") ||
                webpack?.getByKeys?.("leaveGroupDM") || null;
        } catch (_) {}
        try {
            this.rest = webpack?.getByKeys?.("get", "post", "put", "patch", "del") ||
                webpack?.getModule?.(module => typeof module?.get === "function" && typeof module?.post === "function" && (typeof module?.del === "function" || typeof module?.delete === "function"), {searchExports: true}) || null;
        } catch (error) {
            console.debug(`[${PLUGIN_NAME}] Could not find Discord's request module:`, error);
        }
        if (!this.stores.channel) this.toast("Discord's group DM list was not found. Reload Discord and try again.", "error");
    }

    ensureQuickButton() {
        this.quickButton?.remove();
        this.quickButton = null;
        if (!this.settings.showQuickButton) return;
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.quickButton = library.register({id: "group-dm-cleanup", name: "Group DM Cleanup", description: "Review and leave old group DMs", icon: "👥", order: 50, open: () => this.openCleanup()});
    }

    scanGroups(now = Date.now()) {
        let raw = null;
        try { raw = this.stores.channel?.getMutablePrivateChannels?.() || this.stores.channel?.getSortedPrivateChannels?.() || {}; }
        catch (error) { console.debug(`[${PLUGIN_NAME}] Could not scan private channels:`, error); }
        const seen = new Set();
        const groups = [];
        for (const value of this.normalizeCollection(raw)) {
            const channel = value?.channel || value;
            if (!this.isGroupDM(channel) || seen.has(String(channel.id))) continue;
            seen.add(String(channel.id));
            const lastActivity = this.getLastActivity(channel);
            const ageDays = Math.max(0, Math.floor((now - lastActivity) / 86400000));
            groups.push({
                id: String(channel.id),
                channel,
                name: this.getGroupName(channel),
                recipients: this.getRecipients(channel),
                lastActivity,
                ageDays,
                old: ageDays >= this.settings.olderThanDays,
                managed: Boolean(channel.managed)
            });
        }
        return groups.sort((a, b) => a.lastActivity - b.lastActivity || a.name.localeCompare(b.name));
    }

    isGroupDM(channel) {
        if (!channel?.id) return false;
        try { if (channel.isGroupDM?.()) return true; }
        catch (_) {}
        return Number(channel.type) === 3;
    }

    getLastActivity(channel) {
        const lastId = channel?.lastMessageId || channel?.last_message_id;
        if (lastId) return this.snowflakeTime(lastId);
        return this.snowflakeTime(channel?.id);
    }

    snowflakeTime(id) {
        try {
            const timestamp = Number((BigInt(String(id || 0)) >> 22n) + DISCORD_EPOCH);
            return Number.isFinite(timestamp) && timestamp > Number(DISCORD_EPOCH) ? timestamp : Date.now();
        } catch (_) {
            return Date.now();
        }
    }

    getRecipients(channel) {
        const values = this.normalizeCollection(channel?.recipients);
        const recipients = [];
        for (const value of values) {
            const userId = String(value?.id || value || "");
            if (!userId) continue;
            let user = typeof value === "object" ? value : null;
            try { user = this.stores.user?.getUser?.(userId) || user; }
            catch (_) {}
            recipients.push({
                id: userId,
                name: user?.globalName || user?.displayName || user?.username || `User ${userId.slice(-4)}`,
                avatar: this.getAvatarUrl(user, userId)
            });
        }
        return recipients;
    }

    getGroupName(channel) {
        if (channel?.name) return String(channel.name);
        const recipients = this.getRecipients(channel);
        if (!recipients.length) return "Unnamed Group DM";
        const names = recipients.slice(0, 4).map(user => user.name).join(", ");
        return recipients.length > 4 ? `${names} +${recipients.length - 4}` : names;
    }

    getAvatarUrl(user, userId) {
        try {
            const url = user?.getAvatarURL?.(null, 64, true);
            if (url) return url;
        } catch (_) {}
        if (user?.avatar) {
            const format = String(user.avatar).startsWith("a_") ? "gif" : "webp";
            return `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.${format}?size=64`;
        }
        let index = 0;
        try { index = Number((BigInt(String(userId || 0)) >> 22n) % 6n); }
        catch (_) {}
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }

    openCleanup() {
        if (this.busy) return;
        this.closeCleanup();
        this.groups = this.scanGroups();
        this.selected = new Set(this.groups.filter(group => group.old).map(group => group.id));

        const backdrop = this.el("div", {className: "tiny-gdmc-backdrop"});
        const panel = this.el("section", {className: "tiny-gdmc-modal", role: "dialog", "aria-modal": "true", "aria-label": "Group DM Cleanup"});
        const header = this.el("header", {className: "tiny-gdmc-header"});
        const title = this.el("div");
        title.append(this.el("h1", {textContent: "Group DM Cleanup"}), this.el("p", {textContent: "Review old group chats before leaving them"}));
        const close = this.el("button", {className: "tiny-gdmc-close", type: "button", textContent: "\u00D7", title: "Close"});
        close.addEventListener("click", () => this.closeCleanup());
        header.append(title, close);

        const controls = this.el("div", {className: "tiny-gdmc-controls"});
        const cutoffLabel = this.el("label", {className: "tiny-gdmc-cutoff"});
        cutoffLabel.append(this.el("span", {textContent: "Show group DMs inactive for at least"}));
        const input = this.el("input", {type: "number", min: "1", max: "3650", value: String(this.settings.olderThanDays), "aria-label": "Inactive days"});
        cutoffLabel.append(input, this.el("span", {textContent: "days"}));
        input.addEventListener("change", () => {
            this.settings.olderThanDays = Math.max(1, Math.min(3650, Math.round(Number(input.value) || 90)));
            input.value = String(this.settings.olderThanDays);
            this.save("settings", this.settings);
            this.groups = this.scanGroups();
            this.selected = new Set(this.groups.filter(group => group.old).map(group => group.id));
            this.renderGroups();
        });
        const selection = this.el("div", {className: "tiny-gdmc-selection"});
        const all = this.el("button", {type: "button", textContent: "Select all old groups"});
        all.addEventListener("click", () => { this.selected = new Set(this.groups.filter(group => group.old).map(group => group.id)); this.renderGroups(); });
        const none = this.el("button", {type: "button", textContent: "Clear selection"});
        none.addEventListener("click", () => { this.selected.clear(); this.renderGroups(); });
        selection.append(all, none);
        controls.append(cutoffLabel, selection);

        const summary = this.el("div", {className: "tiny-gdmc-summary"});
        const list = this.el("div", {className: "tiny-gdmc-list"});
        const footer = this.el("footer", {className: "tiny-gdmc-footer"});
        const warning = this.el("label", {className: "tiny-gdmc-understand"});
        const understand = this.el("input", {type: "checkbox"});
        warning.append(understand, this.el("span", {textContent: "I understand I may need to be invited again to rejoin these group DMs."}));
        const leave = this.el("button", {className: "tiny-gdmc-leave", type: "button", textContent: "Leave Selected Group DMs", disabled: "true"});
        understand.addEventListener("change", () => { leave.disabled = !understand.checked || !this.selected.size || this.busy; });
        leave.addEventListener("click", () => this.confirmLeave());
        footer.append(warning, leave);
        panel.append(header, controls, summary, list, footer);
        backdrop.append(panel);
        backdrop.addEventListener("mousedown", event => { if (event.target === backdrop) this.closeCleanup(); });
        document.body.append(backdrop);
        this.modal = backdrop;
        this.renderGroups();
    }

    renderGroups() {
        if (!this.modal) return;
        const list = this.modal.querySelector(".tiny-gdmc-list");
        const summary = this.modal.querySelector(".tiny-gdmc-summary");
        const leave = this.modal.querySelector(".tiny-gdmc-leave");
        const understand = this.modal.querySelector(".tiny-gdmc-understand input");
        if (!list || !summary || !leave) return;
        const oldGroups = this.groups.filter(group => group.old);
        const recentCount = this.groups.length - oldGroups.length;
        summary.replaceChildren(
            this.el("strong", {textContent: `${oldGroups.length} old group DM${oldGroups.length === 1 ? "" : "s"}`}),
            this.el("span", {textContent: `${this.selected.size} selected`}),
            this.el("span", {textContent: `${recentCount} newer group${recentCount === 1 ? "" : "s"} safely ignored`})
        );
        list.replaceChildren();
        if (!oldGroups.length) {
            list.append(this.el("div", {className: "tiny-gdmc-empty", textContent: `No group DMs have been inactive for ${this.settings.olderThanDays} days.`}));
        } else {
            for (const group of oldGroups) list.append(this.buildGroupRow(group));
        }
        leave.textContent = this.selected.size ? `Leave ${this.selected.size} Selected Group DM${this.selected.size === 1 ? "" : "s"}` : "Select Group DMs to Leave";
        leave.disabled = !understand?.checked || !this.selected.size || this.busy || (!this.rest && !this.privateActions);
    }

    buildGroupRow(group) {
        const row = this.el("label", {className: `tiny-gdmc-row${this.selected.has(group.id) ? " selected" : ""}`});
        const checkbox = this.el("input", {type: "checkbox"});
        checkbox.checked = this.selected.has(group.id);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selected.add(group.id);
            else this.selected.delete(group.id);
            this.renderGroups();
        });
        const avatars = this.el("div", {className: "tiny-gdmc-avatars"});
        for (const recipient of group.recipients.slice(0, 3)) avatars.append(this.el("img", {src: recipient.avatar, alt: "", title: recipient.name}));
        if (!group.recipients.length) avatars.append(this.el("span", {textContent: "GC"}));
        const info = this.el("div", {className: "tiny-gdmc-info"});
        const heading = this.el("div", {className: "tiny-gdmc-row-heading"});
        heading.append(this.el("strong", {textContent: group.name}));
        if (group.managed) heading.append(this.el("span", {textContent: "APP MANAGED"}));
        const people = group.recipients.length ? group.recipients.map(user => user.name).join(", ") : "Recipients unavailable";
        info.append(heading, this.el("p", {textContent: people}), this.el("time", {textContent: `Last active ${this.formatAge(group.ageDays)} - ${new Date(group.lastActivity).toLocaleDateString()}`}));
        row.append(checkbox, avatars, info);
        return row;
    }

    formatAge(days) {
        if (days < 1) return "today";
        if (days === 1) return "1 day ago";
        if (days < 60) return `${days} days ago`;
        const months = Math.floor(days / 30);
        if (months < 24) return `${months} months ago`;
        const years = Math.floor(days / 365);
        return `${years} year${years === 1 ? "" : "s"} ago`;
    }

    confirmLeave() {
        if (this.busy || !this.selected.size) return;
        const chosen = this.groups.filter(group => this.selected.has(group.id));
        const run = () => this.executeLeave(chosen);
        const message = `You are about to leave ${chosen.length} group DM${chosen.length === 1 ? "" : "s"}. This plugin cannot undo it, and someone may need to invite you again.`;
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showConfirmationModal) ui.showConfirmationModal("Leave selected group DMs?", message, {danger: true, confirmText: `Leave ${chosen.length} Group${chosen.length === 1 ? "" : "s"}`, cancelText: "Cancel", onConfirm: run});
        else if (globalThis.confirm?.(message)) run();
    }

    async executeLeave(groups) {
        if (this.busy || !groups.length) return;
        this.busy = true;
        let completed = 0;
        const failures = [];
        const failedIds = new Set();
        this.setBusy(`Leaving 0 of ${groups.length}\u2026`);
        for (const group of groups) {
            try {
                await this.leaveGroup(group.id);
                completed++;
                this.selected.delete(group.id);
            } catch (error) {
                failedIds.add(group.id);
                failures.push(`${group.name}: ${error?.message || "Unknown error"}`);
            }
            this.setBusy(`Leaving ${completed + failures.length} of ${groups.length}\u2026`);
            if (completed + failures.length < groups.length) await new Promise(resolve => setTimeout(resolve, 450));
        }
        this.busy = false;
        const successfulIds = new Set(groups.filter(group => !failedIds.has(group.id)).map(group => group.id));
        this.groups = this.scanGroups().filter(group => !successfulIds.has(group.id));
        this.setBusy("");
        this.renderGroups();
        if (failures.length === 1) this.toast(failures[0], "error");
        else if (failures.length) this.toast(`Left ${completed} group DMs; ${failures.length} failed. Check the console for details.`, "error");
        else this.toast(`Left all ${completed} selected group DMs.`, "success");
        if (failures.length) console.error(`[${PLUGIN_NAME}] Group DM leave failures:`, failures);
    }

    async leaveGroup(channelId) {
        const nativeAction = this.getNativeLeaveAction();
        let nativeError = null;
        if (nativeAction) {
            try {
                const result = nativeAction(channelId);
                if (result?.then) await result;
                if (await this.waitUntilGroupIsGone(channelId, 2500)) return;
            } catch (error) {
                nativeError = error;
                console.debug(`[${PLUGIN_NAME}] Native leave action failed for ${channelId}:`, error);
            }
        }

        const deleteMethod = typeof this.rest?.del === "function" ? this.rest.del.bind(this.rest) : typeof this.rest?.delete === "function" ? this.rest.delete.bind(this.rest) : null;
        if (deleteMethod) {
            try {
                const result = await Promise.resolve(deleteMethod({url: `/channels/${channelId}`, oldFormErrors: true, retries: 2}));
                const status = Number(result?.status ?? result?.statusCode ?? result?.body?.status);
                if (Number.isFinite(status) && status >= 400) throw new Error(`Discord returned error ${status}`);
            } catch (error) {
                if (await this.waitUntilGroupIsGone(channelId, 1500)) return;
                throw error;
            }
            if (await this.waitUntilGroupIsGone(channelId, 7000)) return;
            throw new Error("Discord accepted the request but kept the group DM open");
        }
        if (nativeError) throw nativeError;
        throw new Error(nativeAction ? "Discord kept the group DM open" : "Discord's leave-group action is unavailable");
    }

    getNativeLeaveAction() {
        for (const name of ["closePrivateChannel", "leaveGroupDM"]) {
            if (typeof this.privateActions?.[name] === "function") return this.privateActions[name].bind(this.privateActions);
        }
        return null;
    }

    isGroupStillOpen(channelId) {
        try {
            const raw = this.stores.channel?.getMutablePrivateChannels?.() || this.stores.channel?.getSortedPrivateChannels?.() || {};
            return this.normalizeCollection(raw).some(value => {
                const channel = value?.channel || value;
                return String(channel?.id || "") === String(channelId) && this.isGroupDM(channel);
            });
        } catch (_) {
            try { return this.isGroupDM(this.stores.channel?.getChannel?.(channelId)); }
            catch (_) { return true; }
        }
    }

    async waitUntilGroupIsGone(channelId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        do {
            if (!this.isGroupStillOpen(channelId)) return true;
            await new Promise(resolve => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        return !this.isGroupStillOpen(channelId);
    }

    setBusy(text) {
        if (!this.modal) return;
        for (const control of this.modal.querySelectorAll("button, input")) control.disabled = this.busy;
        let progress = this.modal.querySelector(".tiny-gdmc-progress");
        if (!progress) {
            progress = this.el("div", {className: "tiny-gdmc-progress"});
            this.modal.querySelector(".tiny-gdmc-footer")?.prepend(progress);
        }
        progress.textContent = text;
    }

    closeCleanup() {
        if (this.busy) return;
        this.modal?.remove();
        this.modal = null;
        this.groups = [];
        this.selected.clear();
    }

    getSettingsPanel() {
        const panel = this.el("div", {className: "tiny-gdmc-settings"});
        panel.append(this.el("h2", {textContent: "Group DM Cleanup"}), this.el("p", {textContent: "Nothing is left automatically. Open the cleanup screen to review and confirm every group."}));
        const open = this.el("button", {className: "tiny-gdmc-open", type: "button", textContent: "Review Old Group DMs"});
        open.addEventListener("click", () => this.openCleanup());
        const quick = this.el("label", {className: "tiny-gdmc-setting"});
        const input = this.el("input", {type: "checkbox"});
        input.checked = this.settings.showQuickButton;
        input.addEventListener("change", () => {
            this.settings.showQuickButton = input.checked;
            this.save("settings", this.settings);
            this.ensureQuickButton();
        });
        quick.append(this.el("span", {textContent: "Show in Tiny Plugin Library"}), input);
        panel.append(open, quick);
        return panel;
    }

    normalizeCollection(value) {
        if (!value) return [];
        if (value instanceof Map || value instanceof Set) return [...value.values()];
        if (Array.isArray(value)) return value;
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
            .tiny-gdmc-button{position:fixed!important;right:6px!important;top:178px!important;z-index:1001!important;width:29px!important;height:27px!important;padding:0!important;border:1px solid rgba(255,255,255,.08)!important;border-radius:7px!important;background:rgba(30,31,36,.76)!important;color:#b5bac1!important;opacity:.5!important;cursor:pointer!important;font-size:9px!important;font-weight:900!important;font-family:var(--font-primary,Arial,sans-serif)!important}.tiny-gdmc-button:hover{opacity:1!important;background:#2b2d31!important}
            .tiny-gdmc-backdrop{position:fixed!important;inset:0!important;z-index:2147483000!important;display:grid!important;place-items:center!important;padding:30px!important;background:rgba(0,0,0,.7)!important;backdrop-filter:blur(2px)!important;font-family:var(--font-primary,Arial,sans-serif)!important}.tiny-gdmc-modal{display:flex!important;flex-direction:column!important;width:min(760px,95vw)!important;height:min(800px,92vh)!important;overflow:hidden!important;border:1px solid #36383e!important;border-radius:13px!important;background:#111214!important;color:#f2f3f5!important;box-shadow:0 24px 80px rgba(0,0,0,.6)!important}
            .tiny-gdmc-header{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:18px 21px!important;border-bottom:1px solid #2e3035!important;background:#191a1e!important}.tiny-gdmc-header h1{margin:0!important;font-size:21px!important}.tiny-gdmc-header p{margin:4px 0 0!important;color:#949ba4!important;font-size:10px!important}.tiny-gdmc-close{width:35px!important;height:35px!important;border:0!important;border-radius:6px!important;background:transparent!important;color:#b5bac1!important;font-size:27px!important;cursor:pointer!important}.tiny-gdmc-close:hover{background:#2b2d31!important;color:white!important}
            .tiny-gdmc-controls{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:12px!important;padding:13px 17px!important;border-bottom:1px solid #292b30!important}.tiny-gdmc-cutoff{display:flex!important;align-items:center!important;gap:7px!important;color:#dbdee1!important;font-size:11px!important}.tiny-gdmc-cutoff input{width:66px!important;height:30px!important;box-sizing:border-box!important;padding:0 7px!important;border:1px solid #3a3c42!important;border-radius:5px!important;background:#0d0e10!important;color:white!important}.tiny-gdmc-selection{display:flex!important;gap:6px!important}.tiny-gdmc-selection button{padding:7px 9px!important;border:0!important;border-radius:5px!important;background:#303239!important;color:#dbdee1!important;font-size:9px!important;font-weight:700!important;cursor:pointer!important}.tiny-gdmc-selection button:hover{background:#404249!important}
            .tiny-gdmc-summary{display:flex!important;align-items:center!important;gap:12px!important;padding:11px 18px!important;background:#15161a!important;color:#949ba4!important;font-size:10px!important}.tiny-gdmc-summary strong{color:#f2f3f5!important;font-size:12px!important}.tiny-gdmc-list{flex:1!important;overflow:auto!important;padding:9px 12px!important}.tiny-gdmc-row{display:flex!important;align-items:center!important;gap:11px!important;margin-bottom:7px!important;padding:11px!important;border:1px solid #2d2f34!important;border-radius:9px!important;background:#191a1e!important;cursor:pointer!important}.tiny-gdmc-row:hover{border-color:#41434a!important}.tiny-gdmc-row.selected{border-color:rgba(88,101,242,.68)!important;background:#1c1e29!important}.tiny-gdmc-row>input{flex:none!important}.tiny-gdmc-avatars{display:flex!important;align-items:center!important;flex:none!important;width:62px!important}.tiny-gdmc-avatars img,.tiny-gdmc-avatars>span{width:31px!important;height:31px!important;margin-left:-8px!important;border:2px solid #191a1e!important;border-radius:50%!important;background:#2b2d31!important;object-fit:cover!important}.tiny-gdmc-avatars img:first-child{margin-left:0!important}.tiny-gdmc-avatars>span{display:grid!important;place-items:center!important;margin-left:0!important;color:#b5bac1!important;font-size:8px!important;font-weight:900!important}.tiny-gdmc-info{min-width:0!important;flex:1!important}.tiny-gdmc-row-heading{display:flex!important;align-items:center!important;gap:6px!important}.tiny-gdmc-row-heading strong{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;font-size:13px!important}.tiny-gdmc-row-heading span{flex:none!important;padding:2px 5px!important;border-radius:4px!important;background:#3a3c43!important;color:#c7cbd1!important;font-size:7px!important;font-weight:900!important}.tiny-gdmc-info p{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;margin:4px 0!important;color:#b5bac1!important;font-size:10px!important}.tiny-gdmc-info time{color:#949ba4!important;font-size:9px!important}.tiny-gdmc-empty{display:grid!important;place-items:center!important;height:100%!important;min-height:240px!important;padding:30px!important;text-align:center!important;color:#949ba4!important}
            .tiny-gdmc-footer{display:flex!important;align-items:center!important;gap:12px!important;padding:13px 17px!important;border-top:1px solid #2e3035!important;background:#17181c!important}.tiny-gdmc-understand{display:flex!important;align-items:center!important;gap:7px!important;min-width:0!important;flex:1!important;color:#b5bac1!important;font-size:9px!important;cursor:pointer!important}.tiny-gdmc-leave{flex:none!important;padding:9px 13px!important;border:0!important;border-radius:5px!important;background:#da373c!important;color:white!important;font-size:10px!important;font-weight:800!important;cursor:pointer!important}.tiny-gdmc-leave:hover{background:#a1282c!important}.tiny-gdmc-leave:disabled{opacity:.4!important;cursor:not-allowed!important}.tiny-gdmc-progress{flex:none!important;color:#e7c36e!important;font-size:10px!important}
            .tiny-gdmc-settings{padding:8px 4px 30px!important;color:var(--text-normal)!important}.tiny-gdmc-settings h2{margin:0 0 5px!important}.tiny-gdmc-settings>p{margin:0 0 14px!important;color:var(--text-muted)!important}.tiny-gdmc-open{margin:4px 0 15px!important;padding:9px 12px!important;border:0!important;border-radius:5px!important;background:#5865f2!important;color:white!important;font-weight:700!important;cursor:pointer!important}.tiny-gdmc-setting{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:13px 0!important;border-top:1px solid var(--background-modifier-accent)!important;cursor:pointer!important}
            @media(max-width:650px){.tiny-gdmc-backdrop{padding:8px!important}.tiny-gdmc-modal{width:100%!important;height:96vh!important}.tiny-gdmc-controls{align-items:flex-start!important;flex-direction:column!important}.tiny-gdmc-summary{flex-wrap:wrap!important}.tiny-gdmc-footer{align-items:flex-start!important;flex-direction:column!important}.tiny-gdmc-leave{width:100%!important}}
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
        if (ui?.showToast) ui.showToast(message, {type, timeout: 5000});
        else console.log(`[${PLUGIN_NAME}] ${message}`);
    }
};
