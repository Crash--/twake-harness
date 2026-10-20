export interface Sample {
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly value: number;
}

// The samples of a Prometheus exposition, as a scraper reads them
export function samplesOf(text: string): Sample[] {
	return text.split('\n').flatMap((line) => {
		const sample = /^(\w+)(?:\{(.*)\})? (\S+)$/.exec(line);
		if (sample === null) return [];
		const pairs = [...(sample[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)];
		return [
			{
				name: sample[1] ?? '',
				labels: Object.fromEntries(pairs.map((pair) => [pair[1] ?? '', pair[2] ?? ''])),
				value: Number(sample[3])
			}
		];
	});
}

// What an operator's sum(name{selector}) reads over the instances of a role
export function total(
	texts: readonly string[],
	name: string,
	selector: Record<string, string>
): number {
	return texts
		.flatMap(samplesOf)
		.filter(
			(s) =>
				s.name === name && Object.entries(selector).every(([key, value]) => s.labels[key] === value)
		)
		.reduce((sum, s) => sum + s.value, 0);
}
