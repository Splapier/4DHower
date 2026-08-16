import {
	App,
	DropdownComponent,
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	Setting,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import { BUCKET_DEFS, GRID_BUCKETS, BUCKETS, bucketOf } from './model';
import type { Bucket, MatrixState, ParsedTask } from './model';
import type EisenhowerPlugin from './main';

function fileBaseName(path: string): string {
	const last = path.split('/').pop();
	return last ?? path;
}

function getDragAfterElement(
	container: HTMLElement,
	y: number,
): HTMLElement | null {
	const rows = Array.from(
		container.querySelectorAll<HTMLElement>('.eisenhower-row:not(.dragging)'),
	);
	let closest: { offset: number; el: HTMLElement } | null = null;
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		if (rect.height === 0) continue;
		const offset = y - rect.top - rect.height / 2;
		if (offset < 0 && (closest === null || offset > closest.offset)) {
			closest = { offset, el: row };
		}
	}
	return closest !== null ? closest.el : null;
}

export class EisenhowerMatrixView extends ItemView {
	static readonly VIEW_TYPE = 'eisenhower-matrix';

	plugin: EisenhowerPlugin;
	filter: string | null = null;
	containers: Partial<Record<Bucket, HTMLElement>> = {};
	filterRow: HTMLElement | null = null;
	filterDropdown: DropdownComponent | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: EisenhowerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return EisenhowerMatrixView.VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Eisenhower Matrix';
	}

	getIcon(): string {
		return 'layout-grid';
	}

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass('eisenhower-view');

		const header = el.createDiv({ cls: 'eisenhower-header' });
		header.createEl('h2', { text: 'Eisenhower Matrix', cls: 'eisenhower-title' });

		const actions = header.createDiv({ cls: 'eisenhower-actions' });
		const newBtn = actions.createEl('button', {
			cls: 'eisenhower-btn',
			attr: { type: 'button' },
		});
		setIcon(newBtn, 'plus');
		newBtn.createSpan({ text: 'New task' });
		this.registerDomEvent(newBtn, 'click', () => {
			new AddTaskModal(this.app, this.plugin).open();
		});

		const completeBtn = actions.createEl('button', {
			cls: 'eisenhower-btn eisenhower-btn-complete',
			attr: { type: 'button' },
		});
		setIcon(completeBtn, 'check');
		completeBtn.createSpan({ text: 'Complete the day' });
		this.registerDomEvent(completeBtn, 'click', () => {
			this.confirmCompleteDay();
		});

		const filterRow = el.createDiv({ cls: 'eisenhower-filterrow' });
		this.filterRow = filterRow;

		const grid = el.createDiv({ cls: 'eisenhower-grid' });
		for (const bucket of GRID_BUCKETS) {
			grid.appendChild(this.createBucketBox(bucket));
		}

		el.appendChild(this.createBucketBox('inbox'));

		const unsubscribe = this.plugin.subscribe((state: MatrixState) => {
			this.render(state);
		});
		this.register(unsubscribe);

		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private createBucketBox(bucket: Bucket): HTMLElement {
		const def = BUCKET_DEFS[bucket];
		const box = this.contentEl.createDiv({
			cls: [
				'eisenhower-quadrant',
				'eisenhower-dropzone',
				bucket === 'inbox' ? 'eisenhower-inbox' : '',
			]
				.filter((c) => c.length > 0)
				.join(' '),
			attr: { 'data-bucket': bucket },
		});
		const head = box.createDiv({ cls: 'eisenhower-qhead' });
		const iconEl = head.createSpan({ cls: 'eisenhower-qicon' });
		setIcon(iconEl, def.icon);
		head.createSpan({ text: def.title, cls: 'eisenhower-qtitle' });
		head.createSpan({ text: def.subtitle, cls: 'eisenhower-qsub' });
		if (bucket === 'inbox') {
			const plus = head.createEl('button', {
				cls: 'eisenhower-plus',
				attr: { 'aria-label': 'New task', type: 'button' },
			});
			setIcon(plus, 'plus');
			this.registerDomEvent(plus, 'click', () => {
				new AddTaskModal(this.app, this.plugin).open();
			});
		}
		const body = box.createDiv({ cls: 'eisenhower-body' });
		this.containers[bucket] = body;
		this.registerDnDHandlers(body, bucket);
		return box;
	}

	// --- Drag & drop ----------------------------------------------------------
	private registerDnDHandlers(body: HTMLElement, bucket: Bucket): void {
		this.registerDomEvent(body, 'dragover', (evt: DragEvent) => {
			evt.preventDefault();
			if (evt.dataTransfer) {
				evt.dataTransfer.dropEffect = 'move';
			}
			body.addClass('drag-over');
		});
		this.registerDomEvent(body, 'dragleave', () => {
			body.removeClass('drag-over');
		});
		this.registerDomEvent(body, 'drop', async (evt: DragEvent) => {
			evt.preventDefault();
			body.removeClass('drag-over');
			const id = evt.dataTransfer?.getData('application/x-eisenhower-task');
			if (!id) return;
			const afterEl = getDragAfterElement(body, evt.clientY);
			const order = (this.plugin.state.bucketOrder[bucket] ?? []).filter(
				(x) => x !== id,
			);
			let index = order.length;
			if (afterEl !== null && afterEl.dataset.id) {
				const i = order.indexOf(afterEl.dataset.id);
				if (i >= 0) index = i;
			}
			await this.plugin.moveTask(id, bucket, index);
		});
	}

	// --- Rendering ------------------------------------------------------------
	private renderFilter(): void {
		const filterRow = this.filterRow;
		if (!filterRow) return;
		filterRow.empty();
		this.filterDropdown = null;
		new Setting(filterRow)
			.setName('Filter')
			.setDesc('Show tasks from one file.')
			.addDropdown((dd) => {
				this.filterDropdown = dd;
				dd.addOption('', 'All files');
				const files = Array.from(
					new Set(this.plugin.tasks.map((t) => t.file)),
				).sort();
				for (const f of files) dd.addOption(f, f);
				dd.setValue(this.filter ?? '');
				dd.onChange((value) => {
					this.filter = value === '' ? null : value;
					this.render();
				});
			});
	}

	render(state?: MatrixState): void {
		const st = state ?? this.plugin.state;
		this.renderFilter();
		const byId = new Map(this.plugin.tasks.map((t) => [t.id, t]));
		const filter = this.filter;
		for (const bucket of BUCKETS) {
			const body = this.containers[bucket];
			if (!body) continue;
			body.empty();
			const shown: ParsedTask[] = [];
			for (const id of st.bucketOrder[bucket] ?? []) {
				if (st.clearedIds.includes(id)) continue;
				const t = byId.get(id);
				if (!t) continue;
				if (filter !== null && t.file !== filter) continue;
				shown.push(t);
			}
			if (shown.length === 0) {
				body.createDiv({ cls: 'eisenhower-empty', text: 'No tasks' });
			}
			for (const t of shown) body.appendChild(this.createRow(body, t));
		}
	}

	private createRow(parent: HTMLElement, t: ParsedTask): HTMLElement {
		const row = parent.createDiv({
			cls: 'eisenhower-row',
			attr: { draggable: 'true' },
		});
		row.dataset.id = t.id;

		const check = row.createEl('input', {
			cls: 'eisenhower-check',
			type: 'checkbox',
		});
		check.checked = t.completed;
		this.registerDomEvent(check, 'change', () => {
			void this.plugin.toggleTask(t);
		});

		const titleEl = row.createSpan({ cls: 'eisenhower-rowtitle' });
		MarkdownRenderer.render(this.app, t.title, titleEl, t.file, this		).catch(
			(err: unknown) => {
				titleEl.setText(t.title);
				console.error('eisenhower: failed to render task title', err);
			},
		);

		const badge = row.createEl('button', {
			cls: 'eisenhower-badge',
			attr: {
				'aria-label': `Open ${t.file}`,
				title: t.file,
				type: 'button',
			},
		});
		setIcon(badge, 'file-text');
		badge.createSpan({
			text: fileBaseName(t.file),
			cls: 'eisenhower-badge-text',
		});
		this.registerDomEvent(badge, 'click', async () => {
			const file = this.app.vault.getFileByPath(t.file);
			if (file) {
				await this.app.workspace.getLeaf(true).openFile(file);
			} else {
				new Notice(`File not found: ${t.file}`, 5000);
			}
		});

		const more = row.createEl('button', {
			cls: 'eisenhower-more',
			attr: { 'aria-label': 'Task actions', type: 'button' },
		});
		setIcon(more, 'more-vertical');
		this.registerDomEvent(more, 'click', (evt: MouseEvent) => {
			this.showTaskMenu(evt, t);
		});

		this.registerDomEvent(row, 'dragstart', (evt: DragEvent) => {
			if (evt.dataTransfer) {
				evt.dataTransfer.setData('application/x-eisenhower-task', t.id);
				evt.dataTransfer.effectAllowed = 'move';
			}
			window.setTimeout(() => row.addClass('dragging'), 0);
		});
		this.registerDomEvent(row, 'dragend', () => {
			row.removeClass('dragging');
		});

		return row;
	}

	// --- Task menu -------------------------------------------------------------
	private showTaskMenu(evt: MouseEvent, t: ParsedTask): void {
		const state = this.plugin.state;
		const current = bucketOf(state, t.id);
		const menu = new Menu();

		if (current !== null) {
			const order = state.bucketOrder[current] ?? [];
			const index = order.indexOf(t.id);
			menu.addItem((item) =>
				item
					.setTitle('Move up')
					.setIcon('arrow-up')
					.setDisabled(index <= 0)
					.onClick(() => {
						void this.plugin.moveTask(
							t.id,
							current,
							Math.max(0, index - 1),
						);
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle('Move down')
					.setIcon('arrow-down')
					.setDisabled(index < 0 || index >= order.length - 1)
					.onClick(() => {
						void this.plugin.moveTask(
							t.id,
							current,
							Math.min(order.length - 1, index + 1),
						);
					}),
			);
			menu.addSeparator();
		}

		for (const other of BUCKETS) {
			if (other === current) continue;
			menu.addItem((item) =>
				item
					.setTitle(`Move to ${BUCKET_DEFS[other].title}`)
					.setIcon(BUCKET_DEFS[other].icon)
					.onClick(() => {
						const len = (this.plugin.state.bucketOrder[other] ?? []).length;
						void this.plugin.moveTask(t.id, other, len);
					}),
			);
		}

		menu.showAtMouseEvent(evt);
	}

	// --- Complete the day -------------------------------------------------------
	private confirmCompleteDay(): void {
		const unfinished = this.plugin.tasks.filter((t) => !t.completed).length;
		const message =
			unfinished === 0
				? 'All tasks are already complete. Archive everything?'
				: `${unfinished} unfinished task${unfinished === 1 ? '' : 's'} will move to the inbox and completed tasks will be archived. Continue?`;
		new ConfirmationModal(this.app, message, () => this.plugin.completeTheDay()).open();
	}
}

export class AddTaskModal extends Modal {
	plugin: EisenhowerPlugin;
	taskInputEl: HTMLInputElement | null = null;
	file: string;

	constructor(app: App, plugin: EisenhowerPlugin) {
		super(app);
		this.plugin = plugin;
		this.file = plugin.settings.defaultTaskFile;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'New task' });

		const input = contentEl.createEl('input', {
			cls: 'eisenhower-modal-input',
			type: 'text',
			placeholder: 'Task title (markdown links allowed)',
		});
		this.taskInputEl = input;
		input.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Enter') void this.submit();
		});

		new Setting(contentEl)
			.setName('File')
			.setDesc('Where the task will be stored in your vault.')
			.addDropdown((dd) => {
				const files = this.app.vault
					.getMarkdownFiles()
					.map((f) => f.path)
					.sort((a, b) => (a < b ? -1 : 1));
				for (const p of files) dd.addOption(p, p);
				if (files.indexOf(this.file) === -1) {
					dd.addOption(this.file, this.file);
				}
				dd.setValue(this.file);
				dd.onChange((value) => {
					this.file = value;
				});
			});

		const actions = contentEl.createDiv({ cls: 'eisenhower-modal-actions' });
		const cancelBtn = actions.createEl('button', { attr: { type: 'button' } });
		cancelBtn.setText('Cancel');
		cancelBtn.addEventListener('click', () => this.close());

		const addBtn = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { type: 'button' },
		});
		addBtn.setText('Add task');
		addBtn.addEventListener('click', () => void this.submit());

		input.focus();
	}

	async submit(): Promise<void> {
		const title = (this.taskInputEl?.value ?? '').trim();
		if (!title) {
			new Notice('Enter a task title first.', 4000);
			return;
		}
		try {
			await this.plugin.addTask(title, this.file);
			this.close();
		} catch (err) {
			new Notice(
				err instanceof Error ? err.message : 'Failed to add task.',
				6000,
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmationModal extends Modal {
	private message: string;
	private onConfirm: () => unknown;

	constructor(
		app: App,
		message: string,
		onConfirm: () => unknown,
	) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('p', { text: this.message });
		const actions = contentEl.createDiv({ cls: 'eisenhower-modal-actions' });
		const cancelBtn = actions.createEl('button', { attr: { type: 'button' } });
		cancelBtn.setText('Cancel');
		cancelBtn.addEventListener('click', () => this.close());
		const okBtn = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { type: 'button' },
		});
		okBtn.setText('Confirm');
		okBtn.addEventListener('click', () => {
			void Promise.resolve(this.onConfirm()).finally(() => this.close());
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
