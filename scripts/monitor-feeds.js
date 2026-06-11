import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const STATUS_FILE = path.join(PROJECT_ROOT, 'src/content/system/status.json');

const status = await loadStatus();
const evaluatedAt = status.generatedAt ? new Date(status.generatedAt) : new Date();
const findings = status.sources.flatMap((source) => evaluateSource(source, evaluatedAt));
const summary = buildSummary(status, findings, evaluatedAt);

console.log(summary.console);
await writeStepSummary(summary.markdown);

if (findings.length > 0) {
	process.exit(1);
}

async function loadStatus() {
	const content = await fs.readFile(STATUS_FILE, 'utf8');
	return JSON.parse(content);
}

function evaluateSource(source, evaluatedAt) {
	const findings = [];
	const lastSuccessAt = source.lastSuccessAt ? new Date(source.lastSuccessAt) : null;
	const checkedAt = source.checkedAt ? new Date(source.checkedAt) : null;
	const staleAfterMs = Number(source.staleAfterHours ?? 0) * 60 * 60 * 1000;

	if (!checkedAt) {
		findings.push({
			sourceId: source.id,
			sourceName: source.name,
			severity: 'error',
			message: 'Source has never been checked.',
		});
		return findings;
	}

	if (source.healthy === false) {
		findings.push({
			sourceId: source.id,
			sourceName: source.name,
			severity: 'error',
			message: source.error
				? `Latest fetch failed: ${source.error}`
				: 'Latest fetch marked the source unhealthy.',
		});
	}

	if (!lastSuccessAt) {
		findings.push({
			sourceId: source.id,
			sourceName: source.name,
			severity: 'error',
			message: 'Source has no recorded successful fetch yet.',
		});
		return findings;
	}

	if (staleAfterMs > 0 && evaluatedAt.getTime() - lastSuccessAt.getTime() > staleAfterMs) {
		findings.push({
			sourceId: source.id,
			sourceName: source.name,
			severity: 'error',
			message: `Last successful fetch was ${formatAge(evaluatedAt.getTime() - lastSuccessAt.getTime())} ago, beyond the ${source.staleAfterHours}h freshness window.`,
		});
	}

	return findings;
}

function buildSummary(status, findings, evaluatedAt) {
	const header = `Feed monitor evaluated ${status.sources.length} source${status.sources.length === 1 ? '' : 's'} at ${evaluatedAt.toISOString()}.`;

	if (findings.length === 0) {
		return {
			console: `${header}\nAll sources are healthy and within their freshness windows.`,
			markdown: [
				'## Feed monitor',
				'',
				header,
				'',
				'All sources are healthy and within their freshness windows.',
			].join('\n'),
		};
	}

	const lines = findings.map(
		(finding) => `- ${finding.sourceName} (\`${finding.sourceId}\`): ${finding.message}`,
	);

	return {
		console: [header, `${findings.length} monitoring alert${findings.length === 1 ? '' : 's'} detected:`, ...lines].join('\n'),
		markdown: [
			'## Feed monitor',
			'',
			header,
			'',
			`${findings.length} monitoring alert${findings.length === 1 ? '' : 's'} detected:`,
			'',
			...lines,
		].join('\n'),
	};
}

function formatAge(ms) {
	const totalMinutes = Math.max(1, Math.round(ms / (60 * 1000)));
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	const parts = [];

	if (days) {
		parts.push(`${days}d`);
	}
	if (hours) {
		parts.push(`${hours}h`);
	}
	if (minutes && parts.length === 0) {
		parts.push(`${minutes}m`);
	}

	return parts.join(' ');
}

async function writeStepSummary(markdown) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (!summaryPath) {
		return;
	}

	await fs.appendFile(summaryPath, `${markdown}\n`, 'utf8');
}
