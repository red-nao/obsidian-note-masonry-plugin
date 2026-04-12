# Note Masonry for Obsidian
Note Masonry is an Obsidian plugin that shows your notes in a **Google Keep–style card grid**. It’s ideal for quick browsing of many small memos or snippets. It is not optimized for mobile use; it’s mainly intended for desktop.

![screenshot](.readme-images/screenshot01.png)
![screenshot](.readme-images/screenshot02.png)

## Features
- Card-based, masonry-style grid of all your Markdown notes
- Filter by folder and tag from a toolbar at the top
- Pinned section for notes with `pinned: true` in frontmatter
- Up to 2 image thumbnails per note (Markdown images or wikilinks)
- Text snippet preview with frontmatter and image markup removed
- Pin/unpin, delete and split-view buttons directly on each card
- Large editor modal when you click a card or create a new note
- Auto-refresh on create/modify/delete/rename and metadata changes
- Multiple Keep View tabs can be opened from the ribbon button

## Installation
1. Put the built plugin files into your vault, e.g. `.obsidian/plugins/note-masonry`:
	- `main.js`
	- `manifest.json`
	- `styles.css`
2. In Obsidian, open **Settings → Community plugins → Installed plugins**.
3. Enable **Note Masonry**.

## Usage
- Use the **grid icon** in the left ribbon to open Keep View.
- You can click the ribbon button multiple times to open multiple Keep View tabs/pages.
- Use the folder and tag dropdowns to filter notes.
- Click the **“+” button** to create a new note in a modal editor.
- Click a card to open it in the modal.
- Use the **pin icon** to toggle `pinned: true` in frontmatter.
- Use the **split pane icon** on a card to open the note in a right split view
- Use the **trash icon** to delete the note.

## Known Limitations
- **Hotkeys in the Modal:** Standard Obsidian hotkeys (e.g., opening the Command Palette, text formatting shortcuts) do not work when editing a note inside the pop-up modal. This is due to an architectural limitation in Obsidian: the editor inside the modal is technically "detached" from the main workspace, so Obsidian does not recognize it as the active target for commands.
  - **Workaround:** If you want to perform heavy editing or use your custom hotkeys, click the **split pane icon** on the card instead. This opens the note in a standard Obsidian split view where all hotkeys function perfectly.
- **Mobile Support:** The layout and interactions are designed for desktop; mobile usage is not optimized.