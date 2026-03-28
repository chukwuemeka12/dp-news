import { SOURCE_CONFIG } from '../src/data/source-config.js';
import {
	buildArticleId,
	buildDedupKey,
	extractFirstLink,
	extractPlainText,
	extractTags,
	getLatestTimestamp,
	loadArticlesMap,
	loadStatusSnapshot,
	normalizeDate,
	persistSnapshot,
	removeArticlesBySourceId,
	summarizeText,
	updateSourceStatus,
	upsertArticle,
} from './lib/content-pipeline.js';

const source = SOURCE_CONFIG.find((entry) => entry.kind === 'enforcement');

if (!source) {
	throw new Error('Enforcement Tracker source configuration is missing.');
}

let articlesMap = await loadArticlesMap();
let statusSnapshot = await loadStatusSnapshot();
const checkedAt = new Date().toISOString();

try {
	removeArticlesBySourceId(articlesMap, source.id);

	const response = await fetch(source.endpoint, {
		headers: {
			'User-Agent': 'dp-news-fetcher/0.0.1',
		},
	});

	if (!response.ok) {
		throw new Error(`Enforcement Tracker returned ${response.status}`);
	}

	const payload = await response.json();
	const rows = payload?.data ?? [];
	const articles = rows
		.map((row) => {
			const etid = extractPlainText(row?.[1] ?? '');
			const country = extractPlainText(row?.[2] ?? '');
			const authority = extractPlainText(row?.[3] ?? '');
			const decisionDate = normalizeDate(row?.[4] ?? '', null);
			const publishedDate = decisionDate;
			const amount = extractPlainText(row?.[5] ?? '');
			const organisation = extractPlainText(row?.[6] ?? '');
			const sector = extractPlainText(row?.[7] ?? '');
			const legalBasis = extractPlainText(row?.[8] ?? '');
			const issue = extractPlainText(row?.[9] ?? '');
			const details = extractPlainText(row?.[10] ?? '');
			const officialLink = extractFirstLink(row?.[11] ?? '');
			const trackerLink = extractFirstLink(row?.[12] ?? '') ?? `${source.siteUrl}${etid}`;

			if (!etid || !country || !trackerLink || !decisionDate) {
				return null;
			}

			const titleParts = [`${country} enforcement action`];
			if (organisation) {
				titleParts.push(`against ${organisation}`);
			}
			if (amount) {
				titleParts.push(`(${amount})`);
			}

			const title = titleParts.join(' ');
			const summary = summarizeText(
				[issue, details, legalBasis ? `Legal basis: ${legalBasis}.` : '']
					.filter(Boolean)
					.join(' '),
				340,
			);
			const id = buildArticleId({
				sourceId: source.id,
				title: `${etid} ${title}`,
				publishedDate,
				originalLink: trackerLink,
			});

			return {
				id,
				title,
				source: source.name,
				sourceId: source.id,
				sourceUrl: source.siteUrl,
				publishedDate,
				decisionDate,
				authorityPublicationDate: null,
				platformPublicationDate: null,
				summary,
				category: 'decisions',
				dedupKey: buildDedupKey({ title, publishedDate }),
				tags: extractTags({
					title,
					text: `${summary} ${sector}`,
					tags: [country, sector, etid],
					defaultTags: source.defaultTags,
				}),
				originalLink: officialLink ?? trackerLink,
				fetchedAt: checkedAt,
			};
		})
		.filter(Boolean);

	for (const article of articles) {
		upsertArticle(articlesMap, article);
	}

	statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
		checkedAt,
		lastSuccessAt: checkedAt,
		latestItemAt: getLatestTimestamp(articles.map((item) => item.publishedDate)),
		itemCount: articles.length,
		healthy: articles.length > 0,
		error: articles.length > 0 ? null : 'Tracker returned zero usable rows.',
	});
} catch (error) {
	statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
		checkedAt,
		healthy: false,
		error: error instanceof Error ? error.message : 'Unknown enforcement tracker error',
	});
}

await persistSnapshot(articlesMap, statusSnapshot);
