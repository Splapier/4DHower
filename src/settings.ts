import { App, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type EisenhowerPlugin from './main';

interface DirSuggestion {
	path: string;
	kind: 'folder' | 'file';
}

export interface EisenhowerSettings {
	taskDirectories: string[];
	defaultTaskFile: string;
	includeSubdirectories: boolean;
}

export const DEFAULT_SETTINGS: EisenhowerSettings = {
	taskDirectories: [],
	defaultTaskFile: 'Inbox.md',
	includeSubdirectories: true,
};

export class EisenhowerSettingTab extends PluginSettingTab {
	plugin: EisenhowerPlugin;

	constructor(app: App, plugin: EisenhowerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl, app } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: 'Tasks are markdown checkboxes inside your notes. Move them between quadrants, ' +
				'complete them, and use "Complete the day" to file unfinished work into the inbox.',
		});

		// --- Task directories -------------------------------------------------
		const dirsSetting = new Setting(containerEl)
			.setName('Task directories')
			.setDesc(
				'Folders or individual files to scan for tasks, in addition to the default task file. Start typing to search.',
			);
		const dirsList = dirsSetting.settingEl.createDiv({
			cls: 'eisenhower-settings-dirs',
		});
		this.renderDirList(dirsList);

		const addRow = dirsSetting.settingEl.createDiv({
			cls: 'eisenhower-settings-addrow',
		});
		const inputWrap = addRow.createDiv({ cls: 'eisenhower-suggest-wrap' });
		const dirInput = inputWrap.createEl('input', {
			type: 'text',
			attr: { placeholder: 'Type a folder or file path…' },
		});
		const dropdown = inputWrap.createDiv({ cls: 'eisenhower-suggest' });
		dropdown.hide();
		const addBtn = addRow.createEl('button', { cls: 'mod-cta', attr: { type: 'button' } });
		addBtn.setText('Add');

		let current: DirSuggestion[] = [];
		let highlight = -1;

		const rankMatch = (path: string, q: string): number => {
			if (q === '') return 0;
			const lower = path.toLowerCase();
			if (lower === q) return 1;
			if (lower.startsWith(q)) return 2;
			if (lower.split('/').some((seg) => seg.startsWith(q))) return 3;
			return 4;
		};

		const computeSuggestions = (query: string): DirSuggestion[] => {
			const q = query.trim().toLowerCase();
			const byRank = (a: string, b: string): number => {
				const ra = rankMatch(a, q);
				const rb = rankMatch(b, q);
				return ra !== rb ? ra - rb : a < b ? -1 : 1;
			};
			const folders = app.vault
				.getAllFolders(false)
				.map((f) => f.path)
				.filter((p) => q === '' || p.toLowerCase().includes(q))
				.sort(byRank);
			const files =
				q === ''
					? []
					: app.vault
						.getMarkdownFiles()
						.map((f) => f.path)
						.filter((p) => p.toLowerCase().includes(q))
						.sort(byRank);
			const out: DirSuggestion[] = [];
			for (const p of folders) out.push({ path: p, kind: 'folder' });
			for (const p of files) out.push({ path: p, kind: 'file' });
			return out.slice(0, 80);
		};

		const updateHighlight = (): void => {
			const items = dropdown.querySelectorAll<HTMLElement>(
				'.eisenhower-suggest-item',
			);
			items.forEach((el, i) => {
				el.toggleClass('is-selected', i === highlight);
			});
			const sel = dropdown.querySelector<HTMLElement>(
				'.eisenhower-suggest-item.is-selected',
			);
			if (sel) sel.scrollIntoView({ block: 'nearest' });
		};

		const renderDropdown = (): void => {
			dropdown.empty();
			if (current.length === 0) {
				dropdown.hide();
				return;
			}
			dropdown.show();
			const added = new Set(this.plugin.settings.taskDirectories);
			for (let i = 0; i < current.length; i++) {
				const s = current[i];
				if (!s) continue;
				const isAdded = added.has(s.path);
				const item = dropdown.createDiv({ cls: 'eisenhower-suggest-item' });
				if (isAdded) item.addClass('is-added');
				const iconEl = item.createSpan({ cls: 'eisenhower-suggest-icon' });
				setIcon(iconEl, s.kind === 'folder' ? 'folder' : 'file-text');
				item.createSpan({ text: s.path, cls: 'eisenhower-suggest-text' });
				if (isAdded) {
					item.createSpan({ text: 'added', cls: 'eisenhower-suggest-tag' });
				}
				item.addEventListener('mousedown', (evt: MouseEvent) => {
					evt.preventDefault();
					addPath(s.path);
				});
				item.addEventListener('mouseenter', () => {
					if (highlight !== i) {
						highlight = i;
						updateHighlight();
					}
				});
			}
			updateHighlight();
		};

		const refresh = (): void => {
			current = computeSuggestions(dirInput.value);
			highlight = current.length > 0 ? 0 : -1;
			renderDropdown();
		};

		const addPath = (raw: string): void => {
			const path = raw.trim();
			if (!path) return;
			const settings = this.plugin.settings;
			if (settings.taskDirectories.includes(path)) {
				new Notice('Already listed.', 3000);
				return;
			}
			if (path.endsWith('.md')) {
				if (!app.vault.getFileByPath(path)) {
					new Notice(`File not found: ${path}`, 5000);
					return;
				}
			} else if (!app.vault.getFolderByPath(path)) {
				new Notice(`Folder not found: ${path}`, 5000);
				return;
			}
			settings.taskDirectories.push(path);
			dirInput.value = '';
			current = [];
			highlight = -1;
			dropdown.hide();
			void this.plugin.onSettingsChanged();
			this.renderDirList(dirsList);
		};

		addBtn.addEventListener('click', () => {
			addPath(dirInput.value);
		});
		dirInput.addEventListener('input', () => {
			refresh();
		});
		dirInput.addEventListener('focus', () => {
			refresh();
		});
		dirInput.addEventListener('blur', () => {
			window.setTimeout(() => dropdown.hide(), 150);
		});
		dirInput.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'ArrowDown') {
				evt.preventDefault();
				if (current.length === 0) return;
				highlight =
					highlight === -1 ? 0 : (highlight + 1) % current.length;
				updateHighlight();
			} else if (evt.key === 'ArrowUp') {
				evt.preventDefault();
				if (current.length === 0) return;
				highlight =
					highlight === -1
						? current.length - 1
						: (highlight - 1 + current.length) % current.length;
				updateHighlight();
			} else if (evt.key === 'Enter') {
				evt.preventDefault();
				const highlighted =
					highlight !== -1 && highlight < current.length
						? current[highlight]
						: undefined;
				addPath(highlighted ? highlighted.path : dirInput.value);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				dropdown.hide();
			}
		});

		// --- Include subdirectories -------------------------------------------
		new Setting(containerEl)
			.setName('Include subdirectories')
			.setDesc('Also scan folders nested inside the task directories.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeSubdirectories)
					.onChange((value) => {
						this.plugin.settings.includeSubdirectories = value;
						void this.plugin.onSettingsChanged();
					});
			});

		// --- Default task file ------------------------------------------------
		new Setting(containerEl)
			.setName('Default task file')
			.setDesc(
				'File used when adding a new task from the matrix. Created automatically if it does not exist.',
			)
			.addText((text) => {
				text
					.setValue(this.plugin.settings.defaultTaskFile)
					.setPlaceholder('Inbox.md')
					.onChange((value) => {
						this.plugin.settings.defaultTaskFile = value.trim();
						void this.plugin.onSettingsChanged();
					});
			});
	}

	private renderDirList(listEl: HTMLElement): void {
		listEl.empty();
		const dirs = this.plugin.settings.taskDirectories;
		if (dirs.length === 0) {
			listEl.createDiv({
				cls: 'eisenhower-settings-empty',
				text: 'Nothing selected — only the default task file is scanned.',
			});
			return;
		}
		for (const dir of dirs) {
			const isFile = dir.endsWith('.md');
			const row = listEl.createDiv({ cls: 'eisenhower-settings-dirrow' });
			const iconEl = row.createSpan({ cls: 'eisenhower-settings-diricon' });
			setIcon(iconEl, isFile ? 'file-text' : 'folder');
			row.createSpan({ text: dir, cls: 'eisenhower-settings-dir' });
			const removeBtn = row.createEl('button', {
				cls: 'eisenhower-settings-remove',
				attr: { 'aria-label': `Remove ${dir}`, type: 'button' },
			});
			setIconBtn(removeBtn);
			removeBtn.addEventListener('click', () => {
				this.plugin.settings.taskDirectories = dirs.filter((d) => d !== dir);
				void this.plugin.onSettingsChanged();
				this.renderDirList(listEl);
			});
		}
	}
}

function setIconBtn(el: HTMLElement): void {
	el.addClass('clickable-icon');
	el.createSpan({ text: '×', cls: 'eisenhower-settings-remove-x' });
}
