/**
 * @name PriorityDND
 * @author tiny
 * @version 1.2.0
 * @description Allows notifications from selected people while DND is active, with default and per-person sounds.
 */

"use strict";

const PLUGIN_NAME = "PriorityDND";
const STYLE_ID = "priority-dnd-styles";

const SOUND_OPTIONS = Object.freeze([
    ["classic", "Classic chime"],
    ["soft", "Soft chime"],
    ["bell", "Bright bell"],
    ["digital", "Digital ping"],
    ["double", "Double tap"],
    ["low", "Low pulse"],
    ["sparkle", "Sparkle"],
    ["silent", "No sound"]
]);

const SOUND_PATTERNS = Object.freeze({
    classic: {type: "sine", volume: 0.13, notes: [[660, 0, 0.28], [880, 0.13, 0.28]]},
    soft: {type: "sine", volume: 0.09, notes: [[523, 0, 0.34], [659, 0.16, 0.36]]},
    bell: {type: "sine", volume: 0.12, notes: [[1047, 0, 0.22], [1319, 0.08, 0.25], [1568, 0.16, 0.3]]},
    digital: {type: "square", volume: 0.055, notes: [[740, 0, 0.1], [988, 0.12, 0.13]]},
    double: {type: "triangle", volume: 0.11, notes: [[880, 0, 0.14], [880, 0.22, 0.14]]},
    low: {type: "triangle", volume: 0.13, notes: [[220, 0, 0.28], [330, 0.14, 0.32]]},
    sparkle: {type: "sine", volume: 0.1, notes: [[784, 0, 0.16], [1175, 0.09, 0.18], [1568, 0.18, 0.24]]}
});

const DEFAULT_SETTINGS = Object.freeze({
    priorityUsers: [],
    notifyDMs: true,
    serverMode: "mentions",
    showMessagePreview: true,
    playSound: true,
    defaultSound: "classic",
    desktopAlerts: true,
    cooldownSeconds: 3
});

module.exports = class PriorityDND {
    constructor() {
        this.api = null;
        this.settings = {...DEFAULT_SETTINGS, priorityUsers: []};
        this.stores = {};
        this.dispatcher = null;
        this.navigation = null;
        this.unpatchUserContext = null;
        this.cooldowns = new Map();
        this.seenMessageIds = new Set();
        this.alerts = new Set();
        this.alertStack = null;
        this.audioContext = null;
        this.statusListeners = new Set();
        this.diagnosticListeners = new Set();
        this.lastDiagnostic = "No incoming message event has been seen yet.";
        this.lastDiagnosticAt = 0;
        this.started = false;
        this.onMessageCreate = this.onMessageCreate.bind(this);
        this.onPresenceChange = this.onPresenceChange.bind(this);
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
        this.patchUserContextMenu();
        this.toast(
            this.isDndActive()
                ? `Priority DND active for ${this.settings.priorityUsers.length} ${this.settings.priorityUsers.length === 1 ? "person" : "people"}.`
                : "Priority DND will activate automatically when your status is DND.",
            "info"
        );
    }

    stop() {
        this.started = false;
        this.unsubscribe();
        this.unpatchUserContext?.();
        this.unpatchUserContext = null;
        for (const alert of this.alerts) alert.remove();
        this.alerts.clear();
        this.alertStack?.remove();
        this.alertStack = null;
        this.statusListeners.clear();
        this.diagnosticListeners.clear();
        this.cooldowns.clear();
        this.seenMessageIds.clear();
        this.removeStyles();
        try {
            this.audioContext?.close?.();
        } catch (_) {}
        this.audioContext = null;
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
            selfPresence: getStore("SelfPresenceStore"),
            presence: getStore("PresenceStore"),
            user: getStore("UserStore"),
            channel: getStore("ChannelStore"),
            guild: getStore("GuildStore")
        };

        try {
            this.dispatcher = webpack?.getByKeys?.("dispatch", "subscribe", "unsubscribe")
                || webpack?.getModule?.(
                    module => typeof module?.dispatch === "function" && typeof module?.subscribe === "function" && typeof module?.unsubscribe === "function",
                    {searchExports: true}
                )
                || null;
            this.navigation = webpack?.getByKeys?.("transitionTo", "replaceWith") || null;
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not load message or navigation modules:`, error);
        }

        if (!this.dispatcher) this.toast("Discord's message dispatcher was not found. Reload Discord to retry.", "error");
    }

    subscribe() {
        try {
            this.dispatcher?.subscribe?.("MESSAGE_CREATE", this.onMessageCreate);
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not subscribe to new messages:`, error);
        }
        for (const store of [this.stores.selfPresence, this.stores.presence]) {
            try {
                store?.addChangeListener?.(this.onPresenceChange);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}] Could not watch DND status:`, error);
            }
        }
    }

    unsubscribe() {
        try {
            this.dispatcher?.unsubscribe?.("MESSAGE_CREATE", this.onMessageCreate);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not unsubscribe from new messages:`, error);
        }
        for (const store of [this.stores.selfPresence, this.stores.presence]) {
            try {
                store?.removeChangeListener?.(this.onPresenceChange);
            } catch (error) {
                console.warn(`[${PLUGIN_NAME}] Could not stop watching DND status:`, error);
            }
        }
    }

    onPresenceChange() {
        for (const listener of this.statusListeners) listener(this.isDndActive());
    }

    getStatusCandidates() {
        const statuses = [];
        try {
            const localStatus = this.stores.selfPresence?.getStatus?.();
            if (typeof localStatus === "string") statuses.push(localStatus.toLowerCase());
        } catch (_) {}
        try {
            const userId = this.stores.user?.getCurrentUser?.()?.id;
            const status = userId ? this.stores.presence?.getStatus?.(userId) : null;
            if (typeof status === "string") statuses.push(status.toLowerCase());
        } catch (_) {}
        return [...new Set(statuses.filter(Boolean))];
    }

    getCurrentStatus() {
        const statuses = this.getStatusCandidates();
        if (statuses.includes("dnd")) return "dnd";
        return statuses[0] || "unknown";
    }

    isDndActive() {
        return this.getCurrentStatus() === "dnd";
    }

    sanitizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const users = Array.isArray(source.priorityUsers) ? source.priorityUsers : [];
        const unique = new Map();
        for (const entry of users) {
            const id = this.normalizeUserId(typeof entry === "string" ? entry : entry?.id);
            if (!id) continue;
            const sound = this.isSoundChoice(entry?.sound, true) ? entry.sound : "default";
            unique.set(id, {id, name: String(entry?.name || `User ${id.slice(-4)}`).slice(0, 80), sound});
        }
        return {
            priorityUsers: [...unique.values()],
            notifyDMs: source.notifyDMs ?? DEFAULT_SETTINGS.notifyDMs,
            serverMode: ["off", "mentions", "all"].includes(source.serverMode) ? source.serverMode : DEFAULT_SETTINGS.serverMode,
            showMessagePreview: source.showMessagePreview ?? DEFAULT_SETTINGS.showMessagePreview,
            playSound: source.playSound ?? DEFAULT_SETTINGS.playSound,
            defaultSound: this.isSoundChoice(source.defaultSound, false) ? source.defaultSound : DEFAULT_SETTINGS.defaultSound,
            desktopAlerts: source.desktopAlerts ?? DEFAULT_SETTINGS.desktopAlerts,
            cooldownSeconds: Math.max(0, Math.min(300, Number(source.cooldownSeconds ?? DEFAULT_SETTINGS.cooldownSeconds)))
        };
    }

    normalizeUserId(value) {
        const match = String(value ?? "").match(/\d{10,25}/);
        return match ? match[0] : "";
    }

    isSoundChoice(value, allowDefault = false) {
        return (allowDefault && value === "default") || SOUND_OPTIONS.some(([id]) => id === value);
    }

    getSoundForUser(userId) {
        const entry = this.settings.priorityUsers.find(user => user.id === String(userId || ""));
        const chosen = entry?.sound && entry.sound !== "default" ? entry.sound : this.settings.defaultSound;
        return this.isSoundChoice(chosen, false) ? chosen : DEFAULT_SETTINGS.defaultSound;
    }

    isPriorityUser(userId) {
        return this.settings.priorityUsers.some(entry => entry.id === String(userId));
    }

    addPriorityUser(userOrId, fallbackName = "") {
        const id = this.normalizeUserId(typeof userOrId === "object" ? userOrId?.id : userOrId);
        if (!id) return false;
        if (this.isPriorityUser(id)) return true;
        const knownUser = typeof userOrId === "object" ? userOrId : this.stores.user?.getUser?.(id);
        const name = knownUser?.globalName || knownUser?.displayName || knownUser?.username || fallbackName || `User ${id.slice(-4)}`;
        this.settings.priorityUsers.push({id, name: String(name).slice(0, 80), sound: "default"});
        this.saveSettings();
        this.refreshSettingsLists();
        this.toast(`${name} added to Priority DND.`, "success");
        return true;
    }

    removePriorityUser(userId) {
        const id = String(userId);
        const entry = this.settings.priorityUsers.find(user => user.id === id);
        this.settings.priorityUsers = this.settings.priorityUsers.filter(user => user.id !== id);
        this.saveSettings();
        this.refreshSettingsLists();
        if (entry) this.toast(`${entry.name} removed from Priority DND.`, "info");
    }

    patchUserContextMenu() {
        const contextMenu = this.api?.ContextMenu || globalThis.BdApi?.ContextMenu;
        if (!contextMenu?.patch || !contextMenu?.buildItem) return;
        try {
            this.unpatchUserContext = contextMenu.patch("user-context", (tree, props) => {
                const user = props?.user || tree?.props?.user;
                const selfId = this.stores.user?.getCurrentUser?.()?.id;
                if (!user?.id || user.id === selfId || !tree?.props) return;
                const checked = this.isPriorityUser(user.id);
                const item = contextMenu.buildItem({
                    type: "toggle",
                    label: "Priority DND alerts",
                    checked,
                    action: () => checked ? this.removePriorityUser(user.id) : this.addPriorityUser(user)
                });
                const children = tree.props.children;
                if (Array.isArray(children)) children.push(item);
                else if (children) tree.props.children = [children, item];
                else tree.props.children = [item];
            });
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not add the user context-menu option:`, error);
        }
    }

    onMessageCreate(event) {
        try {
            const message = this.extractMessage(event);
            const messageId = String(message?.id || "");
            if (!message || !messageId) {
                this.recordDiagnostic("A message event arrived, but Discord did not include a readable message record.");
                return;
            }
            if (this.seenMessageIds.has(messageId)) return;
            this.rememberMessageId(messageId);
            if (!this.isDndActive()) {
                this.recordDiagnostic(`Message received while status was detected as ${this.getCurrentStatus()}, so no alert was created.`);
                return;
            }

            const authorId = String(message.author?.id || message.author_id || message.authorId || message.user_id || "");
            const selfId = String(this.stores.user?.getCurrentUser?.()?.id || "");
            if (!authorId || authorId === selfId) {
                this.recordDiagnostic("A message was received, but it had no external author to notify for.");
                return;
            }
            if (!this.isPriorityUser(authorId)) {
                this.recordDiagnostic(`Message received from user ${authorId}, who is not on the priority list.`);
                return;
            }
            const channelId = message.channel_id || message.channelId || event?.channelId;
            const channel = this.stores.channel?.getChannel?.(channelId) || null;
            if (!this.shouldAlertForMessage(message, channel, selfId)) {
                this.recordDiagnostic("A priority message was received, but the current DM/server alert rule filtered it out.");
                return;
            }

            const now = Date.now();
            const cooldown = this.settings.cooldownSeconds * 1000;
            if (cooldown > 0 && now - (this.cooldowns.get(authorId) || 0) < cooldown) {
                this.recordDiagnostic("A priority message was received during that person's notification cooldown.");
                return;
            }
            this.cooldowns.set(authorId, now);
            this.sendAlert(message, channel);
            this.recordDiagnostic(`Priority message received from ${message.author?.globalName || message.author?.username || authorId}; alert created.`);
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to process a priority message:`, error);
            this.recordDiagnostic(`Priority message handling failed: ${error?.message || "unknown error"}.`);
        }
    }

    extractMessage(event) {
        if (!event || typeof event !== "object") return null;
        return event.message
            || event.messageRecord
            || event.record
            || (Array.isArray(event.messages) ? event.messages[0] : null)
            || (event.id && (event.channel_id || event.channelId) ? event : null);
    }

    recordDiagnostic(message) {
        this.lastDiagnostic = String(message);
        this.lastDiagnosticAt = Date.now();
        for (const listener of this.diagnosticListeners) listener(this.lastDiagnostic, this.lastDiagnosticAt);
    }

    rememberMessageId(messageId) {
        this.seenMessageIds.add(messageId);
        if (this.seenMessageIds.size > 500) {
            const oldest = this.seenMessageIds.values().next().value;
            this.seenMessageIds.delete(oldest);
        }
    }

    shouldAlertForMessage(message, channel, selfId) {
        const isDirectMessage = !channel?.guild_id && !channel?.guildId && !message?.guild_id && !message?.guildId;
        if (isDirectMessage) return Boolean(this.settings.notifyDMs);
        if (this.settings.serverMode === "all") return true;
        if (this.settings.serverMode === "off") return false;
        const mentions = Array.isArray(message.mentions) ? message.mentions : [];
        const directlyMentioned = mentions.some(mention => String(mention?.id || mention) === String(selfId));
        const contentMention = String(message.content || "").includes(`<@${selfId}>`) || String(message.content || "").includes(`<@!${selfId}>`);
        const repliedToSelf = String(message.referenced_message?.author?.id || "") === String(selfId);
        return directlyMentioned || contentMention || repliedToSelf;
    }

    sendAlert(message, channel, testOptions = null) {
        const author = message.author || this.stores.user?.getUser?.(message.author_id) || {};
        const authorName = testOptions?.authorName || author.globalName || author.displayName || author.username || "Priority person";
        const guildId = channel?.guild_id || channel?.guildId || null;
        const guild = guildId ? this.stores.guild?.getGuild?.(guildId) : null;
        const location = testOptions?.location || (guildId ? `${guild?.name || "Server"} · #${channel?.name || "channel"}` : "Direct Message");
        const preview = this.settings.showMessagePreview
            ? this.cleanPreview(testOptions?.content ?? message.content ?? "Sent you a priority message")
            : "New priority message";
        const info = {
            title: `${authorName} · Priority DND`,
            body: preview,
            location,
            channelId: message.channel_id || message.channelId || channel?.id,
            guildId,
            messageId: message.id
        };

        if (this.settings.playSound) this.playNotificationSound(this.getSoundForUser(author.id || message.author_id));
        this.showInAppAlert(info);
        if (this.settings.desktopAlerts) this.showDesktopAlert(info);
    }

    cleanPreview(content) {
        const cleaned = String(content || "")
            .replace(/```[\s\S]*?```/g, "[code]")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/<a?:\w+:\d+>/g, "[emoji]")
            .replace(/<@!?\d+>/g, "@mention")
            .replace(/<#[0-9]+>/g, "#channel")
            .replace(/\s+/g, " ")
            .trim();
        return cleaned ? cleaned.slice(0, 180) : "Sent an attachment or message";
    }

    showInAppAlert(info) {
        if (!globalThis.document?.body) return;
        if (!this.alertStack?.isConnected) {
            this.alertStack = this.element("div", {className: "priority-dnd-alert-stack", "aria-live": "polite"});
            document.body.append(this.alertStack);
        }
        const alert = this.element("button", {className: "priority-dnd-alert", type: "button"});
        const icon = this.element("span", {className: "priority-dnd-alert-icon", textContent: "★"});
        const copy = this.element("span", {className: "priority-dnd-alert-copy"});
        copy.append(
            this.element("strong", {textContent: info.title}),
            this.element("span", {className: "priority-dnd-location", textContent: info.location}),
            this.element("span", {className: "priority-dnd-preview", textContent: info.body})
        );
        alert.append(icon, copy);
        alert.addEventListener("click", () => {
            this.openMessage(info);
            this.dismissAlert(alert);
        });
        this.alertStack.append(alert);
        this.alerts.add(alert);
        requestAnimationFrame(() => alert.classList.add("visible"));
        setTimeout(() => this.dismissAlert(alert), 8000);
    }

    dismissAlert(alert) {
        if (!alert?.isConnected) {
            this.alerts.delete(alert);
            return;
        }
        alert.classList.remove("visible");
        setTimeout(() => {
            alert.remove();
            this.alerts.delete(alert);
            if (!this.alerts.size) {
                this.alertStack?.remove();
                this.alertStack = null;
            }
        }, 180);
    }

    async showDesktopAlert(info) {
        if (typeof globalThis.Notification !== "function" || Notification.permission !== "granted") return;
        try {
            const notification = new Notification(info.title, {body: `${info.location}\n${info.body}`, tag: `priority-dnd-${info.messageId || Date.now()}`, silent: true});
            notification.onclick = () => {
                globalThis.focus?.();
                this.openMessage(info);
                notification.close();
            };
        } catch (error) {
            console.debug(`[${PLUGIN_NAME}] Desktop notification unavailable:`, error);
        }
    }

    openMessage(info) {
        if (!info.channelId || !this.navigation?.transitionTo) return;
        const base = `/channels/${info.guildId || "@me"}/${info.channelId}`;
        const path = info.messageId ? `${base}/${info.messageId}` : base;
        try {
            this.navigation.transitionTo(path);
        } catch (error) {
            console.debug(`[${PLUGIN_NAME}] Could not open the priority message:`, error);
        }
    }

    playNotificationSound(soundId = this.settings.defaultSound) {
        try {
            if (soundId === "silent") return;
            const pattern = SOUND_PATTERNS[soundId] || SOUND_PATTERNS.classic;
            const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AudioContextClass) return;
            if (!this.audioContext) this.audioContext = new AudioContextClass();
            const context = this.audioContext;
            context.resume?.();
            const start = context.currentTime;
            for (const [frequency, offset, duration] of pattern.notes) {
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.type = pattern.type;
                oscillator.frequency.value = frequency;
                oscillator.connect(gain);
                gain.connect(context.destination);
                gain.gain.setValueAtTime(0.0001, start + offset);
                gain.gain.exponentialRampToValueAtTime(pattern.volume, start + offset + 0.012);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
                oscillator.start(start + offset);
                oscillator.stop(start + offset + duration + 0.02);
            }
        } catch (error) {
            console.debug(`[${PLUGIN_NAME}] Could not play the priority sound:`, error);
        }
    }

    playChime() {
        this.playNotificationSound(this.settings.defaultSound);
    }

    async testAlert() {
        if (this.settings.desktopAlerts && typeof globalThis.Notification === "function" && Notification.permission === "default") {
            try {
                await Notification.requestPermission();
            } catch (_) {}
        }
        this.sendAlert(
            {id: `test-${Date.now()}`, content: "This is how a priority message will appear."},
            null,
            {authorName: "Priority DND Test", location: this.isDndActive() ? "DND is currently active" : "DND is currently inactive"}
        );
    }

    getSettingsPanel() {
        const panel = this.element("div", {className: "priority-dnd-settings"});
        panel.append(
            this.element("h2", {textContent: "Priority DND"}),
            this.element("p", {textContent: "Selected people can trigger custom desktop alerts while your Discord status is Do Not Disturb."})
        );

        const status = this.element("div", {className: "priority-dnd-status"});
        const updateStatus = active => {
            status.classList.toggle("active", active);
            status.textContent = active
                ? `Active — watching for ${this.settings.priorityUsers.length} priority ${this.settings.priorityUsers.length === 1 ? "person" : "people"}`
                : "Waiting — set your Discord status to Do Not Disturb to activate";
        };
        updateStatus(this.isDndActive());
        this.statusListeners.add(updateStatus);

        const diagnostic = this.element("div", {className: "priority-dnd-diagnostic"});
        const updateDiagnostic = (message, timestamp) => {
            diagnostic.textContent = timestamp
                ? `Last check (${new Date(timestamp).toLocaleTimeString()}): ${message}`
                : `Last check: ${message}`;
        };
        updateDiagnostic(this.lastDiagnostic, this.lastDiagnosticAt);
        this.diagnosticListeners.add(updateDiagnostic);

        const observer = new MutationObserver(() => {
            if (!panel.isConnected) {
                this.statusListeners.delete(updateStatus);
                this.diagnosticListeners.delete(updateDiagnostic);
                observer.disconnect();
            }
        });
        observer.observe(document.body, {childList: true, subtree: true});
        panel.append(status, diagnostic);

        const addCard = this.element("section", {className: "priority-dnd-card"});
        addCard.append(
            this.element("h3", {textContent: "Priority people"}),
            this.element("p", {textContent: "Right-click any user and toggle Priority DND alerts, or enter their Discord user ID below."})
        );
        const addRow = this.element("div", {className: "priority-dnd-add-row"});
        const input = this.element("input", {type: "text", inputMode: "numeric", placeholder: "Discord user ID"});
        const addButton = this.element("button", {type: "button", textContent: "Add person"});
        const addStatus = this.element("div", {className: "priority-dnd-add-status"});
        const add = () => {
            if (!this.addPriorityUser(input.value)) {
                addStatus.textContent = "Enter a valid Discord user ID.";
                input.focus();
                return;
            }
            input.value = "";
            addStatus.textContent = "";
            updateStatus(this.isDndActive());
        };
        addButton.addEventListener("click", add);
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                add();
            }
        });
        addRow.append(input, addButton);
        const list = this.element("div", {className: "priority-dnd-user-list", "data-priority-dnd-list": "true"});
        addCard.append(addRow, addStatus, list);
        panel.append(addCard);
        this.renderPriorityList(list);

        panel.append(
            this.checkboxSetting("Alert for direct messages", "Allow every DM and group-DM message sent by a priority person.", "notifyDMs"),
            this.selectSetting("Priority server messages", "Choose whether server messages need to mention or reply to you.", "serverMode", [
                ["mentions", "Mentions and replies only"],
                ["all", "Every message"],
                ["off", "No server messages"]
            ]),
            this.checkboxSetting("Show message previews", "Include up to 180 characters of the message in the alert.", "showMessagePreview"),
            this.defaultSoundSetting(),
            this.checkboxSetting("Play priority sounds", "Play the default sound or a person's custom sound for priority alerts.", "playSound"),
            this.checkboxSetting("Show desktop notification", "Also use the operating system notification when Discord has permission.", "desktopAlerts"),
            this.numberSetting("Per-person cooldown", "Minimum seconds between alerts from the same person (0 to 300).", "cooldownSeconds", 0, 300)
        );

        const test = this.element("button", {className: "priority-dnd-test", type: "button", textContent: "Send test alert"});
        test.addEventListener("click", () => this.testAlert());
        panel.append(test);
        return panel;
    }

    renderPriorityList(container) {
        container.replaceChildren();
        if (!this.settings.priorityUsers.length) {
            container.append(this.element("div", {className: "priority-dnd-empty", textContent: "No priority people added yet."}));
            return;
        }
        for (const entry of this.settings.priorityUsers) {
            const row = this.element("div", {className: "priority-dnd-user-row"});
            const copy = this.element("span");
            const soundName = entry.sound === "default" ? `Default: ${this.soundLabel(this.settings.defaultSound)}` : this.soundLabel(entry.sound);
            copy.append(this.element("strong", {textContent: entry.name}), this.element("small", {textContent: `${entry.id} - ${soundName}`}));
            const controls = this.element("div", {className: "priority-dnd-user-controls"});
            const sound = this.element("select", {title: `Notification sound for ${entry.name}`});
            sound.append(this.element("option", {value: "default", textContent: `Use default (${this.soundLabel(this.settings.defaultSound)})`}));
            for (const [value, label] of SOUND_OPTIONS) sound.append(this.element("option", {value, textContent: label}));
            sound.value = entry.sound || "default";
            sound.addEventListener("change", () => {
                entry.sound = sound.value;
                this.saveSettings();
                this.renderPriorityList(container);
            });
            const preview = this.element("button", {className: "priority-dnd-sound-preview", type: "button", textContent: "\u25B6", title: "Preview this sound"});
            preview.addEventListener("click", () => this.playNotificationSound(this.getSoundForUser(entry.id)));
            const remove = this.element("button", {type: "button", textContent: "Remove"});
            remove.addEventListener("click", () => this.removePriorityUser(entry.id));
            controls.append(sound, preview, remove);
            row.append(copy, controls);
            container.append(row);
        }
    }

    soundLabel(soundId) {
        return SOUND_OPTIONS.find(([id]) => id === soundId)?.[1] || "Classic chime";
    }

    defaultSoundSetting() {
        const row = this.settingRow("Default priority sound", "Used for everyone unless they have a different sound selected above.");
        const controls = this.element("div", {className: "priority-dnd-default-sound"});
        const select = this.element("select");
        for (const [value, label] of SOUND_OPTIONS) {
            const option = this.element("option", {value, textContent: label});
            option.selected = this.settings.defaultSound === value;
            select.append(option);
        }
        select.addEventListener("change", () => {
            this.settings.defaultSound = select.value;
            this.saveSettings();
            this.refreshSettingsLists();
        });
        const preview = this.element("button", {type: "button", textContent: "Preview"});
        preview.addEventListener("click", () => this.playNotificationSound(select.value));
        controls.append(select, preview);
        row.append(controls);
        return row;
    }

    refreshSettingsLists() {
        if (!globalThis.document) return;
        for (const list of document.querySelectorAll('[data-priority-dnd-list="true"]')) this.renderPriorityList(list);
        this.onPresenceChange();
    }

    checkboxSetting(title, description, key) {
        const row = this.settingRow(title, description);
        const input = this.element("input", {type: "checkbox"});
        input.checked = Boolean(this.settings[key]);
        input.addEventListener("change", () => {
            this.settings[key] = input.checked;
            this.saveSettings();
        });
        row.append(input);
        return row;
    }

    selectSetting(title, description, key, options) {
        const row = this.settingRow(title, description);
        const select = this.element("select");
        for (const [value, label] of options) {
            const option = this.element("option", {value, textContent: label});
            option.selected = this.settings[key] === value;
            select.append(option);
        }
        select.addEventListener("change", () => {
            this.settings[key] = select.value;
            this.saveSettings();
        });
        row.append(select);
        return row;
    }

    numberSetting(title, description, key, minimum, maximum) {
        const row = this.settingRow(title, description);
        const input = this.element("input", {className: "priority-dnd-number", type: "number", min: minimum, max: maximum, step: 1, value: this.settings[key]});
        input.addEventListener("change", () => {
            const parsed = Number(input.value);
            this.settings[key] = Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : DEFAULT_SETTINGS[key];
            input.value = this.settings[key];
            this.saveSettings();
        });
        row.append(input);
        return row;
    }

    settingRow(title, description) {
        const row = this.element("label", {className: "priority-dnd-setting-row"});
        const copy = this.element("span", {className: "priority-dnd-setting-copy"});
        copy.append(this.element("strong", {textContent: title}), this.element("small", {textContent: description}));
        row.append(copy);
        return row;
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
            .priority-dnd-alert-stack {
                position: fixed !important; right: 16px !important; top: 16px !important; z-index: 2147483000 !important;
                display: flex !important; flex-direction: column !important; align-items: flex-end !important; gap: 9px !important;
                width: min(380px, calc(100vw - 32px)) !important; pointer-events: none !important;
            }
            .priority-dnd-alert {
                position: relative !important;
                display: grid !important; grid-template-columns: 38px minmax(0,1fr) !important; gap: 11px !important;
                width: 100% !important; padding: 13px !important; box-sizing: border-box !important;
                border: 1px solid rgba(255,255,255,.1) !important; border-radius: 10px !important;
                background: rgba(24,25,29,.97) !important; color: #f2f3f5 !important; box-shadow: 0 12px 36px rgba(0,0,0,.42) !important;
                font-family: var(--font-primary, Arial, sans-serif) !important; text-align: left !important; cursor: pointer !important; pointer-events: auto !important;
                opacity: 0 !important; transform: translateY(-10px) !important; transition: opacity .18s ease, transform .18s ease !important;
            }
            .priority-dnd-alert.visible { opacity: 1 !important; transform: translateY(0) !important; }
            .priority-dnd-alert:hover { background: #202126 !important; border-color: rgba(124,134,247,.45) !important; }
            .priority-dnd-alert-icon { display: grid !important; place-items: center !important; width: 36px !important; height: 36px !important; border-radius: 50% !important; background: #5865f2 !important; color: white !important; font-size: 17px !important; }
            .priority-dnd-alert-copy { display: flex !important; flex-direction: column !important; gap: 3px !important; min-width: 0 !important; }
            .priority-dnd-alert-copy strong { overflow: hidden !important; color: #f2f3f5 !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
            .priority-dnd-location { color: #8e98f5 !important; font-size: 11px !important; }
            .priority-dnd-preview { overflow: hidden !important; color: #b5bac1 !important; font-size: 12px !important; line-height: 1.35 !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical !important; }
            .priority-dnd-settings { padding: 8px 4px 40px; color: var(--text-normal); }
            .priority-dnd-settings h2 { margin: 0 0 5px; }
            .priority-dnd-settings > p { margin: 0 0 14px; color: var(--text-muted); }
            .priority-dnd-status { padding: 11px 13px; margin-bottom: 15px; border: 1px solid var(--background-modifier-accent); border-radius: 7px; background: var(--background-secondary); color: var(--text-muted); font-weight: 600; }
            .priority-dnd-status.active { border-color: rgba(35,165,90,.45); background: rgba(35,165,90,.1); color: var(--text-positive); }
            .priority-dnd-diagnostic { padding: 9px 11px; margin: -7px 0 15px; border-radius: 6px; background: var(--background-secondary-alt); color: var(--text-muted); font-size: 11px; line-height: 1.4; }
            .priority-dnd-card { padding: 15px; margin-bottom: 14px; border: 1px solid var(--background-modifier-accent); border-radius: 8px; background: var(--background-secondary); }
            .priority-dnd-card h3 { margin: 0 0 4px; }
            .priority-dnd-card > p { margin: 0 0 11px; color: var(--text-muted); font-size: 13px; }
            .priority-dnd-add-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }
            .priority-dnd-add-row input, .priority-dnd-setting-row select, .priority-dnd-number { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--input-border); border-radius: 4px; outline: none; background: var(--input-background); color: var(--text-normal); }
            .priority-dnd-add-row input:focus { border-color: #5865f2; }
            .priority-dnd-add-row button, .priority-dnd-test { padding: 8px 13px; border: 0; border-radius: 4px; background: #5865f2; color: white; font-weight: 600; cursor: pointer; }
            .priority-dnd-add-status { min-height: 17px; color: var(--text-danger); font-size: 12px; }
            .priority-dnd-user-list { display: flex; flex-direction: column; margin-top: 4px; }
            .priority-dnd-user-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid var(--background-modifier-accent); }
            .priority-dnd-user-row > span { display: flex; flex-direction: column; min-width: 0; flex: 1; }
            .priority-dnd-user-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .priority-dnd-user-row small { color: var(--text-muted); }
            .priority-dnd-user-controls { display: flex; align-items: center; gap: 6px; }
            .priority-dnd-user-controls select, .priority-dnd-default-sound select { box-sizing: border-box; max-width: 205px; padding: 6px 8px; border: 1px solid var(--input-border); border-radius: 4px; background: var(--input-background); color: var(--text-normal); }
            .priority-dnd-user-row button, .priority-dnd-default-sound button { padding: 6px 9px; border: 0; border-radius: 4px; background: var(--button-secondary-background); color: var(--text-normal); cursor: pointer; }
            .priority-dnd-sound-preview { width: 31px; padding: 6px 0 !important; }
            .priority-dnd-default-sound { display: flex; align-items: center; gap: 6px; }
            .priority-dnd-empty { padding: 11px 0 3px; color: var(--text-muted); text-align: center; }
            .priority-dnd-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 0; border-top: 1px solid var(--background-modifier-accent); cursor: pointer; }
            .priority-dnd-setting-copy { display: flex; flex-direction: column; gap: 4px; }
            .priority-dnd-setting-copy small { color: var(--text-muted); line-height: 1.35; }
            .priority-dnd-setting-row > input[type="checkbox"] { width: 20px; height: 20px; flex: 0 0 auto; }
            .priority-dnd-setting-row select { min-width: 190px; }
            .priority-dnd-number { width: 85px; }
            .priority-dnd-test { margin-top: 15px; }
            @media(max-width:650px) {
                .priority-dnd-user-row { align-items: flex-start; flex-direction: column; }
                .priority-dnd-user-controls { width: 100%; flex-wrap: wrap; }
                .priority-dnd-user-controls select { min-width: 0; flex: 1; }
                .priority-dnd-setting-row { align-items: flex-start; flex-direction: column; }
            }
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
