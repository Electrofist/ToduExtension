/*global define, brackets, $ */

// Phoenix Code Todo Extension
// Adds a small dropdown todo panel triggered by an arrow button.
// See docs: https://docs.phcode.dev/api/creating-extensions

define(function (require, exports, module) {
    "use strict";

    // Phoenix / Brackets modules
    const AppInit            = brackets.getModule("utils/AppInit"),
          ExtensionUtils     = brackets.getModule("utils/ExtensionUtils"),
          PreferencesManager = brackets.getModule("preferences/PreferencesManager"),
          CommandManager     = brackets.getModule("command/CommandManager"),
          Menus              = brackets.getModule("command/Menus");

    // Load this extension's stylesheet.
    ExtensionUtils.loadStyleSheet(module, "style.css");

    // Use an extension-scoped preferences store so tasks survive reloads.
    const prefs = PreferencesManager.getExtensionPrefs("todoDropdown");
    prefs.definePreference("tasks", "array", []);

    // In-memory task list. Each task: { id: number, text: string, done: boolean }
    let tasks = (prefs.get("tasks") || []).slice();

    function saveTasks() {
        prefs.set("tasks", tasks);
        prefs.save();
    }

    // ---------- Dropdown panel ----------

    // Build the dropdown panel markup ONCE and attach it to <body>.
    // It stays hidden until the toolbar button is clicked.
    const $panel = $(
        '<div id="td-dropdown" class="td-dropdown" style="display:none;">' +
            '<div class="td-header">' +
                '<span class="td-title">To-Do</span>' +
            '</div>' +
            '<div class="td-input-row">' +
                '<input type="text" class="td-input" placeholder="New task..." maxlength="200" />' +
                '<button type="button" class="td-add-btn" title="Add task">+</button>' +
            '</div>' +
            '<ul class="td-list"></ul>' +
            '<div class="td-empty">No tasks yet. Add one above.</div>' +
        '</div>'
    ).appendTo("body");

    const $input  = $panel.find(".td-input");
    const $addBtn = $panel.find(".td-add-btn");
    const $list   = $panel.find(".td-list");
    const $empty  = $panel.find(".td-empty");

    function renderList() {
        $list.empty();
        if (!tasks.length) {
            $empty.show();
            return;
        }
        $empty.hide();

        tasks.forEach(function (task) {
            const $item = $(
                '<li class="td-item' + (task.done ? ' td-done' : '') + '" data-id="' + task.id + '">' +
                    '<span class="td-text"></span>' +
                    '<button type="button" class="td-delete" title="Delete">&times;</button>' +
                '</li>'
            );
            // Set text safely (avoids HTML injection from pasted task text).
            $item.find(".td-text").text(task.text);
            $list.append($item);
        });
    }

    function addTask() {
        const text = ($input.val() || "").trim();
        if (!text) { return; }
        tasks.push({
            id: Date.now() + Math.floor(Math.random() * 1000),
            text: text,
            done: false
        });
        $input.val("");
        saveTasks();
        renderList();
    }

    // Add task via + button
    $addBtn.on("click", addTask);

    // Add task via Enter key
    $input.on("keydown", function (e) {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            addTask();
        }
    });

    // Click on a task -> toggle strike-through.
    // Click on the delete button -> remove the task.
    $list.on("click", ".td-item", function (e) {
        const $li = $(this);
        const id  = Number($li.attr("data-id"));

        if ($(e.target).hasClass("td-delete")) {
            tasks = tasks.filter(function (t) { return t.id !== id; });
            saveTasks();
            renderList();
            return;
        }

        // Toggle done state for this task
        tasks.forEach(function (t) {
            if (t.id === id) { t.done = !t.done; }
        });
        saveTasks();
        renderList();
    });

    // ---------- Toolbar button ----------

    // Build the toolbar button: a chevron-down arrow icon.
    // Phoenix's right-side icon strip is #main-toolbar.
    const $toolbarBtn = $(
        '<a href="#" id="td-toolbar-btn" title="To-Do list">' +
            '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" ' +
                'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
                '<path d="M5 8 L10 13 L15 8" stroke="currentColor" ' +
                    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
            '</svg>' +
        '</a>'
    );

    function positionPanel() {
        // Position the dropdown near the toolbar button.
        // #main-toolbar lives on the right edge of the window in Phoenix,
        // so we anchor the panel to the LEFT of the button.
        const btn = $toolbarBtn.get(0);
        if (!btn) { return; }
        const rect  = btn.getBoundingClientRect();
        const pw    = 280; // panel width (keep in sync with CSS)
        const gap   = 8;
        let left    = rect.left - pw - gap;
        let top     = rect.top;

        // If the button is on the LEFT side of the screen (e.g. menu bar
        // fallback), open the panel BELOW it instead of to the left.
        if (left < 8) {
            left = Math.max(8, rect.left);
            top  = rect.bottom + gap;
        }

        // Keep the panel inside the viewport.
        const vh = window.innerHeight;
        const ph = $panel.outerHeight() || 300;
        if (top + ph > vh - 8) { top = Math.max(8, vh - ph - 8); }

        $panel.css({ left: left + "px", top: top + "px" });
    }

    function openPanel() {
        $panel.show();
        positionPanel();
        renderList();
        setTimeout(function () { $input.trigger("focus"); }, 0);
    }

    function closePanel() {
        $panel.hide();
    }

    function togglePanel() {
        if ($panel.is(":visible")) {
            closePanel();
        } else {
            openPanel();
        }
    }

    $toolbarBtn.on("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
    });

    // Click anywhere outside the panel or the button -> close.
    $(document).on("mousedown", function (e) {
        if (!$panel.is(":visible")) { return; }
        if ($(e.target).closest("#td-dropdown, #td-toolbar-btn").length) { return; }
        closePanel();
    });

    // Reposition on window resize while open.
    $(window).on("resize", function () {
        if ($panel.is(":visible")) { positionPanel(); }
    });

    // ---------- Mount the button ----------

    // Try to put the button on Phoenix's right-side icon toolbar
    // (#main-toolbar). If that's not available for some reason, fall back
    // to adding a menu entry under View > Toggle To-Do.
    AppInit.appReady(function () {
        const $mainToolbar = $("#main-toolbar");
        if ($mainToolbar.length) {
            // The toolbar has a top icon group and a bottom icon group in
            // Phoenix. Prefer the top group so the button sits with the
            // other extension icons.
            const $iconGroup = $mainToolbar.find(".buttons").first();
            if ($iconGroup.length) {
                $iconGroup.append($toolbarBtn);
            } else {
                $mainToolbar.append($toolbarBtn);
            }
        }

        // Always also register a View-menu command so the user can find it
        // even if the toolbar layout changes.
        const TOGGLE_CMD_ID = "todoDropdown.toggle";
        CommandManager.register("Toggle To-Do List", TOGGLE_CMD_ID, togglePanel);
        const viewMenu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        if (viewMenu) { viewMenu.addMenuItem(TOGGLE_CMD_ID); }

        // Initial render so the list is ready when the user opens it.
        renderList();

        console.log("Todo dropdown extension ready.");
    });
});
