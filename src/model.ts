export type Bucket = 'q1' | 'q2' | 'q3' | 'q4' | 'inbox';

export interface BucketDef {
	id: Bucket;
	title: string;
	subtitle: string;
	icon: string;
}

export const BUCKETS: readonly Bucket[] = ['q1', 'q2', 'q3', 'q4', 'inbox'];

export const GRID_BUCKETS: readonly Bucket[] = ['q1', 'q2', 'q3', 'q4'];

export const BUCKET_DEFS: Record<Bucket, BucketDef> = {
	q1: {
		id: 'q1',
		title: 'Do First',
		subtitle: 'Urgent & Important',
		icon: 'zap',
	},
	q2: {
		id: 'q2',
		title: 'Schedule',
		subtitle: 'Important, Not Urgent',
		icon: 'calendar',
	},
	q3: {
		id: 'q3',
		title: 'Delegate',
		subtitle: 'Urgent, Not Important',
		icon: 'user',
	},
	q4: {
		id: 'q4',
		title: 'Eliminate',
		subtitle: 'Not Urgent, Not Important',
		icon: 'trash',
	},
	inbox: {
		id: 'inbox',
		title: 'Inbox',
		subtitle: 'Unfiled tasks · new tasks land here',
		icon: 'inbox',
	},
};

export interface ParsedTask {
	id: string;
	title: string;
	completed: boolean;
	file: string;
	line: number;
	occurrence: number;
}

export interface MatrixState {
	bucketOrder: Record<Bucket, string[]>;
	clearedIds: string[];
}

export function emptyState(): MatrixState {
	return {
		bucketOrder: { q1: [], q2: [], q3: [], q4: [], inbox: [] },
		clearedIds: [],
	};
}

export function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function taskId(file: string, occurrence: number, title: string): string {
	return `${file}\u0001${occurrence}\u0001${normalizeTitle(title)}`;
}

const TASK_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

export function parseFileTasks(file: string, content: string): ParsedTask[] {
	const lines = content.split('\n');
	const tasks: ParsedTask[] = [];
	const perTitle = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const m = TASK_RE.exec(line);
		if (!m) continue;
		const title = (m[2] ?? '').trim();
		if (!title) continue;
		const norm = normalizeTitle(title);
		const occurrence = perTitle.get(norm) ?? 0;
		perTitle.set(norm, occurrence + 1);
		tasks.push({
			id: taskId(file, occurrence, title),
			title,
			completed: m[1] !== ' ',
			file,
			line: i,
			occurrence,
		});
	}
	return tasks;
}

export function findTask(tasks: ParsedTask[], id: string): ParsedTask | undefined {
	return tasks.find((t) => t.id === id);
}

export function flipLine(
	content: string,
	line: number,
	toCompleted: boolean,
): string {
	const lines = content.split('\n');
	const current = lines[line];
	if (current === undefined) return content;
	const next = toCompleted
		? current.replace(/\[[ xX]\]/, '[x]')
		: current.replace(/\[[ xX]\]/, '[ ]');
	if (next === current) return content;
	lines[line] = next;
	return lines.join('\n');
}

export function reconcile(tasks: ParsedTask[], previous: MatrixState): MatrixState {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const clearedIds = previous.clearedIds.filter((id) => {
		const t = byId.get(id);
		return t !== undefined && t.completed;
	});
	const clearedSet = new Set(clearedIds);
	const bucketOrder = {} as Record<Bucket, string[]>;
	const placed = new Set<string>();
	for (const bucket of BUCKETS) {
		const next: string[] = [];
		for (const id of previous.bucketOrder[bucket] ?? []) {
			if (byId.has(id) && !clearedSet.has(id)) {
				next.push(id);
				placed.add(id);
			}
		}
		bucketOrder[bucket] = next;
	}
	const inbox = bucketOrder.inbox;
	if (inbox) {
		for (const t of tasks) {
			if (!placed.has(t.id) && !clearedSet.has(t.id)) {
				inbox.push(t.id);
			}
		}
	}
	return { bucketOrder, clearedIds };
}

export function buildCompletedDayState(
	tasks: ParsedTask[],
	previous: MatrixState,
): MatrixState {
	const state = emptyState();
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const seen = new Set<string>();
	for (const bucket of BUCKETS) {
		for (const id of previous.bucketOrder[bucket] ?? []) {
			if (seen.has(id)) continue;
			seen.add(id);
			const t = byId.get(id);
			if (!t) continue;
			if (t.completed) state.clearedIds.push(id);
			else state.bucketOrder.inbox.push(id);
		}
	}
	for (const t of tasks) {
		if (seen.has(t.id)) continue;
		if (t.completed) state.clearedIds.push(t.id);
		else state.bucketOrder.inbox.push(t.id);
	}
	return state;
}

export function moveTask(
	state: MatrixState,
	id: string,
	target: Bucket,
	index: number,
): MatrixState {
	const bucketOrder = {} as Record<Bucket, string[]>;
	for (const bucket of BUCKETS) {
		bucketOrder[bucket] = (state.bucketOrder[bucket] ?? []).filter(
			(x) => x !== id,
		);
	}
	const arr = bucketOrder[target];
	const clamped = Math.max(0, Math.min(index, arr.length));
	arr.splice(clamped, 0, id);
	return { bucketOrder, clearedIds: state.clearedIds };
}

export function bucketOf(state: MatrixState, id: string): Bucket | null {
	for (const bucket of BUCKETS) {
		if ((state.bucketOrder[bucket] ?? []).includes(id)) return bucket;
	}
	return null;
}
