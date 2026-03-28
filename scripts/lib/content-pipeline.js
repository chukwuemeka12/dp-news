import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_ARTICLES, RETENTION_DAYS, SOURCE_CONFIG } from '../../src/data/source-config.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const ARTICLES_DIR = path.join(PROJECT_ROOT, 'src/content/articles');
const SYSTEM_DIR = path.join(PROJECT_ROOT, 'src/content/system');
const STATUS_FILE = path.join(SYSTEM_DIR, 'status.json');

const ENTITY_MAP = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
};

export function createEmptyStatus() {
	return {
		generatedAt: '',
		retentionDays: RETENTION_DAYS,
		maxArticles: MAX_ARTICLES,
		totals: {
			articles: 0,
			healthySources: 0,
			totalSources: SOURCE_CONFIG.length,
			byCategory: {
				decisions: 0,
				laws: 0,
				guidance: 0,
				standards: 0,
				appointments: 0,
			},
		},
		sources: SOURCE_CONFIG.map((source) => ({
			id: source.id,
			name: source.name,
			kind: source.kind,
			endpoint: source.feedUrl ?? source.endpoint,
			siteUrl: source.siteUrl,
			defaultCategory: source.defaultCategory,
			description: source.description,
			staleAfterHours: source.staleAfterHours,
			checkedAt: null,
			lastSuccessAt: null,
			latestItemAt: null,
			itemCount: 0,
			healthy: false,
			error: null,
		})),
	};
}

export async function loadArticlesMap() {
	await fs.mkdir(ARTICLES_DIR, { recursive: true });
	const entries = await fs.readdir(ARTICLES_DIR, { withFileTypes: true });
	const articles = new Map();

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) {
			continue;
		}

		const articlePath = path.join(ARTICLES_DIR, entry.name);
		const content = JSON.parse(await fs.readFile(articlePath, 'utf8'));
		articles.set(content.id, content);
	}

	return articles;
}

export async function loadStatusSnapshot() {
	try {
		const content = await fs.readFile(STATUS_FILE, 'utf8');
		const parsed = JSON.parse(content);
		const fallback = createEmptyStatus();
		const mergedSources = fallback.sources.map((source) => {
			const existing = parsed.sources?.find((entry) => entry.id === source.id);
			return existing ? { ...source, ...existing } : source;
		});

		return {
			...fallback,
			...parsed,
			sources: mergedSources,
			totals: {
				...fallback.totals,
				...parsed.totals,
				byCategory: {
					...fallback.totals.byCategory,
					...parsed.totals?.byCategory,
				},
			},
		};
	} catch {
		return createEmptyStatus();
	}
}

export function updateSourceStatus(snapshot, sourceId, updates) {
	const nextSources = snapshot.sources.map((source) =>
		source.id === sourceId
			? {
					...source,
					...updates,
				}
			: source,
	);

	return {
		...snapshot,
		sources: nextSources,
	};
}

export function buildArticleId({ sourceId, title, publishedDate, originalLink }) {
	const normalizedTitle = normalizeWhitespace(title).toLowerCase();
	const normalizedLink = normalizeWhitespace(originalLink ?? '').toLowerCase();
	const dateKey = normalizeDate(publishedDate);
	const hashInput = `${sourceId}|${normalizedTitle}|${dateKey}|${normalizedLink}`;
	const digest = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
	return `${sourceId}-${digest}`;
}

export function buildDedupKey({ title, publishedDate }) {
	const normalizedTitle = normalizeWhitespace(title)
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
	const dateKey = normalizeDate(publishedDate);
	return `${normalizedTitle}|${dateKey}`;
}

export function summarizeText(value, maxLength = 300) {
	const clean = normalizeWhitespace(decodeHtmlEntities(stripHtml(value)));
	if (!clean) {
		return 'Summary unavailable. Follow the original source for the full text.';
	}

	if (clean.length <= maxLength) {
		return clean;
	}

	return `${clean.slice(0, maxLength).trimEnd()}...`;
}

export function extractTags({ title = '', text = '', tags = [], defaultTags = [] }) {
	const sourceTags = [...defaultTags, ...tags]
		.map((tag) => slugify(tag))
		.filter(Boolean);
	const keywordTags = [];
	const haystack = `${title} ${text}`.toLowerCase();

	for (const [pattern, tag] of [
		[/\bgdpr\b/, 'gdpr'],
		[/\bai\b|\bartificial intelligence\b/, 'ai'],
		[/\bcross-border\b/, 'cross-border'],
		[/\bcookies?\b/, 'cookies'],
		[/\bchildren\b/, 'children'],
		[/\bcybersecurity\b/, 'cybersecurity'],
		[/\bhealth\b/, 'health'],
		[/\binternational\b/, 'international'],
		[/\btransfer\b/, 'transfers'],
		[/\benforcement\b|\bfine\b|\bsanction\b/, 'enforcement'],
	]) {
		if (pattern.test(haystack)) {
			keywordTags.push(tag);
		}
	}

	return [...new Set([...sourceTags, ...keywordTags])].slice(0, 8);
}

export function inferCategory(source, { title = '', summary = '' }) {
	const haystack = `${title} ${summary}`.toLowerCase();
	const keywordSets = source.categoryKeywords ?? {};

	for (const category of ['decisions', 'laws', 'guidance', 'standards', 'appointments']) {
		const matches = keywordSets[category] ?? [];
		if (matches.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
			return category;
		}
	}

	return source.defaultCategory;
}

export function shouldSkipBySourceRules(source, { title = '', summary = '' }) {
	const haystack = `${title} ${summary}`.toLowerCase();
	const titleLower = title.toLowerCase();

	for (const pattern of source.excludeTitlePatterns ?? []) {
		if (titleLower.includes(pattern.toLowerCase())) {
			return true;
		}
	}

	for (const pattern of source.excludePatterns ?? []) {
		if (haystack.includes(pattern.toLowerCase())) {
			return true;
		}
	}

	return false;
}

export function upsertArticle(map, article) {
	const existing = map.get(article.id);

	if (!existing) {
		map.set(article.id, article);
		return;
	}

	const summary =
		article.summary.length > existing.summary.length ? article.summary : existing.summary;
	const tags = [...new Set([...(existing.tags ?? []), ...(article.tags ?? [])])].slice(0, 8);

	map.set(article.id, {
		...existing,
		...article,
		summary,
		tags,
		fetchedAt: article.fetchedAt,
	});
}

export function removeArticlesBySourceId(map, sourceId) {
	for (const [id, article] of map.entries()) {
		if (article.sourceId === sourceId) {
			map.delete(id);
		}
	}
}

export function removeCrossSourceDuplicates(map) {
	const byDedupKey = new Map();
	const sourcePriority = new Map(SOURCE_CONFIG.map((source) => [source.id, source.priority ?? 0]));

	for (const article of map.values()) {
		const existing = byDedupKey.get(article.dedupKey);
		if (!existing) {
			byDedupKey.set(article.dedupKey, article);
			continue;
		}

		const existingPriority = sourcePriority.get(existing.sourceId) ?? 0;
		const articlePriority = sourcePriority.get(article.sourceId) ?? 0;
		const winner =
			articlePriority > existingPriority
				? article
				: articlePriority < existingPriority
					? existing
					: article.summary.length > existing.summary.length
						? article
						: existing;

		byDedupKey.set(article.dedupKey, winner);
	}

	map.clear();
	for (const article of byDedupKey.values()) {
		map.set(article.id, article);
	}
}

export async function persistSnapshot(articlesMap, statusSnapshot) {
	await fs.mkdir(ARTICLES_DIR, { recursive: true });
	await fs.mkdir(SYSTEM_DIR, { recursive: true });

	removeCrossSourceDuplicates(articlesMap);
	const retainedArticles = applyRetention([...articlesMap.values()]);
	const keepIds = new Set(retainedArticles.map((article) => article.id));
	const existingFiles = await fs.readdir(ARTICLES_DIR, { withFileTypes: true });

	for (const article of retainedArticles) {
		const articlePath = path.join(ARTICLES_DIR, `${article.id}.json`);
		await fs.writeFile(articlePath, `${JSON.stringify(article, null, 2)}\n`, 'utf8');
	}

	for (const entry of existingFiles) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) {
			continue;
		}

		const articleId = entry.name.replace(/\.json$/, '');
		if (!keepIds.has(articleId)) {
			await fs.unlink(path.join(ARTICLES_DIR, entry.name));
		}
	}

	const totals = retainedArticles.reduce(
		(accumulator, article) => {
			accumulator.byCategory[article.category] += 1;
			return accumulator;
		},
		{
			articles: retainedArticles.length,
			healthySources: statusSnapshot.sources.filter((source) => source.healthy).length,
			totalSources: statusSnapshot.sources.length,
			byCategory: {
				decisions: 0,
				laws: 0,
				guidance: 0,
				standards: 0,
				appointments: 0,
			},
		},
	);

	const nextStatus = {
		...statusSnapshot,
		generatedAt: new Date().toISOString(),
		retentionDays: RETENTION_DAYS,
		maxArticles: MAX_ARTICLES,
		totals,
	};

	await fs.writeFile(STATUS_FILE, `${JSON.stringify(nextStatus, null, 2)}\n`, 'utf8');
}

export function normalizeDate(value, fallback = new Date().toISOString().slice(0, 10)) {
	if (!value) {
		return fallback;
	}

	const raw = String(value).trim();
	if (!raw || /^(unknown|n\/a)$/i.test(raw)) {
		return fallback;
	}

	if (/^\d{4}$/.test(raw)) {
		return `${raw}-01-01`;
	}

	const dayFirstMatch = raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
	if (dayFirstMatch) {
		const [, day, month, year] = dayFirstMatch;
		return `${year}-${month}-${day}`;
	}

	const yearFirstMatch = raw.match(/^(\d{4})[./-](\d{2})[./-](\d{2})$/);
	if (yearFirstMatch) {
		const [, year, month, day] = yearFirstMatch;
		return `${year}-${month}-${day}`;
	}

	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) {
		return fallback;
	}

	return date.toISOString().slice(0, 10);
}

export function getLatestTimestamp(values) {
	const timestamps = values.filter(Boolean).map((value) => new Date(value).getTime());
	if (!timestamps.length) {
		return null;
	}

	return new Date(Math.max(...timestamps)).toISOString();
}

export function stripHtml(value = '') {
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ');
}

export function decodeHtmlEntities(value = '') {
	return value
		.replace(/&#(\d+);/g, (_, digits) => String.fromCharCode(Number(digits)))
		.replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCharCode(Number.parseInt(digits, 16)))
		.replace(/&([a-z]+);/gi, (_, entity) => ENTITY_MAP[entity] ?? `&${entity};`);
}

export function extractFirstLink(html = '') {
	const match = html.match(/href=['"]([^'"]+)['"]/i);
	return match?.[1] ?? null;
}

export function extractPlainText(value = '') {
	return normalizeWhitespace(decodeHtmlEntities(stripHtml(value)));
}

function applyRetention(articles) {
	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);

	return articles
		.filter((article) => new Date(article.publishedDate) >= cutoff)
		.sort((left, right) => {
			const rightDate = new Date(right.publishedDate).getTime();
			const leftDate = new Date(left.publishedDate).getTime();
			if (rightDate !== leftDate) {
				return rightDate - leftDate;
			}

			return right.fetchedAt.localeCompare(left.fetchedAt);
		})
		.slice(0, MAX_ARTICLES);
}

function normalizeWhitespace(value = '') {
	return value.replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
	return normalizeWhitespace(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
