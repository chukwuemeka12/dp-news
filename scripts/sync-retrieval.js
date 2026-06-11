import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ARTICLES_DIR = path.join(PROJECT_ROOT, 'src/content/articles');
const DEFAULT_RETRIEVAL_SERVER_DIR =
	process.env.DPA_RETRIEVAL_SERVER_DIR ??
	'/Users/c.cameron/Documents/Design Privacy Academy/05 Ontology & Data Model/servers';
const DEFAULT_RETRIEVAL_DATA_DIR =
	process.env.DPA_RETRIEVAL_DATA_DIR ?? path.join(DEFAULT_RETRIEVAL_SERVER_DIR, 'data');
const DEFAULT_STATE_FILE =
	process.env.DP_NEWS_SYNC_STATE_FILE ??
	path.join(os.homedir(), '.dp-news', 'retrieval-sync-manifest.json');
const SUPPORTED_SOURCE_IDS = new Set(['cms-enforcement-tracker']);
const GENERIC_TAGS = new Set(['enforcement', 'fines', 'gdpr']);

const options = parseArgs(process.argv.slice(2));
const manifest = await loadManifest(options.stateFile);
const articles = await loadArticles(options.articlesDir);
const candidates = articles
	.filter((article) => SUPPORTED_SOURCE_IDS.has(article.sourceId))
	.sort((left, right) => sortByNewest(right) - sortByNewest(left))
	.slice(0, options.limit ?? Infinity);

const results = [];

for (const article of candidates) {
	const checksum = buildChecksum(article);
	const manifestEntry = manifest.items[article.id];

	if (manifestEntry?.syncChecksum === checksum) {
		results.push({
			articleId: article.id,
			title: article.title,
			outcome: 'already_synced',
			documentId: manifestEntry.retrievalDocumentId,
		});
		continue;
	}

	if (manifestEntry && manifestEntry.syncChecksum !== checksum) {
		results.push({
			articleId: article.id,
			title: article.title,
			outcome: 'update_required',
			documentId: manifestEntry.retrievalDocumentId,
		});
		continue;
	}

	const payload = buildSyncPayload(article, checksum);

	if (!options.apply) {
		results.push({
			articleId: article.id,
			title: article.title,
			outcome: 'would_create',
			tierLevel: 2,
		});
		continue;
	}

	const adapterResult = runAdapter(payload, options);

	if (!adapterResult.success) {
		results.push({
			articleId: article.id,
			title: article.title,
			outcome: 'failed',
			error: adapterResult.error ?? adapterResult,
		});
		continue;
	}

	if (adapterResult.mode === 'existing' && adapterResult.checksumMatches === false) {
		results.push({
			articleId: article.id,
			title: article.title,
			outcome: 'update_required',
			documentId: adapterResult.documentId,
		});
		continue;
	}

	manifest.items[article.id] = {
		articleId: article.id,
		sourceId: article.sourceId,
		retrievalDocumentId: adapterResult.documentId,
		syncChecksum: checksum,
		syncedAt: new Date().toISOString(),
		title: article.title,
		originalLink: article.originalLink,
	};
	await saveManifest(options.stateFile, manifest);

	results.push({
		articleId: article.id,
		title: article.title,
		outcome: adapterResult.mode === 'created' ? 'created' : 'already_present',
		documentId: adapterResult.documentId,
	});
}

printSummary(results, options);

if (options.apply && results.some((result) => result.outcome === 'failed')) {
	process.exit(1);
}

function parseArgs(argv) {
	const parsed = {
		apply: false,
		articlesDir: DEFAULT_ARTICLES_DIR,
		stateFile: DEFAULT_STATE_FILE,
		retrievalServerDir: DEFAULT_RETRIEVAL_SERVER_DIR,
		retrievalDataDir: DEFAULT_RETRIEVAL_DATA_DIR,
		limit: null,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--apply') {
			parsed.apply = true;
			continue;
		}
		if (arg === '--articles-dir') {
			parsed.articlesDir = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--state-file') {
			parsed.stateFile = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--retrieval-server-dir') {
			parsed.retrievalServerDir = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--retrieval-data-dir') {
			parsed.retrievalDataDir = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--limit') {
			parsed.limit = Number.parseInt(argv[++index], 10);
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return parsed;
}

async function loadArticles(articlesDir) {
	const entries = await fs.readdir(articlesDir, { withFileTypes: true });
	const articles = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) {
			continue;
		}

		const filePath = path.join(articlesDir, entry.name);
		const article = JSON.parse(await fs.readFile(filePath, 'utf8'));
		articles.push({
			...article,
			filePath,
		});
	}

	return articles;
}

async function loadManifest(stateFile) {
	try {
		const content = await fs.readFile(stateFile, 'utf8');
		const parsed = JSON.parse(content);
		return {
			version: 1,
			items: parsed.items ?? {},
		};
	} catch {
		return {
			version: 1,
			items: {},
		};
	}
}

async function saveManifest(stateFile, manifest) {
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	await fs.writeFile(
		stateFile,
		`${JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		'utf8',
	);
}

function buildSyncPayload(article, checksum) {
	const enforcementTrackerId = extractEnforcementTrackerId(article);
	const jurisdiction = extractJurisdiction(article);
	const organisation = extractOrganisation(article);
	const topicTags = (article.tags ?? []).filter((tag) => !GENERIC_TAGS.has(tag) && !tag.startsWith('etid-'));

	return {
		article: {
			id: article.id,
			title: article.title,
			filePath: article.filePath,
		},
		checksum,
		metadata: {
			source_system: 'dp_news',
			source_feed: article.sourceId,
			dp_news_article_id: article.id,
			sync_checksum: checksum,
			authority_tier: 2,
			jurisdiction,
			organisation,
			enforcement_tracker_id: enforcementTrackerId,
			original_link: article.originalLink,
			published_date: article.publishedDate,
			decision_date: article.decisionDate,
			tags: article.tags ?? [],
			document_type: 'regulatory_decision',
		},
		chunk: {
			chunk_index: 0,
			chunk_type: 'paragraph',
			owl_class_iri: 'ob:RegulatoryDecision',
			content: buildChunkContent({
				article,
				jurisdiction,
				organisation,
				enforcementTrackerId,
				topicTags,
			}),
		},
	};
}

function buildChunkContent({ article, jurisdiction, organisation, enforcementTrackerId, topicTags }) {
	const lines = [
		article.title,
		`Source: ${article.source}.`,
		`Decision date: ${article.decisionDate ?? article.publishedDate ?? 'Unknown'}.`,
	];

	if (jurisdiction) {
		lines.push(`Jurisdiction: ${jurisdiction}.`);
	}
	if (organisation) {
		lines.push(`Organisation: ${organisation}.`);
	}
	if (enforcementTrackerId) {
		lines.push(`Enforcement Tracker reference: ${enforcementTrackerId}.`);
	}
	if (article.originalLink) {
		lines.push(`Original link: ${article.originalLink}.`);
	}
	lines.push(`Summary: ${article.summary}`);
	if (topicTags.length > 0) {
		lines.push(`Tags: ${topicTags.join(', ')}.`);
	}
	lines.push(`DPA News article ID: ${article.id}.`);

	return lines.join(' ');
}

function runAdapter(payload, options) {
	const adapterPath = path.join(SCRIPT_DIR, 'sync-retrieval-adapter.py');
	const { command, args } = getPythonCommand([
		adapterPath,
		'--server-dir',
		options.retrievalServerDir,
	]);
	const result = spawnSync(
		command,
		args,
		{
			input: JSON.stringify(payload),
			encoding: 'utf8',
			env: {
				...process.env,
				DPA_DATA_DIR: options.retrievalDataDir,
				PYTHONDONTWRITEBYTECODE: '1',
			},
		},
	);

	if (result.status !== 0) {
		return {
			success: false,
			error: result.stderr.trim() || result.stdout.trim() || 'Adapter command failed.',
		};
	}

	return JSON.parse(result.stdout);
}

function getPythonCommand(scriptArgs) {
	if (process.platform === 'darwin' && process.arch === 'x64') {
		return {
			command: 'arch',
			args: ['-arm64', 'python3', ...scriptArgs],
		};
	}

	return {
		command: 'python3',
		args: scriptArgs,
	};
}

function printSummary(results, options) {
	const counts = results.reduce((accumulator, result) => {
		accumulator[result.outcome] = (accumulator[result.outcome] ?? 0) + 1;
		return accumulator;
	}, {});

	console.log(
		[
			`Retrieval sync ${options.apply ? 'apply' : 'dry-run'} completed.`,
			`Candidates evaluated: ${results.length}.`,
			...Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`),
		].join('\n'),
	);

	for (const result of results.slice(0, 20)) {
		const detail = result.documentId ? ` -> ${result.documentId}` : '';
		const error = result.error ? ` (${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)})` : '';
		console.log(`* ${result.articleId}: ${result.outcome}${detail}${error}`);
	}
}

function buildChecksum(article) {
	const hash = crypto.createHash('sha256');
	hash.update(
		JSON.stringify({
			id: article.id,
			title: article.title,
			summary: article.summary,
			decisionDate: article.decisionDate,
			publishedDate: article.publishedDate,
			originalLink: article.originalLink,
			tags: [...(article.tags ?? [])].sort(),
		}),
	);
	return hash.digest('hex').slice(0, 16);
}

function extractJurisdiction(article) {
	const match = article.title.match(/^(.+?) enforcement action against /i);
	if (!match) {
		return '';
	}
	return toTitleCase(match[1]);
}

function extractOrganisation(article) {
	const match = article.title.match(/against (.+?)(?: \([\d,]+\))?$/i);
	return match?.[1] ?? '';
}

function extractEnforcementTrackerId(article) {
	return (article.tags ?? []).find((tag) => tag.startsWith('etid-')) ?? '';
}

function sortByNewest(article) {
	return new Date(article.decisionDate ?? article.publishedDate ?? article.fetchedAt ?? 0).getTime();
}

function toTitleCase(value) {
	return value
		.toLowerCase()
		.split(/[\s-]+/)
		filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
		.join(' ');
}
