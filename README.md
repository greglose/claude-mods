# Claude mods

Mods for Claude Code. Each one lives in its own folder under `mods/`.

## active-chats

A pane beside the chat that lists your Claude Code desktop chats:

- Sections for chats that need you, chats active now, and every project with its quiet chats inside.
- Last activity, project, PR, and context used.
- Badges for uncommitted files and unmerged commits.
- An expandable "What is running" section showing agents and recent tools.
- An animated character for each chat.

Sections and projects collapse, and a search box filters by chat title or project. Scheduled chats are hidden. A toggle adds archived chats.

### Install

At the prompt of a terminal session:

```
/plugin install active-chats --marketplace greglose/claude-mods
```

Press `y` to add the marketplace, then choose a scope.

From a shell:

```bash
claude plugin install active-chats --marketplace greglose/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `greglose/claude-mods`, then Add plugin.

### Good to know

- It needs the Claude Code desktop app on a Mac. The chat list comes from the app's session tools, clicking a title uses the Mac `open` command, and the agent list reads the app's local session files. An app update can break the agent list.
- "Waiting for you" is an estimate from the end of each chat's transcript, so it can miss a chat or flag one wrongly.
- It reads the app's local session records to list every non-scheduled chat. If an app update changes those records, it falls back to the newest 100 chats.
- It reads your chat transcripts, session files, and git folders on your own computer. It sends none of that anywhere.
