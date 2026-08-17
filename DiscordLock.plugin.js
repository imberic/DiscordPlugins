/**
 * @name DiscordLock
 * @author tiny
 * @version 1.2.1
 * @description Covers Discord with a PIN lock screen after inactivity or time away.
 */

"use strict";

const PLUGIN_NAME = "DiscordLock";
const STYLE_ID = "discord-lock-styles";
const PIN_MIN = 4;
const PIN_MAX = 12;
const PBKDF2_ITERATIONS = 150000;

const DEFAULT_SETTINGS = Object.freeze({
    idleMinutes: 15,
    awayMinutes: 5,
    lockOnStart: false,
    showLockButton: true,
    hideToastsWhileLocked: true
});

module.exports = class DiscordLock {
    constructor() {
        this.settings = {...DEFAULT_SETTINGS};
        this.pinRecord = null;
        this.pinReady = false;
        this.pinError = null;
        this.locked = false;
        this.failedAttempts = 0;
        this.blockedUntil = 0;
        this.lastActivityAt = Date.now();
        this.awaySince = null;
        this.interval = null;
        this.lockOverlay = null;
        this.setupOverlay = null;
        this.cornerButton = null;
        this.started = false;

        this.onActivity = this.onActivity.bind(this);
        this.onBlur = this.onBlur.bind(this);
        this.onFocus = this.onFocus.bind(this);
        this.onVisibilityChange = this.onVisibilityChange.bind(this);
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.settings = {...DEFAULT_SETTINGS, ...(this.loadData("settings") || {})};
        this.addStyles();
        this.attachListeners();
        this.interval = setInterval(() => this.checkAutomaticLock(), 1000);

        this.initializePin().then(configured => {
            if (!this.started) return;
            this.pinReady = configured;
            this.pinError = null;
            this.ensureLockButton();

            if (!configured) {
                this.toast("Create your PIN in Discord Lock settings, or close Settings and click Set Discord Lock PIN.", "warning");
            } else if (this.settings.lockOnStart) {
                this.lock();
            }
        }).catch(error => {
            console.error(`[${PLUGIN_NAME}] Failed to initialize the PIN:`, error);
            this.pinReady = false;
            this.pinRecord = null;
            this.pinError = "The saved PIN could not be loaded.";
            this.ensureLockButton();
            this.toast("Create a new PIN in Discord Lock settings before automatic locking can start.", "error");
        });
    }

    stop() {
        this.started = false;
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.detachListeners();
        this.removeLockScreen();
        this.removeSetupScreen();
        this.removeLockButton();
        document.body?.classList.remove("discord-lock-active");
        this.removeStyles();
    }

    async initializePin() {
        const record = this.loadData("pinRecord");
        const configuredByUser = this.loadData("pinConfiguredByUser") === true;

        if (this.isUserPinConfigured(record, configuredByUser)) {
            this.pinRecord = record;
            return true;
        }

        this.pinRecord = null;
        return false;
    }

    normalizePin(value) {
        return String(value ?? "").replace(/\D/g, "").slice(0, PIN_MAX);
    }

    isValidPin(pin) {
        return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
    }

    isValidPinRecord(record) {
        return Boolean(
            record &&
            record.version === 1 &&
            record.algorithm === "PBKDF2-SHA-256" &&
            Number.isInteger(record.iterations) &&
            record.iterations >= PBKDF2_ITERATIONS &&
            typeof record.salt === "string" && record.salt.length > 0 &&
            typeof record.hash === "string" && record.hash.length > 0
        );
    }

    isUserPinConfigured(record, configuredByUser) {
        return configuredByUser === true && this.isValidPinRecord(record);
    }

    async createPinRecord(pin) {
        const normalized = this.normalizePin(pin);
        if (!this.isValidPin(normalized)) {
            throw new Error(`PIN must contain ${PIN_MIN} to ${PIN_MAX} digits.`);
        }

        const cryptoApi = globalThis.crypto;
        if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) {
            throw new Error("Secure PIN storage is unavailable in this Discord build.");
        }

        const salt = cryptoApi.getRandomValues(new Uint8Array(16));
        const keyMaterial = await cryptoApi.subtle.importKey(
            "raw",
            new TextEncoder().encode(normalized),
            "PBKDF2",
            false,
            ["deriveBits"]
        );
        const bits = await cryptoApi.subtle.deriveBits(
            {name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS},
            keyMaterial,
            256
        );

        return {
            version: 1,
            algorithm: "PBKDF2-SHA-256",
            iterations: PBKDF2_ITERATIONS,
            salt: this.bytesToBase64(salt),
            hash: this.bytesToBase64(new Uint8Array(bits))
        };
    }

    async verifyPin(pin, record = this.pinRecord) {
        if (!this.isValidPinRecord(record)) return false;
        const normalized = this.normalizePin(pin);
        if (!this.isValidPin(normalized)) return false;

        const salt = this.base64ToBytes(record.salt);
        const expected = this.base64ToBytes(record.hash);
        const keyMaterial = await globalThis.crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(normalized),
            "PBKDF2",
            false,
            ["deriveBits"]
        );
        const bits = await globalThis.crypto.subtle.deriveBits(
            {name: "PBKDF2", hash: "SHA-256", salt, iterations: record.iterations},
            keyMaterial,
            expected.length * 8
        );
        const actual = new Uint8Array(bits);
        if (actual.length !== expected.length) return false;

        let difference = 0;
        for (let index = 0; index < actual.length; index++) {
            difference |= actual[index] ^ expected[index];
        }
        return difference === 0;
    }

    async saveUserPin(pin) {
        const record = await this.createPinRecord(pin);
        this.saveData("pinRecord", record);
        this.saveData("pinConfiguredByUser", true);
        this.pinRecord = record;
        this.pinReady = true;
        this.pinError = null;
        this.failedAttempts = 0;
        this.blockedUntil = 0;
        this.ensureLockButton();
    }

    bytesToBase64(bytes) {
        if (typeof btoa === "function") {
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary);
        }
        return Buffer.from(bytes).toString("base64");
    }

    base64ToBytes(value) {
        if (typeof atob === "function") {
            const binary = atob(value);
            return Uint8Array.from(binary, character => character.charCodeAt(0));
        }
        return new Uint8Array(Buffer.from(value, "base64"));
    }

    computeLockoutMs(attempts) {
        if (attempts < 5) return 0;
        return Math.min(300000, 30000 * 2 ** Math.floor((attempts - 5) / 2));
    }

    attachListeners() {
        for (const eventName of ["pointerdown", "mousemove", "keydown", "touchstart"]) {
            document.addEventListener(eventName, this.onActivity, true);
        }
        window.addEventListener("blur", this.onBlur, true);
        window.addEventListener("focus", this.onFocus, true);
        document.addEventListener("visibilitychange", this.onVisibilityChange, true);
    }

    detachListeners() {
        for (const eventName of ["pointerdown", "mousemove", "keydown", "touchstart"]) {
            document.removeEventListener(eventName, this.onActivity, true);
        }
        window.removeEventListener("blur", this.onBlur, true);
        window.removeEventListener("focus", this.onFocus, true);
        document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    }

    onActivity(event) {
        if (this.locked) return;
        if (this.setupOverlay?.contains(event.target)) return;
        this.lastActivityAt = Date.now();
    }

    onBlur() {
        if (!this.locked && this.awaySince === null) this.awaySince = Date.now();
    }

    onFocus() {
        this.handleReturnFromAway();
    }

    onVisibilityChange() {
        if (document.hidden) {
            if (!this.locked && this.awaySince === null) this.awaySince = Date.now();
        } else {
            this.handleReturnFromAway();
        }
    }

    handleReturnFromAway() {
        if (this.awaySince === null) return;
        const elapsed = Date.now() - this.awaySince;
        this.awaySince = null;
        if (this.pinReady && !this.locked && elapsed >= this.minutesToMs(this.settings.awayMinutes)) {
            this.lock();
        }
        this.lastActivityAt = Date.now();
    }

    checkAutomaticLock() {
        if (!this.pinReady || this.locked || document.hidden) return;
        if (Date.now() - this.lastActivityAt >= this.minutesToMs(this.settings.idleMinutes)) {
            this.lock();
        }
    }

    minutesToMs(value) {
        const minutes = Number(value);
        return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : Infinity;
    }

    lock() {
        if (!this.pinReady) {
            this.showPinSetup();
            return;
        }
        if (this.locked) return;

        this.removeSetupScreen();
        this.locked = true;
        document.body.classList.add("discord-lock-active");

        const overlay = this.element("div", {className: "discord-lock-overlay", role: "dialog", ariaModal: "true"});
        const card = this.element("form", {className: "discord-lock-card"});
        const emblem = this.element("div", {className: "discord-lock-emblem", textContent: "LOCK"});
        const title = this.element("h1", {textContent: "Discord is locked"});
        const description = this.element("p", {textContent: "Enter your PIN to continue."});
        const input = this.pinInput("PIN", false);
        input.autocomplete = "off";
        const error = this.element("div", {className: "discord-lock-error", ariaLive: "polite"});
        const button = this.element("button", {className: "discord-lock-primary", type: "submit", textContent: "Unlock"});

        card.append(emblem, title, description, input, error, button);
        overlay.append(card);
        document.body.append(overlay);
        this.lockOverlay = overlay;

        const keepFocusInside = event => {
            if (!this.locked || !this.lockOverlay) return;
            if (!this.lockOverlay.contains(event.target)) {
                event.stopPropagation();
                setTimeout(() => input.focus(), 0);
            }
        };
        overlay._discordLockFocusHandler = keepFocusInside;
        document.addEventListener("focusin", keepFocusInside, true);

        card.addEventListener("submit", async event => {
            event.preventDefault();
            const wait = this.blockedUntil - Date.now();
            if (wait > 0) {
                error.textContent = `Try again in ${Math.ceil(wait / 1000)} seconds.`;
                return;
            }

            button.disabled = true;
            error.textContent = "Checking…";
            try {
                if (await this.verifyPin(input.value)) {
                    this.unlock();
                    return;
                }
                this.failedAttempts += 1;
                const delay = this.computeLockoutMs(this.failedAttempts);
                if (delay > 0) this.blockedUntil = Date.now() + delay;
                input.value = "";
                error.textContent = delay > 0
                    ? `Incorrect PIN. Try again in ${Math.ceil(delay / 1000)} seconds.`
                    : "Incorrect PIN.";
            } catch (failure) {
                console.error(`[${PLUGIN_NAME}] PIN verification failed:`, failure);
                error.textContent = "Could not verify the PIN. Try again.";
            } finally {
                button.disabled = false;
                input.focus();
            }
        });

        requestAnimationFrame(() => input.focus());
    }

    unlock() {
        if (!this.locked) return;
        this.locked = false;
        this.failedAttempts = 0;
        this.blockedUntil = 0;
        this.lastActivityAt = Date.now();
        this.awaySince = null;
        document.body.classList.remove("discord-lock-active");
        this.removeLockScreen();
    }

    removeLockScreen() {
        if (!this.lockOverlay) return;
        if (this.lockOverlay._discordLockFocusHandler) {
            document.removeEventListener("focusin", this.lockOverlay._discordLockFocusHandler, true);
        }
        this.lockOverlay.remove();
        this.lockOverlay = null;
    }

    hasBlockingFocusLayer() {
        return Boolean(document.querySelector('[class*="standardSidebarView"]'));
    }

    showPinSetup() {
        if (this.locked || this.setupOverlay || this.pinReady) return;
        if (this.hasBlockingFocusLayer()) {
            this.toast("Create the PIN on this settings page, or close Settings and click Set Discord Lock PIN.", "warning");
            return;
        }

        const overlay = this.element("div", {className: "discord-lock-overlay discord-lock-setup", role: "dialog", ariaModal: "true"});
        const form = this.element("form", {className: "discord-lock-card"});
        const emblem = this.element("div", {className: "discord-lock-emblem", textContent: "SET"});
        const title = this.element("h1", {textContent: "Create your PIN"});
        const description = this.element("p", {textContent: `Choose ${PIN_MIN} to ${PIN_MAX} digits. Discord Lock cannot lock until setup is complete.`});
        const first = this.pinInput("New PIN", false);
        const second = this.pinInput("Confirm PIN", false);
        const revealRow = this.element("label", {className: "discord-lock-reveal"});
        const reveal = this.element("input", {type: "checkbox"});
        revealRow.append(reveal, document.createTextNode(" Show PIN while setting it"));
        const error = this.element("div", {className: "discord-lock-error", ariaLive: "polite"});
        const actions = this.element("div", {className: "discord-lock-actions"});
        const save = this.element("button", {className: "discord-lock-primary", type: "submit", textContent: "Save PIN"});
        const later = this.element("button", {className: "discord-lock-secondary", type: "button", textContent: "Set up later"});
        actions.append(save, later);
        form.append(emblem, title, description, first, second, revealRow, error, actions);
        overlay.append(form);
        document.body.append(overlay);
        this.setupOverlay = overlay;

        reveal.addEventListener("change", () => {
            first.type = reveal.checked ? "text" : "password";
            second.type = reveal.checked ? "text" : "password";
            first.focus();
        });
        later.addEventListener("click", () => this.removeSetupScreen());

        let saving = false;
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (saving) return;
            const firstPin = this.normalizePin(first.value);
            const secondPin = this.normalizePin(second.value);
            if (!this.isValidPin(firstPin)) {
                error.textContent = `Use ${PIN_MIN} to ${PIN_MAX} digits.`;
                first.focus();
                return;
            }
            if (firstPin !== secondPin) {
                error.textContent = "The PINs do not match.";
                second.focus();
                return;
            }

            saving = true;
            save.disabled = true;
            error.textContent = "Saving…";
            try {
                await this.saveUserPin(firstPin);
                this.removeSetupScreen();
                this.toast("Discord Lock PIN saved.", "success");
            } catch (failure) {
                console.error(`[${PLUGIN_NAME}] Could not save the PIN:`, failure);
                error.textContent = failure?.message || "Could not save the PIN.";
                save.disabled = false;
                saving = false;
            }
        });

        requestAnimationFrame(() => first.focus());
    }

    removeSetupScreen() {
        this.setupOverlay?.remove();
        this.setupOverlay = null;
    }

    pinInput(placeholder, reveal) {
        const input = this.element("input", {
            className: "discord-lock-pin-input",
            type: reveal ? "text" : "password",
            inputMode: "numeric",
            placeholder,
            maxLength: PIN_MAX,
            autocomplete: "new-password"
        });
        input.readOnly = false;
        input.disabled = false;
        input.tabIndex = 0;
        input.addEventListener("input", () => {
            const normalized = this.normalizePin(input.value);
            if (input.value !== normalized) input.value = normalized;
        });
        return input;
    }

    ensureLockButton() {
        this.removeLockButton();
        if (!this.settings.showLockButton || !this.started) return;
        const label = this.pinReady ? "Lock Discord" : "Set Discord Lock PIN";
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.cornerButton = library.register({id: "discord-lock", name: "Discord Lock", description: "Lock Discord with your PIN", icon: "🔒", badge: this.pinReady ? "" : "!", status: label, order: 1, open: () => this.pinReady ? this.lock() : this.showPinSetup()});
    }

    removeLockButton() {
        this.cornerButton?.remove();
        this.cornerButton = null;
    }

    getSettingsPanel() {
        const panel = this.element("div", {className: "discord-lock-settings"});
        const heading = this.element("h2", {textContent: "Discord Lock"});
        const intro = this.element("p", {
            textContent: this.pinReady
                ? "Your PIN is set. Change it below or adjust automatic locking."
                : "Create your PIN here. These fields stay inside BetterDiscord Settings, so they can always receive keyboard focus."
        });
        panel.append(heading, intro);

        if (this.pinError) panel.append(this.notice(this.pinError, true));
        panel.append(this.pinReady ? this.buildChangePinSection() : this.buildCreatePinSection());

        panel.append(
            this.numberSetting("Lock after inactivity", "Minutes without mouse or keyboard activity. Use 0 to disable.", "idleMinutes", 0, 1440),
            this.numberSetting("Lock after being away", "Minutes Discord may stay hidden or unfocused before locking when you return. Use 0 to disable.", "awayMinutes", 0, 1440),
            this.checkboxSetting("Lock when Discord starts", "Lock as soon as this plugin starts, after a PIN has been created.", "lockOnStart"),
            this.checkboxSetting("Show in Tiny Plugin Library", "Keep the Lock Discord action in the shared tiny plugin launcher.", "showLockButton", () => this.ensureLockButton()),
            this.checkboxSetting("Hide in-app notifications while locked", "Hide Discord toast and notification layers behind the privacy screen.", "hideToastsWhileLocked")
        );
        return panel;
    }

    buildCreatePinSection() {
        const section = this.element("section", {className: "discord-lock-settings-card"});
        const title = this.element("h3", {textContent: "Create PIN"});
        const first = this.pinInput("New PIN", false);
        const second = this.pinInput("Confirm PIN", false);
        const revealLabel = this.element("label", {className: "discord-lock-settings-check"});
        const reveal = this.element("input", {type: "checkbox"});
        revealLabel.append(reveal, document.createTextNode(" Show PIN while setting it"));
        const status = this.element("div", {className: "discord-lock-settings-status", ariaLive: "polite"});
        const save = this.element("button", {className: "discord-lock-settings-button", type: "button", textContent: "Save PIN"});

        reveal.addEventListener("change", () => {
            first.type = reveal.checked ? "text" : "password";
            second.type = reveal.checked ? "text" : "password";
        });
        save.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            const firstPin = this.normalizePin(first.value);
            const secondPin = this.normalizePin(second.value);
            if (!this.isValidPin(firstPin)) {
                status.textContent = `Use ${PIN_MIN} to ${PIN_MAX} digits.`;
                status.dataset.type = "error";
                first.focus();
                return;
            }
            if (firstPin !== secondPin) {
                status.textContent = "The PINs do not match.";
                status.dataset.type = "error";
                second.focus();
                return;
            }

            save.disabled = true;
            status.textContent = "Saving…";
            status.dataset.type = "";
            try {
                await this.saveUserPin(firstPin);
                first.value = "";
                second.value = "";
                status.textContent = "PIN saved. You can close Settings and click Lock Discord to test it.";
                status.dataset.type = "success";
                save.textContent = "PIN saved";
                this.toast("Discord Lock PIN saved.", "success");
            } catch (failure) {
                console.error(`[${PLUGIN_NAME}] Could not save the PIN:`, failure);
                status.textContent = failure?.message || "Could not save the PIN.";
                status.dataset.type = "error";
                save.disabled = false;
            }
        });

        section.append(title, first, second, revealLabel, status, save);
        return section;
    }

    buildChangePinSection() {
        const section = this.element("section", {className: "discord-lock-settings-card"});
        const title = this.element("h3", {textContent: "Change PIN"});
        const current = this.pinInput("Current PIN", false);
        const next = this.pinInput("New PIN", false);
        const confirm = this.pinInput("Confirm new PIN", false);
        const status = this.element("div", {className: "discord-lock-settings-status", ariaLive: "polite"});
        const save = this.element("button", {className: "discord-lock-settings-button", type: "button", textContent: "Change PIN"});

        save.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            const newPin = this.normalizePin(next.value);
            if (!(await this.verifyPin(current.value))) {
                status.textContent = "The current PIN is incorrect.";
                status.dataset.type = "error";
                current.focus();
                return;
            }
            if (!this.isValidPin(newPin)) {
                status.textContent = `Use ${PIN_MIN} to ${PIN_MAX} digits for the new PIN.`;
                status.dataset.type = "error";
                next.focus();
                return;
            }
            if (newPin !== this.normalizePin(confirm.value)) {
                status.textContent = "The new PINs do not match.";
                status.dataset.type = "error";
                confirm.focus();
                return;
            }

            save.disabled = true;
            status.textContent = "Saving…";
            try {
                await this.saveUserPin(newPin);
                current.value = next.value = confirm.value = "";
                status.textContent = "PIN changed.";
                status.dataset.type = "success";
                save.disabled = false;
                this.toast("Discord Lock PIN changed.", "success");
            } catch (failure) {
                console.error(`[${PLUGIN_NAME}] Could not change the PIN:`, failure);
                status.textContent = failure?.message || "Could not change the PIN.";
                status.dataset.type = "error";
                save.disabled = false;
            }
        });

        section.append(title, current, next, confirm, status, save);
        return section;
    }

    numberSetting(title, description, key, minimum, maximum) {
        const row = this.settingRow(title, description);
        const input = this.element("input", {
            className: "discord-lock-setting-number",
            type: "number",
            min: String(minimum),
            max: String(maximum),
            step: "1",
            value: String(this.settings[key])
        });
        input.addEventListener("change", () => {
            const value = Number(input.value);
            this.settings[key] = Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : DEFAULT_SETTINGS[key];
            input.value = String(this.settings[key]);
            this.saveSettings();
        });
        row.append(input);
        return row;
    }

    checkboxSetting(title, description, key, afterChange) {
        const row = this.settingRow(title, description);
        const input = this.element("input", {className: "discord-lock-setting-check", type: "checkbox"});
        input.checked = Boolean(this.settings[key]);
        input.addEventListener("change", () => {
            this.settings[key] = input.checked;
            this.saveSettings();
            afterChange?.();
        });
        row.append(input);
        return row;
    }

    settingRow(title, description) {
        const row = this.element("label", {className: "discord-lock-setting-row"});
        const text = this.element("span", {className: "discord-lock-setting-copy"});
        text.append(
            this.element("strong", {textContent: title}),
            this.element("small", {textContent: description})
        );
        row.append(text);
        return row;
    }

    notice(message, isError = false) {
        return this.element("div", {
            className: `discord-lock-notice${isError ? " discord-lock-notice-error" : ""}`,
            textContent: message
        });
    }

    element(tag, properties = {}) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === "className") node.className = value;
            else if (key === "textContent") node.textContent = value;
            else if (key === "ariaLive") node.setAttribute("aria-live", value);
            else if (key === "ariaModal") node.setAttribute("aria-modal", value);
            else if (value !== undefined && value !== null) node.setAttribute(key, value);
        }
        return node;
    }

    saveSettings() {
        this.saveData("settings", this.settings);
    }

    loadData(key) {
        try {
            return globalThis.BdApi?.Data?.load(PLUGIN_NAME, key);
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not load ${key}:`, error);
            return undefined;
        }
    }

    saveData(key, value) {
        if (!globalThis.BdApi?.Data?.save) throw new Error("BetterDiscord data storage is unavailable.");
        globalThis.BdApi.Data.save(PLUGIN_NAME, key, value);
    }

    toast(message, type = "info") {
        if (globalThis.BdApi?.UI?.showToast) {
            globalThis.BdApi.UI.showToast(message, {type, timeout: 6000});
        } else {
            console.log(`[${PLUGIN_NAME}] ${message}`);
        }
    }

    addStyles() {
        const css = `
            .discord-lock-overlay {
                position: fixed !important;
                inset: 0 !important;
                z-index: 2147483647 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                padding: 24px !important;
                background: #101116 !important;
                color: #f2f3f5 !important;
                font-family: var(--font-primary, Arial, sans-serif) !important;
                pointer-events: auto !important;
                user-select: none !important;
            }
            .discord-lock-card {
                width: min(390px, calc(100vw - 48px)) !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 10px !important;
                margin: 0 !important;
                padding: 0 !important;
                background: transparent !important;
                pointer-events: auto !important;
            }
            .discord-lock-card h1 { margin: 7px 0 0 !important; text-align: center !important; font-size: 25px !important; color: #f2f3f5 !important; }
            .discord-lock-card p { margin: 0 0 8px !important; text-align: center !important; color: #949ba4 !important; font-size: 13px !important; }
            .discord-lock-emblem {
                width: 60px !important; height: 60px !important; margin: 0 auto !important;
                display: grid !important; place-items: center !important;
                border: 2px solid #5c6370 !important; border-radius: 50% !important;
                color: #e3e5e8 !important; font-size: 20px !important;
            }
            .discord-lock-pin-input {
                display: block !important; width: 100% !important; height: 48px !important;
                box-sizing: border-box !important; padding: 0 14px !important;
                border: 1px solid #3f4147 !important; border-radius: 7px !important;
                outline: none !important; background: #17181d !important; color: #f2f3f5 !important;
                font: 500 18px/1 var(--font-primary, Arial, sans-serif) !important;
                letter-spacing: .35em !important; text-align: center !important;
                pointer-events: auto !important; user-select: text !important; cursor: text !important;
                -webkit-user-select: text !important;
            }
            .discord-lock-pin-input:focus { border-color: #5865f2 !important; box-shadow: 0 0 0 1px #5865f2 !important; }
            .discord-lock-pin-input::placeholder { color: #7f838b !important; opacity: 1 !important; }
            .discord-lock-error { min-height: 18px !important; color: #fa777c !important; text-align: center !important; font-size: 13px !important; }
            .discord-lock-actions { display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 8px !important; }
            .discord-lock-primary, .discord-lock-secondary {
                min-height: 36px !important; padding: 8px 14px !important; border: 0 !important; border-radius: 5px !important;
                color: white !important; font-weight: 700 !important; cursor: pointer !important; pointer-events: auto !important;
            }
            .discord-lock-primary { background: #5865f2 !important; }
            .discord-lock-primary:hover { background: #4752c4 !important; }
            .discord-lock-secondary { background: #4e5058 !important; }
            .discord-lock-primary:disabled { opacity: .55 !important; cursor: wait !important; }
            .discord-lock-reveal { display: flex !important; justify-content: center !important; align-items: center !important; color: #b5bac1 !important; font-size: 12px !important; cursor: pointer !important; pointer-events: auto !important; }
            .discord-lock-reveal input { pointer-events: auto !important; }
            .discord-lock-corner-button {
                position: fixed !important; left: 6px !important; bottom: 6px !important; z-index: 1000 !important;
                display: grid !important; place-items: center !important; width: 30px !important; height: 30px !important;
                padding: 0 !important; border: 1px solid rgba(255,255,255,.08) !important; border-radius: 50% !important;
                background: rgba(30,31,36,.72) !important; color: white !important;
                box-shadow: 0 2px 8px rgba(0,0,0,.2) !important; cursor: pointer !important; opacity: .34 !important;
                transition: opacity .15s ease, transform .15s ease, background .15s ease !important;
            }
            .discord-lock-corner-button:hover, .discord-lock-corner-button:focus-visible { background: #2b2d31 !important; opacity: 1 !important; transform: scale(1.07) !important; }
            .discord-lock-button-icon { font-size: 14px !important; line-height: 1 !important; filter: grayscale(1) !important; }
            .discord-lock-setup-dot { position: absolute !important; right: -1px !important; top: -1px !important; width: 7px !important; height: 7px !important; border: 2px solid #1e1f24 !important; border-radius: 50% !important; background: #f0b232 !important; }
            body.discord-lock-active > :not(.discord-lock-overlay) { pointer-events: none !important; }
            body.discord-lock-active [class*="toast" i], body.discord-lock-active [class*="notification" i] { visibility: hidden !important; }
            .discord-lock-settings { color: var(--text-normal); padding: 8px 4px 40px; }
            .discord-lock-settings h2 { margin: 0 0 6px; }
            .discord-lock-settings > p { color: var(--text-muted); margin: 0 0 18px; line-height: 1.45; }
            .discord-lock-settings-card { display: flex; flex-direction: column; gap: 9px; padding: 16px; margin: 0 0 20px; border: 1px solid var(--background-modifier-accent); border-radius: 8px; background: var(--background-secondary); }
            .discord-lock-settings-card h3 { margin: 0 0 3px; }
            .discord-lock-settings .discord-lock-pin-input { max-width: 430px !important; text-align: left !important; }
            .discord-lock-settings-check { color: var(--text-muted); cursor: pointer; }
            .discord-lock-settings-status { min-height: 18px; color: var(--text-muted); font-size: 13px; }
            .discord-lock-settings-status[data-type="error"] { color: var(--text-danger); }
            .discord-lock-settings-status[data-type="success"] { color: var(--text-positive); }
            .discord-lock-settings-button { align-self: flex-start; padding: 8px 16px; border: 0; border-radius: 4px; background: #5865f2; color: white; font-weight: 600; cursor: pointer; }
            .discord-lock-settings-button:disabled { opacity: .55; }
            .discord-lock-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 0; border-top: 1px solid var(--background-modifier-accent); cursor: pointer; }
            .discord-lock-setting-copy { display: flex; flex-direction: column; gap: 4px; }
            .discord-lock-setting-copy small { color: var(--text-muted); line-height: 1.35; }
            .discord-lock-setting-number { width: 86px; box-sizing: border-box; padding: 8px; border: 1px solid var(--input-border); border-radius: 4px; background: var(--input-background); color: var(--text-normal); }
            .discord-lock-setting-check { width: 20px; height: 20px; flex: 0 0 auto; }
            .discord-lock-notice { padding: 10px; margin-bottom: 12px; border-radius: 5px; background: var(--background-secondary); }
            .discord-lock-notice-error { color: var(--text-danger); }
        `;
        if (globalThis.BdApi?.DOM?.addStyle) globalThis.BdApi.DOM.addStyle(STYLE_ID, css);
        else {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = css;
            document.head.append(style);
        }
    }

    removeStyles() {
        if (globalThis.BdApi?.DOM?.removeStyle) globalThis.BdApi.DOM.removeStyle(STYLE_ID);
        document.getElementById(STYLE_ID)?.remove();
    }
};
