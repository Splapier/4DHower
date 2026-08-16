import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type EisenhowerPlugin from './main';

export interface EisenhowerSettings {
	taskDirectories: string[];
	defaultTaskFile: string;
}

export const DEFAULT_SETTINGS: EisenhowerSettings = {
	taskDirectories: [],
	defaultTaskFile: 'Inbox.md',
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
				'Folders to scan for tasks. Leave the list empty to scan the whole vault.',
			);
		const dirsList = dirsSetting.settingEl.createDiv({
			cls: 'eisenhower-settings-dirs',
		});
		this.renderDirList(dirsList);

		const addRow = dirsSetting.settingEl.createDiv({
			cls: 'eisenhower-settings-addrow',
		});
		const dirInput = addRow.createEl('input', {
			type: 'text',
			attr: { placeholder: 'Folder path, e.g. notes/tasks' },
		});
		const addBtn = addRow.createEl('button', { cls: 'mod-cta', attr: { type: 'button' } });
		addBtn.setText('Add');

		const addDir = (raw: string): void => {
			const dir = raw.trim();
			if (!dir) return;
			const folder = app.vault.getFolderByPath(dir);
			if (!folder) {
				new Notice(`Folder not found: ${dir}`, 5000);
				return;
			}
			if (this.plugin.settings.taskDirectories.includes(folder.path)) {
				new Notice('Folder already listed.', 3000);
				return;
			}
			this.plugin.settings.taskDirectories.push(folder.path);
			void this.plugin.onSettingsChanged();
			this.renderDirList(dirsList);
		};

		addBtn.addEventListener('click', () => {
			addDir(dirInput.value);
		});
		dirInput.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Enter') addDir(dirInput.value);
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
				text: 'No folders selected — the whole vault is scanned.',
			});
			return;
		}
		for (const dir of dirs) {
			const row = listEl.createDiv({ cls: 'eisenhower-settings-dirrow' });
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
