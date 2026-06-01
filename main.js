/*global define, brackets, $ */

// Phoenix Code Todo Extension - Milestone 1
// Notion-ish dropdown todo panel, per-project scoped, with a soft visual pass.
// See docs: https://docs.phcode.dev/api/creating-extensions

define(function (require, exports, module) {
    "use strict";

    // -------- Brackets / Phoenix modules --------
    const AppInit            = brackets.getModule("utils/AppInit"),
          ExtensionUtils     = brackets.getModule("utils/ExtensionUtils"),
          PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
          ProjectManager     = brackets.getModule("project/ProjectManager"),
          CommandManager     = brackets.getModule("command/CommandManager"),
          Menus              = brackets.getModule("command/Menus");

    ExtensionUtils.loadStyleSheet(module, "style.css");

    // -------- Constants --------
    const GLOBAL_KEY            = "__global__";
    const PANEL_WIDTH           = 320;
    const PANEL_GAP             = 8;
    const COMPLETED_COLLAPSE_AT = 3; // collapse "Completed" by default when > N done

    // -------- Storage --------
    // Shape:
    // {
    //   projects: { "<projectPath>": [task, ...], "__global__": [task, ...] },
    //   completedExpanded: boolean,
    //   sortBy: "dateAdded" | "alphabetical"
    // }
    // Each task: { id, text, done, createdAt }
    const prefs = PreferencesManager.getExtensionPrefs("todoDropdown");
    prefs.definePreference("tasksV2", "object", null);
    prefs.definePreference("tasks",   "array",  []);  // legacy migration source

    let store = loadStore();

    function loadStore() {
        let s = prefs.get("tasksV2");
        if (!s || typeof s !== "object" || !s.projects) {
            const legacy = prefs.get("tasks") || [];
            s = {
                projects: {},
                completedExpanded: false,
                sortBy: "dateAdded"
            };
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
            prefs.set("tasksV2", s);
            prefs.save();
        }
        // Ensure expected fields exist (forward-compat).
        if (typeof s.completedExpanded !== "boolean") { s.completedExpanded = false; }
        if (typeof s.sortBy           !== "string")  { s.sortBy = "dateAdded"; }
        if (!s.projects || typeof s.projects !== "object") { s.projects = {}; }
        return s;
    }

    function saveStore() {
        prefs.set("tasksV2", store);
        prefs.save();
    }

    function currentScopeKey() {
        try {
            const root = ProjectManager.getProjectRoot();
            return (root && root.fullPath) ? root.fullPath : GLOBAL_KEY;
        } catch (e) {
            return GLOBAL_KEY;
        }
    }

    function currentTasks() {
        const key = currentScopeKey();
        if (!store.projects[key]) { store.projects[key] = []; }
        return store.projects[key];
    }

    function mutateCurrentTasks(fn) {
        const key   = currentScopeKey();
        const list  = store.projects[key] || [];
        const next  = fn(list);
        store.projects[key] = Array.isArray(next) ? next : list;
        saveStore();
    }

    // -------- Theme detection --------
    // Phoenix's theme isn't surfaced by a stable class name, so detect by reading
    // the computed background luminance of the editor.
    function detectTheme() {
        try {
            const el  = document.querySelector("#editor-holder") || document.body;
            const bg  = getComputedStyle(el).backgroundColor || "rgb(31,31,31)";
            const m   = bg.match(/\d+(\.\d+)?/g);
            if (!m) { return "dark"; }
            const r = parseInt(m[0], 10), g = parseInt(m[1], 10), b = parseInt(m[2], 10);
            // Rec.601 luma
            const luma = (0.299 * r + 0.587 * g + 0.114 * b);
            return luma < 128 ? "dark" : "light";
        } catch (e) {
            return "dark";
        }
    }

    // -------- DOM: panel --------
    const $panel = $(
        '<div id="td-dropdown" class="td-dropdown" style="display:none;">' +
            '<div class="td-header">' +
                '<span class="td-title">To-Do</span>' +
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
                    '<button type="button" class="td-completed-toggle">' +
                        '<svg class="td-chevron" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
                            '<path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" ' +
                                'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
                        '</svg>' +
                        '<span class="td-completed-label">Completed</span>' +
                        '<span class="td-completed-count">0</span>' +
                    '</button>' +
                    '<ul class="td-list td-completed-list"></ul>' +
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
            // The header overflow menu (hidden until ⋯ click)
            '<div class="td-menu" style="display:none;">' +
                '<button type="button" class="td-menu-item" data-action="clear-completed">' +
                    'Clear completed' +
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

    const $input         = $panel.find(".td-input");
    const $addBtn        = $panel.find(".td-add-btn");
    const $menuBtn       = $panel.find(".td-menu-btn");
    const $menu          = $panel.find(".td-menu");
    const $pendingList   = $panel.find(".td-pending-list");
    const $completedList = $panel.find(".td-completed-list");
    const $completedSec  = $panel.find(".td-completed-section");
    const $completedLbl  = $panel.find(".td-completed-count");
    const $completedTog  = $panel.find(".td-completed-toggle");
    const $empty         = $panel.find(".td-empty");

    // -------- Render --------
    function sortTasks(arr) {
        const copy = arr.slice();
        if (store.sortBy === "alphabetical") {
            copy.sort(function (a, b) {
                return (a.text || "").localeCompare(b.text || "", undefined, { sensitivity: "base" });
            });
        } else {
            // dateAdded ascending = oldest first; we want newest first at the top
            copy.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        }
        return copy;
    }

    function buildTaskLi(task) {
        const $li = $(
            '<li class="td-item' + (task.done ? " td-done" : "") + '" ' +
                'data-id="' + task.id + '" tabindex="0">' +
                '<span class="td-checkbox" role="checkbox" ' +
                    'aria-checked="' + (task.done ? "true" : "false") + '" tabindex="-1">' +
                    '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
                        '<path class="td-check-path" d="M3 8.5 L7 12 L13 4" ' +
                            'stroke="currentColor" stroke-width="2.2" ' +
                            'stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
                    '</svg>' +
                '</span>' +
                '<span class="td-text"></span>' +
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
                '</button>' +
            '</li>'
        );
        $li.find(".td-text").text(task.text); // text() prevents HTML injection
        return $li;
    }

    function renderList(opts) {
        const list      = currentTasks();
        const sorted    = sortTasks(list);
        const pending   = sorted.filter(function (t) { return !t.done; });
        const completed = sorted.filter(function (t) { return  t.done; });

        $pendingList.empty();
        $completedList.empty();

        pending.forEach(function (t) { $pendingList.append(buildTaskLi(t)); });
        completed.forEach(function (t) { $completedList.append(buildTaskLi(t)); });

        // Completed section visibility
        if (completed.length) {
            $completedSec.show();
            $completedLbl.text(completed.length);
            // Auto-collapse heuristic on first show
            if (opts && opts.autoCollapse && completed.length > COMPLETED_COLLAPSE_AT) {
                store.completedExpanded = false;
            }
            $completedSec.toggleClass("td-collapsed", !store.completedExpanded);
        } else {
            $completedSec.hide();
        }

        // Empty state shows only when there are zero tasks total
        if (!list.length) { $empty.show(); } else { $empty.hide(); }

        // Reflect sort selection in the menu
        $panel.find('[data-action="sort-dateAdded"]').toggleClass(
            "td-menu-selected", store.sortBy === "dateAdded");
        $panel.find('[data-action="sort-alphabetical"]').toggleClass(
            "td-menu-selected", store.sortBy === "alphabetical");

        updateBadge();
    }

    // -------- Mutations --------
    function addTask() {
        const text = ($input.val() || "").trim();
        if (!text) { return; }
        const id = Date.now() + Math.floor(Math.random() * 10000);
        mutateCurrentTasks(function (list) {
            list.push({ id: id, text: text, done: false, createdAt: Date.now() });
            return list;
        });
        $input.val("");
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

    // -------- Wire up events --------
    $addBtn.on("click", addTask);
    $input.on("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            addTask();
        }
    });

    function $itemFromEvent(e) {
        return $(e.target).closest(".td-item");
    }

    // Pending + completed lists share interaction handlers
    $panel.find(".td-list").on("click", ".td-item", function (e) {
        const $li = $itemFromEvent(e);
        const id  = Number($li.attr("data-id"));
        if ($(e.target).closest(".td-delete").length) {
            deleteTask(id);
            return;
        }
        // checkbox OR row click = toggle done
        toggleDone(id);
    });

    // Keyboard: Space/Enter on a focused task toggles done; Delete removes it
    $panel.find(".td-list").on("keydown", ".td-item", function (e) {
        const id = Number($(this).attr("data-id"));
        if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggleDone(id);
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            deleteTask(id);
        }
    });

    // Completed section collapse toggle
    $completedTog.on("click", function () {
        store.completedExpanded = !store.completedExpanded;
        saveStore();
        $completedSec.toggleClass("td-collapsed", !store.completedExpanded);
    });

    // Overflow menu open/close
    $menuBtn.on("click", function (e) {
        e.stopPropagation();
        if ($menu.is(":visible")) {
            $menu.hide();
        } else {
            $menu.show();
        }
    });

    $menu.on("click", ".td-menu-item", function () {
        const action = $(this).attr("data-action");
        $menu.hide();
        if (action === "clear-completed") {
            clearCompleted();
        } else if (action === "sort-dateAdded") {
            setSortBy("dateAdded");
        } else if (action === "sort-alphabetical") {
            setSortBy("alphabetical");
        }
    });

    // Click anywhere inside the panel but outside the menu closes the menu.
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
            // Badge infrastructure (M4 will activate; hidden today)
            '<span class="td-toolbar-badge" style="display:none;">0</span>' +
        '</a>'
    );

    function updateBadge() {
        // M1: no due dates yet → no overdue. Leave hook in place for M4.
        const $badge = $toolbarBtn.find(".td-toolbar-badge");
        const overdue = 0; // will be computed in M4
        if (overdue > 0) {
            $badge.text(overdue).show();
        } else {
            $badge.hide();
        }
    }

    function positionPanel() {
        const btn = $toolbarBtn.get(0);
        if (!btn) { return; }
        const rect = btn.getBoundingClientRect();
        const pw   = PANEL_WIDTH;
        let left   = rect.left - pw - PANEL_GAP;
        let top    = rect.top;

        // If button is on the left edge (fallback mount), open below it.
        if (left < 8) {
            left = Math.max(8, rect.left);
            top  = rect.bottom + PANEL_GAP;
        }

        const vh = window.innerHeight;
        const ph = $panel.outerHeight() || 320;
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
        $panel.removeClass("td-closing").addClass("td-opening");
        $panel.show();
        positionPanel();
        renderList({ autoCollapse: true });
        setTimeout(function () { $input.trigger("focus"); }, 0);
        // Strip transient class after animation completes
        setTimeout(function () { $panel.removeClass("td-opening"); }, 200);
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

    // Outside-click closes the panel
    $(document).on("mousedown.tdroot", function (e) {
        if (!$panel.is(":visible")) { return; }
        if ($(e.target).closest("#td-dropdown, #td-toolbar-btn").length) { return; }
        closePanel();
    });

    $(window).on("resize", function () {
        if ($panel.is(":visible")) { positionPanel(); }
    });

    // Esc closes
    $(document).on("keydown.tdroot", function (e) {
        if (e.key === "Escape" && $panel.is(":visible")) {
            closePanel();
        }
    });

    // -------- Project change → re-render current scope --------
    try {
        ProjectManager.on(ProjectManager.EVENT_PROJECT_OPEN || "projectOpen", function () {
            // Re-render only if the panel is visible; otherwise it'll render on next open.
            if ($panel.is(":visible")) { renderList(); }
            updateBadge();
        });
    } catch (e) { /* non-fatal */ }

    // -------- Mount --------
    AppInit.appReady(function () {
        const $mainToolbar = $("#main-toolbar");
        if ($mainToolbar.length) {
            const $iconGroup = $mainToolbar.find(".buttons").first();
            if ($iconGroup.length) {
                $iconGroup.append($toolbarBtn);
            } else {
                $mainToolbar.append($toolbarBtn);
            }
        }

        // View-menu fallback
        const TOGGLE_CMD_ID = "todoDropdown.toggle";
        CommandManager.register("Toggle To-Do List", TOGGLE_CMD_ID, togglePanel);
        const viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        if (viewMenu) { viewMenu.addMenuItem(TOGGLE_CMD_ID); }

        applyTheme();
        renderList();   // also calls updateBadge
        console.log("Todo dropdown (M1) ready.");
    });
});
