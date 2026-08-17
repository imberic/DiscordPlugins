/**
 * @name HiddenTyping
 * @author tiny
 * @version 1.1.0
 * @description Adds a message-bar toggle that prevents Discord from telling others when you are typing.
 */

"use strict";

const PLUGIN_NAME = "HiddenTyping";
const STYLE_ID = "tiny-hidden-typing-styles";
const BUTTON_SELECTOR = "[data-tiny-hidden-typing-button]";

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showButton: true
});

module.exports = class HiddenTyping {
    constructor() {
        this.api = null;
        this.settings = {...DEFAULT_SETTINGS};
        this.webpack = null;
        this.typingModule = null;
        this.restModule = null;
        this.selectedChannelStore = null;
        this.observer = null;
        this.buttonTimer = null;
        this.unpatches = [];
        this.started = false;
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.settings = this.sanitizeSettings(this.load("settings"));
        this.findModules();
        this.patchTyping();
        this.addStyles();
        this.startButtonObserver();
        this.ensureButtons();
        if (!this.typingModule && !this.restModule) {
            this.toast("Discord's typing module was not found. Reload Discord to retry.", "error");
        }
    }

    stop() {
        this.started = false;
        this.stopButtonObserver();
        for (const unpatch of this.unpatches.splice(0)) {
            try { unpatch?.(); } catch (_) {}
        }
        try { this.api?.Patcher?.unpatchAll?.(); } catch (_) {}
        try { globalThis.BdApi?.Patcher?.unpatchAll?.(PLUGIN_NAME); } catch (_) {}
        this.removeButtons();
        this.removeStyles();
    }

    initializeApi() {
        try {
            if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not create a scoped BdApi instance:`, error);
        }
        this.webpack = this.api?.Webpack || globalThis.BdApi?.Webpack || null;
    }

    sanitizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        return {
            enabled: source.enabled ?? DEFAULT_SETTINGS.enabled,
            showButton: source.showButton ?? DEFAULT_SETTINGS.showButton
        };
    }

    findModules() {
        const webpack = this.webpack;
        try {
            this.typingModule = webpack?.getByKeys?.("startTyping", "stopTyping")
                || webpack?.getByKeys?.("startTyping")
                || webpack?.getModule?.(
                    module => typeof module?.startTyping === "function",
                    {searchExports: true}
                )
                || null;
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not find Discord's typing controller:`, error);
        }
        try {
            this.restModule = webpack?.getModule?.(
                module => typeof module?.post === "function"
                    && typeof module?.get === "function"
                    && (typeof module?.del === "function" || typeof module?.delete === "function"),
                {searchExports: true}
            ) || null;
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not find Discord's REST controller:`, error);
        }
        try {
            this.selectedChannelStore = webpack?.getStore?.("SelectedChannelStore") || null;
        } catch (_) {
            this.selectedChannelStore = null;
        }
    }

    patchTyping() {
        if (this.typingModule?.startTyping) {
            this.patchInstead(this.typingModule, "startTyping", (_thisObject, args, original) => {
                if (this.settings.enabled) return undefined;
                return original(...args);
            });
        }
        if (this.restModule?.post) {
            this.patchInstead(this.restModule, "post", (_thisObject, args, original) => {
                if (this.settings.enabled && this.isTypingRequest(args?.[0])) {
                    return Promise.resolve({ok: true, status: 204, body: null});
                }
                return original(...args);
            });
        }
    }

    patchInstead(target, method, callback) {
        try {
            if (this.api?.Patcher?.instead) {
                const unpatch = this.api.Patcher.instead(target, method, callback);
                if (typeof unpatch === "function") this.unpatches.push(unpatch);
                return;
            }
            if (globalThis.BdApi?.Patcher?.instead) {
                const unpatch = globalThis.BdApi.Patcher.instead(PLUGIN_NAME, target, method, callback);
                if (typeof unpatch === "function") this.unpatches.push(unpatch);
            }
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not patch ${method}:`, error);
        }
    }

    isTypingRequest(request) {
        const url = typeof request === "string"
            ? request
            : request?.url || request?.path || request?.endpoint || "";
        return /\/channels\/\d+\/typing(?:[/?#]|$)/i.test(String(url));
    }

    setEnabled(enabled, announce = true) {
        this.settings.enabled = Boolean(enabled);
        this.save("settings", this.settings);
        this.updateButtons();
        if (this.settings.enabled) this.stopCurrentTyping();
        if (announce) this.toast(this.settings.enabled ? "Typing is now hidden." : "Typing is now visible.", "success");
    }

    stopCurrentTyping() {
        const channelId = this.selectedChannelStore?.getChannelId?.()
            || String(globalThis.location?.pathname || "").match(/^\/channels\/(?:@me|\d+)\/(\d+)/)?.[1];
        if (!channelId || typeof this.typingModule?.stopTyping !== "function") return;
        try { this.typingModule.stopTyping(String(channelId)); } catch (_) {}
    }

    startButtonObserver() {
        if (this.observer || !globalThis.document?.body || typeof globalThis.MutationObserver !== "function") return;
        this.observer = new MutationObserver(() => this.scheduleEnsureButtons());
        this.observer.observe(document.getElementById("app-mount") || document.body, {childList: true, subtree: true});
    }

    stopButtonObserver() {
        this.observer?.disconnect();
        this.observer = null;
        if (this.buttonTimer) clearTimeout(this.buttonTimer);
        this.buttonTimer = null;
    }

    scheduleEnsureButtons() {
        if (this.buttonTimer) return;
        this.buttonTimer = setTimeout(() => {
            this.buttonTimer = null;
            this.ensureButtons();
        }, 40);
    }

    ensureButtons() {
        if (!this.started || !globalThis.document) return;
        if (!this.settings.showButton) {
            this.removeButtons();
            return;
        }
        const composers = document.querySelectorAll('[contenteditable="true"][role="textbox"]');
        for (const composer of composers) {
            if (!this.isVisible(composer)) continue;
            const root = composer.closest("form, [class*=channelTextArea]");
            if (!root || root.querySelector(BUTTON_SELECTOR)) continue;
            const hosts = [...root.querySelectorAll('[class*="buttons"]')];
            const host = hosts.find(candidate => this.isVisible(candidate) && candidate.querySelector("button, [role=button]"))
                || hosts.find(candidate => this.isVisible(candidate));
            if (!host) continue;
            host.insertBefore(this.createButton(), host.firstChild);
        }
        this.updateButtons();
    }

    createButton() {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tiny-hidden-typing-button";
        button.setAttribute("data-tiny-hidden-typing-button", "true");
        button.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect class="tiny-hidden-typing-keyboard" x="2.5" y="5.5" width="19" height="13" rx="2.2"></rect>
                <path class="tiny-hidden-typing-keys" d="M6 9h.01M9 9h.01M12 9h.01M15 9h.01M18 9h.01M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01M7 15h10"></path>
                <path class="tiny-hidden-typing-slash" d="M4 3l16 18"></path>
            </svg>`;
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.setEnabled(!this.settings.enabled);
        });
        return button;
    }

    updateButtons() {
        if (!globalThis.document) return;
        for (const button of document.querySelectorAll(BUTTON_SELECTOR)) {
            button.classList.toggle("active", this.settings.enabled);
            button.setAttribute("aria-pressed", String(this.settings.enabled));
            button.setAttribute("aria-label", this.settings.enabled ? "Typing hidden — click to show typing" : "Typing visible — click to hide typing");
            button.title = this.settings.enabled ? "Typing hidden" : "Typing visible";
        }
    }

    removeButtons() {
        if (!globalThis.document) return;
        for (const button of document.querySelectorAll(BUTTON_SELECTOR)) button.remove();
    }

    isVisible(element) {
        return Boolean(element?.isConnected && element.getClientRects?.().length);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "tiny-hidden-typing-settings";
        const heading = document.createElement("h2");
        heading.textContent = "Hidden Typing";
        const description = document.createElement("p");
        description.textContent = "Control whether Discord sends typing notifications to other people.";
        panel.append(heading, description);
        panel.append(
            this.checkboxSetting("Hide typing notifications", "Block outgoing typing indicators by default.", "enabled", value => this.setEnabled(value, false)),
            this.checkboxSetting("Show message-bar button", "Add the keyboard toggle beside Discord's message-bar buttons.", "showButton", () => this.ensureButtons())
        );
        return panel;
    }

    checkboxSetting(title, description, key, afterChange) {
        const row = document.createElement("label");
        row.className = "tiny-hidden-typing-setting";
        const copy = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = title;
        const small = document.createElement("small");
        small.textContent = description;
        copy.append(strong, small);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(this.settings[key]);
        input.addEventListener("change", () => {
            this.settings[key] = input.checked;
            this.save("settings", this.settings);
            afterChange?.(input.checked);
            if (key === "showButton" && !input.checked) this.removeButtons();
        });
        row.append(copy, input);
        return row;
    }

    addStyles() {
        const css = `
            .tiny-hidden-typing-button {
                display: flex !important; align-items: center !important; justify-content: center !important;
                flex: 0 0 auto !important; width: 32px !important; height: 32px !important; margin: 0 1px !important;
                padding: 0 !important; border: 0 !important; border-radius: 5px !important;
                background: transparent !important; color: var(--interactive-normal,#b5bac1) !important;
                cursor: pointer !important; opacity: .82 !important; transition: color .15s ease, background .15s ease, opacity .15s ease !important;
            }
            .tiny-hidden-typing-button:hover { background: var(--background-modifier-hover,rgba(255,255,255,.06)) !important; color: var(--interactive-hover,#dbdee1) !important; opacity: 1 !important; }
            .tiny-hidden-typing-button.active { background: rgba(88,101,242,.14) !important; color: #8e98f5 !important; opacity: 1 !important; }
            .tiny-hidden-typing-button.active:hover { background: rgba(88,101,242,.23) !important; color: #aeb5ff !important; }
            .tiny-hidden-typing-button svg { width: 21px !important; height: 21px !important; overflow: visible !important; }
            .tiny-hidden-typing-keyboard { fill: none !important; stroke: currentColor !important; stroke-width: 1.8 !important; }
            .tiny-hidden-typing-keys { fill: none !important; stroke: currentColor !important; stroke-width: 2.2 !important; stroke-linecap: round !important; }
            .tiny-hidden-typing-slash { display: none !important; fill: none !important; stroke: currentColor !important; stroke-width: 2.2 !important; stroke-linecap: round !important; filter: drop-shadow(0 0 2px var(--background-primary,#313338)) !important; }
            .tiny-hidden-typing-button.active .tiny-hidden-typing-slash { display: block !important; }
            .tiny-hidden-typing-settings { padding: 8px 4px 30px; color: var(--text-normal); }
            .tiny-hidden-typing-settings h2 { margin: 0 0 5px; }
            .tiny-hidden-typing-settings > p { margin: 0 0 15px; color: var(--text-muted); }
            .tiny-hidden-typing-setting { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 15px 0; border-top: 1px solid var(--background-modifier-accent); cursor: pointer; }
            .tiny-hidden-typing-setting > span { display: flex; flex-direction: column; gap: 4px; }
            .tiny-hidden-typing-setting small { color: var(--text-muted); line-height: 1.35; }
            .tiny-hidden-typing-setting input { width: 20px; height: 20px; flex: 0 0 auto; }
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
        globalThis.document?.getElementById?.(STYLE_ID)?.remove();
    }

    load(key) {
        try {
            if (this.api?.Data?.load) return this.api.Data.load(key);
            return globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key);
        } catch (_) {
            return undefined;
        }
    }

    save(key, value) {
        try {
            if (this.api?.Data?.save) this.api.Data.save(key, value);
            else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Could not save ${key}:`, error);
        }
    }

    toast(message, type = "info") {
        const ui = this.api?.UI || globalThis.BdApi?.UI;
        if (ui?.showToast) ui.showToast(message, {type, timeout: 3500});
        else console.log(`[${PLUGIN_NAME}] ${message}`);
    }
};
