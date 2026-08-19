import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import {
	Bucket,
	MatrixState,
	ParsedTask,
	buildCompletedDayState,
	emptyState,
	findTask,
	flipLine,
	migrateTaskId,
	moveTask,
	normalizeTitle,
	parseFileTasks,
	reconcile,
	taskId,
} from './model';
import {
	DEFAULT_SETTINGS,
	EisenhowerSettings,
	EisenhowerSettingTab,
} from './settings';
import {
	AddTaskModal,
	ConfirmationModal,
	EisenhowerMatrixView,
} from './matrix-view';

interface StoredData {
	settings?: Partial<EisenhowerSettings>;
	matrix?: {
		bucketOrder?: Partial<Record<Bucket, string[]>>;
		clearedIds?: string[];
	};
}

export type StateListener = (state: MatrixState) => void;

export default class EisenhowerPlugin extends Plugin {
	settings: EisenhowerSettings = { ...DEFAULT_SETTINGS };
	state: MatrixState = emptyState();
	tasks: ParsedTask[] = [];

	private listeners = new Set<StateListener>();
	private reloadTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadPersistentData();

		this.registerView(
			EisenhowerMatrixView.VIEW_TYPE,
			(leaf) => new EisenhowerMatrixView(leaf, this),
		);

		this.addRibbonIcon('layout-grid', 'Open Eisenhower Matrix', () => {
			void this.openView();
		});

		this.addCommand({
			id: 'eisenhower-open',
			name: 'Open',
			callback: () => {
				void this.openView();
			},
		});

		this.addCommand({
			id: 'eisenhower-new-task',
			name: 'New task',
			callback: () => {
				new AddTaskModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'eisenhower-complete-day',
			name: 'Complete the day',
			callback: () => {
				const unfinished = this.tasks.filter((t) => !t.completed).length;
				const message =
					unfinished === 0
						? 'All tasks are already complete. Archive everything?'
						: `${unfinished} unfinished task${unfinished === 1 ? '' : 's'} will move to the inbox and completed tasks will be archived. Continue?`;
				new ConfirmationModal(this.app, message, () => this.completeTheDay()).open();
			},
		});

		this.addSettingTab(new EisenhowerSettingTab(this.app, this));

		const scheduleReload = (): void => {
			if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
			this.reloadTimer = window.setTimeout(() => {
				this.reloadTimer = null;
				void this.reloadNow().catch((err: unknown) => {
					console.error('eisenhower: reload failed', err);
				});
			}, 150);
		};

		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				if (this.isRelevantPath(file.path)) scheduleReload();
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (this.isRelevantPath(file.path)) scheduleReload();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (this.isRelevantPath(file.path)) scheduleReload();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (
					this.isRelevantPath(file.path) ||
					this.isRelevantPath(oldPath)
				) {
					scheduleReload();
				}
			}),
		);

		await this.reloadNow();
	}

	onunload(): void {
		// Views and event listeners are cleaned up by the plugin runtime.
	}

	// --- Persistence -----------------------------------------------------------
	private async loadPersistentData(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as StoredData;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(data.settings ?? {}),
		};
		const m = data.matrix;
		this.state = {
			bucketOrder: {
				q1: m?.bucketOrder?.q1 ?? [],
				q2: m?.bucketOrder?.q2 ?? [],
				q3: m?.bucketOrder?.q3 ?? [],
				q4: m?.bucketOrder?.q4 ?? [],
				inbox: m?.bucketOrder?.inbox ?? [],
			},
			clearedIds: m?.clearedIds ?? [],
		};
	}

	private async persist(): Promise<void> {
		const data: StoredData = {
			settings: this.settings,
			matrix: {
				bucketOrder: this.state.bucketOrder,
				clearedIds: this.state.clearedIds,
			},
		};
		await this.saveData(data);
	}

	// --- State & notification ----------------------------------------------------
	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	notify(): void {
		for (const listener of Array.from(this.listeners)) {
			listener(this.state);
		}
	}

	isRelevantPath(path: string): boolean {
		if (!path.endsWith('.md')) return false;
		const { taskDirectories, defaultTaskFile, includeSubdirectories } =
			this.settings;
		if (defaultTaskFile !== '' && path === defaultTaskFile) return true;
		return taskDirectories.some((root) => {
			if (!path.startsWith(`${root}/`)) return false;
			return (
				includeSubdirectories ||
				!path.slice(root.length + 1).includes('/')
			);
		});
	}

	taskFiles(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => this.isRelevantPath(f.path));
	}

	async reloadNow(): Promise<void> {
		const files = this.taskFiles();
		const tasks: ParsedTask[] = [];
		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				tasks.push(...parseFileTasks(file.path, content));
			} catch {
				// Skip unreadable files.
			}
		}
		this.tasks = tasks;
		this.state = reconcile(tasks, this.state);
		await this.persist();
		this.notify();
	}

	async onSettingsChanged(): Promise<void> {
		await this.persist();
		await this.reloadNow();
	}

	// --- Mutations ----------------------------------------------------------------
	async moveTask(id: string, bucket: Bucket, index: number): Promise<void> {
		this.state = moveTask(this.state, id, bucket, index);
		this.notify();
		await this.persist();
	}

	async toggleTask(task: ParsedTask): Promise<void> {
		const file = this.app.vault.getFileByPath(task.file);
		if (!file) {
			new Notice(`File not found: ${task.file}`, 5000);
			return;
		}
		await this.app.vault.process(file, (current) => {
			const fresh = parseFileTasks(file.path, current);
			const found = findTask(fresh, task.id);
			if (!found) return current;
			return flipLine(current, found.line, !found.completed);
		});
		await this.reloadNow();
	}

	async addTask(title: string, filePath: string): Promise<void> {
		const path = filePath.trim();
		if (!path) throw new Error('No file selected.');
		if (!path.endsWith('.md')) {
			throw new Error(`${path} is not a markdown file.`);
		}
		let file = this.app.vault.getFileByPath(path);
		if (!file) {
			file = await this.app.vault.create(path, '');
		}
		const content = await this.app.vault.read(file);
		const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
		await this.app.vault.append(file, `${prefix}- [ ] ${title}\n`);
		await this.reloadNow();
	}

	async moveTaskToFile(task: ParsedTask, targetPath: string): Promise<void> {
		const path = targetPath.trim();
		if (!path) throw new Error('No file selected.');
		if (!path.endsWith('.md')) {
			throw new Error(`${path} is not a markdown file.`);
		}
		if (!this.isRelevantPath(path)) {
			throw new Error(`${path} is outside the scanned task scope.`);
		}
		if (path === task.file) {
			throw new Error('The task is already in that note.');
		}

		let target = this.app.vault.getFileByPath(path);
		if (!target) {
			target = await this.app.vault.create(path, '');
		}

		const box = task.completed ? '[x]' : '[ ]';
		let newId = taskId(path, 0, task.title);
		await this.app.vault.process(target, (current) => {
			const norm = normalizeTitle(task.title);
			const occurrence = parseFileTasks(path, current).filter(
				(t) => normalizeTitle(t.title) === norm,
			).length;
			newId = taskId(path, occurrence, task.title);
			const prefix =
				current.length === 0 || current.endsWith('\n') ? '' : '\n';
			return `${current}${prefix}- ${box} ${task.title}\n`;
		});

		const source = this.app.vault.getFileByPath(task.file);
		if (source) {
			await this.app.vault.process(source, (current) => {
				const found = findTask(parseFileTasks(source.path, current), task.id);
				if (!found) return current;
				const lines = current.split('\n');
				lines.splice(found.line, 1);
				return lines.join('\n');
			});
		}

		this.state = migrateTaskId(this.state, task.id, newId);
		await this.reloadNow();
	}

	async completeTheDay(): Promise<void> {
		this.state = buildCompletedDayState(this.tasks, this.state);
		this.notify();
		await this.persist();
		new Notice('Day completed. Unfinished tasks moved to the inbox.', 3500);
	}

	// --- View helpers -----------------------------------------------------------
	async openView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(EisenhowerMatrixView.VIEW_TYPE);
		for (const leaf of existing) {
			await workspace.revealLeaf(leaf);
			return;
		}
		const leaf = workspace.getLeaf(true);
		await leaf.setViewState({
			type: EisenhowerMatrixView.VIEW_TYPE,
			active: true,
		});
	}
}
