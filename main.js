/*global define, brackets, $ */

// Phoenix Code Todo Extension - Milestone 3
// "Notion inside Phoenix Code": per-project + global tabs,
// "Add line to To-Do" editor context menu, click-to-jump,
// and an auto TODO/FIXME scanner with dismissal memory.

define(function (require, exports, module) {
    "use strict";

    // -------- Modules --------
    const AppInit            = brackets.getModule("utils/AppInit"),
          ExtensionUtils     = brackets.getModule("utils/ExtensionUtils"),
          PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
          ProjectManager     = brackets.getModule("project/ProjectManager"),
          EditorManager      = brackets.getModule("editor/EditorManager"),
          DocumentManager    = brackets.getModule("document/DocumentManager"),
          FileSystem         = brackets.getModule("filesystem/FileSystem"),
          CommandManager     = brackets.getModule("command/CommandManager"),
          Commands           = brackets.getModule("command/Commands"),
          Menus              = brackets.getModule("command/Menus");

    ExtensionUtils.loadStyleSheet(module, "style.css");

    // -------- Constants --------
    const GLOBAL_KEY            = "__global__";
    const PANEL_WIDTH           = 340;
    const PANEL_GAP             = 8;
    const COMPLETED_COLLAPSE_AT = 3;

    // Scanner config
    const SCAN_FILE_CAP    = 500;
    const SCAN_BYTE_CAP    = 1024 * 1024; // 1 MB per file
    const SCAN_EXT_ALLOW   = [
        "js","jsx","ts","tsx","mjs","cjs","vue","svelte",
        "py","rb","go","rs","java","kt","swift","c","cc","cpp","h","hpp",
        "cs","php","sh","bash","zsh",
        "html","htm","css","scss","sass","less",
        "md","mdx","yml","yaml","toml","json","xml",
        "lua","r","pl","dart"
    ];
    const SCAN_IGNORE_RX = /[\\\/](?:node_modules|\.git|dist|build|out|\.next|\.nuxt|target|vendor|\.cache|coverage|\.venv|venv|__pycache__)[\\\/]/i;

    const TODO_RX  = /(?:\/\/|#|\/\*|<!--)\s*(TODO|FIXME|HACK|XXX|BUG|NOTE)\b\s*[:\-]?\s*(.*?)\s*(?:\*\/|-->)?$/i;

    // -------- Storage --------
    // Shape:
    // {
    //   projects: { "<projPath>": [task,...], "__global__": [task,...] },
    //   sortBy: "dateAdded" | "alphabetical",
    //   completedExpanded: boolean,
    //   fromCodeExpanded:  boolean,
    //   activeTab: "project" | "global",
    //   codeTodosEnabled:  boolean,
    //   dismissedCodeTodos: { "<projPath>": ["<hash>", ...] }
    // }
    // Task: { id, text, done, createdAt, codeLink?: { file, line, snippet } }
    const prefs = PreferencesManager.getExtensionPrefs("todoDropdown");
    // Guard against re-define if the module is hot-reloaded in the same session.
    try { prefs.definePreference("tasksV2", "object", null); } catch (e) { /* already defined */ }
    try { prefs.definePreference("tasks",   "array",  []);   } catch (e) { /* already defined */ }

    let store = loadStore();

    function loadStore() {
        let s = prefs.get("tasksV2");
        if (!s || typeof s !== "object" || !s.projects) {
            const legacy = prefs.get("tasks") || [];
            s = { projects: {} };
            if (legacy.length) {
                s.projects[GLOBAL_KEY] = legacy.map(function (t) {
                    return {
                        id:        t.id || (Date.now() + Math.floor(Math.random() * 10000)),
                        text:      t.text || "",
                        done:      !!t.done,
                        createdAt: t.createdAt || Date.now()
                    };
                });
            }
        }
        // Forward-compat defaults
        if (typeof s.completedExpanded !== "boolean") { s.completedExpanded = false; }
        if (typeof s.fromCodeExpanded  !== "boolean") { s.fromCodeExpanded  = true;  }
        if (typeof s.sortBy            !== "string")  { s.sortBy = "dateAdded"; }
        if (typeof s.codeTodosEnabled  !== "boolean") { s.codeTodosEnabled  = true;  }
        if (typeof s.activeTab         !== "string")  { s.activeTab = "project"; }
        if (!s.projects                || typeof s.projects               !== "object") { s.projects = {}; }
        if (!s.dismissedCodeTodos      || typeof s.dismissedCodeTodos     !== "object") { s.dismissedCodeTodos = {}; }
        prefs.set("tasksV2", s);
        prefs.save();
        return s;
    }

    function saveStore() {
        prefs.set("tasksV2", store);
        prefs.save();
    }

    function projectKey() {
        try {
            const root = ProjectManager.getProjectRoot();
            return (root && root.fullPath) ? root.fullPath : null;
        } catch (e) { return null; }
    }

    function activeScopeKey() {
        if (store.activeTab === "global") { return GLOBAL_KEY; }
        return projectKey() || GLOBAL_KEY;
    }

    function tasksForScope(key) {
        if (!store.projects[key]) { store.projects[key] = []; }
        return store.projects[key];
    }

    function currentTasks() { return tasksForScope(activeScopeKey()); }

    function mutateCurrentTasks(fn) {
        const key  = activeScopeKey();
        const list = store.projects[key] || [];
        const next = fn(list);
        store.projects[key] = Array.isArray(next) ? next : list;
        saveStore();
    }

    // -------- Hash (DJB2) --------
    function hashStr(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return String(h);
    }

    // -------- Theme --------
    function detectTheme() {
        try {
            const el  = document.querySelector("#editor-holder") || document.body;
            const bg  = getComputedStyle(el).backgroundColor || "rgb(31,31,31)";
            const m   = bg.match(/\d+(\.\d+)?/g);
            if (!m) { return "dark"; }
            const r = +m[0], g = +m[1], b = +m[2];
            return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? "dark" : "light";
        } catch (e) { return "dark"; }
    }

    // -------- Path helpers --------
    function relPath(fullPath) {
        if (!fullPath) { return ""; }
        const root = projectKey();
        if (root && fullPath.indexOf(root) === 0) {
            return fullPath.substring(root.length);
        }
        // Fallback: basename
        const parts = fullPath.split(/[\\\/]/);
        return parts[parts.length - 1] || fullPath;
    }

    function baseName(fullPath) {
        if (!fullPath) { return ""; }
        const parts = fullPath.split(/[\\\/]/);
        return parts[parts.length - 1] || fullPath;
    }

    function fileExt(fullPath) {
        const dot = fullPath.lastIndexOf(".");
        if (dot === -1) { return ""; }
        return fullPath.substring(dot + 1).toLowerCase();
    }

    // -------- Open file at line --------
    function jumpTo(fullPath, line) {
        CommandManager.execute(Commands.FILE_OPEN, { fullPath: fullPath })
            .done(function () {
                const ed = EditorManager.getActiveEditor();
                if (ed) {
                    ed.setCursorPos(line, 0, true);
                    ed.focus();
                }
            });
    }

    // -------- DOM: panel --------
    const $panel = $(
        '<div id="td-dropdown" class="td-dropdown" style="display:none;">' +
            '<div class="td-header">' +
                '<div class="td-tabs">' +
                    '<button type="button" class="td-tab" data-tab="project">' +
                        '<span class="td-tab-label">This project</span>' +
                        '<span class="td-tab-count">0</span>' +
                    '</button>' +
                    '<button type="button" class="td-tab" data-tab="global">' +
                        '<span class="td-tab-label">Global</span>' +
                        '<span class="td-tab-count">0</span>' +
                    '</button>' +
                '</div>' +
                '<button type="button" class="td-menu-btn" title="More" aria-label="More actions">' +
                    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
                        '<circle cx="3"  cy="8" r="1.4" fill="currentColor"/>' +
                        '<circle cx="8"  cy="8" r="1.4" fill="currentColor"/>' +
                        '<circle cx="13" cy="8" r="1.4" fill="currentColor"/>' +
                    '</svg>' +
                '</button>' +
            '</div>' +
            '<div class="td-input-row">' +
                '<input type="text" class="td-input" placeholder="New task..." maxlength="200" />' +
                '<button type="button" class="td-add-btn" title="Add task" aria-label="Add task">' +
                    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
                        '<path d="M8 3v10 M3 8h10" stroke="currentColor" stroke-width="2" ' +
                            'stroke-linecap="round" fill="none"/>' +
                    '</svg>' +
                '</button>' +
            '</div>' +
            '<div class="td-body">' +
                '<ul class="td-list td-pending-list"></ul>' +
                '<div class="td-completed-section" style="display:none;">' +
                    '<button type="button" class="td-section-toggle td-completed-toggle">' +
                        '<svg class="td-chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
                            '<path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" ' +
                                'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
                        '</svg>' +
                        '<span class="td-section-label">Completed</span>' +
                        '<span class="td-section-count td-completed-count">0</span>' +
                    '</button>' +
                    '<ul class="td-list td-completed-list"></ul>' +
                '</div>' +
                '<div class="td-from-code-section" style="display:none;">' +
                    '<button type="button" class="td-section-toggle td-from-code-toggle">' +
                        '<svg class="td-chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
                            '<path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" ' +
                                'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
                        '</svg>' +
                        '<span class="td-section-label">From code</span>' +
                        '<span class="td-section-count td-from-code-count">0</span>' +
                        '<span class="td-from-code-status"></span>' +
                    '</button>' +
                    '<ul class="td-list td-from-code-list"></ul>' +
                '</div>' +
                '<div class="td-empty">' +
                    '<svg viewBox="0 0 64 64" width="44" height="44" aria-hidden="true">' +
                        '<circle cx="32" cy="32" r="26" stroke="currentColor" ' +
                            'stroke-width="2" fill="none" opacity="0.25"/>' +
                        '<path d="M22 32 L29 39 L42 25" stroke="currentColor" ' +
                            'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" ' +
                            'fill="none" opacity="0.55"/>' +
                    '</svg>' +
                    '<div class="td-empty-title">Nothing to do here.</div>' +
                    '<div class="td-empty-sub">Add your first task above.</div>' +
                '</div>' +
            '</div>' +
            // Overflow menu (⋯)
            '<div class="td-menu" style="display:none;">' +
                '<button type="button" class="td-menu-item" data-action="clear-completed">' +
                    'Clear completed' +
                '</button>' +
                '<div class="td-menu-divider"></div>' +
                '<button type="button" class="td-menu-item" data-action="toggle-code-scan">' +
                    '<span class="td-menu-check">✓</span>' +
                    '<span>Scan code for TODOs</span>' +
                '</button>' +
                '<button type="button" class="td-menu-item" data-action="rescan">' +
                    '<span class="td-menu-check"></span>' +
                    '<span>Re-scan now</span>' +
                '</button>' +
                '<div class="td-menu-divider"></div>' +
                '<div class="td-menu-section-label">Sort by</div>' +
                '<button type="button" class="td-menu-item" data-action="sort-dateAdded">' +
                    '<span class="td-menu-check">✓</span><span>Date added</span>' +
                '</button>' +
                '<button type="button" class="td-menu-item" data-action="sort-alphabetical">' +
                    '<span class="td-menu-check">✓</span><span>Alphabetical</span>' +
                '</button>' +
            '</div>' +
        '</div>'
    ).appendTo("body");

    const $input          = $panel.find(".td-input");
    const $addBtn         = $panel.find(".td-add-btn");
    const $menuBtn        = $panel.find(".td-menu-btn");
    const $menu           = $panel.find(".td-menu");
    const $tabs           = $panel.find(".td-tabs");
    const $tabProject     = $panel.find('.td-tab[data-tab="project"]');
    const $tabGlobal      = $panel.find('.td-tab[data-tab="global"]');
    const $pendingList    = $panel.find(".td-pending-list");
    const $completedList  = $panel.find(".td-completed-list");
    const $completedSec   = $panel.find(".td-completed-section");
    const $completedLbl   = $panel.find(".td-completed-count");
    const $completedTog   = $panel.find(".td-completed-toggle");
    const $fromCodeSec    = $panel.find(".td-from-code-section");
    const $fromCodeList   = $panel.find(".td-from-code-list");
    const $fromCodeCount  = $panel.find(".td-from-code-count");
    const $fromCodeTog    = $panel.find(".td-from-code-toggle");
    const $fromCodeStatus = $panel.find(".td-from-code-status");
    const $empty          = $panel.find(".td-empty");

    // -------- Task SVG icons (built once) --------
    const CHECKBOX_SVG =
        '<span class="td-checkbox" role="checkbox" tabindex="-1">' +
            '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
                '<path d="M3 8.5 L7 12 L13 4" stroke="currentColor" stroke-width="2.2" ' +
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
            '</svg>' +
        '</span>';

    const TRASH_SVG =
        '<button type="button" class="td-delete" title="Delete task" aria-label="Delete task">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" ' +
                'fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M3 6h18"/>' +
                '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
                '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
                '<line x1="10" y1="11" x2="10" y2="17"/>' +
                '<line x1="14" y1="11" x2="14" y2="17"/>' +
            '</svg>' +
        '</button>';

    const LINK_ICON_SVG =
        '<svg class="td-link-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" ' +
            'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M6.5 9.5 L9.5 6.5"/>' +
            '<path d="M7 4 L9 2 a2.8 2.8 0 1 1 4 4 L11 8"/>' +
            '<path d="M9 12 L7 14 a2.8 2.8 0 1 1 -4 -4 L5 8"/>' +
        '</svg>';

    // -------- Code scanner --------
    // Cache per-project so we don't re-scan every panel open.
    // Keyed by projectKey(). Cleared on project change.
    const scanCache = Object.create(null); // { [projectKey]: { items: [...], at: ts } }
    let scanInFlight = null;

    function isScannable(fullPath) {
        if (SCAN_IGNORE_RX.test(fullPath)) { return false; }
        const ext = fileExt(fullPath);
        return SCAN_EXT_ALLOW.indexOf(ext) !== -1;
    }

    function readFileText(file) {
        return new Promise(function (resolve) {
            file.read({}, function (err, contents) {
                if (err) { resolve(null); return; }
                resolve(contents);
            });
        });
    }

    function statSize(file) {
        return new Promise(function (resolve) {
            file.stat(function (err, stat) {
                if (err) { resolve(0); return; }
                resolve(stat.size || 0);
            });
        });
    }

    function extractTodos(filePath, contents) {
        if (!contents) { return []; }
        const lines = contents.split(/\r?\n/);
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (!ln || ln.length > 400) { continue; }
            const m = ln.match(TODO_RX);
            if (!m) { continue; }
            const type = m[1].toUpperCase();
            const text = (m[2] || "").trim();
            if (!text) { continue; }
            out.push({
                file: filePath,
                line: i,                // 0-based for setCursorPos
                type: type,
                text: text,
                hash: hashStr(filePath + ":" + (i) + ":" + type + ":" + text)
            });
        }
        return out;
    }

    function listProjectFiles() {
        return new Promise(function (resolve) {
            try {
                ProjectManager.getAllFiles(function (f) {
                    return isScannable(f.fullPath);
                }).done(function (files) {
                    resolve(files || []);
                }).fail(function () { resolve([]); });
            } catch (e) { resolve([]); }
        });
    }

    async function scanProjectForTodos() {
        const pk = projectKey();
        if (!pk) { return []; }
        if (scanInFlight) { return scanInFlight; }

        $fromCodeStatus.text("scanning...");
        scanInFlight = (async function () {
            const files = await listProjectFiles();
            const capped = files.slice(0, SCAN_FILE_CAP);
            const all = [];

            // Sequential to keep memory low; small projects finish in ms.
            for (let i = 0; i < capped.length; i++) {
                const f = capped[i];
                try {
                    const size = await statSize(f);
                    if (size > SCAN_BYTE_CAP) { continue; }
                    const text = await readFileText(f);
                    if (!text) { continue; }
                    const found = extractTodos(f.fullPath, text);
                    for (let j = 0; j < found.length; j++) { all.push(found[j]); }
                } catch (e) { /* skip file */ }
            }

            scanCache[pk] = { items: all, at: Date.now() };
            return all;
        })();

        try {
            const result = await scanInFlight;
            return result;
        } finally {
            scanInFlight = null;
            $fromCodeStatus.text("");
        }
    }

    function dismissedSetForProject() {
        const pk = projectKey();
        if (!pk) { return new Set(); }
        const arr = store.dismissedCodeTodos[pk] || [];
        return new Set(arr);
    }

    function setDismissedForProject(set) {
        const pk = projectKey();
        if (!pk) { return; }
        store.dismissedCodeTodos[pk] = Array.from(set);
        saveStore();
    }

    function visibleCodeTodos() {
        const pk = projectKey();
        if (!pk) { return []; }
        const cached = scanCache[pk];
        if (!cached) { return []; }
        const dismissed = dismissedSetForProject();
        return cached.items.filter(function (t) { return !dismissed.has(t.hash); });
    }

    // -------- Render --------
    function sortTasks(arr) {
        const copy = arr.slice();
        if (store.sortBy === "alphabetical") {
            copy.sort(function (a, b) {
                return (a.text || "").localeCompare(b.text || "", undefined, { sensitivity: "base" });
            });
        } else {
            copy.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        }
        return copy;
    }

    function buildCodeLinkChip(file, line, label) {
        const $a = $(
            '<a class="td-code-link" href="#" tabindex="-1" title="Jump to ' +
                file + ':' + (line + 1) + '">' +
                LINK_ICON_SVG +
                '<span class="td-code-link-text"></span>' +
            '</a>'
        );
        $a.attr("data-file", file);
        $a.attr("data-line", String(line));
        $a.find(".td-code-link-text").text(label || (baseName(file) + ":" + (line + 1)));
        return $a;
    }

    function buildTaskLi(task) {
        const $li = $(
            '<li class="td-item' + (task.done ? " td-done" : "") + '" ' +
                'data-id="' + task.id + '" tabindex="0">' +
                CHECKBOX_SVG +
                '<div class="td-task-content">' +
                    '<span class="td-text"></span>' +
                '</div>' +
                TRASH_SVG +
            '</li>'
        );
        $li.find(".td-text").text(task.text);
        if (task.codeLink && task.codeLink.file) {
            const label = baseName(task.codeLink.file) + ":" + ((task.codeLink.line || 0) + 1);
            $li.find(".td-task-content").append(buildCodeLinkChip(
                task.codeLink.file, task.codeLink.line, label
            ));
        }
        return $li;
    }

    function buildFromCodeLi(item) {
        const $li = $(
            '<li class="td-item td-from-code-item" ' +
                'data-hash="' + item.hash + '" tabindex="0">' +
                CHECKBOX_SVG +
                '<div class="td-task-content">' +
                    '<span class="td-text"></span>' +
                    '<a class="td-code-link" href="#" tabindex="-1">' +
                        '<span class="td-tag"></span>' +
                        '<span class="td-code-link-text"></span>' +
                    '</a>' +
                '</div>' +
            '</li>'
        );
        $li.find(".td-text").text(item.text);
        const $chip = $li.find(".td-code-link");
        $chip.attr("data-file", item.file);
        $chip.attr("data-line", String(item.line));
        $chip.attr("title", "Jump to " + item.file + ":" + (item.line + 1));
        $chip.find(".td-tag")
            .text(item.type)
            .addClass("td-tag-" + item.type.toLowerCase());
        $chip.find(".td-code-link-text").text(baseName(item.file) + ":" + (item.line + 1));
        return $li;
    }

    function renderTabs() {
        const projTasks = projectKey() ? tasksForScope(projectKey()) : [];
        const globTasks = tasksForScope(GLOBAL_KEY);

        const projPending = projTasks.filter(function (t) { return !t.done; }).length;
        const globPending = globTasks.filter(function (t) { return !t.done; }).length;

        $tabProject.find(".td-tab-count").text(projPending);
        $tabGlobal.find(".td-tab-count").text(globPending);

        // Project tab disabled when no project open
        const hasProject = !!projectKey();
        $tabProject.attr("disabled", hasProject ? null : "disabled");
        $tabProject.toggleClass("td-tab-disabled", !hasProject);

        // Force active tab to a valid choice
        if (store.activeTab === "project" && !hasProject) {
            store.activeTab = "global";
            saveStore();
        }

        $tabProject.toggleClass("td-tab-active", store.activeTab === "project");
        $tabGlobal.toggleClass("td-tab-active", store.activeTab === "global");
    }

    function renderList(opts) {
        renderTabs();

        const list      = currentTasks();
        const sorted    = sortTasks(list);
        const pending   = sorted.filter(function (t) { return !t.done; });
        const completed = sorted.filter(function (t) { return  t.done; });

        $pendingList.empty();
        $completedList.empty();

        pending.forEach(function (t) { $pendingList.append(buildTaskLi(t)); });
        completed.forEach(function (t) { $completedList.append(buildTaskLi(t)); });

        if (completed.length) {
            $completedSec.show();
            $completedLbl.text(completed.length);
            if (opts && opts.autoCollapse && completed.length > COMPLETED_COLLAPSE_AT) {
                store.completedExpanded = false;
            }
            $completedSec.toggleClass("td-collapsed", !store.completedExpanded);
        } else {
            $completedSec.hide();
        }

        renderFromCode();

        // Empty state: only when there's truly nothing visible in this tab.
        const fromCodeVisible = $fromCodeSec.is(":visible") && visibleCodeTodos().length > 0;
        const isEmpty = !list.length && !(store.activeTab === "project" && fromCodeVisible);
        $empty.toggle(isEmpty);

        // Reflect menu state
        $panel.find('[data-action="sort-dateAdded"]')
            .toggleClass("td-menu-selected", store.sortBy === "dateAdded");
        $panel.find('[data-action="sort-alphabetical"]')
            .toggleClass("td-menu-selected", store.sortBy === "alphabetical");
        $panel.find('[data-action="toggle-code-scan"]')
            .toggleClass("td-menu-selected", !!store.codeTodosEnabled);

        updateBadge();
    }

    function renderFromCode() {
        // Only on the Project tab + only if scanning is enabled + only if a project is open
        const showSection = store.activeTab === "project" && store.codeTodosEnabled && !!projectKey();
        if (!showSection) { $fromCodeSec.hide(); return; }

        const items = visibleCodeTodos();
        $fromCodeList.empty();
        items.forEach(function (item) { $fromCodeList.append(buildFromCodeLi(item)); });
        $fromCodeCount.text(items.length);
        $fromCodeSec.toggle(items.length > 0);
        $fromCodeSec.toggleClass("td-collapsed", !store.fromCodeExpanded);
    }

    // -------- Mutations --------
    function addTask(text, opts) {
        text = (text || "").trim();
        if (!text) { return; }
        const newTask = {
            id: Date.now() + Math.floor(Math.random() * 10000),
            text: text,
            done: false,
            createdAt: Date.now()
        };
        if (opts && opts.codeLink) { newTask.codeLink = opts.codeLink; }
        mutateCurrentTasks(function (list) { list.push(newTask); return list; });
        renderList();
    }

    function toggleDone(id) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) { if (t.id === id) { t.done = !t.done; } });
            return list;
        });
        renderList();
    }

    function deleteTask(id) {
        mutateCurrentTasks(function (list) {
            return list.filter(function (t) { return t.id !== id; });
        });
        renderList();
    }

    function clearCompleted() {
        mutateCurrentTasks(function (list) {
            return list.filter(function (t) { return !t.done; });
        });
        renderList();
    }

    function setSortBy(mode) {
        store.sortBy = mode;
        saveStore();
        renderList();
    }

    function setActiveTab(tab) {
        if (tab !== "project" && tab !== "global") { return; }
        if (tab === "project" && !projectKey()) { return; } // no project open
        store.activeTab = tab;
        saveStore();
        renderList();
    }

    function toggleCodeScanning() {
        store.codeTodosEnabled = !store.codeTodosEnabled;
        saveStore();
        if (store.codeTodosEnabled) {
            ensureScan(true);
        }
        renderList();
    }

    function dismissCodeTodo(hash) {
        const set = dismissedSetForProject();
        set.add(hash);
        setDismissedForProject(set);
        renderList();
    }

    // -------- Scan triggering --------
    async function ensureScan(force) {
        const pk = projectKey();
        if (!pk) { return; }
        if (!store.codeTodosEnabled) { return; }
        if (!force && scanCache[pk]) { renderList(); return; }
        await scanProjectForTodos();
        renderList();
    }

    // Re-scan when files change in the project (DocumentManager fires save events).
    DocumentManager.on("documentSaved.tdScanner", function (evt, doc) {
        if (!store.codeTodosEnabled) { return; }
        const pk = projectKey();
        if (!pk) { return; }
        if (doc && doc.file && doc.file.fullPath && doc.file.fullPath.indexOf(pk) === 0) {
            // Invalidate this project's cache; will re-scan on next panel open
            delete scanCache[pk];
            if ($panel.is(":visible")) { ensureScan(true); }
        }
    });

    // -------- Event wiring --------
    $addBtn.on("click", function () { addTask($input.val()); $input.val(""); });
    $input.on("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            addTask($input.val()); $input.val("");
        }
    });

    // Tabs
    $tabs.on("click", ".td-tab", function () {
        const tab = $(this).attr("data-tab");
        setActiveTab(tab);
    });

    // Pending + completed list interactions
    $panel.find(".td-pending-list, .td-completed-list").on("click", ".td-item", function (e) {
        const $li = $(e.target).closest(".td-item");
        const id  = Number($li.attr("data-id"));

        if ($(e.target).closest(".td-code-link").length) {
            e.preventDefault();
            const $chip = $(e.target).closest(".td-code-link");
            const file  = $chip.attr("data-file");
            const line  = Number($chip.attr("data-line"));
            if (file) { jumpTo(file, line); closePanel(); }
            return;
        }
        if ($(e.target).closest(".td-delete").length) { deleteTask(id); return; }
        toggleDone(id);
    });

    // From-code list interactions
    $fromCodeList.on("click", ".td-from-code-item", function (e) {
        const $li  = $(e.target).closest(".td-from-code-item");
        const hash = $li.attr("data-hash");

        if ($(e.target).closest(".td-code-link").length) {
            e.preventDefault();
            const $chip = $(e.target).closest(".td-code-link");
            const file  = $chip.attr("data-file");
            const line  = Number($chip.attr("data-line"));
            if (file) { jumpTo(file, line); closePanel(); }
            return;
        }
        // Checkbox or row click → dismiss
        if ($(e.target).closest(".td-checkbox").length || $(e.target).is($li)) {
            dismissCodeTodo(hash);
        } else {
            dismissCodeTodo(hash);
        }
    });

    // Keyboard on tasks
    $panel.find(".td-pending-list, .td-completed-list").on("keydown", ".td-item", function (e) {
        const id = Number($(this).attr("data-id"));
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleDone(id); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteTask(id); }
    });

    // Section toggles
    $completedTog.on("click", function () {
        store.completedExpanded = !store.completedExpanded;
        saveStore();
        $completedSec.toggleClass("td-collapsed", !store.completedExpanded);
    });
    $fromCodeTog.on("click", function () {
        store.fromCodeExpanded = !store.fromCodeExpanded;
        saveStore();
        $fromCodeSec.toggleClass("td-collapsed", !store.fromCodeExpanded);
    });

    // Overflow menu
    $menuBtn.on("click", function (e) {
        e.stopPropagation();
        $menu.toggle();
    });
    $menu.on("click", ".td-menu-item", function () {
        const action = $(this).attr("data-action");
        $menu.hide();
        if (action === "clear-completed")       { clearCompleted(); }
        else if (action === "sort-dateAdded")   { setSortBy("dateAdded"); }
        else if (action === "sort-alphabetical"){ setSortBy("alphabetical"); }
        else if (action === "toggle-code-scan") { toggleCodeScanning(); }
        else if (action === "rescan")           {
            const pk = projectKey();
            if (pk) { delete scanCache[pk]; }
            ensureScan(true);
        }
    });
    $panel.on("mousedown", function (e) {
        if (!$menu.is(":visible")) { return; }
        if (!$(e.target).closest(".td-menu, .td-menu-btn").length) { $menu.hide(); }
    });

    // -------- Toolbar button --------
    const $toolbarBtn = $(
        '<a href="#" id="td-toolbar-btn" title="To-Do list" aria-label="To-Do list">' +
            '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" ' +
                'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
                '<path d="M5 8 L10 13 L15 8" stroke="currentColor" stroke-width="2" ' +
                    'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
            '</svg>' +
            '<span class="td-toolbar-badge" style="display:none;">0</span>' +
        '</a>'
    );

    function updateBadge() {
        const $badge = $toolbarBtn.find(".td-toolbar-badge");
        const overdue = 0; // M4 will populate
        if (overdue > 0) { $badge.text(overdue).show(); } else { $badge.hide(); }
    }

    function positionPanel() {
        const btn = $toolbarBtn.get(0);
        if (!btn) { return; }
        const rect = btn.getBoundingClientRect();
        const pw = PANEL_WIDTH;
        let left = rect.left - pw - PANEL_GAP;
        let top  = rect.top;
        if (left < 8) {
            left = Math.max(8, rect.left);
            top  = rect.bottom + PANEL_GAP;
        }
        const vh = window.innerHeight;
        const ph = $panel.outerHeight() || 360;
        if (top + ph > vh - 8) { top = Math.max(8, vh - ph - 8); }
        $panel.css({ left: left + "px", top: top + "px" });
    }

    function applyTheme() {
        const theme = detectTheme();
        $panel.attr("data-td-theme", theme);
        $toolbarBtn.attr("data-td-theme", theme);
    }

    function openPanel() {
        applyTheme();

        // Default to project tab if a project is open and we haven't chosen yet
        if (store.activeTab === "project" && !projectKey()) {
            store.activeTab = "global";
        }

        $panel.removeClass("td-closing").addClass("td-opening");
        $panel.show();
        positionPanel();
        renderList({ autoCollapse: true });
        setTimeout(function () { $input.trigger("focus"); }, 0);
        setTimeout(function () { $panel.removeClass("td-opening"); }, 200);

        // Kick off a scan if needed
        ensureScan(false);
    }

    function closePanel() {
        $menu.hide();
        $panel.hide();
    }

    function togglePanel() {
        if ($panel.is(":visible")) { closePanel(); } else { openPanel(); }
    }

    $toolbarBtn.on("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
    });

    $(document).off("mousedown.tdroot keydown.tdroot");
    $(document).on("mousedown.tdroot", function (e) {
        if (!$panel.is(":visible")) { return; }
        if ($(e.target).closest("#td-dropdown, #td-toolbar-btn").length) { return; }
        closePanel();
    });
    $(document).on("keydown.tdroot", function (e) {
        if (e.key === "Escape" && $panel.is(":visible")) { closePanel(); }
    });
    $(window).on("resize", function () {
        if ($panel.is(":visible")) { positionPanel(); }
    });

    // -------- "Add line to To-Do" editor context menu --------
    const ADD_LINE_CMD_ID = "todoDropdown.addLine";

    function addLineToTodo() {
        const ed = EditorManager.getActiveEditor();
        if (!ed || !ed.document || !ed.document.file) { return; }
        const pos = ed.getCursorPos();
        const lineText = (ed.document.getLine(pos.line) || "").trim();
        if (!lineText) { return; }
        const filePath = ed.document.file.fullPath;

        // Tasks created from code always go into the PROJECT scope, and we
        // also switch the user to the Project tab so they see what was added.
        store.activeTab = "project";
        saveStore();
        addTask(lineText, {
            codeLink: { file: filePath, line: pos.line, snippet: lineText }
        });

        // Flash the panel open to confirm
        openPanel();
    }

    CommandManager.register("Add line to To-Do", ADD_LINE_CMD_ID, addLineToTodo);

    // -------- Project change handling --------
    try {
        const evt = ProjectManager.EVENT_PROJECT_OPEN || "projectOpen";
        ProjectManager.on(evt, function () {
            // New project: clear stale scan cache; re-render
            // (We don't blow away other projects' scan cache.)
            if ($panel.is(":visible")) {
                renderList();
                ensureScan(false);
            } else {
                renderList(); // updates badge/tabs for next open
            }
        });
    } catch (e) { /* non-fatal */ }

    // -------- Mount --------
    AppInit.appReady(function () {
        const $mainToolbar = $("#main-toolbar");
        if ($mainToolbar.length) {
            const $iconGroup = $mainToolbar.find(".buttons").first();
            if ($iconGroup.length) { $iconGroup.append($toolbarBtn); }
            else { $mainToolbar.append($toolbarBtn); }
        }

        // View menu entry
        const TOGGLE_CMD_ID = "todoDropdown.toggle";
        CommandManager.register("Toggle To-Do List", TOGGLE_CMD_ID, togglePanel);
        const viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        if (viewMenu) { viewMenu.addMenuItem(TOGGLE_CMD_ID); }

        // Editor context menu entry
        try {
            const editorMenu = Menus.getContextMenu(Menus.ContextMenuIds.EDITOR_MENU);
            if (editorMenu) { editorMenu.addMenuItem(ADD_LINE_CMD_ID); }
        } catch (e) { /* non-fatal */ }

        applyTheme();
        renderList();
        console.log("Todo dropdown (M3) ready.");
    });
});
