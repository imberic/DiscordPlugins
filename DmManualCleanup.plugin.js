/**
 * @name DmManualCleanup
 * @author tiny
 * @description Queues your messages in the open DM and processes them through Discord's normal Delete Message flow after three confirmations.
 * @version 1.1.1
 */

/*
 * Safety design:
 * - This plugin never reads a token and never makes a network request.
 * - Messages are discovered only while Discord renders them during upward scrolling.
 * - Discord's normal message menu and confirmation dialog remain in the flow.
 * - The final Delete button is clicked only after the full three-layer run confirmation.
 */

module.exports = class DmManualCleanup {
    constructor() {
        this.name = "DmManualCleanup";
        this.state = "disabled";
        this.lockedChannelId = null;
        this.lockedPath = null;
        this.queue = [];
        this.queueIndex = 0;
        this.deleted = 0;
        this.skipped = 0;
        this.failures = [];
        this.runId = 0;
        this.processing = false;
        this.currentMessage = null;
        this.currentDialog = null;
        this.lastOpenFailure = null;
        this.autoConfirm = false;
        this.deleteOrder = "newest";
        this.averageMessageMs = 900;
        this.estimateSamples = 0;
        this.runStartedAt = null;
        this.actionObserver = null;
        this.rootObserver = null;
        this.routeTimer = null;
        this.timers = new Map();
        this.transientObservers = new Set();
        this.ui = null;
        this.launcher = null;
        this.highlighted = null;
        this.userStore = null;
        this.messageStore = null;
        this.onRouteEvent = () => this.checkRouteLock();
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        this.state = "idle";
        this.installStyles();
        this.resolveReadOnlyStores();
        this.rootObserver = new MutationObserver(() => {
            this.checkRouteLock();
            this.ensureLauncher();
        });
        this.rootObserver.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("popstate", this.onRouteEvent, true);
        window.addEventListener("hashchange", this.onRouteEvent, true);
        this.routeTimer = window.setInterval(() => this.checkRouteLock(), 100);
        this.ensureLauncher();
    }

    stop() {
        this.runId++;
        this.state = "disabled";
        this.processing = false;
        this.disconnectActionObserver();
        this.clearTransientResources();
        this.rootObserver?.disconnect();
        this.rootObserver = null;
        window.removeEventListener("popstate", this.onRouteEvent, true);
        window.removeEventListener("hashchange", this.onRouteEvent, true);
        if (this.routeTimer) window.clearInterval(this.routeTimer);
        this.routeTimer = null;
        this.dismissOpenMenuOrDialog();
        this.clearHighlight();
        this.removeUi();
        this.removeLauncher();
        this.clearQueueData();
        BdApi.DOM.removeStyle(this.name);
    }

    installStyles() {
        BdApi.DOM.addStyle(this.name, `
            #dmc-launcher {
                position: fixed; right: 0; bottom: 72px; z-index: 1000;
                width: 30px; height: 30px; padding: 0;
                border: 0; border-radius: 7px 0 0 7px;
                color: #fff; background: var(--brand-experiment, #5865f2);
                font-size: 15px; line-height: 30px; text-align: center;
                cursor: pointer; opacity: .22; transform: translateX(10px);
                box-shadow: var(--elevation-low); transition: opacity .15s ease, transform .15s ease;
            }
            #dmc-launcher:hover, #dmc-launcher:focus-visible {
                opacity: 1; transform: translateX(0); outline: 2px solid #fff; outline-offset: -2px;
            }
            #dmc-panel {
                position: fixed; right: 18px; top: 68px; z-index: 1002; width: 330px;
                box-sizing: border-box; border-radius: 12px; padding: 16px;
                color: #fff !important; background: var(--background-floating, #111214);
                box-shadow: var(--elevation-high); font-family: var(--font-primary);
            }
            #dmc-panel h2 { margin: 0 0 8px; color: #fff !important; font-size: 19px; }
            #dmc-panel p, #dmc-panel label { color: #fff !important; }
            #dmc-panel p { margin: 8px 0; line-height: 1.35; }
            #dmc-panel .dmc-muted { color: #fff !important; font-size: 13px; opacity: .88; }
            #dmc-panel .dmc-progress { font-size: 17px; font-weight: 700; color: #fff !important; }
            #dmc-panel .dmc-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
            #dmc-panel button {
                border: 0; border-radius: 5px; padding: 8px 11px; color: white;
                background: var(--button-secondary-background, #4e5058); font-weight: 600; cursor: pointer;
            }
            #dmc-panel button.dmc-primary { background: var(--brand-experiment, #5865f2); }
            #dmc-panel button.dmc-danger { background: var(--status-danger, #da373c); }
            #dmc-panel button:disabled { cursor: not-allowed; opacity: .45; }
            #dmc-panel input[type="text"] {
                width: 100%; box-sizing: border-box; margin-top: 8px; padding: 9px;
                border: 1px solid var(--background-modifier-accent); border-radius: 5px;
                color: #fff !important; background: var(--input-background, #1e1f22);
            }
            #dmc-panel select {
                width: 100%; box-sizing: border-box; margin-top: 8px; padding: 9px;
                border: 1px solid var(--background-modifier-accent); border-radius: 5px;
                color: #fff !important; background: var(--input-background, #1e1f22);
            }
            #dmc-panel label { display: block; margin-top: 12px; line-height: 1.35; }
            .dmc-message-highlight {
                outline: 3px solid var(--status-warning, #f0b232) !important;
                outline-offset: -3px; background: rgba(240, 178, 50, .16) !important;
            }
        `);
    }

    resolveReadOnlyStores() {
        // These local client stores provide identity for already-rendered messages.
        // They are read-only here; no dispatcher, REST module, token store, or network API is used.
        try {
            this.userStore = BdApi.Webpack.getStore("UserStore");
            this.messageStore = BdApi.Webpack.getStore("MessageStore");
        } catch (_) {
            this.userStore = null;
            this.messageStore = null;
        }
    }

    getDmRoute() {
        const match = location.pathname.match(/^\/channels\/@me\/(\d+)\/?$/);
        return match ? { channelId: match[1], path: location.pathname } : null;
    }

    checkRouteLock() {
        if (this.lockedPath && location.pathname !== this.lockedPath) {
            this.cancelForRouteChange();
            return;
        }
        this.ensureLauncher();
    }

    ensureLauncher() {
        if (this.state !== "idle" || !this.getDmRoute()) {
            this.removeLauncher();
            return;
        }
        if (this.launcher) return;
        const library = globalThis.TinyPluginLibrary;
        if (typeof library?.register !== "function") return this.toast("Tiny Plugin Library is required. Enable it and reload Discord.", "error");
        this.launcher = library.register({id: "dm-cleanup", name: "DM Cleanup", description: "Delete your messages from the open DM", icon: "🧹", order: 55, open: () => this.beginScan()});
    }

    removeLauncher() {
        this.launcher?.remove();
        this.launcher = null;
    }

    async beginScan() {
        if (this.state !== "idle" && this.state !== "summary") return;
        const route = this.getDmRoute();
        if (!route) {
            this.toast("Open a direct message or group direct message first.", "error");
            return;
        }

        this.resolveReadOnlyStores();
        const currentUserId = this.userStore?.getCurrentUser?.()?.id;
        if (!currentUserId) {
            this.toast("Could not identify the logged-in user from Discord's local UI state.", "error");
            return;
        }

        const scroller = this.getMessageScroller();
        if (!scroller) {
            this.toast("Could not find Discord's message scroller.", "error");
            return;
        }

        this.runId++;
        const runId = this.runId;
        this.clearQueueData();
        this.lockedChannelId = route.channelId;
        this.lockedPath = route.path;
        this.currentUserId = currentUserId;
        this.state = "scanning";
        this.removeLauncher();
        this.showScanning(0, "Reading visible messages…");

        try {
            await this.scanToBeginning(scroller, runId);
            if (!this.isRunActive(runId, "scanning")) return;
            this.applyQueueOrder();
            this.state = "confirm-1";
            this.showConfirmationLayer1();
        } catch (error) {
            if (this.isRunActive(runId)) {
                this.toast(`Scan stopped: ${error?.message || "unknown error"}`, "error");
                this.cancelCleanup(false);
            }
        }
    }

    async scanToBeginning(scroller, runId) {
        const found = new Map();
        let stableAtTop = 0;
        let priorOldest = null;
        let rounds = 0;

        while (this.isRunActive(runId, "scanning")) {
            this.collectRenderedOwnMessages(found);
            const renderedIds = this.getRenderedMessageIds();
            const oldest = renderedIds.length ? renderedIds.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b) : null;
            const atTop = scroller.scrollTop <= 2;
            const beginningVisible = this.isConversationBeginningVisible(scroller);
            const hasMoreBefore = this.hasMoreMessagesBefore();

            this.showScanning(found.size, beginningVisible ? "Beginning reached." : "Loading older messages…");
            if (beginningVisible || (atTop && hasMoreBefore === false)) break;

            if (atTop && oldest === priorOldest && !this.hasLoadingIndicator(scroller)) stableAtTop++;
            else stableAtTop = 0;

            // Discord does not expose a stable beginning marker in every client build.
            // Six settled top checks allow lazy loading to finish before treating the top as the beginning.
            if (atTop && stableAtTop >= 12 && hasMoreBefore !== true) break;
            priorOldest = oldest;

            const distance = Math.max(400, Math.floor(scroller.clientHeight * 0.8));
            if (atTop) {
                scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance, bubbles: true, cancelable: true }));
                scroller.scrollTop = 0;
            } else {
                scroller.scrollTop = Math.max(0, scroller.scrollTop - distance);
            }
            // Rendered pages are local and settle quickly. Only wait longer at the
            // very top, where Discord may actually be fetching an older page.
            await this.waitForDomSettle(atTop ? 250 : 50, runId);
            rounds++;
            if (rounds > 20000) throw new Error("safety limit reached while scanning");
        }

        this.collectRenderedOwnMessages(found);
        this.queue = [...found.values()];
    }

    collectRenderedOwnMessages(found) {
        for (const element of this.getRenderedMessageElements()) {
            const parsed = this.parseMessageElement(element);
            if (!parsed || parsed.channelId !== this.lockedChannelId || found.has(parsed.messageId)) continue;
            // MessageLoggerV2 deliberately puts deleted records back into Discord's
            // rendered message list. They are history, not live deletable messages.
            if (this.isMessageLoggerDeleted(parsed.messageId, element)) continue;
            const message = this.messageStore?.getMessage?.(this.lockedChannelId, parsed.messageId);
            const authorId = message?.author?.id || this.getAuthorIdFromElement(element);
            if (authorId === this.currentUserId) found.set(parsed.messageId, { id: parsed.messageId, status: "queued" });
        }
    }

    getRenderedMessageElements() {
        return [...document.querySelectorAll('li[id^="chat-messages-"], [data-list-item-id^="chat-messages___"]')];
    }

    getRenderedMessageIds() {
        const ids = [];
        for (const element of this.getRenderedMessageElements()) {
            const parsed = this.parseMessageElement(element);
            if (parsed?.channelId === this.lockedChannelId) ids.push(parsed.messageId);
        }
        return [...new Set(ids)];
    }

    parseMessageElement(element) {
        const rawId = element.id || "";
        let match = rawId.match(/^chat-messages-(\d+)-(\d+)/);
        if (!match) {
            const listId = element.getAttribute("data-list-item-id") || "";
            match = listId.match(/^chat-messages___(\d+)-(\d+)/);
        }
        return match ? { channelId: match[1], messageId: match[2] } : null;
    }

    getAuthorIdFromElement(element) {
        const explicit = element.querySelector("[data-author-id], [data-user-id]");
        const dataId = explicit?.getAttribute("data-author-id") || explicit?.getAttribute("data-user-id");
        if (/^\d+$/.test(dataId || "")) return dataId;
        const link = element.querySelector('a[href*="/users/"]')?.getAttribute("href") || "";
        const linkMatch = link.match(/\/users\/(\d+)/);
        if (linkMatch) return linkMatch[1];
        for (const image of element.querySelectorAll('img[src*="/avatars/"]')) {
            const avatarMatch = image.src.match(/\/avatars\/(\d+)\//);
            if (avatarMatch) return avatarMatch[1];
        }
        return null;
    }

    getMessageScroller() {
        const list = document.querySelector('[data-list-id="chat-messages"], ol[aria-label*="Messages" i]');
        if (!list) return null;
        let node = list.parentElement;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.clientHeight > 0) return node;
            node = node.parentElement;
        }
        return list.parentElement;
    }

    isConversationBeginningVisible(scroller) {
        const marker = scroller.querySelector('[class*="welcomeMessage"], [class*="emptyMessage"], [class*="header_"]');
        const text = marker?.textContent || "";
        return /beginning of (?:your )?(?:direct message|group)/i.test(text)
            || /no one has said anything yet/i.test(text);
    }

    hasLoadingIndicator(scroller) {
        return Boolean(scroller.querySelector('[class*="spinner"], [aria-label*="loading" i]'));
    }

    hasMoreMessagesBefore() {
        try {
            const messages = this.messageStore?.getMessages?.(this.lockedChannelId);
            return typeof messages?.hasMoreBefore === "boolean" ? messages.hasMoreBefore : null;
        } catch (_) {
            return null;
        }
    }

    compareSnowflakesDesc(a, b) {
        const first = BigInt(a);
        const second = BigInt(b);
        return first === second ? 0 : first > second ? -1 : 1;
    }

    applyQueueOrder() {
        this.queue.sort((a, b) => this.compareSnowflakesDesc(a.id, b.id));
        if (this.deleteOrder === "oldest") this.queue.reverse();
    }

    orderLabel() {
        return this.deleteOrder === "oldest" ? "oldest to newest" : "newest to oldest";
    }

    formatDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        if (totalSeconds < 1) return "under 1 second";
        if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes} minute${minutes === 1 ? "" : "s"}${seconds ? ` ${seconds} seconds` : ""}`;
    }

    estimatedTimeFor(messageCount) {
        return this.formatDuration(messageCount * this.averageMessageMs);
    }

    recordItemDuration(item) {
        if (!item?.startedAt) return;
        const elapsed = performance.now() - item.startedAt;
        delete item.startedAt;
        // Ignore long manual pauses so they do not distort the automated ETA.
        if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 10000) return;
        this.averageMessageMs = this.estimateSamples === 0
            ? elapsed
            : (this.averageMessageMs * 0.7) + (elapsed * 0.3);
        this.estimateSamples++;
    }

    showScanning(count, detail) {
        const panel = this.makePanel("Scanning this DM");
        panel.append(
            this.paragraph(`${count} of your messages found`, "dmc-progress"),
            this.paragraph(detail, "dmc-muted"),
            this.paragraph("Keep this DM open. The scan scrolls upward until Discord reaches the start of the conversation.", "dmc-muted")
        );
        panel.append(this.actions([
            this.button("Cancel Cleanup", "dmc-danger", () => this.cancelCleanup(false))
        ]));
    }

    showConfirmationLayer1() {
        const total = this.queue.length;
        const panel = this.makePanel("Confirmation 1 of 3");
        const orderText = this.paragraph("");
        const refreshOrderText = () => {
            orderText.textContent = `Order: ${this.orderLabel()}. Estimated cleanup time: about ${this.estimatedTimeFor(total)}.`;
        };
        panel.append(
            this.paragraph(`${total} of your messages found`, "dmc-progress"),
            this.paragraph(`The queue is locked to DM channel ${this.lockedChannelId}.`)
        );
        const orderSelect = document.createElement("select");
        orderSelect.setAttribute("aria-label", "Deletion order");
        orderSelect.append(
            new Option("Newest to oldest", "newest"),
            new Option("Oldest to newest", "oldest")
        );
        orderSelect.value = this.deleteOrder;
        orderSelect.addEventListener("change", () => {
            this.deleteOrder = orderSelect.value === "oldest" ? "oldest" : "newest";
            this.applyQueueOrder();
            refreshOrderText();
        });
        refreshOrderText();
        const check = this.checkbox("I reviewed the message count and DM scope.");
        const next = this.button("Continue", "dmc-primary", () => {
            this.state = "confirm-2";
            this.showConfirmationLayer2();
        });
        next.disabled = true;
        check.input.addEventListener("change", () => next.disabled = !check.input.checked);
        panel.append(orderSelect, orderText, check.label, this.actions([next, this.cancelButton()]));
    }

    showConfirmationLayer2() {
        const total = this.queue.length;
        const phrase = `DELETE ${total}`;
        const panel = this.makePanel("Confirmation 2 of 3");
        panel.append(
            this.paragraph(`${total} messages are queued.`, "dmc-progress"),
            this.paragraph(`Order: ${this.orderLabel()} · Estimated time: about ${this.estimatedTimeFor(total)}.`),
            this.paragraph(`Type ${phrase} to continue. This does not delete anything yet.`)
        );
        const input = document.createElement("input");
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.placeholder = phrase;
        const next = this.button("Continue", "dmc-primary", () => {
            this.state = "confirm-3";
            this.showConfirmationLayer3();
        });
        next.disabled = true;
        input.addEventListener("input", () => next.disabled = input.value === phrase ? false : true);
        panel.append(input, this.actions([next, this.cancelButton()]));
        input.focus();
    }

    showConfirmationLayer3() {
        const total = this.queue.length;
        const panel = this.makePanel("Confirmation 3 of 3");
        panel.append(
            this.paragraph(`${total} messages will be deleted one at a time.`, "dmc-progress"),
            this.paragraph(`Order: ${this.orderLabel()} · Estimated time: about ${this.estimatedTimeFor(total)}.`),
            this.paragraph("Discord’s normal confirmation dialog will still open for every message, but this run will automatically click its final Delete button before moving to the next message.")
        );
        const check = this.checkbox("I authorize automatic final confirmation for every message in this locked queue.");
        const start = this.button("Start Automatic Queue", "dmc-danger", () => this.startQueue());
        start.disabled = true;
        check.input.addEventListener("change", () => start.disabled = !check.input.checked);
        panel.append(check.label, this.actions([start, this.cancelButton()]));
    }

    startQueue() {
        if (this.state !== "confirm-3") return;
        this.autoConfirm = true;
        this.state = "running";
        this.queueIndex = 0;
        this.deleted = 0;
        this.skipped = 0;
        this.failures = [];
        this.averageMessageMs = 900;
        this.estimateSamples = 0;
        this.runStartedAt = performance.now();
        this.applyQueueOrder();
        this.showRunControls(`Starting ${this.orderLabel()}…`);
        this.processNext();
    }

    async processNext() {
        if (this.processing || this.state !== "running") return;
        if (!this.lockedPath || location.pathname !== this.lockedPath) {
            this.cancelForRouteChange();
            return;
        }
        if (this.queueIndex >= this.queue.length) {
            this.finishCleanup();
            return;
        }

        this.processing = true;
        const runId = this.runId;
        const item = this.queue[this.queueIndex];
        item.startedAt = performance.now();
        this.currentMessage = item;
        this.showRunControls(`Finding message ${this.queueIndex + 1} of ${this.queue.length}…`);

        try {
            const element = await this.findMessageByScrolling(item.id, runId);
            if (!this.isRunActive(runId) || this.state !== "running") return;
            if (!element) {
                this.recordFailure(item, "Message is already deleted, missing, or could not be loaded.");
                return;
            }

            element.scrollIntoView({ behavior: "auto", block: "center" });
            await this.waitForDomSettle(25, runId);
            if (!this.isRunActive(runId) || this.state !== "running") return;
            if (!element.isConnected) {
                this.recordFailure(item, "Message disappeared before its menu could be opened.");
                return;
            }
            this.highlight(element);
            this.showRunControls("Highlighted. Opening Discord’s Delete Message action…");
            const dialog = await this.openNormalDeleteDialog(element, runId);
            if (!dialog) {
                if (this.state === "paused" || !this.isRunActive(runId)) return;
                this.recordFailure(item, this.lastOpenFailure || "Discord’s normal Delete Message action could not be opened.");
                return;
            }
            this.currentDialog = dialog;
            this.processing = false;
            const wasPaused = this.state === "paused";
            this.state = wasPaused ? "paused" : "waiting-confirmation";
            this.showRunControls(wasPaused
                ? "Paused. Discord’s confirmation dialog remains under your control."
                : "Discord’s confirmation dialog is open. Confirming this queued deletion…");
            this.watchManualConfirmation(item, dialog, runId);
            if (!wasPaused && this.autoConfirm) this.confirmDiscordDelete(dialog, item, runId);
        } catch (error) {
            if (this.isRunActive(runId) && this.state === "running") {
                this.recordFailure(item, error?.message || "Unexpected error.");
            }
        } finally {
            if (this.state !== "waiting-confirmation") this.processing = false;
        }
    }

    async findMessageByScrolling(messageId, runId) {
        const direct = this.findRenderedMessage(messageId);
        if (direct) return this.isMessageLoggerDeleted(messageId, direct) ? null : direct;
        const scroller = this.getMessageScroller();
        if (!scroller) return null;
        let stableAtTop = 0;
        let previousOldest = null;

        for (let attempt = 0; attempt < 20000 && this.isRunActive(runId); attempt++) {
            const element = this.findRenderedMessage(messageId);
            if (element) return this.isMessageLoggerDeleted(messageId, element) ? null : element;
            const ids = this.getRenderedMessageIds();
            if (!ids.length) return null;
            const oldest = ids.reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
            const newest = ids.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
            const target = BigInt(messageId);
            const atTop = scroller.scrollTop <= 2;

            // The queue is descending, so this normally walks upward. The downward case
            // handles user scrolling without allowing a second simultaneous action.
            if (target > BigInt(newest)) {
                scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(400, scroller.clientHeight * 0.8));
            } else if (target < BigInt(oldest)) {
                scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(400, scroller.clientHeight * 0.8));
            } else {
                return null;
            }

            if (atTop && oldest === previousOldest && !this.hasLoadingIndicator(scroller)) stableAtTop++;
            else stableAtTop = 0;
            if (stableAtTop >= 5) return null;
            previousOldest = oldest;
            await this.waitForDomSettle(atTop ? 140 : 40, runId);
        }
        return null;
    }

    findRenderedMessage(messageId) {
        return document.getElementById(`chat-messages-${this.lockedChannelId}-${messageId}`)
            || document.querySelector(`[data-list-item-id="chat-messages___${this.lockedChannelId}-${messageId}"]`);
    }

    async openNormalDeleteDialog(element, runId) {
        this.lastOpenFailure = null;
        this.dismissOpenMenuOrDialog(false);
        await this.waitForDomSettle(0, runId);
        if (this.state !== "running" || !this.isRunActive(runId)) return null;

        // A logger can report deletion before Discord's modal closing animation ends.
        // Never let a new message reuse or compete with that previous dialog.
        const previousDialogs = this.getDeleteDialogs();
        if (previousDialogs.length) {
            await this.waitForElement(() => previousDialogs.every(previous => !previous.isConnected) ? document.body : null, 1800, runId);
            if (previousDialogs.some(previous => previous.isConnected)) {
                this.lastOpenFailure = "Discord’s previous Delete Message dialog was still open.";
                return null;
            }
        }

        const dialogsBeforeOpen = new Set(this.getDeleteDialogs());
        const target = element.querySelector('[id^="message-content-"]') || element;
        const rect = target.getBoundingClientRect();
        const clientX = Math.max(8, Math.min(innerWidth - 8, rect.left + Math.min(40, Math.max(8, rect.width / 2))));
        const clientY = Math.max(8, Math.min(innerHeight - 8, rect.top + Math.min(24, Math.max(8, rect.height / 2))));
        target.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, view: window,
            button: 2, buttons: 2, clientX: Math.round(clientX), clientY: Math.round(clientY)
        }));

        const menu = await this.waitForElement(() => {
            const menus = [...document.querySelectorAll('[role="menu"]')];
            return menus.find(candidate => this.isElementVisible(candidate));
        }, 2500, runId);
        if (!menu) {
            this.lastOpenFailure = "Discord did not expose a visible message context menu.";
            return null;
        }
        if (this.state !== "running") {
            this.dismissOpenMenuOrDialog(false);
            return null;
        }

        const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')];
        const deleteItem = items.find(item => {
            const identity = `${item.id || ""} ${item.getAttribute("data-list-item-id") || ""} ${item.getAttribute("aria-label") || ""}`;
            const label = (item.textContent || "").replace(/\s+/g, " ").trim();
            return /message[-_ ]?delete|delete[-_ ]?message/i.test(identity)
                || /^(?:delete|delete message)(?:\s|$)/i.test(label);
        });
        if (!deleteItem) {
            this.lastOpenFailure = "The message menu opened, but its Delete Message item was not found.";
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
            return null;
        }
        if (this.state !== "running" || !this.isRunActive(runId)) {
            this.dismissOpenMenuOrDialog(false);
            return null;
        }

        // Open Discord's own confirmation dialog before the separately authorized
        // final-confirmation step.
        deleteItem.click();
        const dialog = await this.waitForElement(() => {
            return this.getDeleteDialogs().find(candidate =>
                !dialogsBeforeOpen.has(candidate) && this.isElementVisible(candidate)
            ) || null;
        }, 3000, runId);
        if (!dialog) this.lastOpenFailure = "Delete Message was selected, but Discord’s confirmation dialog was not detected.";
        return dialog;
    }

    watchManualConfirmation(item, dialog, runId) {
        this.disconnectActionObserver();
        let checking = false;
        let dialogClosedAt = null;
        let graceTimer = null;
        const check = () => {
            if (checking || !this.isRunActive(runId) || !["waiting-confirmation", "paused"].includes(this.state)) return;
            checking = true;
            queueMicrotask(() => {
                checking = false;
                if (!this.isRunActive(runId)) return;
                const renderedMessage = this.findRenderedMessage(item.id);
                const loggerMarkedDeleted = this.isMessageLoggerDeleted(item.id, renderedMessage);
                // Do not consult MessageStore here. MessageLoggerV2 intentionally keeps
                // deleted records in that store, which previously paused the queue after
                // the first successful deletion.
                const messageStillExists = Boolean(renderedMessage) && !loggerMarkedDeleted;
                const dialogOpen = dialog.isConnected;

                if (!messageStillExists) {
                    this.clearTrackedTimeout(graceTimer);
                    this.disconnectActionObserver();
                    item.status = "deleted";
                    this.recordItemDuration(item);
                    this.deleted++;
                    this.queueIndex++;
                    this.currentMessage = null;
                    this.clearHighlight();
                    const shouldContinue = this.state !== "paused";
                    this.state = shouldContinue ? "running" : "paused";
                    this.showRunControls(shouldContinue
                        ? "Deletion confirmed. Waiting for Discord to close its dialog…"
                        : "Deletion confirmed. Queue is paused.");
                    this.continueAfterDialogCloses(dialog, runId, shouldContinue);
                } else if (!dialogOpen) {
                    if (dialogClosedAt === null) {
                        dialogClosedAt = Date.now();
                        graceTimer = this.setTrackedTimeout(check, 800);
                        return;
                    }
                    if (Date.now() - dialogClosedAt < 750) return;
                    this.clearTrackedTimeout(graceTimer);
                    this.disconnectActionObserver();
                    this.currentDialog = null;
                    this.state = "paused";
                    this.showRunControls("Discord’s confirmation was dismissed. The queue is paused; Resume retries this message.");
                }
            });
        };
        this.actionObserver = new MutationObserver(check);
        this.actionObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"]
        });
        check();
    }

    async continueAfterDialogCloses(dialog, runId, shouldContinue) {
        if (dialog?.isConnected) {
            await this.waitForElement(() => !dialog.isConnected ? document.body : null, 1800, runId);
        }
        if (!this.isRunActive(runId)) return;

        if (dialog?.isConnected) {
            // The deletion already succeeded; Escape only dismisses a stale completed modal.
            document.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true
            }));
            await this.waitForDomSettle(180, runId);
        }

        if (!this.isRunActive(runId)) return;
        if (dialog?.isConnected) {
            this.currentDialog = dialog;
            this.state = "paused";
            this.showRunControls("The previous Discord confirmation dialog did not close. The queue is paused.");
            return;
        }
        this.currentDialog = null;
        if (!shouldContinue || this.state === "paused") {
            this.state = "paused";
            this.showRunControls("Deletion confirmed. Queue is paused.");
            return;
        }
        if (this.state !== "running") return;
        this.showRunControls("Deletion confirmed. Moving to the next message…");
        // Maximum-speed sequential mode: the previous dialog is fully gone, so
        // begin the next message on the next event-loop turn with no added delay.
        this.setTrackedTimeout(() => this.processNext(), 0);
    }

    async confirmDiscordDelete(dialog, item, runId, attempt = 1) {
        const button = await this.waitForElement(() => {
            if (!dialog?.isConnected || dialog !== this.currentDialog) return null;
            if (!/delete message/i.test(dialog.textContent || "")) return null;
            return [...dialog.querySelectorAll('button, [role="button"]')].find(candidate =>
                this.isElementVisible(candidate)
                && !candidate.disabled
                && candidate.getAttribute("aria-disabled") !== "true"
                && /^delete$/i.test((candidate.textContent || candidate.getAttribute("aria-label") || "").trim())
            ) || null;
        }, 1500, runId);

        if (!button || !this.isRunActive(runId) || this.state !== "waiting-confirmation"
            || this.currentMessage !== item || this.currentDialog !== dialog) {
            if (this.state === "waiting-confirmation" && this.currentMessage === item) {
                this.state = "paused";
                this.showRunControls("Automatic confirmation could not find Discord’s final Delete button. The queue is paused.");
            }
            return;
        }

        // Exact dialog, exact visible "Delete" label, one queued message at a time.
        button.click();
        this.setTrackedTimeout(() => {
            if (!this.isRunActive(runId) || this.state !== "waiting-confirmation"
                || this.currentMessage !== item || this.currentDialog !== dialog || !dialog.isConnected) return;
            if (attempt >= 3) {
                this.state = "paused";
                this.showRunControls("Discord did not accept the automatic confirmation after three attempts. The queue is paused.");
                return;
            }
            this.showRunControls(`Discord did not close the confirmation dialog. Retrying (${attempt + 1} of 3)…`);
            this.confirmDiscordDelete(dialog, item, runId, attempt + 1);
        }, 1500);
    }

    pauseQueue() {
        if (!["running", "waiting-confirmation"].includes(this.state)) return;
        this.state = "paused";
        this.showRunControls(this.currentDialog?.isConnected
            ? "Paused. Discord’s confirmation dialog remains under your control."
            : "Queue paused.");
    }

    resumeQueue() {
        if (this.state !== "paused") return;
        if (this.currentDialog?.isConnected) {
            if (!this.currentMessage) {
                const staleDialog = this.currentDialog;
                this.state = "running";
                this.showRunControls("Closing Discord’s completed confirmation dialog…");
                this.continueAfterDialogCloses(staleDialog, this.runId, true);
                return;
            }
            this.state = "waiting-confirmation";
            this.showRunControls(this.autoConfirm
                ? "Resuming automatic confirmation in Discord’s dialog…"
                : "Waiting for you to confirm or cancel in Discord’s dialog.");
            if (this.autoConfirm) this.confirmDiscordDelete(this.currentDialog, this.currentMessage, this.runId);
            return;
        }
        this.disconnectActionObserver();
        this.currentDialog = null;
        this.lastOpenFailure = null;
        this.state = "running";
        this.showRunControls("Resuming…");
        this.processNext();
    }

    skipCurrent() {
        if (!["running", "waiting-confirmation", "paused"].includes(this.state) || !this.currentMessage) return;
        const item = this.currentMessage;
        this.runId++;
        this.disconnectActionObserver();
        this.clearTransientResources();
        this.dismissOpenMenuOrDialog();
        item.status = "skipped";
        this.recordItemDuration(item);
        this.skipped++;
        this.queueIndex++;
        this.currentMessage = null;
        this.currentDialog = null;
        this.processing = false;
        this.clearHighlight();
        this.state = "running";
        this.showRunControls("Message skipped. Moving to the next message…");
        this.setTrackedTimeout(() => this.processNext(), 75);
    }

    recordFailure(item, reason) {
        if (!item || item.status !== "queued") return;
        item.status = "failed";
        item.failure = reason;
        this.recordItemDuration(item);
        this.failures.push({ id: item.id, reason });
        this.queueIndex++;
        this.currentMessage = null;
        this.currentDialog = null;
        this.processing = false;
        this.clearHighlight();
        if (this.state !== "running") return;
        this.showRunControls(`Failed: ${reason} Moving to the next message…`);
        this.setTrackedTimeout(() => this.processNext(), 100);
    }

    showRunControls(status) {
        const panel = this.makePanel("DM Cleanup");
        const total = this.queue.length;
        const remaining = Math.max(0, total - this.queueIndex);
        panel.append(
            this.paragraph(`Deleted ${this.deleted} of ${total}.`, "dmc-progress"),
            this.paragraph(`Skipped: ${this.skipped} · Failed: ${this.failures.length}`, "dmc-muted"),
            this.paragraph(`Order: ${this.orderLabel()} · Estimated time remaining: about ${this.estimatedTimeFor(remaining)}.`, "dmc-muted"),
            this.paragraph(status)
        );
        const paused = this.state === "paused";
        const canSkip = Boolean(this.currentMessage);
        const pause = this.button("Pause", "", () => this.pauseQueue());
        pause.disabled = paused;
        const resume = this.button("Resume", "dmc-primary", () => this.resumeQueue());
        resume.disabled = !paused;
        const skip = this.button("Skip Message", "", () => this.skipCurrent());
        skip.disabled = !canSkip;
        panel.append(this.actions([
            pause,
            resume,
            skip,
            this.button("Cancel Cleanup", "dmc-danger", () => this.cancelCleanup(true))
        ]));
    }

    finishCleanup() {
        const summary = {
            deleted: this.deleted,
            skipped: this.skipped,
            failed: this.failures.length,
            elapsed: this.runStartedAt ? performance.now() - this.runStartedAt : 0,
            order: this.orderLabel()
        };
        this.disconnectActionObserver();
        this.clearTransientResources();
        this.clearHighlight();
        this.processing = false;
        this.currentMessage = null;
        this.currentDialog = null;
        this.queue = [];
        this.queueIndex = 0;
        this.lockedChannelId = null;
        this.lockedPath = null;
        this.currentUserId = null;
        this.failures = [];
        this.state = "summary";

        const panel = this.makePanel("Cleanup complete");
        panel.append(
            this.paragraph(`Messages deleted: ${summary.deleted}`, "dmc-progress"),
            this.paragraph(`Messages skipped: ${summary.skipped}`),
            this.paragraph(`Messages that failed: ${summary.failed}`),
            this.paragraph(`Order: ${summary.order} · Elapsed time: ${this.formatDuration(summary.elapsed)}.`, "dmc-muted")
        );
        panel.append(this.actions([
            this.button("Close", "dmc-primary", () => {
                this.removeUi();
                this.clearQueueData();
                this.state = "idle";
                this.ensureLauncher();
            })
        ]));
    }

    cancelCleanup(showSummary) {
        if (this.state === "disabled") return;
        const summary = { deleted: this.deleted, skipped: this.skipped, failed: this.failures.length };
        this.runId++;
        this.disconnectActionObserver();
        this.clearTransientResources();
        this.dismissOpenMenuOrDialog();
        this.clearHighlight();
        this.processing = false;
        this.clearQueueData();
        this.state = showSummary ? "summary" : "idle";

        if (showSummary) {
            const panel = this.makePanel("Cleanup canceled");
            panel.append(
                this.paragraph(`Messages deleted: ${summary.deleted}`, "dmc-progress"),
                this.paragraph(`Messages skipped: ${summary.skipped}`),
                this.paragraph(`Messages that failed: ${summary.failed}`)
            );
            panel.append(this.actions([this.button("Close", "dmc-primary", () => {
                this.removeUi();
                this.state = "idle";
                this.ensureLauncher();
            })]));
        } else {
            this.removeUi();
            this.ensureLauncher();
        }
    }

    cancelForRouteChange() {
        if (!this.lockedPath) return;
        this.runId++;
        this.disconnectActionObserver();
        this.clearTransientResources();
        this.dismissOpenMenuOrDialog();
        this.clearHighlight();
        this.processing = false;
        this.clearQueueData();
        this.state = "idle";
        this.removeUi();
        this.removeLauncher();
        this.toast("DM cleanup canceled because the active channel changed.", "warning");
        this.ensureLauncher();
    }

    clearQueueData() {
        this.queue = [];
        this.queueIndex = 0;
        this.deleted = 0;
        this.skipped = 0;
        this.failures = [];
        this.lockedChannelId = null;
        this.lockedPath = null;
        this.currentUserId = null;
        this.currentMessage = null;
        this.currentDialog = null;
        this.lastOpenFailure = null;
        this.autoConfirm = false;
        this.deleteOrder = "newest";
        this.averageMessageMs = 900;
        this.estimateSamples = 0;
        this.runStartedAt = null;
    }

    disconnectActionObserver() {
        this.actionObserver?.disconnect();
        this.actionObserver = null;
    }

    highlight(element) {
        this.clearHighlight();
        element.classList.add("dmc-message-highlight");
        this.highlighted = element;
    }

    clearHighlight() {
        this.highlighted?.classList.remove("dmc-message-highlight");
        this.highlighted = null;
    }

    dismissOpenMenuOrDialog(includeDialog = true) {
        const menuOpen = document.querySelector('[role="menu"]');
        const dialogOpen = includeDialog && this.currentDialog?.isConnected;
        if (menuOpen || dialogOpen) {
            document.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true
            }));
        }
    }

    isRunActive(runId, requiredState = null) {
        return runId === this.runId
            && this.state !== "disabled"
            && (!requiredState || this.state === requiredState)
            && (!this.lockedPath || location.pathname === this.lockedPath);
    }

    isElementVisible(element) {
        if (!element?.isConnected) return false;
        const style = getComputedStyle(element);
        // Discord fades fixed-position menus in from opacity 0, so opacity and
        // offsetParent are not reliable visibility signals here.
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    getDeleteDialogs() {
        return [...document.querySelectorAll('[role="dialog"]')].filter(dialog =>
            /delete message/i.test(dialog.textContent || "")
        );
    }

    isMessageLoggerDeleted(messageId, element = null) {
        try {
            const addon = BdApi.Plugins?.get?.("MessageLoggerV2");
            const candidates = [addon, addon?.instance, addon?.plugin, addon?.exports, addon?.module?.exports]
                .filter(Boolean);

            // BetterDiscord versions expose the running addon instance in slightly
            // different places. Look only at MessageLoggerV2's known local records.
            for (const candidate of candidates) {
                for (const recordName of ["deletedMessageRecord", "purgedMessageRecord"]) {
                    const channelRecords = candidate?.[recordName]?.[this.lockedChannelId];
                    if (Array.isArray(channelRecords) && channelRecords.some(entry => String(entry?.id || entry) === String(messageId))) {
                        return true;
                    }
                }
                const record = candidate?.messageRecord?.get?.(messageId)
                    || candidate?.messageRecord?.[messageId];
                if (record?.delete_data) return true;

                const deletedClass = candidate?.style?.deleted;
                const deletedAltClass = candidate?.style?.deletedAlt;
                if (element && [deletedClass, deletedAltClass].filter(Boolean).some(className =>
                    element.classList.contains(className) || element.querySelector(`.${CSS.escape(className)}`)
                )) return true;
            }

            // Stable fallback for installations with CSS-class obfuscation disabled.
            if (element?.matches?.(".ml2-deleted, .ml2-deleted-alt")
                || element?.querySelector?.(".ml2-deleted, .ml2-deleted-alt")) return true;
        } catch (_) {
            // Compatibility checks fail closed to the normal live-message test below.
        }
        return false;
    }

    waitForDomSettle(milliseconds, runId) {
        return new Promise(resolve => {
            const timeout = this.setTrackedTimeout(resolve, milliseconds, resolve);
            if (!this.isRunActive(runId)) {
                this.clearTrackedTimeout(timeout);
                resolve();
            }
        });
    }

    waitForElement(getter, timeoutMs, runId) {
        return new Promise(resolve => {
            const existing = getter();
            if (existing) return resolve(existing);
            let done = false;
            let timeout = null;
            const finish = value => {
                if (done) return;
                done = true;
                observer.disconnect();
                this.transientObservers.delete(observer);
                this.clearTrackedTimeout(timeout);
                resolve(value);
            };
            const observer = new MutationObserver(() => {
                if (!this.isRunActive(runId)) finish(null);
                else {
                    const value = getter();
                    if (value) finish(value);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            this.transientObservers.add(observer);
            timeout = this.setTrackedTimeout(() => finish(null), timeoutMs, () => finish(null));
        });
    }

    setTrackedTimeout(callback, milliseconds, onCancel = null) {
        const id = window.setTimeout(() => {
            this.timers.delete(id);
            callback();
        }, milliseconds);
        this.timers.set(id, onCancel);
        return id;
    }

    clearTrackedTimeout(id) {
        if (id === null || !this.timers.has(id)) return;
        window.clearTimeout(id);
        this.timers.delete(id);
    }

    clearTransientResources() {
        for (const observer of this.transientObservers) observer.disconnect();
        this.transientObservers.clear();
        const timers = [...this.timers.entries()];
        this.timers.clear();
        for (const [id, onCancel] of timers) {
            window.clearTimeout(id);
            if (onCancel) onCancel();
        }
    }

    makePanel(title) {
        this.removeUi();
        const panel = document.createElement("section");
        panel.id = "dmc-panel";
        panel.setAttribute("aria-live", "polite");
        const heading = document.createElement("h2");
        heading.textContent = title;
        panel.appendChild(heading);
        document.body.appendChild(panel);
        this.ui = panel;
        return panel;
    }

    removeUi() {
        this.ui?.remove();
        this.ui = null;
    }

    paragraph(text, className = "") {
        const p = document.createElement("p");
        p.textContent = text;
        if (className) p.className = className;
        return p;
    }

    checkbox(text) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        label.append(input, document.createTextNode(` ${text}`));
        return { label, input };
    }

    button(text, className, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        if (className) button.className = className;
        button.addEventListener("click", onClick);
        return button;
    }

    cancelButton() {
        return this.button("Cancel Cleanup", "", () => this.cancelCleanup(false));
    }

    actions(buttons) {
        const row = document.createElement("div");
        row.className = "dmc-actions";
        row.append(...buttons);
        return row;
    }

    toast(message, type = "info") {
        try {
            BdApi.UI.showToast(message, { type, timeout: 5000 });
        } catch (_) {
            console.log(`[${this.name}] ${message}`);
        }
    }
};
