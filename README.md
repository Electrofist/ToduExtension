# todu

A Notion-style to-do dropdown for [Phoenix Code](https://phcode.dev). Per-project tasks, due dates, priority, tags, subtasks — and an auto-scanner that surfaces `// TODO` / `// FIXME` comments from anywhere in your project.

> Designed for people who think in lists *and* in code.

---

## Why

Every code editor has a to-do extension. Most of them are notepads with checkboxes. **todu** is built around two ideas that only make sense inside a code editor:

1. **Your tasks live with your project.** Open a project — see that project's todos. Switch projects — switch lists. There's also a Global tab for cross-project items.
2. **Your code already has todos in it.** `// TODO:` comments scattered across your codebase get surfaced automatically and become clickable jumps back to the exact line.

Everything else — due dates, priority, tags, subtasks — is the polish on top.

---

## Features

### Tasks
- **Add tasks fast** with the input + `+` (or Enter)
- **Click to complete** with a smooth strike-through
- **Inline `#tags`** — type `Fix login #bug #urgent` and tags are auto-extracted and color-coded
- **Priority dot** on the left of each row — click to cycle (none → high → medium → low)
- **Due dates** via quick presets (Today / Tomorrow / This weekend / Next week) — chips color-code overdue / today / soon
- **Subtasks** with collapsible progress (e.g. "2/4"). When all subtasks are done, the parent gets a subtle "ready to complete" glow — without auto-checking, so you stay in control.

### Code-aware
- **Right-click any line in the editor → "Add line to To-Do"** — captures the line as a task with a `file:line` chip
- **Click the chip** → editor jumps back to that exact file and line
- **Auto-scanner** finds `// TODO:`, `// FIXME:`, `// HACK:`, `// XXX:`, `// BUG:`, `// NOTE:` across your entire project (also supports `#` and `<!-- -->` styles)
- Found items appear in a separate "From code" section, color-coded by type
- **Dismiss what's no longer relevant** — checkbox marks a scanned TODO as ignored; it stays dismissed unless the underlying comment changes

### Organization
- **Per-project + Global tabs** with pending counts
- **Completed section** that collapses out of the way
- **Sort by** date added / alphabetical / due date / priority
- **Clear completed** in one click

### Polish
- **Light + dark theme** awareness — auto-matches your Phoenix theme
- **Soft Notion-style visuals** — airy spacing, subtle shadows, rounded corners
- **Overdue badge** on the toolbar icon — quiet by default, appears only when something needs attention

---

## Install

### From the Extension Manager (recommended)
1. Open Phoenix Code
2. **File → Extension Manager** (or the puzzle-piece icon in the toolbar)
3. **Available** tab → search **"todu"**
4. Click **Install**

The checked-box icon will appear in the right-side toolbar. Click it to open the panel.

### Manual install (for hacking / pre-release)
1. Download or clone this repo
2. In Phoenix Code: **Debug → Load Project As Extension** → pick the folder

---

## Usage

| Action | How |
|---|---|
| **Add a task** | Type in the input + press Enter or click + |
| **Add a `#tag`** | Type `#tag` anywhere in the task text — auto-styled |
| **Mark done** | Click the checkbox or anywhere on the row |
| **Set priority** | Click the small dot on the left to cycle |
| **Set due date** | Click the calendar icon → pick a preset |
| **Add a subtask** | Hover a task → "+ Subtask" → type, press Enter |
| **Delete** | Hover → click the trash icon (or Backspace when focused) |
| **Pin a code line as a task** | Right-click any line in the editor → "Add line to To-Do" |
| **Jump to source** | Click the `file:line` chip on any task |
| **Switch projects** | The "This project" tab auto-swaps when you switch project folders |
| **Sort / clear completed** | The `⋯` menu in the panel header |
| **Toggle the code scanner** | `⋯` menu → "Scan code for TODOs" |

---

## Storage

All tasks are saved to Phoenix's preferences system. Project tasks are keyed by project path; global tasks are in a separate scope. No external servers, no accounts, no sync — yet.

---

## Roadmap

Possible additions, not promises:

- **Edit tasks in place** (double-click)
- **Drag to reorder**
- **Reminders** with notifications (time-based)
- **Recurring tasks** (daily / weekly)
- **Import / export** JSON
- **Completion stats** ("12 done this week")

Open an issue if any of these would matter to your workflow — it helps me prioritize.

---

## Development

```bash
git clone https://github.com/Electrofist/ToduExtension
```

Open the folder in [create.phcode.dev](https://create.phcode.dev) (the dev build of Phoenix Code that serves non-minified source for easier debugging), then:

1. **Debug → Load Project As Extension**
2. Make changes, save
3. **Debug → Reload With Extensions**

If anything breaks Phoenix itself: **Debug → Reload Without Extensions** is your escape hatch.

---

## License

MIT — do whatever you want, just don't blame me.

---

## Author

Built by **Krrish** ([@Electrofist](https://github.com/Electrofist)) — a UX designer learning to ship code.

If todu makes a small dent in your day, that's the point. Tell me what's missing and I'll see what I can do.
