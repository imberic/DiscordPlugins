/**
 * @name FloatingChats
 * @author tiny
 * @version 1.0.3
 * @description Opens Discord channels and DMs as movable, resizable chat windows that can minimize into bubbles.
 */

"use strict";

const PLUGIN_NAME = "FloatingChats";
const STYLE_ID = "tiny-floating-chats-styles";
const DATA_KEY = "floating-chats";
const DATA_VERSION = 1;
const MESSAGE_EVENTS = ["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK", "LOAD_MESSAGES_SUCCESS"];

module.exports = class FloatingChats {
    constructor() {
        this.api = null;
        this.webpack = null;
        this.stores = {};
        this.dispatcher = null;
        this.messageActions = null;
        this.messageFetch = null;
        this.data = this.emptyData();
        this.root = null;
        this.manager = null;
        this.libraryEntry = null;
        this.views = new Map();
        this.drafts = new Map();
        this.unread = new Map();
        this.fetching = new Set();
        this.saveTimer = null;
        this.zIndex = 2147481000;
        this.started = false;
        this.handlers = Object.fromEntries(MESSAGE_EVENTS.map(event => [event, payload => this.handleMessageEvent(event, payload)]));
    }

    emptyData() { return {version: DATA_VERSION, order: [], windows: {}}; }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") {
            globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
            return;
        }
        if (this.started) return;
        this.started = true;
        this.initializeApi();
        this.data = this.sanitizeData(this.load(DATA_KEY));
        this.findModules();
        this.addStyles();
        this.createRoot();
        this.subscribe();
        this.libraryEntry = globalThis.TinyPluginLibrary.register({
            id: "floating-chats",
            name: "Floating Chats",
            description: "Pin channels and DMs into movable chat windows",
            icon: "💬",
            order: 25,
            open: () => this.openManager()
        });
        this.renderAll();
        this.updateLibraryEntry();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.unsubscribe();
        clearTimeout(this.saveTimer);
        this.saveNow();
        this.closeManager();
        for (const view of this.views.values()) this.destroyView(view);
        this.views.clear();
        this.root?.remove();
        this.root = null;
        this.libraryEntry?.remove?.();
        this.libraryEntry = null;
        this.removeStyles();
    }

    initializeApi() {
        try { if (typeof globalThis.BdApi === "function") this.api = new globalThis.BdApi(PLUGIN_NAME); }
        catch (error) { console.warn(`[${PLUGIN_NAME}] Could not initialize BdApi:`, error); }
        this.webpack = this.api?.Webpack || globalThis.BdApi?.Webpack || null;
    }

    findModules() {
        const getStore = name => {
            try { return this.webpack?.getStore?.(name) || null; }
            catch (_) { return null; }
        };
        this.stores = {
            selected: getStore("SelectedChannelStore"),
            channel: getStore("ChannelStore"),
            guild: getStore("GuildStore"),
            guildChannel: getStore("GuildChannelStore"),
            user: getStore("UserStore"),
            message: getStore("MessageStore")
        };
        try {
            this.dispatcher = this.webpack?.getByKeys?.("dispatch", "subscribe", "unsubscribe")
                || this.webpack?.getModule?.(module => typeof module?.dispatch === "function" && typeof module?.subscribe === "function" && typeof module?.unsubscribe === "function", {searchExports: true}) || null;
        } catch (_) { this.dispatcher = null; }
        try {
            this.messageActions = this.webpack?.getByKeys?.("sendMessage", "editMessage")
                || this.webpack?.getModule?.(module => typeof module?.sendMessage === "function" && typeof module?.editMessage === "function", {searchExports: true}) || null;
        } catch (_) { this.messageActions = null; }
        try {
            this.messageFetch = this.webpack?.getByKeys?.("fetchMessages", "jumpToMessage")
                || this.webpack?.getModule?.(module => typeof module?.fetchMessages === "function", {searchExports: true}) || null;
        } catch (_) { this.messageFetch = null; }
        if (!this.stores.channel || !this.stores.message) this.toast("Discord's channel data is unavailable. Reload Discord and try again.", "error");
    }

    subscribe() {
        for (const event of MESSAGE_EVENTS) {
            try { this.dispatcher?.subscribe?.(event, this.handlers[event]); } catch (_) {}
        }
    }

    unsubscribe() {
        for (const event of MESSAGE_EVENTS) {
            try { this.dispatcher?.unsubscribe?.(event, this.handlers[event]); } catch (_) {}
        }
    }

    createRoot() {
        this.root?.remove();
        this.root = this.el("div", {id: "tiny-floating-chats-root"});
        document.body.append(this.root);
    }

    handleMessageEvent(event, payload) {
        const channelIds = new Set();
        if (event === "LOAD_MESSAGES_SUCCESS") {
            const direct = payload?.channelId ?? payload?.channel_id;
            if (direct) channelIds.add(String(direct));
            for (const message of this.messageArray(payload?.messages || payload?.messageRecords || [])) {
                if (message?.channel_id || message?.channelId) channelIds.add(String(message.channel_id || message.channelId));
            }
        } else if (event === "MESSAGE_DELETE_BULK") {
            const direct = payload?.channelId ?? payload?.channel_id;
            if (direct) channelIds.add(String(direct));
        } else {
            const message = payload?.message || payload;
            const direct = message?.channel_id ?? message?.channelId ?? payload?.channelId ?? payload?.channel_id;
            if (direct) channelIds.add(String(direct));
            if (event === "MESSAGE_CREATE" && direct && String(message?.author?.id || "") !== this.currentUserId()) {
                const state = this.data.windows[String(direct)];
                if (state?.minimized) this.unread.set(String(direct), (this.unread.get(String(direct)) || 0) + 1);
            }
        }
        queueMicrotask(() => {
            for (const channelId of channelIds) {
                if (!this.data.windows[channelId]) continue;
                const view = this.views.get(channelId);
                if (view?.kind === "window") this.renderMessages(channelId, true);
                else if (view?.kind === "bubble") this.updateBubble(channelId);
            }
        });
    }

    sanitizeData(raw) {
        const data = this.emptyData();
        const windows = raw?.windows && typeof raw.windows === "object" ? raw.windows : {};
        for (const [rawId, value] of Object.entries(windows)) {
            const channelId = String(rawId || "");
            if (!channelId) continue;
            data.windows[channelId] = {
                x: this.numberOrNull(value?.x), y: this.numberOrNull(value?.y),
                width: this.clamp(Number(value?.width) || 370, 310, 760),
                height: this.clamp(Number(value?.height) || 480, 280, 820),
                minimized: Boolean(value?.minimized)
            };
        }
        const order = Array.isArray(raw?.order) ? raw.order.map(String).filter(id => data.windows[id]) : [];
        data.order = [...new Set([...order, ...Object.keys(data.windows)])];
        return data;
    }

    numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
    clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

    renderAll() {
        for (const view of this.views.values()) this.destroyView(view);
        this.views.clear();
        if (!this.root) return;
        this.root.replaceChildren();
        for (const channelId of this.data.order) this.mountChannel(channelId);
        this.layoutBubbles();
    }

    mountChannel(channelId) {
        const state = this.data.windows[channelId];
        if (!state || !this.root) return;
        const channel = this.getChannel(channelId);
        if (!channel) return this.mountMissingBubble(channelId);
        if (state.minimized) this.createBubble(channelId, channel);
        else this.createWindow(channelId, channel, state);
    }

    createWindow(channelId, channel, state) {
        const identity = this.channelIdentity(channel);
        const win = this.el("section", {className: "tfc-window", "data-channel-id": channelId, role: "dialog", "aria-label": identity.name});
        const size = this.safeWindowGeometry(state);
        Object.assign(win.style, {left: `${size.x}px`, top: `${size.y}px`, width: `${size.width}px`, height: `${size.height}px`, zIndex: String(++this.zIndex)});

        const header = this.el("header", {className: "tfc-header"});
        const identityNode = this.el("div", {className: "tfc-identity"});
        identityNode.append(this.channelAvatar(identity), this.el("div", {className: "tfc-identity-copy"}));
        identityNode.lastElementChild.append(this.el("strong", {textContent: identity.name}), this.el("span", {textContent: identity.location}));
        const controls = this.el("div", {className: "tfc-controls"});
        const open = this.iconButton("external", "Open in Discord", () => this.openInDiscord(channelId));
        const minimize = this.iconButton("minus", "Minimize to bubble", () => this.setMinimized(channelId, true));
        const close = this.iconButton("close", "Unpin chat", () => this.unpinChannel(channelId));
        controls.append(open, minimize, close);
        header.append(identityNode, controls);

        const messages = this.el("div", {className: "tfc-messages"});
        const composer = this.el("div", {className: "tfc-composer"});
        const textarea = this.el("textarea", {className: "tfc-input", rows: 1, placeholder: `Message ${identity.name}`});
        textarea.value = this.drafts.get(channelId) || "";
        const send = this.iconButton("send", "Send message", () => this.sendMessage(channelId, textarea, send));
        send.classList.add("tfc-send");
        textarea.addEventListener("input", () => { this.drafts.set(channelId, textarea.value); this.resizeComposer(textarea); });
        textarea.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); this.sendMessage(channelId, textarea, send); }
        });
        composer.append(textarea, send);
        win.append(header, messages, composer);
        this.root.append(win);

        const view = {kind: "window", element: win, messages, textarea, header, resizeObserver: null};
        this.views.set(channelId, view);
        this.makeDraggable(channelId, win, header);
        this.observeResize(channelId, view);
        win.addEventListener("pointerdown", () => this.bringToFront(win));
        this.renderMessages(channelId, false);
        this.fetchChannelMessages(channelId);
        requestAnimationFrame(() => this.resizeComposer(textarea));
    }

    safeWindowGeometry(state) {
        const width = this.clamp(state.width || 370, 310, Math.max(310, window.innerWidth - 24));
        const height = this.clamp(state.height || 480, 280, Math.max(280, window.innerHeight - 24));
        const index = Math.max(0, this.data.order.indexOf(Object.keys(this.data.windows).find(id => this.data.windows[id] === state)));
        const fallbackX = Math.max(12, window.innerWidth - width - 24 - (index % 3) * 28);
        const fallbackY = Math.max(12, 76 + (index % 5) * 28);
        return {
            width, height,
            x: this.clamp(state.x ?? fallbackX, 8, Math.max(8, window.innerWidth - width - 8)),
            y: this.clamp(state.y ?? fallbackY, 8, Math.max(8, window.innerHeight - height - 8))
        };
    }

    makeDraggable(channelId, win, handle) {
        handle.addEventListener("pointerdown", event => {
            if (event.button !== 0 || event.target.closest("button")) return;
            event.preventDefault();
            this.bringToFront(win);
            const rect = win.getBoundingClientRect(), offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
            handle.setPointerCapture?.(event.pointerId);
            const move = moveEvent => {
                const x = this.clamp(moveEvent.clientX - offsetX, 6, Math.max(6, window.innerWidth - win.offsetWidth - 6));
                const y = this.clamp(moveEvent.clientY - offsetY, 6, Math.max(6, window.innerHeight - win.offsetHeight - 6));
                win.style.left = `${x}px`; win.style.top = `${y}px`;
            };
            const up = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
                handle.removeEventListener("pointercancel", up);
                const state = this.data.windows[channelId];
                if (state) { state.x = parseFloat(win.style.left); state.y = parseFloat(win.style.top); this.scheduleSave(); }
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
            handle.addEventListener("pointercancel", up);
        });
    }

    observeResize(channelId, view) {
        if (typeof ResizeObserver !== "function") return;
        view.resizeObserver = new ResizeObserver(entries => {
            const rect = entries[0]?.contentRect, state = this.data.windows[channelId];
            if (!rect || !state) return;
            state.width = Math.round(rect.width); state.height = Math.round(rect.height); this.scheduleSave();
        });
        view.resizeObserver.observe(view.element);
    }

    bringToFront(element) { element.style.zIndex = String(++this.zIndex); }

    createBubble(channelId, channel) {
        const identity = this.channelIdentity(channel);
        const bubble = this.el("button", {className: "tfc-bubble", type: "button", title: `Open ${identity.name}`, "data-channel-id": channelId});
        bubble.append(this.channelAvatar(identity), this.el("span", {className: "tfc-bubble-name", textContent: identity.name}));
        const badge = this.el("span", {className: "tfc-unread"});
        bubble.append(badge);
        bubble.addEventListener("click", () => this.setMinimized(channelId, false));
        bubble.addEventListener("contextmenu", event => { event.preventDefault(); this.unpinChannel(channelId); });
        this.root.append(bubble);
        this.views.set(channelId, {kind: "bubble", element: bubble, badge});
        this.updateBubble(channelId);
    }

    mountMissingBubble(channelId) {
        const bubble = this.el("button", {className: "tfc-bubble tfc-missing", type: "button", title: "Channel unavailable — right-click to remove"});
        bubble.append(this.el("span", {className: "tfc-avatar", textContent: "?"}));
        bubble.addEventListener("contextmenu", event => { event.preventDefault(); this.unpinChannel(channelId); });
        this.root?.append(bubble);
        this.views.set(channelId, {kind: "bubble", element: bubble, badge: null});
    }

    updateBubble(channelId) {
        const view = this.views.get(channelId), count = this.unread.get(channelId) || 0;
        if (view?.kind !== "bubble" || !view.badge) return;
        view.badge.textContent = count > 99 ? "99+" : String(count || "");
        view.badge.hidden = !count;
    }

    layoutBubbles() {
        const bubbles = [...this.views.values()].filter(view => view.kind === "bubble").map(view => view.element);
        bubbles.forEach((bubble, index) => {
            bubble.style.right = `${18 + (index % 7) * 58}px`;
            bubble.style.bottom = `${18 + Math.floor(index / 7) * 58}px`;
        });
    }

    setMinimized(channelId, minimized) {
        const state = this.data.windows[channelId];
        if (!state) return;
        const existing = this.views.get(channelId);
        if (existing?.kind === "window") {
            const rect = existing.element.getBoundingClientRect();
            Object.assign(state, {x: rect.left, y: rect.top, width: rect.width, height: rect.height});
        }
        state.minimized = Boolean(minimized);
        if (!minimized) this.unread.delete(channelId);
        if (existing) this.destroyView(existing);
        this.views.delete(channelId);
        this.mountChannel(channelId);
        this.layoutBubbles();
        this.scheduleSave();
        this.updateLibraryEntry();
    }

    pinChannel(channelId) {
        channelId = String(channelId || "");
        if (!channelId || !this.getChannel(channelId)) return false;
        if (this.data.windows[channelId]) {
            if (this.data.windows[channelId].minimized) this.setMinimized(channelId, false);
            else this.bringToFront(this.views.get(channelId)?.element);
            return true;
        }
        const offset = this.data.order.length;
        this.data.windows[channelId] = {x: null, y: null, width: 370, height: 480, minimized: false};
        this.data.order.push(channelId);
        this.mountChannel(channelId);
        this.scheduleSave();
        this.updateLibraryEntry();
        this.refreshManager();
        return true;
    }

    unpinChannel(channelId) {
        const view = this.views.get(channelId);
        if (view) this.destroyView(view);
        this.views.delete(channelId);
        delete this.data.windows[channelId];
        this.data.order = this.data.order.filter(id => id !== channelId);
        this.drafts.delete(channelId); this.unread.delete(channelId);
        this.layoutBubbles();
        this.scheduleSave();
        this.updateLibraryEntry();
        this.refreshManager();
    }

    destroyView(view) { try { view?.resizeObserver?.disconnect?.(); } catch (_) {} view?.element?.remove?.(); }

    renderMessages(channelId, preserveScroll = true) {
        const view = this.views.get(channelId);
        if (view?.kind !== "window") return;
        const list = view.messages;
        const wasNearBottom = !preserveScroll || list.scrollHeight - list.scrollTop - list.clientHeight < 70;
        const previousBottomGap = list.scrollHeight - list.scrollTop;
        const messages = this.getMessages(channelId).slice(-60);
        list.replaceChildren();
        if (!messages.length) list.append(this.el("div", {className: "tfc-empty", textContent: "No cached messages yet. Open this channel once if it stays empty."}));
        let previous = null;
        for (const message of messages) {
            const row = this.renderMessage(message, previous);
            if (row) list.append(row);
            previous = message;
        }
        requestAnimationFrame(() => {
            if (wasNearBottom) list.scrollTop = list.scrollHeight;
            else list.scrollTop = Math.max(0, list.scrollHeight - previousBottomGap);
        });
    }

    renderMessage(message, previous) {
        if (!message) return null;
        const author = message.author || this.stores.user?.getUser?.(message.authorId || message.author_id) || {};
        const authorId = String(author.id || message.authorId || message.author_id || "system");
        const timestamp = this.messageTimestamp(message);
        const previousTimestamp = previous ? this.messageTimestamp(previous) : 0;
        const compact = previous && String(previous.author?.id || previous.authorId || previous.author_id || "") === authorId && timestamp - previousTimestamp < 300000;
        const row = this.el("article", {className: `tfc-message${compact ? " compact" : ""}`});
        if (!compact) row.append(this.userAvatar(author));
        else row.append(this.el("span", {className: "tfc-avatar-spacer"}));
        const body = this.el("div", {className: "tfc-message-body"});
        if (!compact) {
            const meta = this.el("div", {className: "tfc-message-meta"});
            meta.append(this.el("strong", {textContent: this.userName(author)}), this.el("time", {textContent: this.timeLabel(timestamp), title: new Date(timestamp).toLocaleString()}));
            body.append(meta);
        }
        const content = String(message.content || "");
        if (content) body.append(this.messageContent(content));
        const mediaCount = this.appendAttachments(body, message, content);
        if (!content && !mediaCount) body.append(this.el("div", {className: "tfc-content tfc-muted", textContent: "Message"}));
        if (message.edited_timestamp || message.editedTimestamp) body.append(this.el("span", {className: "tfc-edited", textContent: "edited"}));
        row.append(body);
        return row;
    }

    messageContent(content) {
        const node = this.el("div", {className: "tfc-content"});
        const expanded = content
            .replace(/<@!?(\d+)>/g, (_match, id) => `@${this.userName(this.stores.user?.getUser?.(id) || {username: "user"})}`)
            .replace(/<#(\d+)>/g, (_match, id) => `#${this.getChannel(id)?.name || "channel"}`)
            .replace(/<a?:([\w~]+):\d+>/g, ":$1:");
        const urlPattern = /https?:\/\/[^\s<]+/gi;
        let index = 0;
        for (const match of expanded.matchAll(urlPattern)) {
            if (match.index > index) node.append(document.createTextNode(expanded.slice(index, match.index)));
            const link = this.el("a", {href: match[0], target: "_blank", rel: "noreferrer", textContent: match[0]});
            node.append(link); index = match.index + match[0].length;
        }
        if (index < expanded.length) node.append(document.createTextNode(expanded.slice(index)));
        return node;
    }

    appendAttachments(body, message, content = "") {
        let added = 0;
        const seen = new Set();
        const addImage = (url, href = url, alt = "Image") => {
            if (!url || seen.has(url)) return;
            seen.add(url);
            const link = this.el("a", {className: "tfc-media", href: href || url, target: "_blank", rel: "noreferrer"});
            const image = this.el("img", {src: url, alt, loading: "lazy"});
            let triedOriginal = false;
            image.addEventListener("error", () => {
                if (!triedOriginal && href && href !== url) { triedOriginal = true; image.src = href; }
                else { link.className = "tfc-file"; link.textContent = "Open image"; }
            });
            link.append(image); body.append(link); added++;
        };
        const addVideo = (url, gifLike = false) => {
            if (!url || seen.has(url)) return;
            seen.add(url);
            const video = this.el("video", {className: "tfc-media", src: url, controls: gifLike ? undefined : "", preload: "metadata", playsinline: ""});
            if (gifLike) { video.autoplay = true; video.loop = true; video.muted = true; }
            body.append(video); added++;
        };

        const attachments = this.normalize(message.attachments);
        for (const attachment of attachments.slice(0, 6)) {
            const url = attachment?.url || attachment?.proxy_url || attachment?.proxyUrl;
            if (!url) continue;
            const type = String(attachment.content_type || attachment.contentType || "");
            if (type.startsWith("image/") || /\.(gif|png|jpe?g|webp)(\?|$)/i.test(url)) {
                addImage(attachment.proxy_url || attachment.proxyUrl || url, url, attachment.filename || "Image");
            } else if (type.startsWith("video/")) {
                addVideo(attachment.proxy_url || attachment.proxyUrl || url);
            } else {
                const file = this.el("a", {className: "tfc-file", href: url, target: "_blank", rel: "noreferrer", textContent: attachment.filename || "Open attachment"}); body.append(file);
                added++;
            }
        }
        for (const embed of this.normalize(message.embeds).slice(0, 3)) {
            const image = embed?.image?.proxy_url || embed?.image?.url || embed?.thumbnail?.proxy_url || embed?.thumbnail?.url;
            const video = embed?.video?.proxy_url || embed?.video?.url;
            const gifLike = String(embed?.type || "").toLowerCase() === "gifv";
            if (video && gifLike) addVideo(video, true);
            else if (image) addImage(image, embed.url || image, embed.title || "Embed");
            else if (video) addVideo(video, false);
        }
        for (const sticker of this.normalize(message.sticker_items || message.stickerItems || message.stickers).slice(0, 3)) {
            const stickerId = String(sticker?.id || "");
            if (!stickerId) continue;
            const extension = Number(sticker.format_type || sticker.formatType) === 4 ? "gif" : "png";
            addImage(`https://media.discordapp.net/stickers/${stickerId}.${extension}?size=320`, null, sticker.name || "Sticker");
        }
        const linkedImages = String(content || "").match(/https?:\/\/[^\s<]+?(?:\.gif|\.png|\.jpe?g|\.webp)(?:\?[^\s<]*)?/gi) || [];
        for (const url of linkedImages.slice(0, 4)) addImage(url, url, "Linked image");
        return added;
    }

    getMessages(channelId) {
        try { return this.messageArray(this.stores.message?.getMessages?.(channelId)).filter(message => message?.id).sort((a, b) => this.compareMessageIds(a.id, b.id)); }
        catch (_) { return []; }
    }

    messageArray(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        try { if (typeof value.toArray === "function") return value.toArray(); } catch (_) {}
        if (Array.isArray(value._array)) return value._array;
        if (value._map instanceof Map) return [...value._map.values()];
        return this.normalize(value._messages || value._map || value);
    }

    async fetchChannelMessages(channelId) {
        if (this.fetching.has(channelId) || typeof this.messageFetch?.fetchMessages !== "function") return;
        this.fetching.add(channelId);
        try {
            const result = this.messageFetch.fetchMessages({channelId, limit: 50});
            if (result?.then) await result;
            this.renderMessages(channelId, false);
        } catch (_) {}
        finally { this.fetching.delete(channelId); }
    }

    async sendMessage(channelId, textarea, button) {
        const content = String(textarea?.value || "").trim();
        if (!content) return;
        if (typeof this.messageActions?.sendMessage !== "function") return this.toast("Discord's message sender was not found. Reload Discord and try again.", "error");
        textarea.disabled = true; button.disabled = true;
        try {
            const result = this.messageActions.sendMessage(channelId, {content, tts: false, invalidEmojis: [], validNonShortcutEmojis: []}, true, {});
            if (result?.then) await result;
            textarea.value = ""; this.drafts.delete(channelId); this.resizeComposer(textarea); textarea.focus();
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Could not send message:`, error);
            this.toast("Discord could not send that message.", "error");
        } finally { textarea.disabled = false; button.disabled = false; }
    }

    resizeComposer(textarea) {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(110, Math.max(34, textarea.scrollHeight))}px`;
    }

    openManager() {
        this.closeManager();
        const overlay = this.el("div", {className: "tfc-manager-overlay"});
        const panel = this.el("section", {className: "tfc-manager", role: "dialog", "aria-modal": "true", "aria-label": "Floating Chats"});
        const head = this.el("header", {className: "tfc-manager-head"});
        const copy = this.el("div"); copy.append(this.el("h1", {textContent: "Floating Chats"}), this.el("p", {textContent: "Pin channels and DMs while you browse Discord"}));
        head.append(copy, this.iconButton("close", "Close", () => this.closeManager()));
        const tools = this.el("div", {className: "tfc-manager-tools"});
        const search = this.el("input", {type: "search", placeholder: "Search channels and DMs…", autocomplete: "off"});
        const currentId = this.currentChannelId();
        const pinCurrent = this.el("button", {className: "tfc-primary", type: "button", textContent: "Pin current channel", disabled: !currentId});
        pinCurrent.addEventListener("click", () => { if (currentId && this.pinChannel(currentId)) this.refreshManager(); });
        tools.append(search, pinCurrent);
        const list = this.el("div", {className: "tfc-channel-list"});
        panel.append(head, tools, list); overlay.append(panel); document.body.append(overlay);
        overlay.addEventListener("mousedown", event => { if (event.target === overlay) this.closeManager(); });
        this.manager = {overlay, panel, search, list};
        search.addEventListener("input", () => this.refreshManager());
        this.refreshManager();
        requestAnimationFrame(() => search.focus());
    }

    refreshManager() {
        if (!this.manager) return;
        const query = this.manager.search.value.trim().toLowerCase();
        const channels = this.availableChannels().filter(channel => {
            if (!query) return true;
            const identity = this.channelIdentity(channel);
            return `${identity.name} ${identity.location}`.toLowerCase().includes(query);
        }).slice(0, 100);
        const list = this.manager.list;
        list.replaceChildren();
        if (!channels.length) list.append(this.el("div", {className: "tfc-manager-empty", textContent: "No matching channels found."}));
        let previousSection = "";
        for (const channel of channels) {
            const channelId = String(channel.id), identity = this.channelIdentity(channel), pinned = Boolean(this.data.windows[channelId]);
            const section = this.isPrivateChannel(channel) ? "Recent DMs" : "Server channels";
            if (section !== previousSection) {
                list.append(this.el("div", {className: "tfc-section-label", textContent: section}));
                previousSection = section;
            }
            const row = this.el("div", {className: "tfc-channel-row"});
            const copy = this.el("div", {className: "tfc-channel-copy"});
            copy.append(this.el("strong", {textContent: identity.name}), this.el("span", {textContent: identity.location}));
            const action = this.el("button", {className: pinned ? "tfc-secondary" : "tfc-primary", type: "button", textContent: pinned ? "Show" : "Pin"});
            action.addEventListener("click", () => { this.pinChannel(channelId); this.refreshManager(); });
            row.append(this.channelAvatar(identity), copy, action); list.append(row);
        }
    }

    closeManager() { this.manager?.overlay?.remove(); this.manager = null; }

    availableChannels() {
        const found = new Map();
        for (const channel of this.getPrivateChannels()) if (this.isMessageChannel(channel)) found.set(String(channel.id), channel);
        for (const guild of this.getGuilds()) for (const channel of this.getGuildChannels(guild.id)) if (this.isMessageChannel(channel)) found.set(String(channel.id), channel);
        const currentId = this.currentChannelId(), current = currentId ? this.getChannel(currentId) : null;
        if (current && this.isMessageChannel(current)) found.set(String(current.id), current);
        return [...found.values()].sort((a, b) => {
            const aPrivate = this.isPrivateChannel(a), bPrivate = this.isPrivateChannel(b);
            if (aPrivate !== bPrivate) return aPrivate ? -1 : 1;
            if (aPrivate && bPrivate) {
                const activityDifference = this.channelActivityTimestamp(b) - this.channelActivityTimestamp(a);
                if (activityDifference) return activityDifference;
            }
            if (String(a.id) === currentId) return -1;
            if (String(b.id) === currentId) return 1;
            return this.channelIdentity(a).sort.localeCompare(this.channelIdentity(b).sort);
        });
    }

    channelActivityTimestamp(channel) {
        const lastMessageId = channel?.lastMessageId || channel?.last_message_id;
        if (lastMessageId) {
            try { return Number((BigInt(String(lastMessageId)) >> 22n) + 1420070400000n); } catch (_) {}
        }
        try {
            const messages = this.messageArray(this.stores.message?.getMessages?.(String(channel?.id || ""))).filter(message => message?.id);
            if (messages.length) return this.messageTimestamp(messages.sort((a, b) => this.compareMessageIds(a.id, b.id)).at(-1));
        } catch (_) {}
        return 0;
    }

    getPrivateChannels() {
        try {
            const raw = this.stores.channel?.getSortedPrivateChannels?.() || this.stores.channel?.getMutablePrivateChannels?.() || {};
            return this.normalize(raw).map(value => value?.channel || value).filter(channel => channel?.id);
        } catch (_) { return []; }
    }

    getGuilds() {
        try { return this.normalize(this.stores.guild?.getGuilds?.() || {}).filter(guild => guild?.id); }
        catch (_) { return []; }
    }

    getGuildChannels(guildId) {
        let raw = null;
        try { raw = this.stores.guildChannel?.getChannels?.(guildId); } catch (_) {}
        if (!raw) try { raw = this.stores.channel?.getMutableGuildChannelsForGuild?.(guildId); } catch (_) {}
        const found = new Map(), visited = new Set();
        const walk = (value, depth = 0) => {
            if (!value || typeof value !== "object" || depth > 7 || visited.has(value)) return;
            visited.add(value);
            const candidate = value.channel && typeof value.channel === "object" ? value.channel : value;
            if (candidate.id && candidate.type !== undefined) found.set(String(candidate.id), candidate);
            if (value instanceof Map || value instanceof Set) for (const child of value.values()) walk(child, depth + 1);
            else if (Array.isArray(value)) for (const child of value) walk(child, depth + 1);
            else for (const child of Object.values(value)) walk(child, depth + 1);
        };
        walk(raw); return [...found.values()];
    }

    isMessageChannel(channel) {
        if (!channel?.id) return false;
        const type = Number(channel.type);
        return [0, 1, 2, 3, 5, 10, 11, 12, 13, 15, 16].includes(type);
    }

    isPrivateChannel(channel) {
        try { if (channel?.isDM?.() || channel?.isGroupDM?.()) return true; } catch (_) {}
        return Number(channel?.type) === 1 || Number(channel?.type) === 3;
    }

    channelIdentity(channel) {
        const type = Number(channel?.type), guildId = String(channel?.guild_id || channel?.guildId || "");
        if (type === 1) {
            const recipientId = String(channel?.getRecipientId?.() || this.normalize(channel?.recipients)[0] || "");
            const user = this.stores.user?.getUser?.(recipientId) || null;
            const name = this.userName(user || {username: channel?.name || "Direct Message"});
            return {name, location: "Direct Message", avatarUrl: this.avatarUrl(user), initial: name.charAt(0), sort: `0 ${name}`};
        }
        if (type === 3) {
            const users = this.normalize(channel?.recipients).map(id => this.stores.user?.getUser?.(String(id))).filter(Boolean);
            const name = channel?.name || users.map(user => this.userName(user)).join(", ") || "Group DM";
            return {name, location: "Group DM", avatarUrl: "", initial: name.charAt(0), sort: `0 ${name}`};
        }
        const guild = guildId ? this.stores.guild?.getGuild?.(guildId) : null;
        const name = channel?.name ? `${type === 2 || type === 13 ? "🔊 " : "# "}${channel.name}` : "Channel";
        return {name, location: guild?.name || "Discord", avatarUrl: "", initial: type === 2 || type === 13 ? "V" : "#", sort: `1 ${guild?.name || ""} ${name}`};
    }

    channelAvatar(identity) {
        if (identity.avatarUrl) return this.el("img", {className: "tfc-avatar", src: identity.avatarUrl, alt: ""});
        return this.el("span", {className: "tfc-avatar", textContent: String(identity.initial || "#").toUpperCase()});
    }

    userAvatar(user) {
        const url = this.avatarUrl(user);
        if (url) return this.el("img", {className: "tfc-message-avatar", src: url, alt: ""});
        return this.el("span", {className: "tfc-message-avatar", textContent: this.userName(user).charAt(0).toUpperCase() || "?"});
    }

    avatarUrl(user) { try { return user?.getAvatarURL?.(null, 64, true) || ""; } catch (_) { return ""; } }
    userName(user) { return String(user?.globalName || user?.displayName || user?.username || "Unknown user"); }
    getChannel(channelId) { try { return this.stores.channel?.getChannel?.(String(channelId)) || null; } catch (_) { return null; } }
    currentChannelId() { try { return String(this.stores.selected?.getChannelId?.() || ""); } catch (_) { return ""; } }
    currentUserId() { try { return String(this.stores.user?.getCurrentUser?.()?.id || ""); } catch (_) { return ""; } }

    openInDiscord(channelId) {
        const channel = this.getChannel(channelId), guildId = channel?.guild_id || channel?.guildId;
        const path = guildId ? `/channels/${guildId}/${channelId}` : `/channels/@me/${channelId}`;
        try {
            const existingLink = [...document.querySelectorAll('a[href^="/channels/"]')].find(link => {
                try { return new URL(link.href, location.origin).pathname === path; } catch (_) { return false; }
            });
            if (existingLink) { existingLink.click(); return; }
            if (!globalThis.history || typeof globalThis.dispatchEvent !== "function") throw new Error("Browser history is unavailable");
            history.pushState(history.state, "", path);
            const navigationEvent = typeof globalThis.PopStateEvent === "function"
                ? new PopStateEvent("popstate", {state: history.state})
                : new Event("popstate");
            globalThis.dispatchEvent(navigationEvent);
        } catch (error) {
            console.warn(`[${PLUGIN_NAME}] Safe channel navigation failed:`, error);
            this.toast("Discord could not open that channel. Open it from the channel list instead.", "error");
        }
    }

    updateLibraryEntry() {
        const count = this.data.order.length, open = this.data.order.filter(id => !this.data.windows[id]?.minimized).length;
        this.libraryEntry?.update?.({badge: count ? String(count) : "", status: count ? `${open} open · ${count - open} minimized` : "No pinned chats"});
    }

    messageTimestamp(message) {
        const value = message?.timestamp?.valueOf?.() ?? message?.timestamp ?? message?.createdAt;
        const number = Number(value); if (Number.isFinite(number)) return number;
        const parsed = Date.parse(String(value || "")); if (Number.isFinite(parsed)) return parsed;
        try { return Number((BigInt(String(message?.id)) >> 22n) + 1420070400000n); } catch (_) { return Date.now(); }
    }

    timeLabel(timestamp) {
        const date = new Date(timestamp), today = new Date();
        return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}) : date.toLocaleDateString([], {month: "short", day: "numeric"});
    }

    compareMessageIds(a, b) { try { const left = BigInt(String(a)), right = BigInt(String(b)); return left < right ? -1 : left > right ? 1 : 0; } catch (_) { return String(a).localeCompare(String(b)); } }
    normalize(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (value instanceof Map || value instanceof Set) return [...value.values()];
        try { if (typeof value.toArray === "function") return value.toArray(); } catch (_) {}
        try { if (typeof value.valueSeq === "function") return value.valueSeq().toArray(); } catch (_) {}
        if (Array.isArray(value._array)) return value._array;
        if (value._map instanceof Map) return [...value._map.values()];
        try { if (typeof value !== "string" && value[Symbol.iterator]) return [...value]; } catch (_) {}
        if (typeof value === "object") return Object.values(value);
        return [];
    }

    iconButton(icon, label, handler) {
        const button = this.el("button", {className: "tfc-icon-button", type: "button", title: label, "aria-label": label});
        button.append(this.icon(icon)); button.addEventListener("click", handler); return button;
    }

    icon(name) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
        const paths = {
            close: ["M18 6 6 18", "m6 0 12 12"], minus: ["M5 12h14"], external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
            send: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"]
        };
        for (const data of paths[name] || paths.close) { const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", data); svg.append(path); }
        return svg;
    }

    el(tag, properties = {}) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(properties)) {
            if (key === "className") node.className = value;
            else if (key === "textContent") node.textContent = value;
            else if (key === "disabled") node.disabled = Boolean(value);
            else if (key === "rows") node.rows = Number(value);
            else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
        }
        return node;
    }

    scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveNow(), 250); }
    saveNow() { this.save(DATA_KEY, this.data); }
    load(key) { try { return this.api?.Data?.load ? this.api.Data.load(key) : globalThis.BdApi?.Data?.load?.(PLUGIN_NAME, key); } catch (_) { return null; } }
    save(key, value) { try { if (this.api?.Data?.save) this.api.Data.save(key, value); else globalThis.BdApi?.Data?.save?.(PLUGIN_NAME, key, value); } catch (_) {} }
    toast(message, type = "info") { const ui = this.api?.UI || globalThis.BdApi?.UI; ui?.showToast?.(message, {type}); }

    addStyles() {
        const css = `
            #tiny-floating-chats-root{position:fixed!important;inset:0!important;z-index:2147480000!important;pointer-events:none!important;font-family:var(--font-primary,"gg sans",Arial,sans-serif)!important}.tfc-window{position:fixed!important;display:grid!important;grid-template-rows:50px minmax(0,1fr) auto!important;min-width:310px!important;min-height:280px!important;max-width:calc(100vw - 12px)!important;max-height:calc(100vh - 12px)!important;overflow:hidden!important;resize:both!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:10px!important;background:var(--background-primary,#313338)!important;color:var(--text-normal,#dbdee1)!important;box-shadow:0 18px 55px rgba(0,0,0,.55)!important;pointer-events:auto!important}.tfc-header{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important;padding:0 8px 0 10px!important;border-bottom:1px solid rgba(255,255,255,.07)!important;background:var(--background-secondary,#2b2d31)!important;cursor:move!important;user-select:none!important}.tfc-identity{display:flex!important;align-items:center!important;min-width:0!important;gap:9px!important}.tfc-avatar{display:grid!important;place-items:center!important;flex:none!important;width:30px!important;height:30px!important;border-radius:50%!important;background:var(--background-tertiary,#1e1f22)!important;color:var(--interactive-normal,#b5bac1)!important;object-fit:cover!important;font-size:11px!important;font-weight:750!important}.tfc-identity-copy{display:flex!important;min-width:0!important;flex-direction:column!important;gap:1px!important}.tfc-identity-copy strong,.tfc-identity-copy span{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}.tfc-identity-copy strong{color:var(--header-primary,#f2f3f5)!important;font-size:12px!important}.tfc-identity-copy span{color:var(--text-muted,#949ba4)!important;font-size:9px!important}.tfc-controls{display:flex!important;align-items:center!important;gap:2px!important}.tfc-icon-button{display:grid!important;place-items:center!important;flex:none!important;width:28px!important;height:28px!important;padding:0!important;border:0!important;border-radius:6px!important;background:transparent!important;color:var(--interactive-normal,#b5bac1)!important;cursor:pointer!important}.tfc-icon-button:hover{background:var(--background-modifier-hover,rgba(255,255,255,.06))!important;color:var(--header-primary,#f2f3f5)!important}.tfc-icon-button:disabled{cursor:not-allowed!important;opacity:.45!important}.tfc-icon-button svg{width:15px!important;height:15px!important}.tfc-messages{overflow-x:hidden!important;overflow-y:auto!important;padding:12px 10px 10px!important;background:var(--background-primary,#313338)!important;scrollbar-color:var(--background-modifier-accent) transparent!important}.tfc-message{display:grid!important;grid-template-columns:30px minmax(0,1fr)!important;gap:8px!important;margin-top:11px!important}.tfc-message:first-child{margin-top:0!important}.tfc-message.compact{margin-top:3px!important}.tfc-message-avatar{display:grid!important;place-items:center!important;width:30px!important;height:30px!important;border-radius:50%!important;background:var(--brand-500,#5865f2)!important;color:white!important;object-fit:cover!important;font-size:10px!important;font-weight:800!important}.tfc-avatar-spacer{width:30px!important}.tfc-message-body{min-width:0!important}.tfc-message-meta{display:flex!important;align-items:baseline!important;gap:6px!important;margin-bottom:2px!important}.tfc-message-meta strong{overflow:hidden!important;color:var(--header-primary,#f2f3f5)!important;font-size:11px!important;text-overflow:ellipsis!important;white-space:nowrap!important}.tfc-message-meta time{flex:none!important;color:var(--text-muted,#949ba4)!important;font-size:8px!important}.tfc-content{overflow-wrap:anywhere!important;color:var(--text-normal,#dbdee1)!important;font-size:11px!important;line-height:1.38!important;white-space:pre-wrap!important;user-select:text!important}.tfc-content a{color:var(--text-link,#00a8fc)!important}.tfc-muted,.tfc-edited{color:var(--text-muted,#949ba4)!important}.tfc-edited{margin-left:5px!important;font-size:8px!important}.tfc-media{display:block!important;width:max-content!important;max-width:100%!important;margin-top:5px!important}.tfc-media img,.tfc-media video,video.tfc-media{display:block!important;max-width:min(100%,280px)!important;max-height:220px!important;border-radius:6px!important;object-fit:contain!important}.tfc-file{display:block!important;overflow:hidden!important;max-width:100%!important;margin-top:5px!important;padding:7px 9px!important;border:1px solid rgba(255,255,255,.07)!important;border-radius:6px!important;background:var(--background-secondary,#2b2d31)!important;color:var(--text-link,#00a8fc)!important;font-size:10px!important;text-overflow:ellipsis!important;white-space:nowrap!important}.tfc-empty{display:grid!important;min-height:100%!important;place-items:center!important;padding:25px!important;color:var(--text-muted,#949ba4)!important;font-size:10px!important;text-align:center!important}.tfc-composer{display:flex!important;align-items:flex-end!important;gap:7px!important;padding:8px!important;border-top:1px solid rgba(255,255,255,.07)!important;background:var(--background-secondary,#2b2d31)!important}.tfc-input{display:block!important;flex:1!important;min-height:34px!important;max-height:110px!important;padding:8px 10px!important;overflow-y:auto!important;resize:none!important;border:1px solid transparent!important;border-radius:7px!important;outline:0!important;background:var(--channeltextarea-background,#383a40)!important;color:var(--text-normal,#dbdee1)!important;font:inherit!important;font-size:11px!important;line-height:16px!important}.tfc-input:focus{border-color:rgba(88,101,242,.55)!important}.tfc-input::placeholder{color:var(--channel-text-area-placeholder,#6d6f78)!important}.tfc-send{width:34px!important;height:34px!important;background:var(--brand-500,#5865f2)!important;color:white!important}.tfc-send:hover{background:var(--brand-560,#4752c4)!important}.tfc-bubble{position:fixed!important;display:flex!important;align-items:center!important;justify-content:center!important;width:48px!important;height:48px!important;padding:0!important;border:2px solid var(--background-primary,#313338)!important;border-radius:50%!important;background:var(--background-secondary,#2b2d31)!important;color:var(--text-normal,#dbdee1)!important;box-shadow:0 7px 22px rgba(0,0,0,.45)!important;cursor:pointer!important;pointer-events:auto!important;transition:transform .15s ease!important}.tfc-bubble:hover{transform:translateY(-3px)!important}.tfc-bubble .tfc-avatar{width:100%!important;height:100%!important}.tfc-bubble-name{display:none!important}.tfc-unread{position:absolute!important;right:-4px!important;bottom:-3px!important;display:grid!important;min-width:17px!important;height:17px!important;place-items:center!important;padding:0 4px!important;border:2px solid var(--background-primary,#313338)!important;border-radius:9px!important;background:var(--status-danger,#f23f43)!important;color:white!important;font-size:8px!important;font-weight:800!important}.tfc-unread[hidden]{display:none!important}.tfc-missing{opacity:.55!important}.tfc-manager-overlay{position:fixed!important;inset:0!important;z-index:2147483500!important;display:grid!important;place-items:center!important;padding:20px!important;background:rgba(0,0,0,.72)!important;backdrop-filter:blur(2px)!important;font-family:var(--font-primary,"gg sans",Arial,sans-serif)!important}.tfc-manager{display:grid!important;grid-template-rows:auto auto minmax(0,1fr)!important;width:min(650px,calc(100vw - 40px))!important;max-height:min(720px,calc(100vh - 40px))!important;overflow:hidden!important;border:1px solid rgba(255,255,255,.09)!important;border-radius:10px!important;background:var(--background-primary,#313338)!important;color:var(--text-normal,#dbdee1)!important;box-shadow:0 24px 80px rgba(0,0,0,.65)!important}.tfc-manager-head{display:flex!important;align-items:center!important;justify-content:space-between!important;padding:16px 17px!important;border-bottom:1px solid rgba(255,255,255,.07)!important;background:var(--background-secondary,#2b2d31)!important}.tfc-manager-head h1{margin:0!important;color:var(--header-primary,#f2f3f5)!important;font-size:18px!important}.tfc-manager-head p{margin:3px 0 0!important;color:var(--text-muted,#949ba4)!important;font-size:10px!important}.tfc-manager-tools{display:flex!important;gap:8px!important;padding:11px!important;border-bottom:1px solid rgba(255,255,255,.06)!important}.tfc-manager-tools input{flex:1!important;min-width:0!important;padding:8px 10px!important;border:1px solid rgba(255,255,255,.07)!important;border-radius:6px!important;outline:0!important;background:var(--background-tertiary,#1e1f22)!important;color:var(--text-normal,#dbdee1)!important;font-size:11px!important}.tfc-manager-tools input:focus{border-color:rgba(88,101,242,.55)!important}.tfc-primary,.tfc-secondary{padding:7px 10px!important;border:0!important;border-radius:5px!important;color:white!important;font-size:10px!important;font-weight:700!important;cursor:pointer!important}.tfc-primary{background:var(--brand-500,#5865f2)!important}.tfc-primary:hover{background:var(--brand-560,#4752c4)!important}.tfc-primary:disabled{cursor:not-allowed!important;opacity:.45!important}.tfc-secondary{border:1px solid rgba(255,255,255,.08)!important;background:var(--background-secondary,#2b2d31)!important;color:var(--interactive-normal,#b5bac1)!important}.tfc-channel-list{overflow-y:auto!important;padding:7px!important;scrollbar-color:var(--background-modifier-accent) transparent!important}.tfc-channel-row{display:flex!important;align-items:center!important;gap:10px!important;padding:8px 9px!important;border-radius:6px!important}.tfc-channel-row:hover{background:var(--background-modifier-hover,rgba(255,255,255,.05))!important}.tfc-channel-copy{display:flex!important;min-width:0!important;flex:1!important;flex-direction:column!important;gap:2px!important}.tfc-channel-copy strong,.tfc-channel-copy span{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}.tfc-channel-copy strong{color:var(--header-primary,#f2f3f5)!important;font-size:11px!important}.tfc-channel-copy span{color:var(--text-muted,#949ba4)!important;font-size:9px!important}.tfc-manager-empty{padding:35px!important;color:var(--text-muted,#949ba4)!important;font-size:11px!important;text-align:center!important}@media(max-width:600px){.tfc-window{min-width:280px!important}.tfc-manager-overlay{padding:8px!important}.tfc-manager{width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)!important}.tfc-manager-tools{align-items:stretch!important;flex-direction:column!important}}
        `;
        const managerPolish = `.tfc-section-label{position:sticky!important;top:-7px!important;z-index:1!important;margin:0 -1px 4px!important;padding:9px 8px 6px!important;background:var(--background-primary,#313338)!important;color:var(--text-muted,#949ba4)!important;font-size:9px!important;font-weight:800!important;letter-spacing:.45px!important;text-transform:uppercase!important}.tfc-section-label:not(:first-child){margin-top:7px!important;border-top:1px solid rgba(255,255,255,.06)!important}`;
        const combinedCss = css + managerPolish;
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.addStyle) dom.addStyle(STYLE_ID, combinedCss);
        else if (document.head) { const style = this.el("style", {id: STYLE_ID}); style.textContent = combinedCss; document.head.append(style); }
    }

    removeStyles() {
        const dom = this.api?.DOM || globalThis.BdApi?.DOM;
        if (dom?.removeStyle) dom.removeStyle(STYLE_ID);
        document.getElementById(STYLE_ID)?.remove();
    }
};
