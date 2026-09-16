/*global define, brackets, $ */

// Phoenix Code Todo Extension - Final
// M1 + M3 + M4a + Priority + Tags + Subtasks

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

    // Optional: older Phoenix/Brackets builds may not ship NotificationUI. Reminders degrade to a
    // console line + the toolbar badge rather than breaking the whole extension on load.
    let NotificationUI = null;
    try { NotificationUI = brackets.getModule("widgets/NotificationUI"); } catch (e) { NotificationUI = null; }

    ExtensionUtils.loadStyleSheet(module, "style.css");

    // -------- Constants --------
    const GLOBAL_KEY            = "__global__";
    const PANEL_WIDTH           = 360;
    const PANEL_GAP             = 8;
    const COMPLETED_COLLAPSE_AT = 3;

    const SCAN_FILE_CAP = 500;
    const SCAN_BYTE_CAP = 1024 * 1024;
    const SCAN_EXT_ALLOW = [
        "js","jsx","ts","tsx","mjs","cjs","vue","svelte",
        "py","rb","go","rs","java","kt","swift","c","cc","cpp","h","hpp",
        "cs","php","sh","bash","zsh",
        "html","htm","css","scss","sass","less",
        "md","mdx","yml","yaml","toml","json","xml",
        "lua","r","pl","dart"
    ];
    const SCAN_IGNORE_RX = /[\\\/](?:node_modules|\.git|dist|build|out|\.next|\.nuxt|target|vendor|\.cache|coverage|\.venv|venv|__pycache__)[\\\/]/i;
    const TODO_RX = /(?:\/\/|#|\/\*|<!--)\s*(TODO|FIXME|HACK|XXX|BUG|NOTE)\b\s*[:\-]?\s*(.*?)\s*(?:\*\/|-->)?$/i;
    const TAG_RX  = /#([a-zA-Z][a-zA-Z0-9_-]{0,30})/g;

    const PRIORITY_ORDER = [null, "high", "medium", "low"];

    // Reminder presets. A reminder is an absolute timestamp; these just pick the time-of-day that
    // gets stamped onto the task's due date.
    const REMIND_TIMES = [
        { id: "morning",   label: "9:00 AM",  hour: 9,  minute: 0 },
        { id: "noon",      label: "12:00 PM", hour: 12, minute: 0 },
        { id: "evening",   label: "6:00 PM",  hour: 18, minute: 0 }
    ];
    const REPEAT_OPTIONS = [
        { id: "daily",    label: "Daily"    },
        { id: "weekdays", label: "Weekdays" },
        { id: "weekly",   label: "Weekly"   },
        { id: "monthly",  label: "Monthly"  }
    ];
    const REPEAT_IDS = REPEAT_OPTIONS.map(function (o) { return o.id; });

    const REMINDER_TICK_MS = 30 * 1000;
    const SNOOZE_MS        = 10 * 60 * 1000;
    // A task left repeating + untouched for years shouldn't spin the roll-forward loop forever.
    const MAX_ROLL_STEPS   = 2000;
    // How many task titles a digest toast names before it says "+N more".
    const DIGEST_LIST_CAP  = 3;
    // Curated tag hues distributed around the wheel so adjacent tags don't collide.
    const TAG_HUES = [355, 25, 45, 130, 175, 210, 260, 305];

    // -------- Storage --------
    const prefs = PreferencesManager.getExtensionPrefs("todoDropdown");
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
                    return normalizeTask({
                        id:        t.id,
                        text:      t.text || "",
                        done:      !!t.done,
                        createdAt: t.createdAt || Date.now()
                    });
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
        if (!s.expandedSubtasks        || typeof s.expandedSubtasks       !== "object") { s.expandedSubtasks = {}; }
        // Normalize every existing task so new fields are present
        Object.keys(s.projects).forEach(function (k) {
            s.projects[k] = (s.projects[k] || []).map(normalizeTask);
        });
        prefs.set("tasksV2", s);
        prefs.save();
        return s;
    }

    function normalizeTask(t) {
        return {
            id:        t.id || (Date.now() + Math.floor(Math.random() * 10000)),
            text:      t.text || "",
            done:      !!t.done,
            createdAt: t.createdAt || Date.now(),
            codeLink:  t.codeLink || null,
            dueAt:     (typeof t.dueAt === "number") ? t.dueAt : null,
            // Absolute timestamp for the reminder, and the time it actually fired. remindedAt is
            // what stops a reminder re-firing every tick — and leaving it null is exactly what lets
            // a reminder that came due while Phoenix was shut fire on the next launch.
            remindAt:   (typeof t.remindAt   === "number") ? t.remindAt   : null,
            remindedAt: (typeof t.remindedAt === "number") ? t.remindedAt : null,
            repeat:     (REPEAT_IDS.indexOf(t.repeat) !== -1) ? t.repeat : null,
            timesCompleted: (typeof t.timesCompleted === "number") ? t.timesCompleted : 0,
            priority:  t.priority || null,
            tags:      Array.isArray(t.tags) ? t.tags : extractTags(t.text || ""),
            subtasks:  Array.isArray(t.subtasks) ? t.subtasks.map(function (s) {
                return {
                    id: s.id || (Date.now() + Math.floor(Math.random() * 10000)),
                    text: s.text || "",
                    done: !!s.done
                };
            }) : []
        };
    }

    function saveStore() { prefs.set("tasksV2", store); prefs.save(); }

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
    function mutateScope(key, fn) {
        const list = store.projects[key] || [];
        const next = fn(list);
        store.projects[key] = Array.isArray(next) ? next : list;
        saveStore();
    }
    function mutateCurrentTasks(fn) { mutateScope(activeScopeKey(), fn); }
    // Reminders fire for every scope, not just the visible tab, so toast actions need to edit a
    // task in whichever project owns it.
    function mutateTaskInScope(scopeKey, taskId, fn) {
        mutateScope(scopeKey, function (list) {
            list.forEach(function (t) { if (t.id === taskId) { fn(t); } });
            return list;
        });
    }

    // -------- Helpers --------
    function hashStr(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
        return String(h);
    }
    function extractTags(text) {
        const set = new Set();
        let m;
        const re = new RegExp(TAG_RX.source, "g");
        while ((m = re.exec(text || "")) !== null) { set.add(m[1]); }
        return Array.from(set);
    }
    function tagHue(name) {
        const h = parseInt(hashStr(name), 10);
        return TAG_HUES[Math.abs(h) % TAG_HUES.length];
    }
    function nextPriority(p) {
        const i = PRIORITY_ORDER.indexOf(p);
        return PRIORITY_ORDER[(i + 1) % PRIORITY_ORDER.length];
    }
    function startOfToday() {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    function presetToTs(presetId) {
        const now = new Date();
        const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (presetId === "clear")    { return null; }
        if (presetId === "today")    { return t.getTime(); }
        if (presetId === "tomorrow") { t.setDate(t.getDate() + 1); return t.getTime(); }
        if (presetId === "weekend")  {
            const dow = t.getDay();
            const delta = (6 - dow + 7) % 7 || 7;
            t.setDate(t.getDate() + delta);
            return t.getTime();
        }
        if (presetId === "nextweek") {
            const dow = t.getDay();
            const delta = ((1 - dow + 7) % 7) || 7;
            t.setDate(t.getDate() + delta);
            return t.getTime();
        }
        return null;
    }
    function formatDueDate(ts) {
        if (!ts) { return null; }
        const today = startOfToday();
        const due = new Date(ts);
        if (ts < today) {
            return {
                label: due.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
                tone:  "overdue"
            };
        }
        if (ts === today) { return { label: "Today",    tone: "today" }; }
        if (ts === today + 86400000) { return { label: "Tomorrow", tone: "soon"  }; }
        const diffDays = Math.round((ts - today) / 86400000);
        if (diffDays < 7) {
            return { label: due.toLocaleDateString(undefined, { weekday: "short" }), tone: "soon" };
        }
        return {
            label: due.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
            tone:  "future"
        };
    }

    // -------- Reminders & recurrence --------
    function startOfDay(ts) {
        const d = new Date(ts);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    // Build "this date, at this time". Going through Date (rather than adding hour*3600000 to a
    // midnight stamp) keeps the wall-clock time correct across DST boundaries.
    function atTimeOnDate(dateTs, hour, minute) {
        const d = new Date(dateTs);
        d.setHours(hour, minute, 0, 0);
        return d.getTime();
    }
    function formatTime(ts) {
        return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    // Which preset (if any) a reminder's time-of-day corresponds to — so the popover can tick it.
    // A snoozed reminder lands on an arbitrary minute and simply matches nothing.
    function remindIdFor(ts) {
        if (!ts) { return "clear"; }
        const d = new Date(ts);
        const match = REMIND_TIMES.filter(function (r) {
            return r.hour === d.getHours() && r.minute === d.getMinutes();
        })[0];
        return match ? match.id : null;
    }
    function repeatLabel(id) {
        const match = REPEAT_OPTIONS.filter(function (o) { return o.id === id; })[0];
        return match ? match.label : null;
    }
    function advanceOnce(ts, freq) {
        const d = new Date(ts);
        if (freq === "weekly") {
            d.setDate(d.getDate() + 7);
        } else if (freq === "monthly") {
            // Clamp to the target month's length so Jan 31 + 1 month is Feb 28, not Mar 3.
            const dayOfMonth = d.getDate();
            d.setDate(1);
            d.setMonth(d.getMonth() + 1);
            const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
            d.setDate(Math.min(dayOfMonth, daysInMonth));
        } else if (freq === "weekdays") {
            d.setDate(d.getDate() + 1);
            while (d.getDay() === 0 || d.getDay() === 6) { d.setDate(d.getDate() + 1); }
        } else {
            d.setDate(d.getDate() + 1);
        }
        return d.getTime();
    }
    // Next occurrence strictly at or after notBefore. Skipping past missed occurrences is what
    // stops a daily task you ignored for a week from rolling forward to last Tuesday.
    function nextOccurrence(ts, freq, notBefore) {
        let next = advanceOnce(ts, freq);
        let steps = 0;
        while (next < notBefore && steps < MAX_ROLL_STEPS) {
            next = advanceOnce(next, freq);
            steps++;
        }
        return next;
    }

    // -------- Theme --------
    function detectTheme() {
        try {
            const el = document.querySelector("#editor-holder") || document.body;
            const bg = getComputedStyle(el).backgroundColor || "rgb(31,31,31)";
            const m = bg.match(/\d+(\.\d+)?/g);
            if (!m) { return "dark"; }
            const r = +m[0], g = +m[1], b = +m[2];
            return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? "dark" : "light";
        } catch (e) { return "dark"; }
    }

    // -------- Paths / nav --------
    function baseName(p) {
        if (!p) { return ""; }
        const parts = p.split(/[\\\/]/);
        return parts[parts.length - 1] || p;
    }
    function fileExt(p) {
        const i = p.lastIndexOf(".");
        return i < 0 ? "" : p.substring(i + 1).toLowerCase();
    }
    function jumpTo(fullPath, line) {
        CommandManager.execute(Commands.FILE_OPEN, { fullPath: fullPath })
            .done(function () {
                const ed = EditorManager.getActiveEditor();
                if (ed) { ed.setCursorPos(line, 0, true); ed.focus(); }
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
                '<input type="text" class="td-input" placeholder="New task... (try #tag)" maxlength="200" />' +
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
                    '<span class="td-menu-check">✓</span><span>Scan code for TODOs</span>' +
                '</button>' +
                '<button type="button" class="td-menu-item" data-action="rescan">' +
                    '<span class="td-menu-check"></span><span>Re-scan now</span>' +
                '</button>' +
                '<div class="td-menu-divider"></div>' +
                '<div class="td-menu-section-label">Sort by</div>' +
                '<button type="button" class="td-menu-item" data-action="sort-dateAdded">' +
                    '<span class="td-menu-check">✓</span><span>Date added</span>' +
                '</button>' +
                '<button type="button" class="td-menu-item" data-action="sort-alphabetical">' +
                    '<span class="td-menu-check">✓</span><span>Alphabetical</span>' +
                '</button>' +
                '<button type="button" class="td-menu-item" data-action="sort-due">' +
                    '<span class="td-menu-check">✓</span><span>Due date</span>' +
                '</button>' +
                '<button type="button" class="td-menu-item" data-action="sort-priority">' +
                    '<span class="td-menu-check">✓</span><span>Priority</span>' +
                '</button>' +
            '</div>' +
        '</div>'
    ).appendTo("body");

    // Date preset popover (separate floating element, also under body)
    const $datePopover = $(
        '<div class="td-date-popover" style="display:none;">' +
            '<button type="button" class="td-date-option" data-preset="today">' +
                '<span class="td-date-icon">●</span><span>Today</span>' +
                '<span class="td-date-hint td-date-hint-today"></span>' +
            '</button>' +
            '<button type="button" class="td-date-option" data-preset="tomorrow">' +
                '<span class="td-date-icon">●</span><span>Tomorrow</span>' +
                '<span class="td-date-hint td-date-hint-tomorrow"></span>' +
            '</button>' +
            '<button type="button" class="td-date-option" data-preset="weekend">' +
                '<span class="td-date-icon">●</span><span>This weekend</span>' +
                '<span class="td-date-hint td-date-hint-weekend"></span>' +
            '</button>' +
            '<button type="button" class="td-date-option" data-preset="nextweek">' +
                '<span class="td-date-icon">●</span><span>Next week</span>' +
                '<span class="td-date-hint td-date-hint-nextweek"></span>' +
            '</button>' +
            '<div class="td-date-divider"></div>' +
            '<button type="button" class="td-date-option td-date-clear" data-preset="clear">' +
                '<span class="td-date-icon">×</span><span>No date</span>' +
            '</button>' +
            '<div class="td-date-divider"></div>' +
            '<div class="td-date-section-label">Remind me</div>' +
            REMIND_TIMES.map(function (r) {
                return '<button type="button" class="td-date-option" data-remind="' + r.id + '">' +
                    '<span class="td-date-icon">◷</span><span>' + r.label + '</span>' +
                    '<span class="td-opt-check">✓</span>' +
                '</button>';
            }).join("") +
            '<button type="button" class="td-date-option td-date-clear" data-remind="clear">' +
                '<span class="td-date-icon">×</span><span>No reminder</span>' +
                '<span class="td-opt-check">✓</span>' +
            '</button>' +
            '<div class="td-date-divider"></div>' +
            '<div class="td-date-section-label">Repeat</div>' +
            REPEAT_OPTIONS.map(function (o) {
                return '<button type="button" class="td-date-option" data-repeat="' + o.id + '">' +
                    '<span class="td-date-icon">↻</span><span>' + o.label + '</span>' +
                    '<span class="td-opt-check">✓</span>' +
                '</button>';
            }).join("") +
            '<button type="button" class="td-date-option td-date-clear" data-repeat="never">' +
                '<span class="td-date-icon">×</span><span>Never</span>' +
                '<span class="td-opt-check">✓</span>' +
            '</button>' +
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

    // -------- SVG snippets --------
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
    const CAL_ICON_SVG =
        '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" ' +
            'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/>' +
            '<path d="M2.5 6.5 h11"/>' +
            '<path d="M5.5 2.5 v2"/>' +
            '<path d="M10.5 2.5 v2"/>' +
        '</svg>';

    const CLOCK_ICON_SVG =
        '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" ' +
            'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="8" cy="8" r="5.5"/>' +
            '<path d="M8 5 v3.2 l2.2 1.3"/>' +
        '</svg>';

    // -------- Code scanner (M3) --------
    const scanCache = Object.create(null);
    let scanInFlight = null;

    function isScannable(p) {
        if (SCAN_IGNORE_RX.test(p)) { return false; }
        return SCAN_EXT_ALLOW.indexOf(fileExt(p)) !== -1;
    }
    function readFileText(file) {
        return new Promise(function (r) {
            file.read({}, function (err, c) { r(err ? null : c); });
        });
    }
    function statSize(file) {
        return new Promise(function (r) {
            file.stat(function (err, s) { r(err ? 0 : (s && s.size || 0)); });
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
                file: filePath, line: i, type: type, text: text,
                hash: hashStr(filePath + ":" + i + ":" + type + ":" + text)
            });
        }
        return out;
    }
    function listProjectFiles() {
        return new Promise(function (resolve) {
            try {
                ProjectManager.getAllFiles(function (f) { return isScannable(f.fullPath); })
                    .done(function (files) { resolve(files || []); })
                    .fail(function () { resolve([]); });
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
            for (let i = 0; i < capped.length; i++) {
                const f = capped[i];
                try {
                    const size = await statSize(f);
                    if (size > SCAN_BYTE_CAP) { continue; }
                    const text = await readFileText(f);
                    if (!text) { continue; }
                    const found = extractTodos(f.fullPath, text);
                    for (let j = 0; j < found.length; j++) { all.push(found[j]); }
                } catch (e) { /* skip */ }
            }
            scanCache[pk] = { items: all, at: Date.now() };
            return all;
        })();
        try { return await scanInFlight; }
        finally { scanInFlight = null; $fromCodeStatus.text(""); }
    }
    function dismissedSetForProject() {
        const pk = projectKey();
        if (!pk) { return new Set(); }
        return new Set(store.dismissedCodeTodos[pk] || []);
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

    // -------- Render: task text with inline tag chips --------
    function appendTextWithTags($container, text) {
        const re = new RegExp(TAG_RX.source, "g");
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) {
                $container.append(document.createTextNode(text.substring(last, m.index)));
            }
            const hue = tagHue(m[1]);
            $container.append(
                $('<span class="td-tag-inline"></span>')
                    .text("#" + m[1])
                    .css("--tag-hue", hue)
            );
            last = re.lastIndex;
        }
        if (last < text.length) {
            $container.append(document.createTextNode(text.substring(last)));
        }
    }

    // -------- Render: code link chip --------
    function buildCodeLinkChip(file, line) {
        const $a = $(
            '<a class="td-code-link" href="#" tabindex="-1">' +
                LINK_ICON_SVG +
                '<span class="td-code-link-text"></span>' +
            '</a>'
        );
        $a.attr("data-file", file);
        $a.attr("data-line", String(line));
        $a.attr("title", "Jump to " + file + ":" + (line + 1));
        $a.find(".td-code-link-text").text(baseName(file) + ":" + (line + 1));
        return $a;
    }

    // -------- Render: due chip --------
    function buildDueChip(dueAt) {
        if (!dueAt) {
            // No date set → small "+ date" affordance (visible on hover via CSS)
            return $(
                '<button type="button" class="td-due-add" title="Set due date">' +
                    CAL_ICON_SVG +
                '</button>'
            );
        }
        const info = formatDueDate(dueAt);
        const $chip = $(
            '<button type="button" class="td-due-chip" title="Change due date">' +
                CAL_ICON_SVG +
                '<span class="td-due-label"></span>' +
            '</button>'
        );
        $chip.addClass("td-due-" + info.tone);
        $chip.find(".td-due-label").text(info.label);
        return $chip;
    }

    // -------- Render: reminder + repeat chips --------
    function buildRemindChip(remindAt) {
        const $chip = $(
            '<button type="button" class="td-remind-chip" title="Change reminder">' +
                CLOCK_ICON_SVG +
                '<span class="td-remind-label"></span>' +
            '</button>'
        );
        if (remindAt < Date.now()) { $chip.addClass("td-remind-past"); }
        $chip.find(".td-remind-label").text(formatTime(remindAt));
        return $chip;
    }
    function buildRepeatChip(repeat) {
        const $chip = $(
            '<button type="button" class="td-repeat-chip" title="Change repeat">' +
                '<span class="td-repeat-icon">↻</span>' +
                '<span class="td-repeat-label"></span>' +
            '</button>'
        );
        $chip.find(".td-repeat-label").text(repeatLabel(repeat) || "");
        return $chip;
    }

    function flashRow(taskId, cls) {
        const $li = $panel.find('.td-item[data-id="' + taskId + '"]');
        if (!$li.length) { return; }
        $li.addClass(cls);
        setTimeout(function () { $li.removeClass(cls); }, 1100);
    }

    // -------- Render: priority dot --------
    function buildPriorityDot(priority) {
        const $d = $('<button type="button" class="td-priority" title="Set priority" aria-label="Set priority"></button>');
        if (priority) { $d.addClass("td-priority-" + priority); }
        else          { $d.addClass("td-priority-none"); }
        return $d;
    }

    // -------- Render: subtasks --------
    function isExpanded(taskId) {
        return !!store.expandedSubtasks[taskId];
    }
    function buildSubtaskItem(parentId, sub) {
        const $li = $(
            '<li class="td-subtask' + (sub.done ? " td-done" : "") + '" data-sub-id="' + sub.id + '">' +
                CHECKBOX_SVG +
                '<span class="td-subtask-text"></span>' +
                '<button type="button" class="td-subtask-delete" title="Delete subtask" aria-label="Delete subtask">×</button>' +
            '</li>'
        );
        $li.find(".td-subtask-text").text(sub.text);
        return $li;
    }
    function buildSubtasksSection(task) {
        const total = task.subtasks.length;
        const done  = task.subtasks.filter(function (s) { return s.done; }).length;
        const expanded = isExpanded(task.id);

        const $sec = $(
            '<div class="td-subtasks-section' + (expanded ? "" : " td-collapsed") + '">' +
                '<button type="button" class="td-subtasks-toggle">' +
                    '<svg class="td-chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
                        '<path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" ' +
                            'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
                    '</svg>' +
                    '<span class="td-subtasks-label">Subtasks</span>' +
                    '<span class="td-subtasks-progress"></span>' +
                '</button>' +
                '<ul class="td-subtasks-list"></ul>' +
                '<input type="text" class="td-subtask-input" placeholder="Add subtask..." maxlength="200"/>' +
            '</div>'
        );
        $sec.find(".td-subtasks-progress").text("(" + done + "/" + total + ")");

        const $ul = $sec.find(".td-subtasks-list");
        task.subtasks.forEach(function (s) { $ul.append(buildSubtaskItem(task.id, s)); });

        return $sec;
    }

    function buildTaskLi(task) {
        const allSubsDone = task.subtasks.length > 0 &&
            task.subtasks.every(function (s) { return s.done; });
        const readyHint = !task.done && allSubsDone;

        const $li = $(
            '<li class="td-item' +
                (task.done ? " td-done" : "") +
                (readyHint ? " td-ready" : "") +
                '" data-id="' + task.id + '" tabindex="0">' +
                '<div class="td-item-row">' +
                    '' + // priority placeholder
                    CHECKBOX_SVG +
                    '<div class="td-task-content">' +
                        '<div class="td-text-row">' +
                            '<span class="td-text"></span>' +
                        '</div>' +
                    '</div>' +
                    '' + // trash placeholder
                '</div>' +
            '</li>'
        );

        // Insert priority dot at the start of the item-row
        const $row = $li.find(".td-item-row");
        $row.prepend(buildPriorityDot(task.priority));

        // Render task text with inline tags
        const $text = $li.find(".td-text");
        appendTextWithTags($text, task.text);

        // Due chip / "+date" affordance — append to the text row
        const $textRow = $li.find(".td-text-row");
        $textRow.append(buildDueChip(task.dueAt));
        if (task.remindAt) { $textRow.append(buildRemindChip(task.remindAt)); }
        if (task.repeat)   { $textRow.append(buildRepeatChip(task.repeat)); }

        // Code link (if any)
        if (task.codeLink && task.codeLink.file) {
            $li.find(".td-task-content").append(buildCodeLinkChip(
                task.codeLink.file, task.codeLink.line
            ));
        }

        // Subtasks block:
        //   - has subtasks       → full section (toggle + list + input)
        //   - none, but expanded → just the input (user clicked "+ Subtask")
        //   - none, not expanded → hover-revealed "+ Subtask" hint
        if (task.subtasks.length > 0) {
            $li.find(".td-task-content").append(buildSubtasksSection(task));
        } else if (isExpanded(task.id)) {
            $li.find(".td-task-content").append(
                '<div class="td-subtasks-section td-subtasks-empty">' +
                    '<input type="text" class="td-subtask-input" ' +
                        'placeholder="Add subtask..." maxlength="200"/>' +
                '</div>'
            );
        } else {
            $li.find(".td-task-content").append(
                '<button type="button" class="td-add-subtask-hint" title="Add subtask">' +
                    '+ Subtask</button>'
            );
        }

        // Trash on the far right
        $row.append(TRASH_SVG);

        return $li;
    }

    function buildFromCodeLi(item) {
        const $li = $(
            '<li class="td-item td-from-code-item" ' +
                'data-hash="' + item.hash + '" tabindex="0">' +
                '<div class="td-item-row">' +
                    CHECKBOX_SVG +
                    '<div class="td-task-content">' +
                        '<div class="td-text-row"><span class="td-text"></span></div>' +
                        '<a class="td-code-link" href="#" tabindex="-1">' +
                            '<span class="td-tag"></span>' +
                            '<span class="td-code-link-text"></span>' +
                        '</a>' +
                    '</div>' +
                '</div>' +
            '</li>'
        );
        $li.find(".td-text").text(item.text);
        const $chip = $li.find(".td-code-link");
        $chip.attr("data-file", item.file);
        $chip.attr("data-line", String(item.line));
        $chip.attr("title", "Jump to " + item.file + ":" + (item.line + 1));
        $chip.find(".td-tag").text(item.type).addClass("td-tag-" + item.type.toLowerCase());
        $chip.find(".td-code-link-text").text(baseName(item.file) + ":" + (item.line + 1));
        return $li;
    }

    // -------- Sort --------
    function sortTasks(arr) {
        const copy = arr.slice();
        if (store.sortBy === "alphabetical") {
            copy.sort(function (a, b) {
                return (a.text || "").localeCompare(b.text || "", undefined, { sensitivity: "base" });
            });
        } else if (store.sortBy === "due") {
            copy.sort(function (a, b) {
                const ad = a.dueAt || Infinity;
                const bd = b.dueAt || Infinity;
                if (ad !== bd) { return ad - bd; }
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
        } else if (store.sortBy === "priority") {
            const rank = { high: 0, medium: 1, low: 2 };
            copy.sort(function (a, b) {
                const ar = (a.priority && rank[a.priority] !== undefined) ? rank[a.priority] : 3;
                const br = (b.priority && rank[b.priority] !== undefined) ? rank[b.priority] : 3;
                if (ar !== br) { return ar - br; }
                return (b.createdAt || 0) - (a.createdAt || 0);
            });
        } else {
            copy.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        }
        return copy;
    }

    // -------- Render: full --------
    function renderTabs() {
        const projTasks = projectKey() ? tasksForScope(projectKey()) : [];
        const globTasks = tasksForScope(GLOBAL_KEY);
        const projPending = projTasks.filter(function (t) { return !t.done; }).length;
        const globPending = globTasks.filter(function (t) { return !t.done; }).length;
        $tabProject.find(".td-tab-count").text(projPending);
        $tabGlobal.find(".td-tab-count").text(globPending);
        const hasProject = !!projectKey();
        $tabProject.attr("disabled", hasProject ? null : "disabled");
        $tabProject.toggleClass("td-tab-disabled", !hasProject);
        if (store.activeTab === "project" && !hasProject) {
            store.activeTab = "global"; saveStore();
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
        pending.forEach(function (t)   { $pendingList.append(buildTaskLi(t)); });
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

        const fromCodeVisible = $fromCodeSec.is(":visible") && visibleCodeTodos().length > 0;
        const isEmpty = !list.length && !(store.activeTab === "project" && fromCodeVisible);
        $empty.toggle(isEmpty);

        $panel.find('[data-action="sort-dateAdded"]')
            .toggleClass("td-menu-selected", store.sortBy === "dateAdded");
        $panel.find('[data-action="sort-alphabetical"]')
            .toggleClass("td-menu-selected", store.sortBy === "alphabetical");
        $panel.find('[data-action="sort-due"]')
            .toggleClass("td-menu-selected", store.sortBy === "due");
        $panel.find('[data-action="sort-priority"]')
            .toggleClass("td-menu-selected", store.sortBy === "priority");
        $panel.find('[data-action="toggle-code-scan"]')
            .toggleClass("td-menu-selected", !!store.codeTodosEnabled);

        updateBadge();
        updateDatePresetHints();
    }

    function renderFromCode() {
        const showSection = store.activeTab === "project" && store.codeTodosEnabled && !!projectKey();
        if (!showSection) { $fromCodeSec.hide(); return; }
        const items = visibleCodeTodos();
        $fromCodeList.empty();
        items.forEach(function (item) { $fromCodeList.append(buildFromCodeLi(item)); });
        $fromCodeCount.text(items.length);
        $fromCodeSec.toggle(items.length > 0);
        $fromCodeSec.toggleClass("td-collapsed", !store.fromCodeExpanded);
    }

    function updateDatePresetHints() {
        const fmt = function (ts) {
            return new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        };
        $(".td-date-hint-today").text(fmt(presetToTs("today")));
        $(".td-date-hint-tomorrow").text(fmt(presetToTs("tomorrow")));
        $(".td-date-hint-weekend").text(fmt(presetToTs("weekend")));
        $(".td-date-hint-nextweek").text(fmt(presetToTs("nextweek")));
    }

    // -------- Mutations --------
    function addTask(rawText, opts) {
        const text = (rawText || "").trim();
        if (!text) { return; }
        const newTask = normalizeTask({
            id: Date.now() + Math.floor(Math.random() * 10000),
            text: text,
            done: false,
            createdAt: Date.now(),
            tags: extractTags(text)
        });
        if (opts && opts.codeLink) { newTask.codeLink = opts.codeLink; }
        mutateCurrentTasks(function (list) { list.push(newTask); return list; });
        renderList();
    }
    function toggleDone(id) {
        let outcome = null;
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) { if (t.id === id) { outcome = applyCompletion(t); } });
            return list;
        });
        renderList();
        if (outcome === "rolled") { flashRow(id, "td-rolled"); }
    }
    function deleteTask(id) {
        delete store.expandedSubtasks[id];
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
        if (tab === "project" && !projectKey()) { return; }
        store.activeTab = tab;
        saveStore();
        renderList();
    }
    function toggleCodeScanning() {
        store.codeTodosEnabled = !store.codeTodosEnabled;
        saveStore();
        if (store.codeTodosEnabled) { ensureScan(true); }
        renderList();
    }
    function dismissCodeTodo(hash) {
        const set = dismissedSetForProject();
        set.add(hash);
        setDismissedForProject(set);
        renderList();
    }

    // Task field mutations
    function cyclePriority(id) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id === id) { t.priority = nextPriority(t.priority); }
            });
            return list;
        });
        renderList();
    }
    function setDueAt(id, ts) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id !== id) { return; }
                t.dueAt = ts;
                // Keep an existing reminder pinned to the due date: same time of day, new day.
                if (t.remindAt) {
                    if (!ts) {
                        t.remindAt = null;
                    } else {
                        const prev = new Date(t.remindAt);
                        t.remindAt = atTimeOnDate(ts, prev.getHours(), prev.getMinutes());
                    }
                    t.remindedAt = null;
                }
            });
            return list;
        });
        renderList();
    }
    function setRemindTime(id, remindId) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id !== id) { return; }
                if (remindId === "clear") {
                    t.remindAt = null;
                    t.remindedAt = null;
                    return;
                }
                const spec = REMIND_TIMES.filter(function (r) { return r.id === remindId; })[0];
                if (!spec) { return; }
                // A reminder needs a day to sit on. With no due date set, use today — or tomorrow
                // if that time already passed, so a new reminder is never born already overdue.
                const base = t.dueAt || startOfToday();
                let when = atTimeOnDate(base, spec.hour, spec.minute);
                if (!t.dueAt && when <= Date.now()) {
                    when = atTimeOnDate(base + 86400000, spec.hour, spec.minute);
                }
                t.remindAt = when;
                t.remindedAt = null;
                if (!t.dueAt) { t.dueAt = startOfDay(when); }
            });
            return list;
        });
        renderList();
    }
    function setRepeat(id, repeatId) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id === id) { t.repeat = (repeatId === "never") ? null : repeatId; }
            });
            return list;
        });
        renderList();
    }

    // Completing a repeating task advances it to its next occurrence instead of finishing it, so
    // it stays a live task. Subtasks reset for the new cycle.
    function rollForward(t) {
        const anchor = t.dueAt || startOfToday();
        // notBefore = tomorrow: finishing today's occurrence must land on the next one, not today.
        const nextDue = nextOccurrence(anchor, t.repeat, startOfToday() + 86400000);
        if (t.remindAt) {
            const prev = new Date(t.remindAt);
            t.remindAt = atTimeOnDate(nextDue, prev.getHours(), prev.getMinutes());
        }
        t.dueAt = nextDue;
        t.remindedAt = null;
        t.timesCompleted = (t.timesCompleted || 0) + 1;
        t.subtasks.forEach(function (s) { s.done = false; });
    }
    function applyCompletion(t) {
        if (!t.done && t.repeat) { rollForward(t); return "rolled"; }
        t.done = !t.done;
        return t.done ? "done" : "reopened";
    }

    // Subtask mutations
    function addSubtask(parentId, text) {
        text = (text || "").trim();
        if (!text) { return; }
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id === parentId) {
                    t.subtasks.push({
                        id: Date.now() + Math.floor(Math.random() * 10000),
                        text: text,
                        done: false
                    });
                }
            });
            return list;
        });
        store.expandedSubtasks[parentId] = true;
        saveStore();
        renderList();
    }
    function toggleSubtaskDone(parentId, subId) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id === parentId) {
                    t.subtasks.forEach(function (s) {
                        if (s.id === subId) { s.done = !s.done; }
                    });
                }
            });
            return list;
        });
        renderList();
    }
    function deleteSubtask(parentId, subId) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id === parentId) {
                    t.subtasks = t.subtasks.filter(function (s) { return s.id !== subId; });
                }
            });
            return list;
        });
        renderList();
    }
    function toggleSubtasksSection(parentId) {
        store.expandedSubtasks[parentId] = !store.expandedSubtasks[parentId];
        saveStore();
        renderList();
    }

    // -------- Code scan triggering --------
    async function ensureScan(force) {
        const pk = projectKey();
        if (!pk) { return; }
        if (!store.codeTodosEnabled) { return; }
        if (!force && scanCache[pk]) { renderList(); return; }
        await scanProjectForTodos();
        renderList();
    }
    DocumentManager.on("documentSaved.tdScanner", function (evt, doc) {
        if (!store.codeTodosEnabled) { return; }
        const pk = projectKey();
        if (!pk) { return; }
        if (doc && doc.file && doc.file.fullPath && doc.file.fullPath.indexOf(pk) === 0) {
            delete scanCache[pk];
            if ($panel.is(":visible")) { ensureScan(true); }
        }
    });

    // -------- Date popover state --------
    let datePopoverTaskId = null;

    function findCurrentTask(id) {
        return currentTasks().filter(function (t) { return t.id === id; })[0] || null;
    }
    function refreshPopoverSelection(task) {
        $datePopover.find("[data-remind], [data-repeat]").removeClass("td-opt-selected");
        if (!task) { return; }
        // A snoozed reminder sits on an arbitrary minute and matches no preset — nothing ticks.
        const remindId = remindIdFor(task.remindAt);
        if (remindId) {
            $datePopover.find('[data-remind="' + remindId + '"]').addClass("td-opt-selected");
        }
        $datePopover.find('[data-repeat="' + (task.repeat || "never") + '"]')
            .addClass("td-opt-selected");
    }
    function openDatePopover(forTaskId, $anchor) {
        datePopoverTaskId = forTaskId;
        updateDatePresetHints();
        refreshPopoverSelection(findCurrentTask(forTaskId));
        $datePopover.show();
        const r = $anchor.get(0).getBoundingClientRect();
        const pw = $datePopover.outerWidth() || 220;
        const ph = $datePopover.outerHeight() || 220;
        let left = r.left;
        let top  = r.bottom + 4;
        if (left + pw > window.innerWidth - 8) { left = window.innerWidth - pw - 8; }
        if (top + ph > window.innerHeight - 8) { top = r.top - ph - 4; }
        // With three sections the popover is tall enough to miss both above and below the anchor;
        // clamp into the viewport and let CSS scroll it rather than letting it run off-screen.
        if (top < 8) { top = Math.max(8, window.innerHeight - ph - 8); }
        $datePopover.css({ left: left + "px", top: top + "px" });
    }
    function closeDatePopover() {
        datePopoverTaskId = null;
        $datePopover.hide();
    }
    $datePopover.on("click", ".td-date-option", function (e) {
        e.stopPropagation();
        if (!datePopoverTaskId) { closeDatePopover(); return; }
        const $opt   = $(this);
        const taskId = datePopoverTaskId;
        const preset = $opt.attr("data-preset");
        const remind = $opt.attr("data-remind");
        const repeat = $opt.attr("data-repeat");

        if (preset !== undefined) {
            // Picking a date closes the popover — unchanged from how this has always behaved.
            setDueAt(taskId, presetToTs(preset));
            closeDatePopover();
            return;
        }
        if (remind !== undefined)      { setRemindTime(taskId, remind); }
        else if (repeat !== undefined) { setRepeat(taskId, repeat); }
        // Reminder and repeat are settings rather than a one-shot pick, so the popover stays open
        // to let both be set in one visit. Esc or an outside click closes it.
        datePopoverTaskId = taskId;
        refreshPopoverSelection(findCurrentTask(taskId));
    });

    // -------- Reminder scheduler --------
    let reminderTimer = null;

    function dueReminders(now) {
        const out = [];
        Object.keys(store.projects).forEach(function (scopeKey) {
            (store.projects[scopeKey] || []).forEach(function (t) {
                if (!t.done && t.remindAt && !t.remindedAt && t.remindAt <= now) {
                    out.push({ scope: scopeKey, task: t });
                }
            });
        });
        return out;
    }
    function scopeLabel(scopeKey) {
        return scopeKey === GLOBAL_KEY ? "Global" : baseName(scopeKey.replace(/[\\\/]$/, ""));
    }
    function focusTask(entry) {
        const isGlobal = entry.scope === GLOBAL_KEY;
        // A reminder can belong to a project that isn't the open one; we can only reveal the task
        // when its scope is reachable from here.
        const reachable = isGlobal || entry.scope === projectKey();
        if (reachable) {
            store.activeTab = isGlobal ? "global" : "project";
            saveStore();
        }
        openPanel();
        if (!reachable) { return; }
        setTimeout(function () {
            const $li = $panel.find('.td-item[data-id="' + entry.task.id + '"]');
            if (!$li.length) { return; }
            if ($li.get(0).scrollIntoView) { $li.get(0).scrollIntoView({ block: "center" }); }
            flashRow(entry.task.id, "td-flash");
        }, 30);
    }
    function snoozeReminder(entry) {
        mutateTaskInScope(entry.scope, entry.task.id, function (t) {
            t.remindAt   = Date.now() + SNOOZE_MS;
            t.remindedAt = null;
        });
        renderList();
    }
    function completeFromToast(entry) {
        mutateTaskInScope(entry.scope, entry.task.id, function (t) { applyCompletion(t); });
        renderList();
    }
    function toastAction(label, primary) {
        return $('<button type="button" class="td-toast-btn"></button>')
            .addClass(primary ? "td-toast-btn-primary" : "")
            .text(label);
    }
    function reminderToastStyle() {
        return (NotificationUI.NOTIFICATION_STYLES_CSS_CLASS &&
                NotificationUI.NOTIFICATION_STYLES_CSS_CLASS.SUBTLE) || "style-info";
    }
    function showReminderToast(entry) {
        const t = entry.task;
        if (!NotificationUI) { console.log("[todu] Reminder due:", t.text); return; }

        const $tpl = $('<div class="td-toast"></div>');
        $('<div class="td-toast-text"></div>').text(t.text).appendTo($tpl);
        const meta = [scopeLabel(entry.scope)];
        if (t.repeat) { meta.push(repeatLabel(t.repeat)); }
        $('<div class="td-toast-meta"></div>').text(meta.join(" · ")).appendTo($tpl);

        const $actions = $('<div class="td-toast-actions"></div>').appendTo($tpl);
        const $open    = toastAction("Open").appendTo($actions);
        const $snooze  = toastAction("Snooze 10m").appendTo($actions);
        const $done    = toastAction(t.repeat ? "Done for now" : "Mark done", true).appendTo($actions);

        const note = NotificationUI.createToastFromTemplate("Reminder", $tpl, {
            // This toast carries actions, so a stray click must not eat them.
            dismissOnClick: false,
            toastStyle: reminderToastStyle(),
            instantOpen: true
        });
        $open.on("click",   function () { note.close(); focusTask(entry); });
        $snooze.on("click", function () { note.close(); snoozeReminder(entry); });
        $done.on("click",   function () { note.close(); completeFromToast(entry); });
    }
    function showDigestToast(entries) {
        if (!NotificationUI) {
            console.log("[todu] " + entries.length + " reminders due");
            return;
        }
        const $tpl = $('<div class="td-toast"></div>');
        entries.slice(0, DIGEST_LIST_CAP).forEach(function (e) {
            $('<div class="td-toast-line"></div>').text(e.task.text).appendTo($tpl);
        });
        if (entries.length > DIGEST_LIST_CAP) {
            $('<div class="td-toast-meta"></div>')
                .text("+" + (entries.length - DIGEST_LIST_CAP) + " more")
                .appendTo($tpl);
        }
        const $actions = $('<div class="td-toast-actions"></div>').appendTo($tpl);
        const $open = toastAction("Open todu", true).appendTo($actions);
        const note = NotificationUI.createToastFromTemplate(
            entries.length + " reminders due", $tpl,
            { dismissOnClick: false, toastStyle: reminderToastStyle(), instantOpen: true }
        );
        $open.on("click", function () { note.close(); openPanel(); });
    }
    function tickReminders() {
        const now = Date.now();
        const due = dueReminders(now);
        if (!due.length) { return; }
        // Stamp before showing: a reminder fires exactly once even if the toast throws. Many at
        // once (typically a catch-up after the editor was closed) collapse into one digest.
        due.forEach(function (e) { e.task.remindedAt = now; });
        saveStore();
        if (due.length === 1) { showReminderToast(due[0]); }
        else                  { showDigestToast(due); }
        if ($panel.is(":visible")) { renderList(); }
        else                       { updateBadge(); }
    }
    function startReminderLoop() {
        if (reminderTimer) { clearInterval(reminderTimer); }
        tickReminders();
        reminderTimer = setInterval(tickReminders, REMINDER_TICK_MS);
    }

    // -------- Event wiring --------
    $addBtn.on("click", function () { addTask($input.val()); $input.val(""); });
    $input.on("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            addTask($input.val()); $input.val("");
        }
    });

    $tabs.on("click", ".td-tab", function () { setActiveTab($(this).attr("data-tab")); });

    // Task row clicks (pending + completed)
    $panel.find(".td-pending-list, .td-completed-list").on("click", ".td-item", function (e) {
        const $li = $(e.target).closest(".td-item");
        const id  = Number($li.attr("data-id"));
        const $tgt = $(e.target);

        // Priority dot
        if ($tgt.closest(".td-priority").length) {
            e.stopPropagation();
            cyclePriority(id);
            return;
        }
        // Due / reminder / repeat chips all open the same scheduling popover
        const CHIP_SEL = ".td-due-chip, .td-due-add, .td-remind-chip, .td-repeat-chip";
        if ($tgt.closest(CHIP_SEL).length) {
            e.stopPropagation();
            openDatePopover(id, $tgt.closest(CHIP_SEL));
            return;
        }
        // Code link
        if ($tgt.closest(".td-code-link").length) {
            e.preventDefault();
            const $chip = $tgt.closest(".td-code-link");
            const file  = $chip.attr("data-file");
            const line  = Number($chip.attr("data-line"));
            if (file) { jumpTo(file, line); closePanel(); }
            return;
        }
        // Trash
        if ($tgt.closest(".td-delete").length) {
            deleteTask(id);
            return;
        }
        // Subtask interactions (delegated)
        if ($tgt.closest(".td-subtask").length) {
            e.stopPropagation();
            const $sub = $tgt.closest(".td-subtask");
            const subId = Number($sub.attr("data-sub-id"));
            if ($tgt.closest(".td-subtask-delete").length) {
                deleteSubtask(id, subId);
            } else {
                toggleSubtaskDone(id, subId);
            }
            return;
        }
        // Subtask section toggle
        if ($tgt.closest(".td-subtasks-toggle").length) {
            e.stopPropagation();
            toggleSubtasksSection(id);
            return;
        }
        // Add-subtask hint
        if ($tgt.closest(".td-add-subtask-hint").length) {
            e.stopPropagation();
            store.expandedSubtasks[id] = true;
            // Add an empty subtask so the input/UI exists; user fills then we save
            mutateCurrentTasks(function (list) {
                list.forEach(function (t) {
                    if (t.id === id && t.subtasks.length === 0) {
                        // No-op: we want the input visible, so add a placeholder via re-render
                    }
                });
                return list;
            });
            saveStore();
            renderList();
            // Focus the input after render
            setTimeout(function () {
                const $sub = $('.td-item[data-id="' + id + '"] .td-subtask-input');
                if ($sub.length) { $sub.trigger("focus"); }
            }, 0);
            return;
        }
        // Click on subtask input — don't propagate
        if ($tgt.is(".td-subtask-input")) {
            e.stopPropagation();
            return;
        }
        // Default: toggle task done
        toggleDone(id);
    });

    // Subtask input: Enter to add
    $panel.find(".td-pending-list, .td-completed-list").on("keydown", ".td-subtask-input", function (e) {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            const $li = $(this).closest(".td-item");
            const id  = Number($li.attr("data-id"));
            const text = ($(this).val() || "").trim();
            if (text) {
                addSubtask(id, text);
                setTimeout(function () {
                    const $next = $('.td-item[data-id="' + id + '"] .td-subtask-input');
                    if ($next.length) { $next.trigger("focus"); }
                }, 0);
            }
        }
    });

    // Keyboard nav on tasks (toggle/delete)
    $panel.find(".td-pending-list, .td-completed-list").on("keydown", ".td-item", function (e) {
        if ($(e.target).is(".td-subtask-input")) { return; } // input handles its own
        const id = Number($(this).attr("data-id"));
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleDone(id); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteTask(id); }
    });

    // From-code list
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
        dismissCodeTodo(hash);
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
        if      (action === "clear-completed")    { clearCompleted(); }
        else if (action === "sort-dateAdded")     { setSortBy("dateAdded"); }
        else if (action === "sort-alphabetical")  { setSortBy("alphabetical"); }
        else if (action === "sort-due")           { setSortBy("due"); }
        else if (action === "sort-priority")      { setSortBy("priority"); }
        else if (action === "toggle-code-scan")   { toggleCodeScanning(); }
        else if (action === "rescan")             {
            const pk = projectKey();
            if (pk) { delete scanCache[pk]; }
            ensureScan(true);
        }
    });
    $panel.on("mousedown", function (e) {
        if ($menu.is(":visible") && !$(e.target).closest(".td-menu, .td-menu-btn").length) {
            $menu.hide();
        }
    });

    // -------- Toolbar button --------
    const $toolbarBtn = $(
        '<a href="#" id="td-toolbar-btn" title="To-Do list" aria-label="To-Do list">' +
            '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                'stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
                '<rect x="3" y="3" width="14" height="14" rx="2.5"/>' +
                '<path d="M6.5 10 L9 12.5 L14 7.5"/>' +
            '</svg>' +
            '<span class="td-toolbar-badge" style="display:none;">0</span>' +
        '</a>'
    );

    function countOverdueAcrossAll() {
        const today = startOfToday();
        let n = 0;
        Object.keys(store.projects).forEach(function (k) {
            (store.projects[k] || []).forEach(function (t) {
                if (!t.done && t.dueAt && t.dueAt < today) { n++; }
            });
        });
        return n;
    }
    function updateBadge() {
        const $badge = $toolbarBtn.find(".td-toolbar-badge");
        const overdue = countOverdueAcrossAll();
        if (overdue > 0) { $badge.text(overdue > 99 ? "99+" : String(overdue)).show(); }
        else { $badge.hide(); }
    }

    function positionPanel() {
        const btn = $toolbarBtn.get(0);
        if (!btn) { return; }
        const rect = btn.getBoundingClientRect();
        const pw = PANEL_WIDTH;
        let left = rect.left - pw - PANEL_GAP;
        let top  = rect.top;
        if (left < 8) { left = Math.max(8, rect.left); top = rect.bottom + PANEL_GAP; }
        const vh = window.innerHeight;
        const ph = $panel.outerHeight() || 360;
        if (top + ph > vh - 8) { top = Math.max(8, vh - ph - 8); }
        $panel.css({ left: left + "px", top: top + "px" });
    }
    function applyTheme() {
        const theme = detectTheme();
        $panel.attr("data-td-theme", theme);
        $toolbarBtn.attr("data-td-theme", theme);
        $datePopover.attr("data-td-theme", theme);
    }
    function openPanel() {
        applyTheme();
        if (store.activeTab === "project" && !projectKey()) { store.activeTab = "global"; }
        $panel.removeClass("td-closing").addClass("td-opening");
        $panel.show();
        positionPanel();
        renderList({ autoCollapse: true });
        setTimeout(function () { $input.trigger("focus"); }, 0);
        setTimeout(function () { $panel.removeClass("td-opening"); }, 200);
        ensureScan(false);
        tickReminders();
    }
    function closePanel() {
        $menu.hide();
        closeDatePopover();
        $panel.hide();
    }
    function togglePanel() { if ($panel.is(":visible")) { closePanel(); } else { openPanel(); } }

    $toolbarBtn.on("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        togglePanel();
    });
    $(document).off("mousedown.tdroot keydown.tdroot");
    $(document).on("mousedown.tdroot", function (e) {
        // Date popover outside-click
        if ($datePopover.is(":visible") && !$(e.target).closest(".td-date-popover, .td-due-chip, .td-due-add").length) {
            closeDatePopover();
        }
        if (!$panel.is(":visible")) { return; }
        if ($(e.target).closest("#td-dropdown, #td-toolbar-btn, .td-date-popover").length) { return; }
        closePanel();
    });
    $(document).on("keydown.tdroot", function (e) {
        if (e.key === "Escape") {
            if ($datePopover.is(":visible")) { closeDatePopover(); return; }
            if ($panel.is(":visible")) { closePanel(); }
        }
    });
    $(window).on("resize", function () {
        if ($panel.is(":visible")) { positionPanel(); }
        if ($datePopover.is(":visible")) { closeDatePopover(); }
    });

    // -------- "Add line to To-Do" --------
    const ADD_LINE_CMD_ID = "todoDropdown.addLine";
    function addLineToTodo() {
        const ed = EditorManager.getActiveEditor();
        if (!ed || !ed.document || !ed.document.file) { return; }
        const pos = ed.getCursorPos();
        const lineText = (ed.document.getLine(pos.line) || "").trim();
        if (!lineText) { return; }
        const filePath = ed.document.file.fullPath;
        store.activeTab = "project"; saveStore();
        addTask(lineText, { codeLink: { file: filePath, line: pos.line, snippet: lineText } });
        openPanel();
    }
    CommandManager.register("Add line to To-Do", ADD_LINE_CMD_ID, addLineToTodo);

    // -------- Project change --------
    try {
        const evt = ProjectManager.EVENT_PROJECT_OPEN || "projectOpen";
        ProjectManager.on(evt, function () {
            if ($panel.is(":visible")) { renderList(); ensureScan(false); }
            else { renderList(); }
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
        const TOGGLE_CMD_ID = "todoDropdown.toggle";
        CommandManager.register("Toggle To-Do List", TOGGLE_CMD_ID, togglePanel);
        const viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        if (viewMenu) { viewMenu.addMenuItem(TOGGLE_CMD_ID); }

        try {
            const editorMenu = Menus.getContextMenu(Menus.ContextMenuIds.EDITOR_MENU);
            if (editorMenu) { editorMenu.addMenuItem(ADD_LINE_CMD_ID); }
        } catch (e) { /* non-fatal */ }

        applyTheme();
        renderList();
        startReminderLoop();
        console.log("todu ready.");
    });
});
