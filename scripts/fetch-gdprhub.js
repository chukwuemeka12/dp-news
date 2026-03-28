import { SOURCE_CONFIG } from '../src/data/source-config.js';
import {
	buildArticleId,
	buildDedupKey,
	extractTags,
	getLatestTimestamp,
	loadArticlesMap,
	loadStatusSnapshot,
	normalizeDate,
	persistSnapshot,
	removeArticlesBySourceId,
	updateSourceStatus,
	upsertArticle,
} from './lib/content-pipeline.js';

const source = SOURCE_CONFIG.find((entry) => entry.kind === 'gdprhub');

if (!source) {
	throw new Error('GDPRhub source configuration is missing.');
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
		throw new Error(`GDPRhub API returned ${response.status}`);
	}

	const payload = await response.json();
	const changes = payload?.query?.recentchanges ?? [];
	const dedupedChanges = [...new Map(changes.map((item) => [item.title, item])).values()];
	const articles = dedupedChanges
		.filter((item) => item?.title && !item.title.includes(':'))
		.map((item) => {
			const platformPublicationDate = normalizeDate(item.timestamp);
			const publishedDate = platformPublicationDate;
			const originalLink = `https://gdprhub.eu/index.php?title=${encodeURIComponent(item.title)}`;
			const title = item.title.trim();
			const summary = buildGdprhubSummary(item);
			const countryMatch = title.match(/\(([^)]+)\)/);
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
				authorityPublicationDate: null,
				platformPublicationDate,
				summary,
				category: 'decisions',
				dedupKey: buildDedupKey({ title, publishedDate }),
				tags: extractTags({
					title,
					text: `${summary} ${countryMatch?.[1] ?? ''}`,
					tags: countryMatch?.[1] ? [countryMatch[1]] : [],
					defaultTags: source.defaultTags,
				}),
				originalLink,
				fetchedAt: checkedAt,
			};
		});

	for (const article of articles) {
		upsertArticle(articlesMap, article);
	}

	statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
		checkedAt,
		lastSuccessAt: checkedAt,
		latestItemAt: getLatestTimestamp(articles.map((item) => item.publishedDate)),
		itemCount: articles.length,
		healthy: articles.length > 0,
		error: articles.length > 0 ? null : 'API returned zero usable items.',
	});
} catch (error) {
	statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
		checkedAt,
		healthy: false,
		error: error instanceof Error ? error.message : 'Unknown GDPRhub error',
	});
}

await persistSnapshot(articlesMap, statusSnapshot);

function buildGdprhubSummary(item) {
	const title = item.title?.trim() || 'this case';
	const comment = item.comment || '';
	const type = item.type || 'edit';
	const jurisdiction = extractTemplateField(comment, 'Jurisdiction');
	const originalSource = extractTemplateField(comment, 'Original_Source_Name_1');
	const templateType = extractTemplateType(comment);
	const bodyType =
		templateType === 'COURTdecisionBOX'
			? 'court decision'
			: templateType === 'DPAdecisionBOX'
				? 'DPA decision'
				: 'case-law';

	const intro =
		type === 'new'
			? `New GDPRhub ${bodyType} added for ${title}.`
			: `GDPRhub updated its ${bodyType} record for ${title}.`;

	const details = [];
	if (jurisdiction) {
		details.push(`Jurisdiction: ${jurisdiction}.`);
	}
	if (originalSource) {
		details.push(`Original source listed by GDPRhub: ${originalSource}.`);
	}

	return [intro, ...details].join(' ').trim();
}

function extractTemplateField(comment, fieldName) {
	const pattern = new RegExp(`\\|${fieldName}=([^|"]+)`);
	const match = comment.match(pattern);
	return match?.[1]?.trim() || '';
}

function extractTemplateType(comment) {
	const match = comment.match(/\{\{([A-Za-z]+)\s*\|?/);
	return match?.[1] || '';
}
