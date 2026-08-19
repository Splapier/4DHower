import {
	App,
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	Setting,
	SuggestModal,
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
	draggedRow?: HTMLElement | null,
): HTMLElement | null {
	const rows = Array.from(
		container.querySelectorAll<HTMLElement>('.eisenhower-row'),
	).filter((r) => r !== draggedRow);
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
	filter: string[] = [];
	inboxQuery: string = '';
	filterQuery: string = '';
	containers: Partial<Record<Bucket, HTMLElement>> = {};
	filterRow: HTMLElement | null = null;
	private drag: { id: string; row: HTMLElement } | null = null;
	private dropHandled = false;
	private dragFrame: number | null = null;
	private pendingDrag: { body: HTMLElement; y: number } | null = null;
	private rows = new Map<string, HTMLElement>();
	private rowParts = new Map<string, { check: HTMLInputElement; title: HTMLElement }>();
	private lastFilterKey: string | null = null;
	private filterChips = new Map<string, HTMLElement>();
	private filterChipsEl: HTMLElement | null = null;
	private filterNoMatchEl: HTMLElement | null = null;
	private lastFilesKey: string | null = null;
	private dragStartTick = 0;

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
		this.rows.clear();
		this.rowParts.clear();
		this.lastFilterKey = null;
		this.drag = null;
		this.dragStartTick = 0;
		this.inboxQuery = '';
		this.filterQuery = '';
		this.filterChips.clear();
		this.filterChipsEl = null;
		this.filterNoMatchEl = null;
		this.lastFilesKey = null;
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
		this.cancelDragFrame();
		this.drag = null;
		this.dragStartTick = 0;
		this.rows.clear();
		this.rowParts.clear();
		this.filterChips.clear();
		this.filterChipsEl = null;
		this.filterNoMatchEl = null;
		this.lastFilesKey = null;
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
			const searchbar = box.createDiv({ cls: 'eisenhower-inboxsearchbar' });
			const search = searchbar.createEl('input', {
				cls: 'eisenhower-inboxsearch',
				type: 'text',
				placeholder: 'Search inbox',
				attr: { 'aria-label': 'Search inbox' },
			});
			search.value = this.inboxQuery;
			this.registerDomEvent(search, 'input', () => {
				this.inboxQuery = search.value;
				this.applyInboxFilter();
			});
		}
		const body = box.createDiv({ cls: 'eisenhower-body' });
		this.containers[bucket] = body;
		this.registerDnDHandlers(box, body, bucket);
		return box;
	}

	// --- Drag & drop ----------------------------------------------------------
	private registerDnDHandlers(
		box: HTMLElement,
		body: HTMLElement,
		bucket: Bucket,
	): void {
		this.registerDomEvent(box, 'dragover', (evt: DragEvent) => {
			const drag = this.drag;
			if (!drag) return;
			evt.preventDefault();
			if (evt.dataTransfer) {
				evt.dataTransfer.dropEffect = 'move';
			}
			this.pendingDrag = { body, y: evt.clientY };
			if (this.dragFrame === null) {
				this.dragFrame = window.requestAnimationFrame(() => {
					this.dragFrame = null;
					const pending = this.pendingDrag;
					const d = this.drag;
					this.pendingDrag = null;
					if (pending === null || d === null) return;
					if (this.dragStartTick === 0) return;
					this.placeDragRow(pending.body, d.row, pending.y);
				});
			}
		});
		this.registerDomEvent(box, 'drop', (evt: DragEvent) => {
			const drag = this.drag;
			if (!drag) return;
			evt.preventDefault();
			const id = drag.id;
			this.cancelDragFrame();
			this.placeDragRow(body, drag.row, evt.clientY);
			const ids = Array.from(
				body.querySelectorAll<HTMLElement>('.eisenhower-row'),
			).map((r) => r.dataset.id ?? '');
			const index = Math.max(0, ids.indexOf(id));
			this.dropHandled = true;
			const targetBucket = bucket;
			const targetIndex = Math.max(0, Math.min(index, ids.length));
			this.clearDnDState();
			void this.plugin.moveTask(id, targetBucket, targetIndex);
		});
	}

  private placeDragRow(body: HTMLElement, row: HTMLElement, y: number): void {
    const empty = body.querySelector<HTMLElement>('.eisenhower-empty');
    if (empty) empty.remove();
    const afterEl = getDragAfterElement(body, y, row);
    if (afterEl === null) {
      if (body.lastElementChild !== row) body.appendChild(row);
    } else if (row.nextElementSibling !== afterEl) {
      body.insertBefore(row, afterEl);
    }
  }

	private cancelDragFrame(): void {
		if (this.dragFrame !== null) {
			window.cancelAnimationFrame(this.dragFrame);
			this.dragFrame = null;
		}
		this.pendingDrag = null;
	}

	private commitDraggedRow(row: HTMLElement): void {
		const id = row.dataset.id ?? '';
		const box = row.closest<HTMLElement>('.eisenhower-quadrant');
		const bucket = box?.dataset.bucket as Bucket | undefined;
		if (id === '' || bucket === undefined) return;
		const body = box?.querySelector<HTMLElement>('.eisenhower-body');
		if (!body) return;
		const ids = Array.from(
			body.querySelectorAll<HTMLElement>('.eisenhower-row'),
		).map((r) => r.dataset.id ?? '');
		const index = Math.max(0, ids.indexOf(id));
		const current = bucketOf(this.plugin.state, id);
		if (current !== null && current === bucket) {
			const order = this.plugin.state.bucketOrder[bucket] ?? [];
			if (order.indexOf(id) === index) return;
		}
		void this.plugin.moveTask(id, bucket, index);
	}

	private clearDnDState(): void {
		this.drag = null;
		this.dragStartTick = 0;
		this.cancelDragFrame();
	}

	// --- Rendering ------------------------------------------------------------
	private renderFilter(): void {
		const filterRow = this.filterRow;
		if (!filterRow) return;
		const files = Array.from(new Set(this.plugin.tasks.map((t) => t.file))).sort();
		this.filter = this.filter.filter((f) => files.indexOf(f) !== -1);
		const key =
			files.join('\u0001') +
			'\u0001' +
			[...this.filter].sort().join('\u0001') +
			'\u0001' +
			this.filterQuery;
		if (key === this.lastFilterKey) return;
		this.lastFilterKey = key;

		if (this.filterChipsEl === null) {
			this.buildFilterRow(filterRow);
		}
		const filesKey = files.join('\u0001');
		if (filesKey !== this.lastFilesKey) {
			this.filterChipsEl?.empty();
			this.filterChips.clear();
			for (const f of files) {
				this.filterChips.set(f, this.createFilterChip(f));
			}
			this.lastFilesKey = filesKey;
		}
		const q = this.filterQuery.trim().toLowerCase();
		let visibleCount = 0;
		for (const f of files) {
			const chip = this.filterChips.get(f);
			if (!chip) continue;
			const visible =
				q === '' ||
				f.toLowerCase().includes(q) ||
				fileBaseName(f).toLowerCase().includes(q);
			chip.classList.toggle('eisenhower-hidden', !visible);
			if (visible) visibleCount += 1;
			const active = this.filter.indexOf(f) !== -1;
			chip.classList.toggle('is-active', active);
			chip.setAttribute('aria-pressed', active ? 'true' : 'false');
		}
		if (this.filterNoMatchEl) {
			this.filterNoMatchEl.classList.toggle(
				'eisenhower-hidden',
				visibleCount !== 0,
			);
		}
	}

	private buildFilterRow(filterRow: HTMLElement): void {
		const setting = new Setting(filterRow)
			.setName('Filter')
			.setDesc('Show tasks from the selected files. None selected shows all.');
		const control = setting.controlEl;
		control.addClass('eisenhower-filtercontrol');
		const search = control.createEl('input', {
			cls: 'eisenhower-filtersearch',
			type: 'text',
			placeholder: 'Search filters',
			attr: { 'aria-label': 'Search filters' },
		});
		search.value = this.filterQuery;
		this.registerDomEvent(search, 'input', () => {
			this.filterQuery = search.value;
			this.renderFilter();
		});
		const chips = control.createDiv({ cls: 'eisenhower-filterchips' });
		this.filterChipsEl = chips;
		this.filterNoMatchEl = control.createSpan({
			text: 'No matching filters',
			cls: 'eisenhower-filternomatch eisenhower-hidden',
		});
	}

	private createFilterChip(f: string): HTMLElement {
		const parent = this.filterChipsEl;
		if (!parent) {
			throw new Error('Filter chips container is not initialized.');
		}
		const chip = parent.createEl('button', {
			cls: 'eisenhower-chip',
			attr: { type: 'button', title: f, 'aria-pressed': 'false' },
		});
		chip.createSpan({ text: fileBaseName(f), cls: 'eisenhower-chip-text' });
		this.registerDomEvent(chip, 'click', () => {
			const idx = this.filter.indexOf(f);
			if (idx === -1) this.filter.push(f);
			else this.filter.splice(idx, 1);
			this.render();
		});
		return chip;
	}

	render(state?: MatrixState): void {
		const st = state ?? this.plugin.state;
		this.renderFilter();
		const byId = new Map(this.plugin.tasks.map((t) => [t.id, t]));
		const clearedSet = new Set(st.clearedIds);
		const filterSet = this.filter.length > 0 ? new Set(this.filter) : null;
		const wanted = new Set<string>();
		const desired = {} as Record<Bucket, ParsedTask[]>;
		for (const bucket of BUCKETS) {
			const list: ParsedTask[] = [];
			const inboxQ =
				bucket === 'inbox' ? this.inboxQuery.trim().toLowerCase() : '';
			for (const id of st.bucketOrder[bucket] ?? []) {
				if (clearedSet.has(id)) continue;
				const t = byId.get(id);
				if (!t) continue;
				if (filterSet !== null && !filterSet.has(t.file)) continue;
				if (inboxQ !== '' && !t.title.toLowerCase().includes(inboxQ)) continue;
				list.push(t);
				wanted.add(t.id);
			}
			desired[bucket] = list;
		}
		for (const [id, row] of Array.from(this.rows)) {
			if (!wanted.has(id)) {
				row.remove();
				this.rows.delete(id);
				this.rowParts.delete(id);
			}
		}
		for (const bucket of BUCKETS) {
			const body = this.containers[bucket];
			if (!body) continue;
			const shown = desired[bucket];
			for (const t of shown) {
				let row = this.rows.get(t.id);
				if (row === undefined) {
					row = this.createRow(body, t);
					this.rows.set(t.id, row);
				} else {
					this.updateRow(row, t);
				}
			}
			this.ensureOrder(body, shown);
			const emptyEl = body.querySelector<HTMLElement>('.eisenhower-empty');
			if (emptyEl) emptyEl.remove();
			if (shown.length === 0) {
				body.createDiv({ cls: 'eisenhower-empty', text: 'No tasks' });
			}
		}
	}

	private applyInboxFilter(): void {
		const body = this.containers['inbox'];
		if (!body) return;
		const st = this.plugin.state;
		const byId = new Map(this.plugin.tasks.map((t) => [t.id, t]));
		const clearedSet = new Set(st.clearedIds);
		const filterSet = this.filter.length > 0 ? new Set(this.filter) : null;
		const inboxQ = this.inboxQuery.trim().toLowerCase();
		const shown: ParsedTask[] = [];
		for (const id of st.bucketOrder['inbox'] ?? []) {
			if (clearedSet.has(id)) continue;
			const t = byId.get(id);
			if (!t) continue;
			if (filterSet !== null && !filterSet.has(t.file)) continue;
			if (inboxQ !== '' && !t.title.toLowerCase().includes(inboxQ)) continue;
			shown.push(t);
		}
		const shownIds = new Set(shown.map((t) => t.id));
		for (const [id, row] of Array.from(this.rows)) {
			if (row.parentElement !== body) continue;
			if (!shownIds.has(id)) {
				row.remove();
				this.rows.delete(id);
				this.rowParts.delete(id);
			}
		}
		for (const t of shown) {
			let row = this.rows.get(t.id);
			if (row === undefined) {
				row = this.createRow(body, t);
				this.rows.set(t.id, row);
			} else {
				this.updateRow(row, t);
			}
		}
		this.ensureOrder(body, shown);
		const emptyEl = body.querySelector<HTMLElement>('.eisenhower-empty');
		if (emptyEl) emptyEl.remove();
		if (shown.length === 0) {
			body.createDiv({ cls: 'eisenhower-empty', text: 'No tasks' });
		}
	}

	private ensureOrder(body: HTMLElement, shown: ParsedTask[]): void {
		const desiredRows: HTMLElement[] = [];
		for (const t of shown) {
			const row = this.rows.get(t.id);
			if (row) desiredRows.push(row);
		}
		const currentRows = Array.from(
			body.querySelectorAll<HTMLElement>('.eisenhower-row'),
		);
		if (
			currentRows.length === desiredRows.length &&
			currentRows.every((r, i) => r === desiredRows[i])
		) {
			return;
		}
		for (const row of desiredRows) body.appendChild(row);
	}

	private updateRow(row: HTMLElement, t: ParsedTask): void {
		const parts = this.rowParts.get(t.id);
		if (!parts) return;
		if (parts.check.checked !== t.completed) parts.check.checked = t.completed;
		const key = `${t.file}\u0001${t.title}`;
		if (row.dataset.titleKey === key) return;
		row.dataset.titleKey = key;
		const titleEl = parts.title;
		titleEl.empty();
		MarkdownRenderer.render(this.app, t.title, titleEl, t.file, this).catch(
			(err: unknown) => {
				titleEl.setText(t.title);
				console.error('eisenhower: failed to render task title', err);
			},
		);
	}

	private createRow(parent: HTMLElement, t: ParsedTask): HTMLElement {
		const row = parent.createDiv({
			cls: 'eisenhower-row',
			attr: { draggable: 'true' },
		});
		row.dataset.id = t.id;
		row.dataset.titleKey = `${t.file}\u0001${t.title}`;

		const check = row.createEl('input', {
			cls: 'eisenhower-check',
			type: 'checkbox',
		});
		check.checked = t.completed;
		this.registerDomEvent(check, 'change', () => {
			void this.plugin.toggleTask(t);
		});

		const titleEl = row.createSpan({ cls: 'eisenhower-rowtitle' });
		this.rowParts.set(t.id, { check, title: titleEl });
		MarkdownRenderer.render(this.app, t.title, titleEl, t.file, this		).catch(
			(err: unknown) => {
				titleEl.setText(t.title);
				console.error('eisenhower: failed to render task title', err);
			},
		);

		const badge = row.createEl('button', {
			cls: 'eisenhower-badge',
			attr: {
				'aria-label': `Move task to another note (currently ${t.file})`,
				title: `Currently in ${t.file} — click to move`,
				type: 'button',
			},
		});
		setIcon(badge, 'file-text');
		badge.createSpan({
			text: fileBaseName(t.file),
			cls: 'eisenhower-badge-text',
		});
		this.registerDomEvent(badge, 'click', () => {
			new MoveTaskModal(this.app, this.plugin, t).open();
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
			this.dropHandled = false;
			this.dragStartTick = performance.now();
			this.drag = { id: t.id, row };
			this.cancelDragFrame();
			this.pendingDrag = null;
			row.addClass('dragging');
		});
		this.registerDomEvent(row, 'dragend', () => {
			row.removeClass('dragging');
			this.cancelDragFrame();
			if (this.dropHandled) {
				this.dropHandled = false;
				this.dragStartTick = 0;
				return;
			}
			this.commitDraggedRow(row);
			this.clearDnDState();
			this.dragStartTick = 0;
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

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Open note')
				.setIcon('file-text')
				.onClick(() => {
					const file = this.app.vault.getFileByPath(t.file);
					if (file) {
						void this.app.workspace.getLeaf(true).openFile(file);
					} else {
						new Notice(`File not found: ${t.file}`, 5000);
					}
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle('Move to note…')
				.setIcon('folder-input')
				.onClick(() => {
					new MoveTaskModal(this.app, this.plugin, t).open();
				}),
		);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Delete')
				.setIcon('trash-2')
				.onClick(() => {
					new ConfirmationModal(
						this.app,
						`Delete the task from ${t.file}? This removes it from the note and the matrix.`,
						() => this.plugin.deleteTask(t),
					).open();
				}),
		);

		menu.showAtMouseEvent(evt);
	}

	// --- Complete the day -------------------------------------------------------
	private confirmCompleteDay(): void {
		new ConfirmationModal(
			this.app,
			this.plugin.completeDayPrompt(),
			() => this.plugin.completeTheDay(),
		).open();
	}
}

const ADD_BUCKET_ORDER: readonly Bucket[] = ['inbox', 'q1', 'q2', 'q3', 'q4'];

export class AddTaskModal extends Modal {
	plugin: EisenhowerPlugin;
	taskInputEl: HTMLInputElement | null = null;
	file: string;
	bucket: Bucket = 'inbox';

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

		const fileSetting = new Setting(contentEl)
			.setName('File')
			.setDesc(
				'Where the task will be stored. Start typing to filter scanned files.',
			);
		const control = fileSetting.controlEl;
		const inputWrap = control.createDiv({ cls: 'eisenhower-suggest-wrap' });
		const fileInput = inputWrap.createEl('input', {
			type: 'text',
			placeholder: 'Filter files…',
			attr: { 'aria-label': 'Filter files' },
		});
		fileInput.value = this.file;
		const dropdown = inputWrap.createDiv({ cls: 'eisenhower-suggest' });
		dropdown.hide();

		let current: FileSuggestion[] = [];
		let highlight = -1;

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

		const choose = (raw: string): void => {
			const path = raw.trim();
			if (!path) return;
			this.file = path;
			fileInput.value = path;
			current = [];
			highlight = -1;
			dropdown.hide();
		};

		const renderDropdown = (): void => {
			dropdown.empty();
			if (current.length === 0) {
				dropdown.hide();
				return;
			}
			dropdown.show();
			for (let i = 0; i < current.length; i++) {
				const s = current[i];
				if (!s) continue;
				const item = dropdown.createDiv({ cls: 'eisenhower-suggest-item' });
				const iconEl = item.createSpan({ cls: 'eisenhower-suggest-icon' });
				setIcon(iconEl, 'file-text');
				item.createSpan({ text: s.path, cls: 'eisenhower-suggest-text' });
				if (s.create) {
					item.createSpan({
						text: 'will be created',
						cls: 'eisenhower-suggest-tag',
					});
				}
				item.addEventListener('mousedown', (evt: MouseEvent) => {
					evt.preventDefault();
					choose(s.path);
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
			current = this.computeFileSuggestions(fileInput.value);
			highlight = current.length > 0 ? 0 : -1;
			renderDropdown();
		};

		fileInput.addEventListener('input', () => refresh());
		fileInput.addEventListener('focus', () => refresh());
		fileInput.addEventListener('blur', () => {
			window.setTimeout(() => dropdown.hide(), 150);
		});
		fileInput.addEventListener('keydown', (evt: KeyboardEvent) => {
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
				choose(highlighted ? highlighted.path : fileInput.value);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				dropdown.hide();
			}
		});

		new Setting(contentEl)
			.setName('Quadrant')
			.setDesc('Where the new task will be placed.')
			.addDropdown((dd) => {
				for (const b of ADD_BUCKET_ORDER) {
					dd.addOption(b, BUCKET_DEFS[b].title);
				}
				dd.setValue(this.bucket);
				dd.onChange((value) => {
					this.bucket = value as Bucket;
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

	private computeFileSuggestions(query: string): FileSuggestion[] {
		const q = query.trim().toLowerCase();
		const out: FileSuggestion[] = [];
		for (const f of this.plugin.taskFiles()) {
			if (q === '' || f.path.toLowerCase().includes(q)) {
				out.push({ path: f.path, create: false });
			}
		}
		out.sort((a, b) => (a.path < b.path ? -1 : 1));
		const typed = query.trim();
		if (
			typed !== '' &&
			typed.endsWith('.md') &&
			!this.plugin.taskFiles().some((f) => f.path === typed) &&
			this.plugin.isRelevantPath(typed)
		) {
			out.push({ path: typed, create: true });
		}
		return out.slice(0, 80);
	}

	async submit(): Promise<void> {
		const title = (this.taskInputEl?.value ?? '').trim();
		if (!title) {
			new Notice('Enter a task title first.', 4000);
			return;
		}
		if (this.file.trim() === '') {
			new Notice('Pick a file first.', 4000);
			return;
		}
		try {
			await this.plugin.addTask(title, this.file, this.bucket);
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

interface FileSuggestion {
	path: string;
	create: boolean;
}

export class MoveTaskModal extends SuggestModal<FileSuggestion> {
	plugin: EisenhowerPlugin;
	task: ParsedTask;

	constructor(app: App, plugin: EisenhowerPlugin, task: ParsedTask) {
		super(app);
		this.plugin = plugin;
		this.task = task;
		this.setTitle('Move task to note');
		this.setPlaceholder(`Currently in ${task.file} — pick another note`);
	}

	getSuggestions(query: string): FileSuggestion[] {
		const q = query.trim().toLowerCase();
		const out: FileSuggestion[] = [];
		for (const f of this.plugin.taskFiles()) {
			if (f.path === this.task.file) continue;
			if (q !== '') {
				const name = fileBaseName(f.path).toLowerCase();
				if (!f.path.toLowerCase().includes(q) && !name.includes(q)) {
					continue;
				}
			}
			out.push({ path: f.path, create: false });
		}
		out.sort((a, b) => (a.path < b.path ? -1 : 1));
		const typed = query.trim();
		if (
			typed !== '' &&
			typed.endsWith('.md') &&
			!this.plugin.taskFiles().some((f) => f.path === typed) &&
			this.plugin.isRelevantPath(typed)
		) {
			out.push({ path: typed, create: true });
		}
		return out;
	}

	renderSuggestion(item: FileSuggestion, el: HTMLElement): void {
		el.createSpan({ text: item.path });
		if (item.create) {
			el.createSpan({ text: ' — will be created', cls: 'eisenhower-move-create' });
		}
	}

	onChooseSuggestion(item: FileSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		void this.plugin
			.moveTaskToFile(this.task, item.path)
			.then(() => {
				new Notice(`Moved to ${item.path}`, 2500);
			})
			.catch((err: unknown) => {
				new Notice(
					err instanceof Error ? err.message : 'Failed to move task.',
					6000,
				);
			});
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
