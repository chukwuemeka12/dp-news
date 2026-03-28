import Parser from 'rss-parser';

import { SOURCE_CONFIG } from '../src/data/source-config.js';
import {
	buildArticleId,
	buildDedupKey,
	extractTags,
	getLatestTimestamp,
	inferCategory,
	loadArticlesMap,
	loadStatusSnapshot,
	normalizeDate,
	persistSnapshot,
	removeArticlesBySourceId,
	shouldSkipBySourceRules,
	summarizeText,
	updateSourceStatus,
	upsertArticle,
} from './lib/content-pipeline.js';

const parser = new Parser({
	timeout: 15000,
	headers: {
		'User-Agent': 'dp-news-fetcher/0.0.1',
	},
});

const rssSources = SOURCE_CONFIG.filter((source) => source.kind === 'rss');

let articlesMap = await loadArticlesMap();
let statusSnapshot = await loadStatusSnapshot();

for (const source of rssSources) {
	const checkedAt = new Date().toISOString();

	try {
		removeArticlesBySourceId(articlesMap, source.id);

		const feed = await parser.parseURL(source.feedUrl);
		const items = feed.items ?? [];
		const normalizedItems = items
			.map((item) => {
				const title = item.title?.trim();
				const originalLink = item.link?.trim() ?? item.guid?.trim();

				if (!title || !originalLink) {
					return null;
				}

				const summarySource =
					item.contentSnippet ?? item.content ?? item.summary ?? item.contentEncoded ?? '';
				const publishedDate = normalizeDate(item.isoDate ?? item.pubDate);
				const authorityPublicationDate =
					source.publicationDateSemantics === 'authority_and_platform' ? publishedDate : null;
				const platformPublicationDate = publishedDate;
				const summary = summarizeText(summarySource);
				const category = inferCategory(source, { title, summary });
				const fetchedAt = new Date().toISOString();

				if (shouldSkipBySourceRules(source, { title, summary })) {
					return null;
				}

				const id = buildArticleId({
					sourceId: source.id,
					title,
					publishedDate,
					originalLink,
				});

				return {
					id,
					title,
					source: source.name,
					sourceId: source.id,
					sourceUrl: source.siteUrl,
					publishedDate,
					decisionDate: null,
					authorityPublicationDate,
					platformPublicationDate,
					summary,
					category,
					dedupKey: buildDedupKey({ title, publishedDate }),
					tags: extractTags({
						title,
						text: summary,
						tags: item.categories ?? [],
						defaultTags: source.defaultTags,
					}),
					originalLink,
					fetchedAt,
				};
			})
			.filter(Boolean);

		for (const article of normalizedItems) {
			upsertArticle(articlesMap, article);
		}

		statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
			checkedAt,
			lastSuccessAt: checkedAt,
			latestItemAt: getLatestTimestamp(normalizedItems.map((item) => item.publishedDate)),
			itemCount: normalizedItems.length,
			healthy: normalizedItems.length > 0,
			error: normalizedItems.length > 0 ? null : 'Feed returned zero usable items.',
		});
	} catch (error) {
		statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
			checkedAt,
			healthy: false,
			error: error instanceof Error ? error.message : 'Unknown RSS error',
		});
	}
}

await persistSnapshot(articlesMap, statusSnapshot);
