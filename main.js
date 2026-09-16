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
          KeyBindingManager  = brackets.getModule("command/KeyBindingManager"),
          StatusBar          = brackets.getModule("widgets/StatusBar"),
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

    // Ctrl maps to Cmd on macOS. Ctrl-Shift-T is taken by "Reopen closed file".
    const TOGGLE_SHORTCUT = "Ctrl-Alt-T";

    // Completion history powering the stats card. Bounded both ways so prefs never grow unbounded.
    const STATS_LOG_CAP        = 2000;
    const STATS_RETENTION_DAYS = 120;

    const STATUS_INDICATOR_ID = "status-todu";

    // Words the quick-add parser understands at the END of a task ("Ship it friday 3pm daily").
    const DAY_WORDS = {
        sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
        wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
        fri: 5, friday: 5, sat: 6, saturday: 6
    };
    const REPEAT_WORDS    = { daily: "daily", weekdays: "weekdays", weekly: "weekly", monthly: "monthly" };
    const EVERY_WORDS     = { day: "daily", weekday: "weekdays", week: "weekly", month: "monthly" };
    const CONNECTOR_WORDS = ["at", "on", "by", "due"];
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
        if (!Array.isArray(s.completionLog)) { s.completionLog = []; }
        if (typeof s.statsVisible !== "boolean") { s.statsVisible = false; }
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
    // Calendar-day arithmetic via Date, so a day is never 23 or 25 hours across DST.
    function addDays(ts, n) {
        const d = new Date(ts);
        d.setDate(d.getDate() + n);
        return d.getTime();
    }

    // -------- Quick-add parsing --------
    function parseClockToken(tok) {
        let m = tok.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
        if (m) {
            let hour = Number(m[1]);
            const minute = m[2] ? Number(m[2]) : 0;
            if (hour < 1 || hour > 12 || minute > 59) { return null; }
            if (m[3] === "pm" && hour !== 12) { hour += 12; }
            if (m[3] === "am" && hour === 12) { hour = 0; }
            return { hour: hour, minute: minute };
        }
        m = tok.match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
            const hour = Number(m[1]), minute = Number(m[2]);
            if (hour > 23 || minute > 59) { return null; }
            return { hour: hour, minute: minute };
        }
        return null;
    }
    /**
     * Pulls a due date, reminder time and repeat rule off the END of a task title:
     *   "Fix login tomorrow 3pm #bug" -> "Fix login #bug", due tomorrow, remind 15:00.
     * Only trailing words are read, and parsing stops at the first word it doesn't recognise, so a
     * title like "Write daily report" is left alone. #tags may sit anywhere in the trailing run.
     */
    function parseQuickAdd(raw, now) {
        now = now || Date.now();
        const text  = (raw || "").trim();
        const plain = { text: text, dueAt: null, remindAt: null, repeat: null, matched: false };
        if (!text) { return plain; }

        const words = text.split(/\s+/);
        const found = { day: null, clock: null, repeat: null };
        const keptTags = [];
        let i = words.length - 1;
        while (i >= 0) {
            const w    = words[i];
            const lw   = w.toLowerCase().replace(/[.,;!?]+$/, "");
            const prev = i > 0 ? words[i - 1].toLowerCase() : "";

            if (/^#[a-zA-Z]/.test(w)) { keptTags.unshift(w); i--; continue; }

            // Two-word forms
            if (!found.repeat && EVERY_WORDS[lw] && prev === "every") {
                found.repeat = EVERY_WORDS[lw]; i -= 2; continue;
            }
            if (!found.day && lw === "week" && prev === "next") {
                found.day = { kind: "nextweek" }; i -= 2; continue;
            }
            if (!found.clock && (lw === "am" || lw === "pm") && /^\d{1,2}(:\d{2})?$/.test(prev)) {
                const c2 = parseClockToken(prev + lw);
                if (c2) { found.clock = c2; i -= 2; continue; }
            }

            // One-word forms
            if (!found.repeat && REPEAT_WORDS[lw]) { found.repeat = REPEAT_WORDS[lw]; i--; continue; }
            if (!found.clock) {
                const c = parseClockToken(lw);
                if (c) { found.clock = c; i--; continue; }
            }
            if (!found.day) {
                if (lw === "today") { found.day = { kind: "today" }; i--; continue; }
                if (lw === "tonight") {
                    found.day = { kind: "today" };
                    if (!found.clock) { found.clock = { hour: 18, minute: 0 }; }
                    i--; continue;
                }
                if (lw === "tomorrow" || lw === "tmrw" || lw === "tmr") {
                    found.day = { kind: "tomorrow" }; i--; continue;
                }
                if (Object.prototype.hasOwnProperty.call(DAY_WORDS, lw)) {
                    found.day = { kind: "weekday", dow: DAY_WORDS[lw] }; i--; continue;
                }
            }
            // "at 3pm", "on friday" — a connector only goes when it introduces something parsed.
            if (CONNECTOR_WORDS.indexOf(lw) !== -1 && (found.day || found.clock)) { i--; continue; }
            break;
        }

        if (!found.day && !found.clock && !found.repeat) { return plain; }
        const title = words.slice(0, i + 1).concat(keptTags).join(" ");
        // Never eat the whole title: "Tomorrow" on its own is a task called Tomorrow.
        if (!words.slice(0, i + 1).join(" ").trim()) { return plain; }

        const today = startOfDay(now);
        let dueAt = null;
        if (found.day) {
            if (found.day.kind === "today")    { dueAt = today; }
            if (found.day.kind === "tomorrow") { dueAt = addDays(today, 1); }
            if (found.day.kind === "nextweek") {
                const delta = ((1 - new Date(today).getDay() + 7) % 7) || 7;
                dueAt = addDays(today, delta);
            }
            if (found.day.kind === "weekday") {
                dueAt = addDays(today, (found.day.dow - new Date(today).getDay() + 7) % 7);
            }
        }
        if (dueAt === null && found.clock) {
            // A bare time means the next time the clock reads that.
            dueAt = atTimeOnDate(today, found.clock.hour, found.clock.minute) <= now ? addDays(today, 1) : today;
        }
        if (dueAt === null && found.repeat) {
            dueAt = today;
            if (found.repeat === "weekdays") {
                while (new Date(dueAt).getDay() === 0 || new Date(dueAt).getDay() === 6) { dueAt = addDays(dueAt, 1); }
            }
        }
        return {
            text: title,
            dueAt: dueAt,
            remindAt: found.clock ? atTimeOnDate(dueAt, found.clock.hour, found.clock.minute) : null,
            repeat: found.repeat,
            matched: true
        };
    }

    // -------- Stats --------
    function dayKey(ts) {
        const d = new Date(ts);
        return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
    }
    function computeStats(log, now) {
        const counts = Object.create(null);
        (log || []).forEach(function (e) {
            const k = dayKey(e.at);
            counts[k] = (counts[k] || 0) + 1;
        });
        const today = startOfDay(now || Date.now());
        const days = [];
        for (let n = 6; n >= 0; n--) {
            const ts = addDays(today, -n);
            days.push({ ts: ts, count: counts[dayKey(ts)] || 0 });
        }
        const week = days.reduce(function (sum, d) { return sum + d.count; }, 0);
        // A streak survives until the end of today: nothing done yet today still counts yesterday's run.
        let streak = 0;
        let cursor = counts[dayKey(today)] ? today : addDays(today, -1);
        while (counts[dayKey(cursor)] && streak < STATS_RETENTION_DAYS) {
            streak++;
            cursor = addDays(cursor, -1);
        }
        return { today: days[6].count, week: week, streak: streak, days: days };
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
                '<div class="td-header-actions">' +
                    '<button type="button" class="td-icon-btn td-stats-btn" title="Stats" aria-label="Toggle stats">' +
                        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" ' +
                            'stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
                            '<path d="M3 13 V9"/><path d="M8 13 V4"/><path d="M13 13 V7"/>' +
                        '</svg>' +
                    '</button>' +
                    '<button type="button" class="td-icon-btn td-menu-btn" title="More" aria-label="More actions">' +
                        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
                            '<circle cx="3"  cy="8" r="1.4" fill="currentColor"/>' +
                            '<circle cx="8"  cy="8" r="1.4" fill="currentColor"/>' +
                            '<circle cx="13" cy="8" r="1.4" fill="currentColor"/>' +
                        '</svg>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="td-input-row">' +
                '<input type="text" class="td-input" placeholder="Add a task… try &quot;tomorrow 3pm #tag&quot;" maxlength="200" />' +
                '<button type="button" class="td-add-btn" title="Add task" aria-label="Add task">' +
                    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
                        '<path d="M8 3v10 M3 8h10" stroke="currentColor" stroke-width="2" ' +
                            'stroke-linecap="round" fill="none"/>' +
                    '</svg>' +
                '</button>' +
            '</div>' +
            '<div class="td-input-hint" style="display:none;"></div>' +
            '<div class="td-body">' +
                '<div class="td-stats" style="display:none;">' +
                    '<div class="td-stats-nums">' +
                        '<div class="td-stat"><span class="td-stat-val td-stat-today">0</span>' +
                            '<span class="td-stat-lbl">Done today</span></div>' +
                        '<div class="td-stat"><span class="td-stat-val td-stat-week">0</span>' +
                            '<span class="td-stat-lbl">Last 7 days</span></div>' +
                        '<div class="td-stat"><span class="td-stat-val td-stat-streak">0</span>' +
                            '<span class="td-stat-lbl">Day streak</span></div>' +
                    '</div>' +
                    '<div class="td-stats-bars"></div>' +
                '</div>' +
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
                    '<div class="td-empty-title">You\'re all clear</div>' +
                    '<div class="td-empty-sub">Add a task above. A few things worth knowing:</div>' +
                    '<ul class="td-empty-tips">' +
                        '<li><code>tomorrow 3pm</code>, <code>friday</code>, <code>every weekday 9am</code> at the end of a task schedule it</li>' +
                        '<li><code>#tag</code> anywhere to label it</li>' +
                        '<li>Double-click a task to edit it</li>' +
                        '<li>Right-click a line of code → <b>Add line to To-Do</b></li>' +
                    '</ul>' +
                '</div>' +
            '</div>' +
            '<div class="td-footer">' +
                '<span class="td-footer-hint"><kbd class="td-kbd td-shortcut-kbd"></kbd> toggle</span>' +
                '<span class="td-footer-hint"><kbd class="td-kbd">Double-click</kbd> edit</span>' +
            '</div>' +
            // Overflow menu (⋯)
            '<div class="td-menu" style="display:none;">' +
                '<div class="td-menu-section-label">View</div>' +
                '<button type="button" class="td-menu-item" data-action="toggle-stats">' +
                    '<span class="td-menu-check">✓</span><span>Show stats</span>' +
                '</button>' +
                '<div class="td-menu-divider"></div>' +
                '<div class="td-menu-section-label">Code</div>' +
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
                '<div class="td-menu-divider"></div>' +
                '<button type="button" class="td-menu-item td-menu-item-danger" data-action="clear-completed">' +
                    '<span class="td-menu-check"></span><span>Clear completed</span>' +
                '</button>' +
            '</div>' +
        '</div>'
    ).appendTo("body");

    // Date preset popover (separate floating element, also under body)
    const $datePopover = $(
        '<div class="td-date-popover" style="display:none;">' +
            '<div class="td-date-section-label">Due</div>' +
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
            '<button type="button" class="td-date-option td-date-clear" data-preset="clear">' +
                '<span class="td-date-icon">×</span><span>No date</span>' +
            '</button>' +
            '<div class="td-date-divider"></div>' +
            // Reminder + repeat as compact pill rows: same data-* attributes and handlers as before.
            '<div class="td-date-section-label">Remind me</div>' +
            '<div class="td-pill-row">' +
                REMIND_TIMES.map(function (r) {
                    return '<button type="button" class="td-date-option td-pill" data-remind="' + r.id + '">' +
                        r.label.replace(":00", "") +
                    '</button>';
                }).join("") +
                '<button type="button" class="td-date-option td-pill td-pill-quiet" data-remind="clear" title="No reminder">Off</button>' +
            '</div>' +
            '<div class="td-date-custom">' +
                '<input type="time" class="td-time-input" step="300" aria-label="Custom reminder time"/>' +
                '<button type="button" class="td-time-set">Set time</button>' +
            '</div>' +
            '<div class="td-date-divider"></div>' +
            '<div class="td-date-section-label">Repeat</div>' +
            '<div class="td-pill-row">' +
                REPEAT_OPTIONS.map(function (o) {
                    return '<button type="button" class="td-date-option td-pill" data-repeat="' + o.id + '">' +
                        o.label +
                    '</button>';
                }).join("") +
                '<button type="button" class="td-date-option td-pill td-pill-quiet" data-repeat="never" title="Don\'t repeat">Off</button>' +
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
    const $inputHint      = $panel.find(".td-input-hint");
    const $stats          = $panel.find(".td-stats");
    const $statsBars      = $panel.find(".td-stats-bars");

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

    const SUBTASK_ICON_SVG =
        '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" ' +
            'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M3 3 v5 a2 2 0 0 0 2 2 h3"/>' +
            '<path d="M11 8 v4"/><path d="M9 10 h4"/>' +
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
            // jQuery 2's .css() silently drops custom properties, which left every tag uncolored.
            const tagEl = document.createElement("span");
            tagEl.className = "td-tag-inline";
            tagEl.textContent = "#" + m[1];
            tagEl.style.setProperty("--tag-hue", String(tagHue(m[1])));
            $container.append(tagEl);
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
            // No date set → "schedule" affordance in the hover actions
            return $(
                '<button type="button" class="td-due-add td-action-btn" title="Schedule: date, reminder, repeat" aria-label="Schedule">' +
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
    function buildRepeatChip(repeat, timesCompleted) {
        const $chip = $(
            '<button type="button" class="td-repeat-chip" title="Change repeat">' +
                '<span class="td-repeat-icon">↻</span>' +
                '<span class="td-repeat-label"></span>' +
            '</button>'
        );
        $chip.find(".td-repeat-label").text(repeatLabel(repeat) || "");
        if (timesCompleted > 0) {
            $('<span class="td-repeat-count"></span>').text(timesCompleted + "×").appendTo($chip);
            $chip.attr("title", "Done " + timesCompleted + (timesCompleted === 1 ? " time" : " times") +
                " — click to change repeat");
        }
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
                    CHECKBOX_SVG +
                    '<div class="td-task-content">' +
                        '<div class="td-text-row">' +
                            '<span class="td-text"></span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="td-row-actions"></div>' +
                '</div>' +
            '</li>'
        );
        const $row     = $li.find(".td-item-row");
        const $content = $li.find(".td-task-content");
        const $actions = $li.find(".td-row-actions");

        $row.prepend(buildPriorityDot(task.priority));
        appendTextWithTags($li.find(".td-text"), task.text);

        // Title gets the full width; everything about *when* and *where* sits on one quiet line below,
        // so chips never squeeze the title onto two lines.
        const $meta = $('<div class="td-meta"></div>');
        if (task.dueAt)    { $meta.append(buildDueChip(task.dueAt)); }
        if (task.remindAt) { $meta.append(buildRemindChip(task.remindAt)); }
        if (task.repeat)   { $meta.append(buildRepeatChip(task.repeat, task.timesCompleted)); }
        if (task.codeLink && task.codeLink.file) {
            $meta.append(buildCodeLinkChip(task.codeLink.file, task.codeLink.line));
        }
        if ($meta.children().length) { $content.append($meta); }

        // Subtasks: full section when there are some, a bare input right after "+ subtask" is clicked.
        if (task.subtasks.length > 0) {
            $content.append(buildSubtasksSection(task));
        } else if (isExpanded(task.id)) {
            $content.append(
                '<div class="td-subtasks-section td-subtasks-empty">' +
                    '<input type="text" class="td-subtask-input" ' +
                        'placeholder="Add subtask…" maxlength="200"/>' +
                '</div>'
            );
        }

        // Hover actions float over the row's right edge instead of reserving invisible space.
        if (!task.dueAt) {
            $actions.append(buildDueChip(null));
        }
        if (!task.subtasks.length && !isExpanded(task.id)) {
            $actions.append(
                '<button type="button" class="td-add-subtask-hint td-action-btn" title="Add subtask" aria-label="Add subtask">' +
                    SUBTASK_ICON_SVG +
                '</button>'
            );
        }
        $actions.append(TRASH_SVG);

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
        $panel.find('[data-action="toggle-stats"]')
            .toggleClass("td-menu-selected", !!store.statsVisible);
        $panel.find(".td-stats-btn").toggleClass("td-icon-btn-active", !!store.statsVisible);

        renderStats();

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
        let text = (rawText || "").trim();
        if (!text) { return; }
        // Only typed input is parsed. A captured code line ("Add line to To-Do") stays verbatim —
        // "return cache.get(key) // daily" must not quietly become a recurring task.
        const parsed = (opts && opts.parse) ? parseQuickAdd(text) : null;
        if (parsed && parsed.matched) { text = parsed.text; }
        const newTask = normalizeTask({
            id: Date.now() + Math.floor(Math.random() * 10000),
            text: text,
            done: false,
            createdAt: Date.now(),
            tags: extractTags(text)
        });
        if (parsed && parsed.matched) {
            newTask.dueAt    = parsed.dueAt;
            newTask.remindAt = parsed.remindAt;
            newTask.repeat   = parsed.repeat;
        }
        if (opts && opts.codeLink) { newTask.codeLink = opts.codeLink; }
        mutateCurrentTasks(function (list) { list.push(newTask); return list; });
        renderList();
    }
    function submitInput() {
        addTask($input.val(), { parse: true });
        $input.val("");
        renderInputHint();
    }
    // Live preview of what the quick-add parser will pull off the typed text.
    function renderInputHint() {
        const parsed = parseQuickAdd($input.val());
        if (!parsed.matched) { $inputHint.hide().empty(); return; }
        $inputHint.empty().append($('<span class="td-input-hint-label">Will schedule</span>'));
        const pill = function (iconHtml, label) {
            return $('<span class="td-hint-pill"></span>').html(iconHtml)
                .append($("<span></span>").text(label));
        };
        if (parsed.dueAt)    { $inputHint.append(pill(CAL_ICON_SVG, formatDueDate(parsed.dueAt).label)); }
        if (parsed.remindAt) { $inputHint.append(pill(CLOCK_ICON_SVG, formatTime(parsed.remindAt))); }
        if (parsed.repeat)   { $inputHint.append(pill('<span class="td-repeat-icon">↻</span>', repeatLabel(parsed.repeat))); }
        $inputHint.show();
    }

    // -------- Completion log (stats) --------
    function recordCompletion(taskId, outcome) {
        const log = store.completionLog;
        if (outcome === "done" || outcome === "rolled") {
            log.push({ id: taskId, at: Date.now() });
        } else if (outcome === "reopened") {
            // Un-checking takes back the most recent completion of that task, so a misclick
            // doesn't inflate the numbers.
            for (let i = log.length - 1; i >= 0; i--) {
                if (log[i].id === taskId) { log.splice(i, 1); break; }
            }
        } else {
            return;
        }
        const cutoff = addDays(startOfToday(), -STATS_RETENTION_DAYS);
        store.completionLog = log
            .filter(function (e) { return e.at >= cutoff; })
            .slice(-STATS_LOG_CAP);
        saveStore();
    }
    function renderStats() {
        $stats.toggle(!!store.statsVisible);
        if (!store.statsVisible) { return; }
        const s = computeStats(store.completionLog);
        $stats.find(".td-stat-today").text(s.today);
        $stats.find(".td-stat-week").text(s.week);
        $stats.find(".td-stat-streak").text(s.streak);
        const max = Math.max.apply(null, s.days.map(function (d) { return d.count; }).concat([1]));
        $statsBars.empty();
        s.days.forEach(function (d, idx) {
            const date = new Date(d.ts);
            const $col = $('<div class="td-bar-col"></div>').attr("title",
                date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) +
                " — " + d.count + " done");
            const $bar = $('<div class="td-bar"></div>')
                .css("height", Math.round((d.count / max) * 100) + "%")
                .toggleClass("td-bar-empty", d.count === 0)
                .toggleClass("td-bar-today", idx === 6);
            $('<div class="td-bar-track"></div>').append($bar).appendTo($col);
            $('<div class="td-bar-lbl"></div>')
                .text(date.toLocaleDateString(undefined, { weekday: "narrow" }))
                .appendTo($col);
            $statsBars.append($col);
        });
    }

    // -------- Edit in place --------
    let editingId = null;
    let pendingToggle = null;

    function beginEdit(id) {
        const task = findCurrentTask(id);
        if (!task) { return; }
        const $li = $panel.find('.td-item[data-id="' + id + '"]');
        const $text = $li.find(".td-text").first();
        if (!$text.length) { return; }
        editingId = id;
        const $field = $('<input type="text" class="td-edit-input" maxlength="200"/>').val(task.text);
        $text.empty().append($field);
        $li.addClass("td-editing");
        $field.trigger("focus");
        const el = $field.get(0);
        el.setSelectionRange(el.value.length, el.value.length);
    }
    function commitEdit(id, value) {
        if (editingId !== id) { return; } // blur after Enter re-rendered: already handled
        editingId = null;
        const text = (value || "").trim();
        // An emptied field cancels rather than deletes — deleting has its own button.
        if (text) {
            mutateCurrentTasks(function (list) {
                list.forEach(function (t) {
                    if (t.id === id) { t.text = text; t.tags = extractTags(text); }
                });
                return list;
            });
        }
        renderList();
    }
    function cancelEdit() {
        editingId = null;
        renderList();
    }

    function toggleDone(id) {
        let outcome = null;
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) { if (t.id === id) { outcome = applyCompletion(t); } });
            return list;
        });
        recordCompletion(id, outcome);
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
        if (remindId === "clear") {
            mutateCurrentTasks(function (list) {
                list.forEach(function (t) {
                    if (t.id === id) { t.remindAt = null; t.remindedAt = null; }
                });
                return list;
            });
            renderList();
            return;
        }
        const spec = REMIND_TIMES.filter(function (r) { return r.id === remindId; })[0];
        if (spec) { setReminderClock(id, spec.hour, spec.minute); }
    }
    // Any hour:minute — used by the presets and the custom time field alike.
    function setReminderClock(id, hour, minute) {
        mutateCurrentTasks(function (list) {
            list.forEach(function (t) {
                if (t.id !== id) { return; }
                // A reminder needs a day to sit on. With no due date set, use today — or tomorrow
                // if that time already passed, so a new reminder is never born already overdue.
                const base = t.dueAt || startOfToday();
                let when = atTimeOnDate(base, hour, minute);
                if (!t.dueAt && when <= Date.now()) {
                    when = atTimeOnDate(addDays(base, 1), hour, minute);
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
        $datePopover.find("[data-preset], [data-remind], [data-repeat]").removeClass("td-opt-selected");
        if (!task) { return; }
        ["today", "tomorrow", "weekend", "nextweek"].forEach(function (p) {
            if (task.dueAt && presetToTs(p) === task.dueAt) {
                $datePopover.find('[data-preset="' + p + '"]').addClass("td-opt-selected");
            }
        });
        // A snoozed reminder sits on an arbitrary minute and matches no preset — nothing ticks.
        const remindId = remindIdFor(task.remindAt);
        if (remindId) {
            $datePopover.find('[data-remind="' + remindId + '"]').addClass("td-opt-selected");
        }
        $datePopover.find('[data-repeat="' + (task.repeat || "never") + '"]')
            .addClass("td-opt-selected");
        // Custom field shows the reminder's actual time, and lights up when no preset matches it.
        const $time = $datePopover.find(".td-time-input");
        if (task.remindAt) {
            const d = new Date(task.remindAt);
            $time.val(String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"));
        } else {
            $time.val("");
        }
        $datePopover.find(".td-date-custom").toggleClass("td-opt-selected", !!task.remindAt && !remindId);
    }
    function applyCustomTime() {
        if (!datePopoverTaskId) { return; }
        const m = /^(\d{2}):(\d{2})/.exec($datePopover.find(".td-time-input").val() || "");
        if (!m) { return; }
        const taskId = datePopoverTaskId;
        setReminderClock(taskId, Number(m[1]), Number(m[2]));
        refreshPopoverSelection(findCurrentTask(taskId));
    }
    $datePopover.on("click", ".td-time-set", function (e) {
        e.stopPropagation();
        applyCustomTime();
    });
    $datePopover.on("keydown", ".td-time-input", function (e) {
        if (e.key === "Enter") { e.preventDefault(); applyCustomTime(); }
    });
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
        let outcome = null;
        mutateTaskInScope(entry.scope, entry.task.id, function (t) { outcome = applyCompletion(t); });
        recordCompletion(entry.task.id, outcome);
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
        // Don't re-render out from under someone mid-edit; the badge still updates.
        if ($panel.is(":visible") && editingId === null) { renderList(); }
        else                                             { updateBadge(); }
    }
    function startReminderLoop() {
        if (reminderTimer) { clearInterval(reminderTimer); }
        tickReminders();
        // updateBadge on every tick also rolls the status bar count over at midnight.
        reminderTimer = setInterval(function () { tickReminders(); updateBadge(); }, REMINDER_TICK_MS);
    }

    // -------- Event wiring --------
    $addBtn.on("click", submitInput);
    $input.on("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            submitInput();
        }
    });
    $input.on("input", renderInputHint);

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
        // Click on subtask / edit input — don't propagate
        if ($tgt.is(".td-subtask-input, .td-edit-input")) {
            e.stopPropagation();
            return;
        }
        // Task title: single click completes, double click edits. The single click waits a beat so
        // a double click can cancel it — otherwise the first click would re-render the row away.
        if ($tgt.closest(".td-text").length) {
            if (pendingToggle) { clearTimeout(pendingToggle); pendingToggle = null; }
            if (e.detail >= 2) {
                beginEdit(id);
            } else {
                pendingToggle = setTimeout(function () {
                    pendingToggle = null;
                    toggleDone(id);
                }, 220);
            }
            return;
        }
        // Default: toggle task done
        toggleDone(id);
    });

    // Edit field: Enter saves, Escape cancels (without closing the panel), blur saves.
    $panel.find(".td-pending-list, .td-completed-list").on("keydown", ".td-edit-input", function (e) {
        e.stopPropagation();
        const id = Number($(this).closest(".td-item").attr("data-id"));
        if (e.key === "Enter")  { e.preventDefault(); commitEdit(id, $(this).val()); }
        if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    });
    $panel.find(".td-pending-list, .td-completed-list").on("blur", ".td-edit-input", function () {
        const id = Number($(this).closest(".td-item").attr("data-id"));
        commitEdit(id, $(this).val());
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
        // Inputs handle their own keys — Backspace in an edit field must never delete the task.
        if ($(e.target).is("input")) { return; }
        const id = Number($(this).attr("data-id"));
        if (e.key === "F2") { e.preventDefault(); beginEdit(id); }
        else if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleDone(id); }
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

    $panel.find(".td-stats-btn").on("click", function () {
        store.statsVisible = !store.statsVisible;
        saveStore();
        renderList();
    });
    $panel.find(".td-shortcut-kbd").text(
        brackets.platform === "mac" ? "⌘⌥T" : TOGGLE_SHORTCUT.replace(/-/g, "+")
    );

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
        else if (action === "toggle-stats")       {
            store.statsVisible = !store.statsVisible;
            saveStore();
            renderList();
        }
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
        updateStatusIndicator();
    }

    // -------- Status bar --------
    let statusMounted = false;
    const $statusIndicator = $(
        '<div class="td-status" role="button" tabindex="0">' +
            '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
                'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<rect x="3" y="3" width="14" height="14" rx="2.5"/>' +
                '<path d="M6.5 10 L9 12.5 L14 7.5"/>' +
            '</svg>' +
            '<span class="td-status-label"></span>' +
        '</div>'
    );
    // What's on your plate right now: this project + Global, due today or already overdue.
    function countDueNow() {
        const today = startOfToday();
        const endOfToday = addDays(today, 1);
        const scopes = [GLOBAL_KEY];
        const pk = projectKey();
        if (pk) { scopes.push(pk); }
        let due = 0, overdue = 0;
        scopes.forEach(function (k) {
            (store.projects[k] || []).forEach(function (t) {
                if (t.done || !t.dueAt || t.dueAt >= endOfToday) { return; }
                due++;
                if (t.dueAt < today) { overdue++; }
            });
        });
        return { due: due, overdue: overdue };
    }
    function updateStatusIndicator() {
        if (!statusMounted) { return; }
        const c = countDueNow();
        $statusIndicator.find(".td-status-label").text(c.due + " due");
        const tip = c.overdue
            ? c.due + " due today or overdue (" + c.overdue + " overdue) — click to open todu"
            : c.due + " due today — click to open todu";
        // updateIndicator replaces the class attribute wholesale, so the full class list goes in.
        const cls = "indicator td-status" + (c.overdue ? " td-status-overdue" : "");
        try {
            StatusBar.updateIndicator(STATUS_INDICATOR_ID, c.due > 0, cls, tip);
        } catch (e) { /* non-fatal */ }
    }
    function mountStatusIndicator() {
        try {
            StatusBar.addIndicator(STATUS_INDICATOR_ID, $statusIndicator, false, "td-status", "todu");
            statusMounted = true;
        } catch (e) { statusMounted = false; }
        $statusIndicator.on("click", function (e) {
            e.preventDefault();
            togglePanel();
        });
        $statusIndicator.on("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePanel(); }
        });
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
        // The status bar count is a toggle too — let its own click close the panel, not this.
        if ($(e.target).closest("#td-dropdown, #td-toolbar-btn, .td-date-popover, .td-status").length) { return; }
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
        // Registered before the menu item so the shortcut shows next to it in View.
        try { KeyBindingManager.addBinding(TOGGLE_CMD_ID, TOGGLE_SHORTCUT); } catch (e) { /* non-fatal */ }
        const viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        if (viewMenu) { viewMenu.addMenuItem(TOGGLE_CMD_ID); }

        try {
            const editorMenu = Menus.getContextMenu(Menus.ContextMenuIds.EDITOR_MENU);
            if (editorMenu) { editorMenu.addMenuItem(ADD_LINE_CMD_ID); }
        } catch (e) { /* non-fatal */ }

        applyTheme();
        mountStatusIndicator();
        renderList();
        startReminderLoop();
        console.log("todu ready.");
    });
});
