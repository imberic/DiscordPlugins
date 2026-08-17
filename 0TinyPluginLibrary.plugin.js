/**
 * @name TinyPluginLibrary
 * @author tiny
 * @version 1.3.1
 * @description Required shared launcher and UI library for tiny's Discord plugins.
 */

"use strict";

const PLUGIN_NAME = "TinyPluginLibrary";
const GLOBAL_KEY = "TinyPluginLibrary";
const REGISTRY_KEY = "__TinyPluginLibraryRegistry";
const STYLE_ID = "tiny-plugin-library-styles";

module.exports = class TinyPluginLibrary {
    constructor() {
        this.api = null;
        this.registry = globalThis[REGISTRY_KEY] ||= {entries: new Map(), listeners: new Set()};
        this.entries = this.registry.entries;
        this.refreshListener = () => this.refresh();
        this.button = null;
        this.panel = null;
        this.outsideHandler = null;
        this.escapeHandler = null;
        this.publicApi = null;
        this.searchQuery = "";
    }

    start() {
        this.initializeApi();
        this.registry.listeners.add(this.refreshListener);
        this.addStyles();
        this.installPublicApi();
        this.ensureButton();
        globalThis.document?.dispatchEvent?.(new CustomEvent("tiny-plugin-library-ready"));
    }

    stop() {
        this.closePanel();
        this.button?.remove();
        this.button = null;
        this.removeStyles();
        this.registry.listeners.delete(this.refreshListener);
        if (globalThis[GLOBAL_KEY] === this.publicApi) delete globalThis[GLOBAL_KEY];
    }

    initializeApi() {
        try { if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME); }
        catch (_) {}
    }

    installPublicApi() {
        this.publicApi = Object.freeze({
            version: "1.3.1",
            register: entry => this.register(entry),
            unregister: id => this.unregister(id),
            update: (id, patch) => this.update(id, patch),
            open: () => this.openPanel(),
            close: () => this.closePanel(),
            has: id => this.entries.has(String(id))
        });
        globalThis[GLOBAL_KEY] = this.publicApi;
    }

    register(rawEntry) {
        const id = String(rawEntry?.id || "").trim();
        if (!id || typeof rawEntry?.open !== "function") throw new Error("TinyPluginLibrary.register requires an id and open function");
        const entry = {
            id,
            name: String(rawEntry.name || id),
            description: String(rawEntry.description || ""),
            icon: String(rawEntry.icon || "•").slice(0, 4),
            badge: rawEntry.badge == null ? "" : String(rawEntry.badge),
            status: String(rawEntry.status || ""),
            open: rawEntry.open,
            order: Number(rawEntry.order) || 100
        };
        this.entries.set(id, entry);
        this.notifyRegistry();
        let removed = false;
        return Object.freeze({
            remove: () => { if (!removed) { removed = true; this.unregister(id); } },
            update: patch => { if (!removed) this.update(id, patch); }
        });
    }

    unregister(id) {
        this.entries.delete(String(id));
        this.notifyRegistry();
    }

    update(id, patch) {
        const entry = this.entries.get(String(id));
        if (!entry || !patch || typeof patch !== "object") return false;
        for (const key of ["name", "description", "icon", "badge", "status", "order"]) {
            if (patch[key] !== undefined) entry[key] = key === "order" ? Number(patch[key]) || 100 : String(patch[key] ?? "");
        }
        if (typeof patch.open === "function") entry.open = patch.open;
        this.notifyRegistry();
        return true;
    }

    notifyRegistry() {
        for (const listener of [...this.registry.listeners]) {
            try { listener(); } catch (_) {}
        }
    }

    ensureButton() {
        this.button?.remove();
        if (!globalThis.document?.body) return;
        const button = this.el("button", {
            className: "tiny-library-button",
            type: "button",
            title: "Open tiny's plugin library",
            "aria-label": "Open tiny's plugin library"
        });
        button.append(this.makeGridIcon("tiny-library-button-mark"), this.el("span", {className: "tiny-library-button-count", textContent: "0"}));
        button.addEventListener("click", event => {
            event.stopPropagation();
            this.panel ? this.closePanel() : this.openPanel();
        });
        document.body.append(button);
        this.button = button;
        this.refreshButton();
    }

    refresh() {
        this.refreshButton();
        if (this.panel) this.renderEntries();
    }

    refreshButton() {
        if (!this.button) return;
        const count = this.entries.size;
        this.button.dataset.count = String(count);
        this.button.title = `${count} tiny plugin${count === 1 ? "" : "s"}`;
        const badge = this.button.querySelector(".tiny-library-button-count");
        if (badge) { badge.textContent = count > 99 ? "99+" : String(count); badge.hidden = !count; }
    }

    openPanel() {
        this.closePanel();
        if (!globalThis.document?.body) return;
        this.searchQuery = "";
        const panel = this.el("section", {className: "tiny-library-panel", role: "dialog", "aria-label": "tiny plugin library"});
        const header = this.el("header", {className: "tiny-library-header"});
        const brand = this.el("div", {className: "tiny-library-brand"});
        const heading = this.el("div", {className: "tiny-library-heading"});
        heading.append(this.el("strong", {textContent: "Tiny Plugins"}), this.el("small", {className: "tiny-library-subtitle", textContent: `${this.entries.size} plugins enabled` }));
        const headerIcon = this.el("span", {className: "tiny-library-header-icon"});
        headerIcon.append(this.makeGridIcon("tiny-library-header-mark"));
        brand.append(headerIcon, heading);
        const close = this.el("button", {className: "tiny-library-close", type: "button", textContent: "×", title: "Close"});
        close.addEventListener("click", () => this.closePanel());
        header.append(brand, close);
        const searchWrap = this.el("label", {className: "tiny-library-search"});
        const search = this.el("input", {type: "search", placeholder: "Search plugins", "aria-label": "Search tiny plugins", autocomplete: "off"});
        search.addEventListener("input", () => { this.searchQuery = search.value; this.renderEntries(false); });
        searchWrap.append(search);
        const footer = this.el("footer", {className: "tiny-library-footer"});
        footer.append(this.el("span", {textContent: "made by tiny"}), this.el("span", {className: "tiny-library-footer-count", textContent: `${this.entries.size} ready`}));
        panel.append(header, searchWrap, this.el("div", {className: "tiny-library-list"}), footer);
        document.body.append(panel);
        this.panel = panel;
        this.renderEntries(false);
        setTimeout(() => search.focus());
        this.outsideHandler = event => {
            if (!this.panel?.contains(event.target) && !this.button?.contains(event.target)) this.closePanel();
        };
        this.escapeHandler = event => { if (event.key === "Escape") this.closePanel(); };
        setTimeout(() => document.addEventListener("mousedown", this.outsideHandler, true));
        document.addEventListener("keydown", this.escapeHandler, true);
    }

    renderEntries(preserveScroll = true) {
        const list = this.panel?.querySelector(".tiny-library-list");
        if (!list) return;
        const previousScrollTop = preserveScroll ? list.scrollTop : 0;
        list.textContent = "";
        const query = this.searchQuery.trim().toLowerCase();
        const allEntries = [...this.entries.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        const entries = query ? allEntries.filter(entry => `${entry.name} ${entry.description} ${entry.status}`.toLowerCase().includes(query)) : allEntries;
        const subtitle = this.panel.querySelector(".tiny-library-subtitle");
        const footerCount = this.panel.querySelector(".tiny-library-footer-count");
        if (subtitle) subtitle.textContent = `${this.entries.size} plugin${this.entries.size === 1 ? "" : "s"} enabled`;
        if (footerCount) footerCount.textContent = query ? `${entries.length} found` : `${this.entries.size} ready`;
        if (!entries.length) {
            const empty = this.el("div", {className: "tiny-library-empty"});
            empty.append(this.el("span", {textContent: query ? "⌕" : "T"}), this.el("strong", {textContent: query ? "No plugins found" : "Nothing here yet"}), this.el("small", {textContent: query ? "Try a different search." : "Enabled tiny plugins will appear here."}));
            list.append(empty);
            list.scrollTop = previousScrollTop;
            return;
        }
        for (const entry of entries) {
            const button = this.el("button", {className: "tiny-library-entry", type: "button", title: entry.description || entry.name});
            const icon = this.el("span", {className: "tiny-library-icon", textContent: entry.icon});
            const copy = this.el("span", {className: "tiny-library-copy"});
            copy.append(this.el("strong", {textContent: entry.name}), this.el("small", {textContent: entry.description || "Open plugin"}));
            if (entry.status) copy.append(this.el("em", {textContent: entry.status}));
            button.append(icon, copy);
            if (entry.badge) button.append(this.el("span", {className: "tiny-library-badge", textContent: entry.badge}));
            button.addEventListener("click", () => {
                this.closePanel();
                try { entry.open(); } catch (error) { console.error(`[${PLUGIN_NAME}] Could not open ${entry.name}:`, error); this.toast(`Could not open ${entry.name}`, "error"); }
            });
            list.append(button);
        }
        list.scrollTop = previousScrollTop;
    }

    makeGridIcon(className) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", className);
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        for (const [x, y] of [[3, 3], [13, 3], [3, 13], [13, 13]]) {
            const square = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            square.setAttribute("x", String(x));
            square.setAttribute("y", String(y));
            square.setAttribute("width", "8");
            square.setAttribute("height", "8");
            square.setAttribute("rx", "2");
            square.setAttribute("fill", "currentColor");
            svg.append(square);
        }
        return svg;
    }

    closePanel() {
        if (this.outsideHandler && globalThis.document) document.removeEventListener("mousedown", this.outsideHandler, true);
        if (this.escapeHandler && globalThis.document) document.removeEventListener("keydown", this.escapeHandler, true);
        this.outsideHandler = null;
        this.escapeHandler = null;
        this.panel?.remove();
        this.panel = null;
    }

    getSettingsPanel() {
        const panel = this.el("div", {className: "tiny-library-settings"});
        panel.append(
            this.el("h2", {textContent: "Tiny Plugin Library"}),
            this.el("p", {textContent: "Required by tiny's plugins. It replaces their separate floating buttons with one compact launcher."})
        );
        const open = this.el("button", {type: "button", textContent: "Open plugin library"});
        open.addEventListener("click", () => this.openPanel());
        panel.append(open);
        return panel;
    }

    addStyles() {
        const css = `
            .tiny-library-button {
                position: fixed !important; right: 8px !important; top: 74px !important; z-index: 1100 !important;
                display: grid !important; place-items: center !important; width: 36px !important; height: 36px !important;
                padding: 0 !important; border: 1px solid rgba(190,195,255,.26) !important; border-radius: 12px !important;
                background: linear-gradient(145deg,rgba(55,58,76,.96),rgba(22,23,29,.96)) !important; color: white !important;
                opacity: .8 !important; cursor: pointer !important; backdrop-filter: blur(12px) !important;
                box-shadow: 0 7px 22px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.08) !important;
                transition: transform .16s ease, opacity .16s ease, border-color .16s ease, box-shadow .16s ease !important;
            }
            .tiny-library-button:hover, .tiny-library-button:focus-visible {
                opacity: 1 !important; transform: translateY(-1px) scale(1.04) !important;
                border-color: rgba(150,157,255,.72) !important;
                box-shadow: 0 9px 28px rgba(0,0,0,.45), 0 0 0 3px rgba(88,101,242,.13) !important;
            }
            .tiny-library-button:active { transform: scale(.96) !important; }
            .tiny-library-button[data-count="0"] { opacity: .42 !important; }
            .tiny-library-button-logo, .tiny-library-brand-logo {
                display: grid !important; grid-template-columns: repeat(2,1fr) !important; gap: 3px !important;
            }
            .tiny-library-button-logo { width: 15px !important; height: 15px !important; }
            .tiny-library-button-logo i, .tiny-library-brand-logo i {
                display: block !important; border-radius: 50% !important; background: currentColor !important;
                box-shadow: 0 0 8px currentColor !important;
            }
            .tiny-library-button-logo i:nth-child(2), .tiny-library-button-logo i:nth-child(3),
            .tiny-library-brand-logo i:nth-child(2), .tiny-library-brand-logo i:nth-child(3) { opacity: .52 !important; }
            .tiny-library-button-count {
                position: absolute !important; right: -6px !important; top: -6px !important; display: grid !important;
                place-items: center !important; min-width: 18px !important; height: 18px !important; padding: 0 4px !important;
                box-sizing: border-box !important; border: 2px solid #111214 !important; border-radius: 10px !important;
                background: #7c83ff !important; color: white !important;
                font: 800 10px var(--font-primary,Arial,sans-serif) !important;
            }
            .tiny-library-button-count[hidden] { display: none !important; }

            @keyframes tiny-library-enter {
                from { opacity: 0; transform: translateY(-7px) scale(.975); }
                to { opacity: 1; transform: none; }
            }
            .tiny-library-panel {
                position: fixed !important; right: 51px !important; top: 67px !important; z-index: 2147483000 !important;
                display: flex !important; flex-direction: column !important; width: min(410px,calc(100vw - 66px)) !important;
                max-height: min(710px,calc(100vh - 84px)) !important; overflow: hidden !important;
                border: 1px solid rgba(118,122,145,.38) !important; border-radius: 17px !important;
                background: linear-gradient(160deg,rgba(28,29,36,.985),rgba(13,14,18,.99)) !important;
                color: #f4f5f7 !important; backdrop-filter: blur(20px) !important;
                box-shadow: 0 28px 90px rgba(0,0,0,.68), inset 0 1px 0 rgba(255,255,255,.055) !important;
                font-family: var(--font-primary,Arial,sans-serif) !important; animation: tiny-library-enter .17s ease-out !important;
            }
            .tiny-library-panel:before {
                content: "" !important; position: absolute !important; inset: 0 18px auto !important; height: 1px !important;
                background: linear-gradient(90deg,transparent,#8c92ff,transparent) !important; opacity: .8 !important;
            }
            .tiny-library-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                min-height: 72px !important; padding: 13px 15px !important; border-bottom: 1px solid rgba(255,255,255,.055) !important;
                background: linear-gradient(115deg,rgba(124,131,255,.11),transparent 58%) !important;
            }
            .tiny-library-brand { display: flex !important; align-items: center !important; gap: 11px !important; min-width: 0 !important; }
            .tiny-library-brand-logo {
                flex: none !important; width: 38px !important; height: 38px !important; padding: 10px !important;
                box-sizing: border-box !important; border: 1px solid rgba(160,166,255,.25) !important; border-radius: 12px !important;
                background: linear-gradient(145deg,#626bf2,#944fe0) !important; color: white !important;
                box-shadow: 0 7px 18px rgba(88,101,242,.25) !important;
            }
            .tiny-library-heading { display: flex !important; min-width: 0 !important; flex-direction: column !important; gap: 3px !important; }
            .tiny-library-heading strong {
                overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
                font-size: 16px !important; letter-spacing: -.15px !important;
            }
            .tiny-library-heading small { color: #a4a8b3 !important; font-size: 12px !important; }
            .tiny-library-close {
                display: grid !important; place-items: center !important; flex: none !important; width: 32px !important; height: 32px !important;
                padding: 0 !important; border: 0 !important; border-radius: 9px !important; background: rgba(255,255,255,.035) !important;
                color: #9b9faa !important; font-size: 22px !important; line-height: 1 !important; cursor: pointer !important; transition: .14s ease !important;
            }
            .tiny-library-close:hover { background: rgba(255,255,255,.09) !important; color: white !important; transform: rotate(4deg) !important; }
            .tiny-library-search {
                display: flex !important; align-items: center !important; gap: 8px !important; margin: 11px 11px 3px !important;
                padding: 0 11px !important; border: 1px solid rgba(255,255,255,.075) !important; border-radius: 10px !important;
                background: rgba(7,8,11,.48) !important; color: #7c83ff !important;
                transition: border-color .14s ease, box-shadow .14s ease !important;
            }
            .tiny-library-search:focus-within { border-color: rgba(124,131,255,.58) !important; box-shadow: 0 0 0 3px rgba(124,131,255,.1) !important; }
            .tiny-library-search > span { font-size: 18px !important; transform: translateY(-1px) !important; }
            .tiny-library-search input {
                flex: 1 !important; min-width: 0 !important; height: 40px !important; padding: 0 !important; border: 0 !important;
                outline: 0 !important; background: transparent !important; color: #f2f3f5 !important;
                font: 500 13px var(--font-primary,Arial,sans-serif) !important;
            }
            .tiny-library-search input::placeholder { color: #777c87 !important; }
            .tiny-library-search input::-webkit-search-cancel-button { filter: invert(.75) !important; }
            .tiny-library-list {
                display: flex !important; flex: 1 !important; min-height: 100px !important; flex-direction: column !important;
                gap: 7px !important; overflow: auto !important; padding: 8px 10px 11px !important; scrollbar-width: thin !important;
            }
            .tiny-library-list::-webkit-scrollbar { width: 6px !important; }
            .tiny-library-list::-webkit-scrollbar-thumb { border-radius: 6px !important; background: #373a44 !important; }
            .tiny-library-entry {
                position: relative !important; display: flex !important; align-items: center !important; gap: 11px !important;
                width: 100% !important; min-height: 70px !important; padding: 10px !important; overflow: hidden !important;
                border: 1px solid rgba(255,255,255,.055) !important; border-radius: 12px !important;
                background: linear-gradient(110deg,rgba(255,255,255,.047),rgba(255,255,255,.022)) !important;
                color: #e7e8eb !important; text-align: left !important; cursor: pointer !important;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.025) !important;
                transition: transform .14s ease, border-color .14s ease, background .14s ease !important;
            }
            .tiny-library-entry:before {
                content: "" !important; position: absolute !important; left: 0 !important; top: 14px !important; bottom: 14px !important;
                width: 2px !important; border-radius: 0 3px 3px 0 !important; background: var(--tiny-entry-accent) !important;
                box-shadow: 0 0 10px var(--tiny-entry-accent) !important; opacity: .8 !important;
            }
            .tiny-library-entry:after {
                content: "›" !important; flex: none !important; margin-left: 1px !important; color: #6e727d !important;
                font-size: 18px !important; transition: .14s ease !important;
            }
            .tiny-library-entry:hover {
                transform: translateX(2px) !important;
                border-color: color-mix(in srgb,var(--tiny-entry-accent) 36%,transparent) !important;
                background: linear-gradient(110deg,color-mix(in srgb,var(--tiny-entry-accent) 10%,transparent),rgba(255,255,255,.034)) !important;
            }
            .tiny-library-entry:hover:after { color: #d9dbdf !important; transform: translateX(2px) !important; }
            .tiny-library-icon {
                display: grid !important; place-items: center !important; flex: none !important; width: 44px !important; height: 44px !important;
                border: 1px solid color-mix(in srgb,var(--tiny-entry-accent) 34%,transparent) !important; border-radius: 12px !important;
                background: color-mix(in srgb,var(--tiny-entry-accent) 13%,#17181d) !important; color: var(--tiny-entry-accent) !important;
                font-size: 12px !important; font-weight: 900 !important; letter-spacing: .2px !important;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.045) !important;
            }
            .tiny-library-copy { display: flex !important; flex: 1 !important; min-width: 0 !important; flex-direction: column !important; gap: 3px !important; }
            .tiny-library-copy strong {
                overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
                color: #f0f1f3 !important; font-size: 14px !important; letter-spacing: -.05px !important;
            }
            .tiny-library-copy small, .tiny-library-copy em { overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
            .tiny-library-copy small { color: #8e939e !important; font-size: 11px !important; }
            .tiny-library-copy em { color: color-mix(in srgb,var(--tiny-entry-accent) 78%,white) !important; font-size: 11px !important; font-style: normal !important; }
            .tiny-library-badge {
                display: grid !important; place-items: center !important; flex: none !important; min-width: 24px !important; height: 22px !important;
                padding: 0 7px !important; border: 1px solid rgba(255,255,255,.12) !important; border-radius: 11px !important;
                background: var(--tiny-entry-accent) !important; color: #101116 !important; font-size: 10px !important; font-weight: 900 !important;
                box-shadow: 0 4px 12px color-mix(in srgb,var(--tiny-entry-accent) 24%,transparent) !important;
            }
            .tiny-library-empty {
                display: flex !important; align-items: center !important; justify-content: center !important; min-height: 190px !important;
                flex-direction: column !important; gap: 5px !important; padding: 25px 14px !important; color: #898e99 !important; text-align: center !important;
            }
            .tiny-library-empty > span {
                display: grid !important; place-items: center !important; width: 42px !important; height: 42px !important; margin-bottom: 4px !important;
                border: 1px solid rgba(255,255,255,.07) !important; border-radius: 13px !important; background: rgba(255,255,255,.03) !important;
                color: #7c83ff !important; font-size: 17px !important;
            }
            .tiny-library-empty strong { color: #c9cbd0 !important; font-size: 14px !important; }
            .tiny-library-empty small { font-size: 12px !important; }
            .tiny-library-footer {
                display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 9px 13px !important;
                border-top: 1px solid rgba(255,255,255,.05) !important; background: rgba(5,6,8,.24) !important;
                color: #696e79 !important; font-size: 11px !important; text-transform: lowercase !important;
            }
            .tiny-library-footer-count { color: #8c91a0 !important; }
            .tiny-library-settings { padding: 10px 4px 28px !important; color: var(--text-normal) !important; }
            .tiny-library-settings h2 { margin: 0 0 5px !important; }
            .tiny-library-settings p { color: var(--text-muted) !important; }
            .tiny-library-settings button {
                padding: 9px 12px !important; border: 0 !important; border-radius: 7px !important;
                background: linear-gradient(135deg,#5865f2,#7c5ce7) !important; color: white !important;
                font-weight: 700 !important; cursor: pointer !important;
            }

            /* Plain Discord-style pass: intentionally flat, quiet, and familiar. */
            .tiny-library-button {
                width: 32px !important; height: 32px !important; border: 0 !important; border-radius: 8px !important;
                background: var(--background-secondary,#2b2d31) !important; color: var(--interactive-normal,#b5bac1) !important;
                opacity: .72 !important; backdrop-filter: none !important; box-shadow: none !important;
            }
            .tiny-library-button:hover, .tiny-library-button:focus-visible {
                opacity: 1 !important; transform: none !important; border-color: transparent !important;
                background: var(--background-modifier-hover,#35373c) !important; color: var(--interactive-hover,#dbdee1) !important;
                box-shadow: none !important;
            }
            .tiny-library-button:active { transform: none !important; background: var(--background-modifier-active,#404249) !important; }
            .tiny-library-button-mark { font-size: 17px !important; font-weight: 700 !important; line-height: 1 !important; }
            .tiny-library-button-count {
                right: -5px !important; top: -5px !important; min-width: 16px !important; height: 16px !important;
                padding: 0 3px !important; border-color: var(--background-base-lowest,#111214) !important;
                background: var(--status-danger,#da373c) !important; font-size: 9px !important;
            }
            .tiny-library-panel {
                right: 47px !important; top: 68px !important; width: min(380px,calc(100vw - 62px)) !important;
                border: 1px solid var(--background-modifier-accent,rgba(255,255,255,.08)) !important; border-radius: 8px !important;
                background: var(--background-floating,#111214) !important; color: var(--text-normal,#dbdee1) !important;
                backdrop-filter: none !important; box-shadow: 0 8px 16px rgba(0,0,0,.32) !important; animation: none !important;
            }
            .tiny-library-panel:before { display: none !important; }
            .tiny-library-header {
                min-height: 58px !important; padding: 11px 14px !important;
                border-bottom-color: var(--background-modifier-accent,rgba(255,255,255,.08)) !important;
                background: transparent !important;
            }
            .tiny-library-heading { gap: 2px !important; }
            .tiny-library-heading strong { color: var(--header-primary,#f2f3f5) !important; font-size: 16px !important; letter-spacing: 0 !important; }
            .tiny-library-heading small { color: var(--text-muted,#949ba4) !important; font-size: 12px !important; }
            .tiny-library-close {
                width: 28px !important; height: 28px !important; border-radius: 4px !important;
                background: transparent !important; color: var(--interactive-normal,#b5bac1) !important;
            }
            .tiny-library-close:hover {
                background: var(--background-modifier-hover,rgba(255,255,255,.06)) !important;
                color: var(--interactive-hover,#dbdee1) !important; transform: none !important;
            }
            .tiny-library-search {
                margin: 10px 10px 4px !important; padding: 0 10px !important; border: 0 !important; border-radius: 4px !important;
                background: var(--input-background,#1e1f22) !important; color: var(--text-normal,#dbdee1) !important;
            }
            .tiny-library-search:focus-within { border-color: transparent !important; box-shadow: none !important; }
            .tiny-library-search input { height: 36px !important; font-size: 13px !important; }
            .tiny-library-search input::placeholder { color: var(--text-muted,#949ba4) !important; }
            .tiny-library-list { gap: 2px !important; padding: 6px 8px 8px !important; }
            .tiny-library-entry {
                min-height: 58px !important; padding: 8px !important; border: 0 !important; border-radius: 4px !important;
                background: transparent !important; box-shadow: none !important;
                transition: background-color .1s ease !important;
            }
            .tiny-library-entry:before { display: none !important; }
            .tiny-library-entry:hover {
                transform: none !important; border-color: transparent !important;
                background: var(--background-modifier-hover,rgba(255,255,255,.06)) !important;
            }
            .tiny-library-entry:after { color: var(--interactive-muted,#4e5058) !important; transform: none !important; }
            .tiny-library-entry:hover:after { color: var(--interactive-normal,#b5bac1) !important; transform: none !important; }
            .tiny-library-icon {
                width: 38px !important; height: 38px !important; border: 0 !important; border-radius: 8px !important;
                background: var(--background-secondary-alt,#2b2d31) !important; color: var(--text-normal,#dbdee1) !important;
                box-shadow: none !important; font-size: 11px !important;
            }
            .tiny-library-copy { gap: 2px !important; }
            .tiny-library-copy strong { color: var(--header-primary,#f2f3f5) !important; font-size: 14px !important; }
            .tiny-library-copy small, .tiny-library-copy em { color: var(--text-muted,#949ba4) !important; font-size: 11px !important; }
            .tiny-library-badge {
                min-width: 22px !important; height: 20px !important; padding: 0 6px !important; border: 0 !important;
                background: var(--brand-500,#5865f2) !important; color: white !important; box-shadow: none !important;
            }
            .tiny-library-empty > span {
                border: 0 !important; border-radius: 8px !important; background: var(--background-secondary,#2b2d31) !important;
                color: var(--text-muted,#949ba4) !important;
            }
            .tiny-library-footer {
                border-top-color: var(--background-modifier-accent,rgba(255,255,255,.08)) !important;
                background: transparent !important; color: var(--text-muted,#949ba4) !important; text-transform: none !important;
            }
            .tiny-library-footer-count { color: var(--text-muted,#949ba4) !important; }
            .tiny-library-settings button { background: var(--brand-500,#5865f2) !important; }

            /* Final balanced finish: Discord-native with one restrained accent. */
            .tiny-library-button {
                width: 34px !important; height: 34px !important; border: 0 !important; border-radius: 10px !important;
                background: var(--brand-500,#5865f2) !important; color: #fff !important; opacity: .88 !important;
                box-shadow: 0 3px 8px rgba(0,0,0,.24) !important;
            }
            .tiny-library-button:hover, .tiny-library-button:focus-visible {
                background: var(--brand-560,#4752c4) !important; color: #fff !important; opacity: 1 !important;
                transform: translateY(-1px) !important; box-shadow: 0 5px 12px rgba(0,0,0,.28) !important;
            }
            .tiny-library-button:active { transform: translateY(0) !important; }
            .tiny-library-button-mark { width: 17px !important; height: 17px !important; }
            .tiny-library-panel {
                right: 49px !important; width: min(392px,calc(100vw - 64px)) !important;
                border: 1px solid var(--background-modifier-accent,rgba(255,255,255,.09)) !important;
                border-top: 2px solid var(--brand-500,#5865f2) !important; border-radius: 12px !important;
                background: var(--background-floating,#111214) !important;
                box-shadow: 0 12px 30px rgba(0,0,0,.42) !important;
            }
            .tiny-library-header { min-height: 64px !important; padding: 12px 14px !important; }
            .tiny-library-brand { gap: 10px !important; }
            .tiny-library-header-icon {
                display: grid !important; place-items: center !important; flex: none !important;
                width: 34px !important; height: 34px !important; border-radius: 9px !important;
                background: var(--brand-500,#5865f2) !important; color: white !important;
            }
            .tiny-library-header-mark { width: 17px !important; height: 17px !important; }
            .tiny-library-heading strong { font-weight: 700 !important; }
            .tiny-library-close { border-radius: 7px !important; }
            .tiny-library-search {
                margin: 10px 10px 5px !important; border: 1px solid var(--background-modifier-accent,rgba(255,255,255,.08)) !important;
                border-radius: 7px !important; background: var(--input-background,#1e1f22) !important;
            }
            .tiny-library-search:focus-within {
                border-color: var(--brand-500,#5865f2) !important;
                box-shadow: 0 0 0 1px var(--brand-500,#5865f2) !important;
            }
            .tiny-library-list { gap: 5px !important; padding: 6px 9px 10px !important; }
            .tiny-library-entry {
                min-height: 62px !important; padding: 9px !important;
                border: 1px solid transparent !important; border-radius: 8px !important;
                background: var(--background-secondary,#2b2d31) !important;
            }
            .tiny-library-entry:hover {
                border-color: rgba(88,101,242,.45) !important;
                background: var(--background-secondary-alt,#25262a) !important;
            }
            .tiny-library-icon {
                width: 40px !important; height: 40px !important; border-radius: 9px !important;
                background: var(--background-tertiary,#1e1f22) !important;
                color: var(--interactive-normal,#b5bac1) !important;
            }
            .tiny-library-copy strong { font-weight: 600 !important; }
            .tiny-library-copy em { color: var(--brand-360,#949cf7) !important; }
            .tiny-library-badge { background: var(--brand-500,#5865f2) !important; }
            .tiny-library-footer { background: var(--background-tertiary,#1e1f22) !important; }

            /* Plugin gallery */
            .tiny-library-panel { width: min(460px,calc(100vw - 64px)) !important; }
            .tiny-library-list {
                display: grid !important; grid-template-columns: repeat(2,minmax(0,1fr)) !important;
                align-content: start !important; gap: 8px !important; padding: 8px 10px 11px !important;
            }
            .tiny-library-entry {
                display: flex !important; flex-direction: column !important; align-items: flex-start !important;
                gap: 9px !important; min-width: 0 !important; min-height: 132px !important; padding: 11px !important;
                text-align: left !important;
            }
            .tiny-library-entry:after { display: none !important; }
            .tiny-library-icon {
                width: 38px !important; height: 38px !important; flex: none !important;
                background: var(--background-tertiary,#1e1f22) !important; font-size: 21px !important;
                font-family: "Segoe UI Emoji","Apple Color Emoji",sans-serif !important; font-weight: 400 !important;
            }
            .tiny-library-copy { width: 100% !important; gap: 4px !important; }
            .tiny-library-copy strong {
                width: 100% !important; padding-right: 30px !important; box-sizing: border-box !important;
                font-size: 14px !important;
            }
            .tiny-library-copy small {
                display: -webkit-box !important; min-height: 30px !important; overflow: hidden !important;
                white-space: normal !important; line-height: 15px !important;
                -webkit-box-orient: vertical !important; -webkit-line-clamp: 2 !important;
            }
            .tiny-library-copy em {
                width: 100% !important; overflow: hidden !important; text-overflow: ellipsis !important;
                white-space: nowrap !important; font-size: 10px !important;
            }
            .tiny-library-badge {
                position: absolute !important; top: 11px !important; right: 11px !important;
            }
            .tiny-library-empty { grid-column: 1 / -1 !important; }
            @media (max-width: 520px) {
                .tiny-library-panel { right: 8px !important; top: 116px !important; width: calc(100vw - 16px) !important; max-height: calc(100vh - 124px) !important; }
                .tiny-library-button { top: 74px !important; }
            }
            @media (max-width: 410px) {
                .tiny-library-list { grid-template-columns: 1fr !important; }
                .tiny-library-entry { min-height: 108px !important; }
            }
        `;
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.addStyle) dom.addStyle(STYLE_ID, css);
        else if (globalThis.document?.head) { const style = document.createElement("style"); style.id = STYLE_ID; style.textContent = css; document.head.append(style); }
    }

    removeStyles() {
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.removeStyle) dom.removeStyle(STYLE_ID);
        globalThis.document?.getElementById?.(STYLE_ID)?.remove();
    }

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
