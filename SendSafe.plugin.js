/**
 * @name SendSafe
 * @author tiny
 * @description Checks messages and attachments locally before potentially risky Discord sends.
 * @version 1.1.0
 */

/*
 * Privacy design:
 * - Checks happen only inside this Discord client.
 * - No account token, message history, or network service is used.
 * - Warning cards identify the risk category without repeating the sensitive value.
 * - The plugin never stores message or attachment content.
 */

module.exports = class SendSafe {
    constructor() {
        this.name = "SendSafe";
        this.defaultSettings = {
            checkPersonalInfo: true,
            checkCredentials: true,
            checkMassMentions: true,
            checkPrivateLanguage: true,
            checkAttachments: true,
            checkMetadata: true,
            requireShiftOverride: true,
            protectedLocationIds: "",
            sensitiveWords: ""
        };
        this.settings = { ...this.defaultSettings };
        this.panel = null;
        this.pendingFiles = new Map();
        this.bypassOnce = false;
        this.checking = false;
        this.preflightId = 0;
        this.lastPath = null;
        this.routeTimer = null;
        this.onKeyDown = event => this.handleKeyDown(event);
        this.onClick = event => this.handleClick(event);
        this.onPaste = event => this.captureFiles(event.clipboardData?.files);
        this.onDrop = event => this.captureFiles(event.dataTransfer?.files);
        this.onChange = event => {
            if (event.target?.files) this.captureFiles(event.target.files);
        };
    }

    start() {
        if (typeof globalThis.TinyPluginLibrary?.register !== "function") return globalThis.BdApi?.UI?.showToast?.("Tiny Plugin Library is required. Enable it and reload Discord.", {type: "error"});
        this.loadSettings();
        this.installStyles();
        this.lastPath = location.pathname;
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("click", this.onClick, true);
        document.addEventListener("paste", this.onPaste, true);
        document.addEventListener("drop", this.onDrop, true);
        document.addEventListener("change", this.onChange, true);
        this.routeTimer = window.setInterval(() => this.checkRoute(), 500);
        this.toast("SendSafe is checking risky sends locally.", "success");
    }

    stop() {
        this.preflightId++;
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener("click", this.onClick, true);
        document.removeEventListener("paste", this.onPaste, true);
        document.removeEventListener("drop", this.onDrop, true);
        document.removeEventListener("change", this.onChange, true);
        if (this.routeTimer) window.clearInterval(this.routeTimer);
        this.routeTimer = null;
        this.pendingFiles.clear();
        this.removePanel();
        BdApi.DOM.removeStyle(this.name);
    }

    loadSettings() {
        try {
            this.settings = { ...this.defaultSettings, ...(BdApi.Data.load(this.name, "settings") || {}) };
        } catch (_) {
            this.settings = { ...this.defaultSettings };
        }
    }

    saveSettings() {
        BdApi.Data.save(this.name, "settings", this.settings);
    }

    getSettingsPanel() {
        const root = document.createElement("div");
        root.className = "sendsafe-settings";
        root.append(
            this.settingCheckbox("Personal information", "Warn about email addresses, phone numbers, IP addresses, street addresses, and invite links.", "checkPersonalInfo"),
            this.settingCheckbox("Credentials and secrets", "Warn about password assignments, bearer credentials, Discord token formats, and common API-key formats.", "checkCredentials"),
            this.settingCheckbox("Mass and role mentions", "Warn before sending @everyone, @here, or role mentions.", "checkMassMentions"),
            this.settingCheckbox("Private wording in servers", "Warn when DM-like wording appears in a server channel.", "checkPrivateLanguage"),
            this.settingCheckbox("Attachment safety", "Check suspicious filenames, executable files, double extensions, and MIME mismatches.", "checkAttachments"),
            this.settingCheckbox("Attachment metadata", "Look locally for common EXIF, GPS, PDF author, and document-property markers.", "checkMetadata"),
            this.settingCheckbox("Require Shift-click override", "Sending after a warning requires holding Shift while clicking Send anyway.", "requireShiftOverride"),
            this.settingText("Always-confirm server or channel IDs", "Comma-separated server or channel IDs that should always display a confirmation.", "protectedLocationIds", "123456789, 987654321"),
            this.settingText("Custom sensitive words", "Comma-separated words or phrases that should trigger a warning.", "sensitiveWords", "client secret, project codename")
        );
        return root;
    }

    settingShell(name, note) {
        const row = document.createElement("label");
        row.className = "sendsafe-setting-row";
        const copy = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = name;
        const detail = document.createElement("small");
        detail.textContent = note;
        copy.append(title, detail);
        row.appendChild(copy);
        return row;
    }

    settingCheckbox(name, note, key) {
        const row = this.settingShell(name, note);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(this.settings[key]);
        input.addEventListener("change", () => {
            this.settings[key] = input.checked;
            this.saveSettings();
        });
        row.appendChild(input);
        return row;
    }

    settingText(name, note, key, placeholder) {
        const row = this.settingShell(name, note);
        const input = document.createElement("input");
        input.type = "text";
        input.value = String(this.settings[key] || "");
        input.placeholder = placeholder;
        input.addEventListener("change", () => {
            this.settings[key] = input.value.trim();
            this.saveSettings();
        });
        row.appendChild(input);
        return row;
    }

    installStyles() {
        BdApi.DOM.addStyle(this.name, `
            #sendsafe-panel {
                position: fixed; inset: 0; z-index: 2147483600; display: flex; align-items: center; justify-content: center;
                padding: 24px; background: rgba(0,0,0,.72); font-family: var(--font-primary);
            }
            #sendsafe-panel * { box-sizing: border-box; }
            #sendsafe-panel .sendsafe-card {
                width: min(520px, calc(100vw - 32px)); max-height: min(680px, calc(100vh - 32px)); overflow-y: auto;
                padding: 20px; color: var(--text-normal, #dbdee1); background: var(--background-floating, #111214);
                border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.12)); border-radius: 14px;
                box-shadow: var(--elevation-high);
            }
            #sendsafe-panel h2 { margin: 0 0 6px; color: var(--header-primary, #f2f3f5); font-size: 20px; }
            #sendsafe-panel p { margin: 7px 0; line-height: 1.4; }
            #sendsafe-panel .sendsafe-muted { color: var(--text-muted, #949ba4); font-size: 13px; }
            #sendsafe-panel .sendsafe-list { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; }
            #sendsafe-panel .sendsafe-finding { padding: 11px; border-left: 4px solid #f0b232; border-radius: 6px; background: rgba(240,178,50,.10); }
            #sendsafe-panel .sendsafe-finding.sendsafe-high { border-color: #da373c; background: rgba(218,55,60,.10); }
            #sendsafe-panel .sendsafe-finding strong { display: block; color: var(--header-primary, #f2f3f5); }
            #sendsafe-panel .sendsafe-finding span { color: var(--text-muted, #949ba4); font-size: 13px; }
            #sendsafe-panel .sendsafe-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
            #sendsafe-panel button {
                border: 0; border-radius: 6px; padding: 9px 12px; color: white;
                background: var(--button-secondary-background, #4e5058); font: inherit; font-weight: 700; cursor: pointer;
            }
            #sendsafe-panel button.sendsafe-cancel { background: var(--brand-500, #5865f2); }
            #sendsafe-panel button.sendsafe-danger { background: var(--status-danger, #da373c); }
            #sendsafe-panel .sendsafe-shift { color: var(--text-warning, #f0b232); font-size: 13px; }
            #sendsafe-panel .sendsafe-checking { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
            #sendsafe-panel .sendsafe-spinner {
                width: 18px; height: 18px; border: 3px solid var(--background-modifier-accent);
                border-top-color: var(--brand-500, #5865f2); border-radius: 50%; animation: sendsafe-spin .8s linear infinite;
            }
            @keyframes sendsafe-spin { to { transform: rotate(360deg); } }
            .sendsafe-settings { color: var(--text-normal); }
            .sendsafe-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 15px 0; border-bottom: 1px solid var(--background-modifier-accent); }
            .sendsafe-setting-row > span { display: flex; flex: 1; flex-direction: column; gap: 4px; }
            .sendsafe-setting-row small { color: var(--text-muted); line-height: 1.35; }
            .sendsafe-setting-row input[type="text"] {
                min-width: 190px; max-width: 250px; padding: 7px; color: var(--interactive-active);
                background: var(--background-secondary); border: 1px solid var(--background-modifier-accent); border-radius: 4px;
            }
        `);
    }

    handleKeyDown(event) {
        if (event.key === "Escape" && this.panel) {
            event.preventDefault();
            event.stopPropagation();
            this.cancelWarning();
            return;
        }
        if (this.bypassOnce) {
            this.bypassOnce = false;
            return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.defaultPrevented) return;
        const composer = event.target?.closest?.('[contenteditable="true"][role="textbox"]');
        if (!composer || composer.closest("#sendsafe-panel")) return;

        const request = this.makeRequest(composer, () => this.replayKeyboardSend(composer, event));
        if (!this.requestNeedsPreflight(request)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.beginPreflight(request);
    }

    handleClick(event) {
        if (event.target?.closest?.("#sendsafe-panel")) return;
        if (this.bypassOnce) {
            this.bypassOnce = false;
            return;
        }
        const button = event.target?.closest?.("button, [role=button]");
        if (!button || !this.isSendButton(button)) return;
        const composer = this.findComposer(button);
        const request = this.makeRequest(composer, () => this.replayButtonSend(button), button);
        if (!this.requestNeedsPreflight(request)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.beginPreflight(request);
    }

    isSendButton(button) {
        const labels = [button.getAttribute("aria-label") || "", button.textContent || ""].map(value => value.trim()).filter(Boolean);
        if (!labels.some(label => /^(?:send|upload)(?:\s+message|\s+file)?$/i.test(label))) return false;
        const dialog = button.closest("[role=dialog]");
        if (dialog) {
            return Boolean(dialog.querySelector('[contenteditable="true"], [class*="upload"], [class*="attachment"]'))
                || /\bupload\b|add a comment/i.test(dialog.textContent || "");
        }
        return Boolean(button.closest("form, [class*=channelTextArea], [class*=uploadModal]"));
    }

    findComposer(button = null) {
        const localRoot = button?.closest?.("form, [role=dialog], [class*=chatContent]");
        const local = localRoot?.querySelector?.('[contenteditable="true"][role="textbox"]');
        if (local && this.isVisible(local)) return local;
        return [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(element => this.isVisible(element)) || null;
    }

    composerText(composer) {
        return String(composer?.innerText || composer?.textContent || "").trim();
    }

    makeRequest(composer, action, button = null) {
        const route = this.getRouteContext();
        const text = this.composerText(composer);
        const textFindings = this.uniqueFindings([...this.scanText(text, route), ...this.scanComposerStructure(composer)]);
        const files = this.getRelevantFileRecords(composer, button);
        return { composer, action, button, text, route, textFindings, files };
    }

    requestNeedsPreflight(request) {
        return request.textFindings.length > 0 || (this.settings.checkAttachments && request.files.length > 0);
    }

    async beginPreflight(request) {
        if (this.checking || this.panel) return;
        const preflightId = ++this.preflightId;
        this.checking = true;
        if (request.files.length) this.showChecking(request.files.length);
        try {
            const fileFindings = this.settings.checkAttachments
                ? (await Promise.all(request.files.map(record => record.promise))).flat()
                : [];
            if (preflightId !== this.preflightId) return;
            const findings = this.uniqueFindings([...request.textFindings, ...fileFindings]);
            this.checking = false;
            if (!findings.length) {
                this.removePanel();
                this.performApprovedSend(request.action);
                return;
            }
            this.showWarning(findings, request);
        } catch (_) {
            if (preflightId !== this.preflightId) return;
            this.checking = false;
            this.showWarning([{ code: "FILE_SCAN_FAILED", severity: "medium", title: "Attachment could not be checked", detail: "Review the attachment manually before sending." }], request);
        }
    }

    showChecking(fileCount) {
        const card = this.makePanel();
        const title = document.createElement("h2");
        title.textContent = "Checking attachment";
        const copy = document.createElement("p");
        copy.className = "sendsafe-muted";
        copy.textContent = `Inspecting ${fileCount} local file${fileCount === 1 ? "" : "s"}. Nothing is being uploaded by SendSafe.`;
        const status = document.createElement("div");
        status.className = "sendsafe-checking";
        const spinner = document.createElement("span");
        spinner.className = "sendsafe-spinner";
        status.append(spinner, document.createTextNode("Running local safety checks..."));
        card.append(title, copy, status);
    }

    showWarning(findings, request) {
        const card = this.makePanel();
        const heading = document.createElement("h2");
        heading.textContent = "Check before sending";
        const intro = document.createElement("p");
        intro.textContent = `SendSafe found ${findings.length} possible risk${findings.length === 1 ? "" : "s"}. Your sensitive values are not repeated here.`;
        const list = document.createElement("div");
        list.className = "sendsafe-list";
        for (const finding of findings) {
            const row = document.createElement("div");
            row.className = `sendsafe-finding${finding.severity === "high" ? " sendsafe-high" : ""}`;
            const title = document.createElement("strong");
            title.textContent = finding.title;
            const detail = document.createElement("span");
            detail.textContent = finding.detail;
            row.append(title, detail);
            list.appendChild(row);
        }
        const help = document.createElement("p");
        help.className = "sendsafe-shift";
        help.textContent = this.settings.requireShiftOverride
            ? "To override the warning, hold Shift while clicking Send anyway."
            : "Review every warning before overriding it.";
        const actions = document.createElement("div");
        actions.className = "sendsafe-actions";
        const edit = this.button("Go back and edit", "sendsafe-cancel", () => {
            this.cancelWarning();
            request.composer?.focus?.();
        });
        const send = this.button("Send anyway", "sendsafe-danger", event => {
            if (this.settings.requireShiftOverride && !event.shiftKey) {
                help.textContent = "Keep Shift held while clicking Send anyway.";
                return;
            }
            this.removePanel();
            this.performApprovedSend(request.action);
        });
        actions.append(edit, send);
        card.append(heading, intro, list, help, actions);
    }

    makePanel() {
        this.removePanel();
        const overlay = document.createElement("section");
        overlay.id = "sendsafe-panel";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "SendSafe warning");
        const card = document.createElement("div");
        card.className = "sendsafe-card";
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        this.panel = overlay;
        return card;
    }

    button(text, className, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.className = className;
        button.addEventListener("click", onClick);
        return button;
    }

    cancelWarning() {
        this.preflightId++;
        this.checking = false;
        this.removePanel();
    }

    removePanel() {
        this.panel?.remove();
        this.panel = null;
    }

    performApprovedSend(action) {
        this.removePanel();
        this.bypassOnce = true;
        try {
            action();
            window.setTimeout(() => {
                this.bypassOnce = false;
                this.pendingFiles.clear();
            }, 1000);
        } catch (_) {
            this.bypassOnce = false;
            this.toast("Discord did not accept the resumed send. Your draft was left untouched.", "error");
        }
    }

    replayButtonSend(button) {
        if (!button?.isConnected) throw new Error("send button is no longer available");
        button.click();
    }

    replayKeyboardSend(composer, originalEvent) {
        const form = composer.closest("form, [class*=channelTextArea]");
        const sendButton = [...(form?.querySelectorAll?.("button, [role=button]") || [])].find(button => this.isSendButton(button));
        if (sendButton) return sendButton.click();
        composer.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
            ctrlKey: originalEvent.ctrlKey, altKey: originalEvent.altKey, metaKey: originalEvent.metaKey,
            bubbles: true, cancelable: true
        }));
    }

    scanText(text, context = {}) {
        if (!text) return this.locationFindings(context);
        const findings = this.locationFindings(context);
        const add = (code, severity, title, detail) => findings.push({ code, severity, title, detail });

        if (this.settings.checkPersonalInfo) {
            if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) add("EMAIL", "high", "Possible email address", "Personal contact information may be visible.");
            if (/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(text)) add("PHONE", "high", "Possible phone number", "Personal contact information may be visible.");
            if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)) add("IP", "high", "Possible IP address", "A network address may be visible.");
            if (/\b\d{1,6}\s+[A-Za-z0-9.' -]{2,50}\s(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b/i.test(text)) add("ADDRESS", "high", "Possible street address", "A physical address may be visible.");
            if (/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/i.test(text)) add("INVITE", "medium", "Discord invite link", "Confirm that this invite is intended for the current conversation.");
        }

        if (this.settings.checkCredentials) {
            if (/\b(?:password|passwd|pwd|passcode)\s*(?:is|=|:)\s*[^\s]{4,}/i.test(text)) add("PASSWORD", "high", "Possible password or passcode", "Credential-like text may be visible.");
            if (/\bmfa\.[A-Za-z0-9_-]{20,}\b|\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/.test(text)) add("DISCORD_TOKEN", "high", "Possible Discord token", "Never send account tokens to another person.");
            if (/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/.test(text)) add("API_KEY", "high", "Possible API or access key", "A credential-like key may be visible.");
            if (/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i.test(text)) add("BEARER", "high", "Possible bearer credential", "An authorization credential may be visible.");
        }

        if (this.settings.checkMassMentions) {
            if (/@everyone\b|@here\b/.test(text)) add("MASS_MENTION", "medium", "Mass mention", "This may notify a large number of people.");
            if (/<@&\d+>/.test(text)) add("ROLE_MENTION", "medium", "Role mention", "Confirm that notifying this role is intentional.");
        }

        if (this.settings.checkPrivateLanguage && context.isServer
            && /\b(?:just between us|do not share|don't share|keep this private|private message|my home address|my password|confidential)\b/i.test(text)) {
            add("PRIVATE_LANGUAGE", "high", "Private-sounding message in a server", "This wording may have been intended for a direct message.");
        }

        const lower = text.toLocaleLowerCase();
        for (const phrase of this.commaValues(this.settings.sensitiveWords)) {
            if (phrase.length >= 2 && lower.includes(phrase.toLocaleLowerCase())) {
                add("CUSTOM_WORD", "high", "Custom sensitive phrase", "A phrase from your local SendSafe blocklist is present.");
                break;
            }
        }
        return this.uniqueFindings(findings);
    }

    scanComposerStructure(composer) {
        if (!this.settings.checkMassMentions || !composer) return [];
        const roleMention = composer.querySelector('[data-role-id], [class*="roleMention"], [class*="mention"][aria-label*="role" i]');
        return roleMention
            ? [{ code: "ROLE_MENTION", severity: "medium", title: "Role mention", detail: "Confirm that notifying this role is intentional." }]
            : [];
    }

    locationFindings(context) {
        const protectedIds = new Set(this.idValues(this.settings.protectedLocationIds));
        if (protectedIds.has(String(context.channelId || "")) || protectedIds.has(String(context.guildId || ""))) {
            return [{ code: "PROTECTED_LOCATION", severity: "medium", title: "Always-confirm location", detail: "You configured this server or channel to require confirmation." }];
        }
        return [];
    }

    getRouteContext() {
        const match = location.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
        if (!match) return { isServer: false, isDm: false, guildId: null, channelId: null };
        return { isServer: match[1] !== "@me", isDm: match[1] === "@me", guildId: match[1], channelId: match[2] };
    }

    commaValues(value) {
        return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
    }

    idValues(value) {
        return String(value || "").split(/[\s,]+/).map(item => item.trim()).filter(item => /^\d+$/.test(item));
    }

    uniqueFindings(findings) {
        return [...new Map(findings.map(finding => [finding.code, finding])).values()];
    }

    captureFiles(fileList) {
        if (!this.settings.checkAttachments || !fileList?.length) return;
        const now = Date.now();
        for (const [key, record] of this.pendingFiles) {
            if (now - record.addedAt > 15 * 60000) this.pendingFiles.delete(key);
        }
        for (const file of [...fileList]) {
            if (!file?.name) continue;
            const key = `${file.name}:${file.size}:${file.lastModified || 0}`;
            this.pendingFiles.set(key, { file, addedAt: now, promise: this.inspectFile(file) });
        }
    }

    getRelevantFileRecords(composer, button) {
        if (!this.settings.checkAttachments || !this.pendingFiles.size) return [];
        const root = composer?.closest?.("form, [class*=channelTextArea], [role=dialog]") || button?.closest?.("form, [role=dialog]");
        const visibleAttachmentArea = root?.querySelector?.('[class*="channelAttachmentArea"], [class*="attachmentPreview"], [class*="attachedBars"], [class*="uploadModal"]');
        const uploadDialog = Boolean(button?.closest?.('[role=dialog], [class*="uploadModal"]'));
        if (!visibleAttachmentArea && !uploadDialog) return [];
        const rootText = root?.textContent || "";
        const records = [...this.pendingFiles.values()].filter(record => !rootText || rootText.includes(record.file.name));
        return records.length ? records : [...this.pendingFiles.values()];
    }

    async inspectFile(file) {
        const findings = this.inspectFileBasics(file);
        if (!this.settings.checkMetadata || typeof file.slice !== "function") return findings;
        try {
            const buffer = await file.slice(0, Math.min(file.size || 0, 2 * 1024 * 1024)).arrayBuffer();
            const sample = new TextDecoder("latin1").decode(buffer);
            if (/image\/(?:jpeg|jpg|tiff)/i.test(file.type || "") && /Exif\x00\x00|GPSLatitude|GPSLongitude|DateTimeOriginal/.test(sample)) {
                findings.push({ code: "IMAGE_METADATA", severity: "medium", title: "Image metadata detected", detail: "The image may contain EXIF, date, device, or location metadata." });
            }
            if (/pdf/i.test(file.type || "") && /\/(?:Author|Creator|Producer|CreationDate)\s*[<(]/.test(sample)) {
                findings.push({ code: "PDF_METADATA", severity: "medium", title: "PDF metadata detected", detail: "The document may contain author, software, or creation details." });
            }
            if (/docProps\/(?:core|app)\.xml/i.test(sample)) {
                findings.push({ code: "DOCUMENT_METADATA", severity: "medium", title: "Document properties detected", detail: "The document may contain author or application metadata." });
            }
        } catch (_) {
            findings.push({ code: "FILE_READ", severity: "medium", title: "Attachment could not be fully inspected", detail: "Review the file manually before sending." });
        }
        return this.uniqueFindings(findings);
    }

    inspectFileBasics(file) {
        const name = String(file?.name || "");
        const type = String(file?.type || "").toLowerCase();
        const lower = name.toLowerCase();
        const findings = [];
        const add = (code, severity, title, detail) => findings.push({ code, severity, title, detail });
        if (/\.(?:exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|apk|dmg|pkg)$/i.test(name)) add("EXECUTABLE", "high", "Executable attachment", "This file type can run code on another device.");
        if (/\.[a-z0-9]{2,6}\.(?:exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|apk)$/i.test(name)) add("DOUBLE_EXTENSION", "high", "Misleading double extension", "The filename may disguise an executable file as another type.");
        if (/\b(?:password|passwd|secret|token|private[_ -]?key|passport|license|tax|ssn)\b/i.test(name)) add("SENSITIVE_FILENAME", "high", "Sensitive-looking filename", "The filename suggests the attachment may contain private information.");
        if (/^(?:screenshot|screen shot|capture)[ _-]/i.test(name)) add("SCREENSHOT", "medium", "Screenshot attachment", "Review the full image for notifications, account details, or other private information.");

        const extension = lower.match(/\.([a-z0-9]+)$/)?.[1] || "";
        const expected = {
            jpg: ["image/jpeg"], jpeg: ["image/jpeg"], png: ["image/png"], gif: ["image/gif"], webp: ["image/webp"],
            pdf: ["application/pdf"], txt: ["text/plain"], mp3: ["audio/mpeg"], mp4: ["video/mp4"],
            zip: ["application/zip", "application/x-zip-compressed"], json: ["application/json", "text/json"]
        };
        if (type && expected[extension] && !expected[extension].includes(type)) {
            add("MIME_MISMATCH", "high", "File type does not match its extension", "The attachment's reported content type differs from its filename.");
        }
        return this.uniqueFindings(findings);
    }

    isVisible(element) {
        if (!element?.isConnected) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    checkRoute() {
        if (location.pathname === this.lastPath) return;
        this.lastPath = location.pathname;
        this.pendingFiles.clear();
        this.cancelWarning();
    }

    toast(message, type = "info") {
        try { BdApi.UI.showToast(message, { type, timeout: 4500 }); }
        catch (_) { console.log(`[${this.name}] ${message}`); }
    }
};
