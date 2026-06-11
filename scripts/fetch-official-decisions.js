import { DECISION_RETENTION_DAYS, SOURCE_CONFIG } from '../src/data/source-config.js';
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
	summarizeText,
	updateSourceStatus,
	upsertArticle,
} from './lib/content-pipeline.js';

const sourceIdFilter = parseSourceIdFilter(process.argv.slice(2));
const officialDecisionSources = SOURCE_CONFIG.filter(
	(source) => source.kind === 'official-decisions' && (!sourceIdFilter || source.id === sourceIdFilter),
);
const EDPS_PAGE_LIMIT = 25;
const OPC_CANADA_PAGE_LIMIT = 25;
const PDPC_PAGE_LIMIT = 40;

if (sourceIdFilter && officialDecisionSources.length === 0) {
	throw new Error(`Unknown official decision source id: ${sourceIdFilter}`);
}

let articlesMap = await loadArticlesMap();
let statusSnapshot = await loadStatusSnapshot();
const initialCounts = new Map();
for (const [id, article] of articlesMap.entries()) {
	initialCounts.set(article.sourceId, (initialCounts.get(article.sourceId) ?? 0) + 1);
}

console.log(`Loaded ${articlesMap.size} existing articles from disk.`);
console.log();

for (const source of officialDecisionSources) {
	const checkedAt = new Date().toISOString();
	const previousCount = initialCounts.get(source.id) ?? 0;

	try {
		const articles = await fetchOfficialDecisionSource(source, checkedAt);
		let removedCount = 0;

		if (articles.length > 0) {
			// Only replace existing articles when the fetch returned real data.
			// The previous pattern (delete-then-fetch) destroyed all stored articles
			// when a source returned zero results due to network errors, rate-limiting,
			// or site changes — a destructive failure mode discovered 2026-04-12.
			removedCount = previousCount;
			removeArticlesBySourceId(articlesMap, source.id);
			for (const article of articles) {
				upsertArticle(articlesMap, article);
			}
		}

		// Count how many articles for this source are now in the map.
		let currentCount = 0;
		for (const a of articlesMap.values()) {
			if (a.sourceId === source.id) currentCount++;
		}

		console.log(`[${source.id}] fetched=${articles.length} previous=${previousCount} persisted=${currentCount}${articles.length === 0 ? ' (zero results — existing articles preserved)' : ''}`);

		statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
			checkedAt,
			lastSuccessAt: articles.length > 0 ? checkedAt : undefined,
			latestItemAt: getLatestTimestamp(
				articles.map((item) => item.platformPublicationDate ?? item.authorityPublicationDate ?? item.decisionDate),
			),
			itemCount: articles.length,
			healthy: articles.length > 0,
			error: articles.length > 0 ? null : 'Decision source returned zero usable items (existing articles preserved).',
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown official decisions error';
		console.log(`[${source.id}] ERROR: ${message}`);
		statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
			checkedAt,
			healthy: false,
			error: message,
		});
	}
}

// Count per-source articles after dedup and retention (applied by persistSnapshot).
const preDedupSize = articlesMap.size;
await persistSnapshot(articlesMap, statusSnapshot);

console.log();
console.log(`Persist: ${preDedupSize} articles before dedup/retention → disk.`);

function parseSourceIdFilter(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === '--source-id') {
			return argv[index + 1] ?? null;
		}
	}

	return null;
}

async function fetchOfficialDecisionSource(source, checkedAt) {
	if (source.extractor === 'ico-enforcement-actions') {
		return fetchIcoEnforcementActions(source, checkedAt);
	}

	if (source.extractor === 'opc-canada-pipeda-investigations') {
		return fetchOpcCanadaBusinessInvestigations(source, checkedAt);
	}

	if (source.extractor === 'dpc-published-decisions') {
		return fetchDpcPublishedDecisions(source, checkedAt);
	}

	if (source.extractor === 'edps-investigations') {
		return fetchEdpsInvestigations(source, checkedAt);
	}

	if (source.extractor === 'pdpc-commissions-decisions') {
		return fetchPdpcCommissionDecisions(source, checkedAt);
	}

	if (source.extractor === 'odpc-determinations') {
		return fetchOdpcDeterminations(source, checkedAt);
	}

	if (source.extractor === 'cnil-enforcement-decisions') {
		return fetchCnilEnforcementDecisions(source, checkedAt);
	}

	if (source.extractor === 'aepd-enforcement-decisions') {
		return fetchAepdEnforcementDecisions(source, checkedAt);
	}

	throw new Error(`Unsupported official decisions extractor: ${source.extractor}`);
}

async function fetchIcoEnforcementActions(source, checkedAt) {
	const articles = [];

	for (let page = 1; ; page += 1) {
		const response = await fetchIcoSearchPage(source, page);
		const items = Array.isArray(response.results) ? response.results : [];

		if (items.length === 0) {
			break;
		}

		for (const item of items) {
			const relevantText = [item.title, item.description, item.filterItemMetaData].filter(Boolean).join(' ');
			if (!isRelevantIcoItem(relevantText)) {
				continue;
			}

			const detailUrl = absolutizeUrl('https://ico.org.uk', item.url);
			const detailHtml = await fetchIcoDetailHtml(detailUrl, source);
			const article =
				buildIcoArticle({ source, item, detailUrl, detailHtml, checkedAt }) ??
				buildIcoFallbackArticle({ source, item, detailUrl, checkedAt });
			if (article) {
				articles.push(article);
			}
		}

		if (typeof response.pagination?.totalPages === 'number' && page >= response.pagination.totalPages) {
			break;
		}

		await wait(250);
	}

	return articles;
}

async function fetchDpcPublishedDecisions(source, checkedAt) {
	const listingHtml = await fetchHtml(source.feedUrl);
	const listingItems = extractDpcListingItems(listingHtml);
	const articles = [];

	for (const item of listingItems) {
		const detailHtml = await fetchHtml(item.href);
		const article = buildDpcArticle({ source, item, detailHtml, checkedAt });
		if (article) {
			articles.push(article);
		}
	}

	return articles;
}

async function fetchEdpsInvestigations(source, checkedAt) {
	const articles = [];
	const seen = new Set();

	for (let page = 0; page < EDPS_PAGE_LIMIT; page += 1) {
		const pageUrl = page === 0 ? source.feedUrl : `${source.feedUrl}?page=${page}`;
		const listingHtml = await fetchHtml(pageUrl);
		const listingItems = extractEdpsListingItems(listingHtml);

		if (listingItems.length === 0) {
			break;
		}

		for (const item of listingItems) {
			const dedupeToken = item.documentUrl ?? item.detailUrl ?? `${item.title}|${item.publicationDate}`;
			if (seen.has(dedupeToken)) {
				continue;
			}

			seen.add(dedupeToken);

			const article = buildEdpsArticle({ source, item, checkedAt });
			if (article) {
				articles.push(article);
			}
		}
	}

	return articles;
}

async function fetchPdpcCommissionDecisions(source, checkedAt) {
	const searchPageHtml = await fetchHtml(source.searchPageUrl);
	const requestVerificationToken = extractMatch(
		searchPageHtml,
		/<input name="__RequestVerificationToken" type="hidden" value="([^"]+)"/i,
	);

	if (!requestVerificationToken) {
		throw new Error('PDPC search token not found.');
	}

	const articles = [];
	const cutoffDate = source.disableRetention ? null : getDecisionRetentionCutoff(checkedAt);

	for (let page = 1; page <= PDPC_PAGE_LIMIT; page += 1) {
		const payload = new URLSearchParams({
			keyword: '',
			type: 'cases',
			page: String(page),
		});
		const response = await fetchJson(source.searchEndpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				RequestVerificationToken: requestVerificationToken,
			},
			body: payload.toString(),
		});
		const items = Array.isArray(response.items) ? response.items : [];

		if (items.length === 0) {
			break;
		}

		let pageHasCurrentItem = false;
		for (const item of items) {
			const decisionDate = normalizeDate(item.date, null);
			if (!decisionDate) {
				continue;
			}

			if (cutoffDate && new Date(decisionDate) < cutoffDate) {
				continue;
			}

			pageHasCurrentItem = true;

			const detailUrl = absolutizeUrl('https://www.pdpc.gov.sg', item.url);
			const detailHtml = await fetchHtml(detailUrl);
			const article = buildPdpcArticle({ source, item, detailUrl, detailHtml, checkedAt });
			if (article) {
				articles.push(article);
			}
		}

		if (!pageHasCurrentItem && cutoffDate) {
			break;
		}

		if (typeof response.totalPages === 'number' && page >= response.totalPages) {
			break;
		}
	}

	return articles;
}

async function fetchOdpcDeterminations(source, checkedAt) {
	const pageUrls = [source.feedUrl, ...(source.archiveUrls ?? [])];
	const seen = new Set();
	const articles = [];

	for (const pageUrl of pageUrls) {
		const html = await fetchHtml(pageUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)',
			},
		});
		const items = extractOdpcDeterminationItems(html);

		for (const item of items) {
			if (seen.has(item.documentUrl)) {
				continue;
			}

			seen.add(item.documentUrl);

			const article = buildOdpcArticle({ source, item, checkedAt });
			if (article) {
				articles.push(article);
			}
		}
	}

	return articles;
}

async function fetchOpcCanadaBusinessInvestigations(source, checkedAt) {
	const articles = [];
	const seen = new Set();

	for (let page = 1; page <= OPC_CANADA_PAGE_LIMIT; page += 1) {
		const pageUrl = page === 1 ? source.feedUrl : `${source.feedUrl}?Filter=True&Page=${page}&o=d`;
		const listingHtml = await fetchHtml(pageUrl);
		const listingItems = extractOpcCanadaListingItems(listingHtml);

		if (listingItems.length === 0) {
			break;
		}

		for (const item of listingItems) {
			if (seen.has(item.detailUrl)) {
				continue;
			}

			seen.add(item.detailUrl);

			const detailHtml = await fetchHtml(item.detailUrl);
			const article = buildOpcCanadaArticle({ source, item, detailHtml, checkedAt });
			if (article) {
				articles.push(article);
			}

			await wait(250);
		}

		if (listingItems.length < 10) {
			break;
		}
	}

	return articles;
}

function buildDpcArticle({ source, item, detailHtml, checkedAt }) {
	const pageTitle =
		extractMatch(detailHtml, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ??
		extractMatch(detailHtml, /<h2[^>]*>([\s\S]*?)<\/h2>/i) ??
		item.title;
	const title = cleanHtmlText(pageTitle);
	const caseReference = cleanHtmlText(extractMatch(detailHtml, /<h3[^>]*>\s*\(([^)]+)\)\s*<\/h3>/i) ?? '');
	const decisionDateRaw = extractMatch(detailHtml, /Date of [Dd]ecision:\s*([^<\n]+)/i);
	const platformDateRaw = extractStandaloneDate(detailHtml);
	const decisionDate = normalizeDate(decisionDateRaw, null);
	const platformPublicationDate = normalizeDate(platformDateRaw, null);
	const authorityPublicationDate = platformPublicationDate;
	const summary = buildDpcSummary(detailHtml);
	const sourceDetailUrl = item.href;
	const documentUrl = extractDpcDocumentUrl(detailHtml);
	const originalDocumentUrl = documentUrl ?? sourceDetailUrl;

	if (!title || !decisionDate || !summary) {
		return null;
	}

	const textForTags = [summary, caseReference].filter(Boolean).join(' ');
	const id = buildArticleId({
		sourceId: source.id,
		title,
		publishedDate: decisionDate,
		originalLink: originalDocumentUrl,
	});

	const publishedDate = platformPublicationDate ?? authorityPublicationDate ?? decisionDate;

	return {
		id,
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate,
		decisionDate,
		authorityPublicationDate,
		platformPublicationDate,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title, publishedDate: decisionDate }),
		tags: extractTags({
			title,
			text: textForTags,
			tags: caseReference ? [caseReference] : [],
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({ sourceDetailUrl, documentUrl }),
		originalLink: originalDocumentUrl,
		fetchedAt: checkedAt,
	};
}

function buildIcoArticle({ source, item, detailUrl, detailHtml, checkedAt }) {
	if (!detailHtml) {
		return null;
	}

	const title = cleanHtmlText(extractMatch(detailHtml, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || cleanHtmlText(item.title);
	const decisionDateRaw = extractLabeledStrongText(detailHtml, 'Date') || extractIcoMetaDate(item.filterItemMetaData);
	const decisionDate = normalizeDate(decisionDateRaw, null);
	const enforcementType =
		extractLabeledStrongText(detailHtml, 'Type') || extractIcoMetadataParts(item.filterItemMetaData).join(', ');
	const summary = buildIcoSummary(detailHtml, item.description);
	const documentUrl = extractIcoDocumentUrl(detailHtml);
	const sourceDetailUrl = detailUrl;
	const originalDocumentUrl = documentUrl ?? sourceDetailUrl;

	if (!title || !decisionDate || !summary) {
		return null;
	}

	const id = buildArticleId({
		sourceId: source.id,
		title,
		publishedDate: decisionDate,
		originalLink: originalDocumentUrl,
	});
	const metadataParts = extractIcoMetadataParts(item.filterItemMetaData);
	const tagSeeds = metadataParts.filter(Boolean);

	return {
		id,
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate: decisionDate,
		decisionDate,
		authorityPublicationDate: decisionDate,
		platformPublicationDate: decisionDate,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title, publishedDate: decisionDate }),
		tags: extractTags({
			title,
			text: [summary, enforcementType, ...metadataParts].filter(Boolean).join(' '),
			tags: tagSeeds,
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({ sourceDetailUrl, documentUrl }),
		originalLink: originalDocumentUrl,
		fetchedAt: checkedAt,
	};
}

function buildIcoFallbackArticle({ source, item, detailUrl, checkedAt }) {
	const title = cleanHtmlText(item.title);
	const decisionDate = normalizeDate(extractIcoMetaDate(item.filterItemMetaData), null);
	const metadataParts = extractIcoMetadataParts(item.filterItemMetaData);
	const summary = summarizeText(cleanHtmlText(item.description), 340);
	if (!title || !decisionDate || !summary) {
		return null;
	}

	return {
		id: buildArticleId({
			sourceId: source.id,
			title,
			publishedDate: decisionDate,
			originalLink: detailUrl,
		}),
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate: decisionDate,
		decisionDate,
		authorityPublicationDate: decisionDate,
		platformPublicationDate: decisionDate,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title, publishedDate: decisionDate }),
		tags: extractTags({
			title,
			text: [summary, ...metadataParts].join(' '),
			tags: metadataParts,
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({ sourceDetailUrl: detailUrl, documentUrl: null }),
		originalLink: detailUrl,
		fetchedAt: checkedAt,
	};
}

function buildEdpsArticle({ source, item, checkedAt }) {
	const relevantText = [item.title, item.summary].filter(Boolean).join(' ');
	if (!isRelevantEdpsItem(relevantText)) {
		return null;
	}

	const decisionDate = normalizeDate(item.publicationDate, null);
	if (!item.title || !decisionDate || !item.summary) {
		return null;
	}

	const id = buildArticleId({
		sourceId: source.id,
		title: item.title,
		publishedDate: decisionDate,
		originalLink: item.documentUrl ?? item.detailUrl,
	});

	return {
		id,
		title: item.title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate: decisionDate,
		decisionDate,
		authorityPublicationDate: decisionDate,
		platformPublicationDate: decisionDate,
		summary: summarizeText(item.summary, 340),
		category: 'decisions',
		dedupKey: buildDedupKey({ title: item.title, publishedDate: decisionDate }),
		tags: extractTags({
			title: item.title,
			text: [item.summary, ...(item.topics ?? [])].join(' '),
			tags: item.topics ?? [],
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({
			sourceDetailUrl: item.detailUrl || source.siteUrl,
			documentUrl: item.documentUrl || null,
		}),
		originalLink: item.documentUrl ?? item.detailUrl ?? source.siteUrl,
		fetchedAt: checkedAt,
	};
}

function buildPdpcArticle({ source, item, detailUrl, detailHtml, checkedAt }) {
	const detailTitle = cleanHtmlText(extractMatch(detailHtml, /<h2 class="page-title">([\s\S]*?)<\/h2>/i));
	const detailDate = cleanHtmlText(extractMatch(detailHtml, /<p class="page-date">([\s\S]*?)<\/p>/i));
	const decisionDate = normalizeDate(detailDate || item.date, null);
	const pdfHref =
		extractLinkedDocument(detailHtml, /\.pdf/i) ||
		extractMatch(detailHtml, /href="([^"]+\/pdf-files\/commissions-decisions\/[^"]+\.pdf)"/i);
	const documentUrl = pdfHref ? absolutizeUrl('https://www.pdpc.gov.sg', pdfHref) : null;
	const sourceDetailUrl = detailUrl;
	const originalDocumentUrl = documentUrl ?? sourceDetailUrl;
	const summary = buildPdpcSummary(detailHtml, item.description);
	const title = detailTitle || item.title;

	if (!title || !decisionDate || !summary) {
		return null;
	}

	const id = buildArticleId({
		sourceId: source.id,
		title,
		publishedDate: decisionDate,
		originalLink: originalDocumentUrl,
	});

	const tagSeeds = [item.nature, item.decision]
		.flatMap((value) => String(value ?? '').split(','))
		.map((value) => value.trim())
		.filter(Boolean);

	return {
		id,
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate: decisionDate,
		decisionDate,
		authorityPublicationDate: decisionDate,
		platformPublicationDate: decisionDate,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title, publishedDate: decisionDate }),
		tags: extractTags({
			title,
			text: [summary, item.nature, item.decision].filter(Boolean).join(' '),
			tags: tagSeeds,
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({ sourceDetailUrl, documentUrl }),
		originalLink: originalDocumentUrl,
		fetchedAt: checkedAt,
	};
}

function buildOdpcArticle({ source, item, checkedAt }) {
	const publishedDate = normalizeDate(item.publicationDate, null);
	if (!item.complaintReference || !item.parties || !publishedDate || !item.documentUrl) {
		return null;
	}

	const title = `${item.complaintReference} - ${item.parties}`;
	const summary = summarizeText(
		`Official ODPC determination ${item.complaintReference} involving ${item.parties}. Determination PDF published by the Office of the Data Protection Commissioner of Kenya.`,
		320,
	);
	const id = buildArticleId({
		sourceId: source.id,
		title,
		publishedDate,
		originalLink: item.documentUrl,
	});

	const extraTags = item.complaintReference.includes('/SM/') ? ['suo-moto'] : [];

	return {
		id,
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate,
		decisionDate: publishedDate,
		authorityPublicationDate: publishedDate,
		platformPublicationDate: publishedDate,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title, publishedDate }),
		tags: extractTags({
			title,
			text: `${item.complaintReference} ${item.parties}`,
			tags: [item.complaintReference, ...extraTags],
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({
			sourceDetailUrl: source.siteUrl,
			documentUrl: item.documentUrl,
		}),
		originalLink: item.documentUrl,
		fetchedAt: checkedAt,
	};
}

function buildOpcCanadaArticle({ source, item, detailHtml, checkedAt }) {
	const title = cleanHtmlText(extractMatch(detailHtml, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || item.title;
	const decisionDate = item.decisionDate ?? item.platformPublicationDate;
	const authorityPublicationDate = decisionDate;
	const platformPublicationDate = item.platformPublicationDate;
	const publishedDate = platformPublicationDate ?? authorityPublicationDate ?? decisionDate;
	const summary = buildOpcCanadaSummary(detailHtml, item.title);
	const documentUrl = extractOpcCanadaDocumentUrl(detailHtml);
	const sourceDetailUrl = item.detailUrl;
	const originalDocumentUrl = documentUrl ?? sourceDetailUrl;

	if (!title || !decisionDate || !summary) {
		return null;
	}

	const dispositionTags = extractOpcCanadaDispositionTags(detailHtml);
	const id = buildArticleId({
		sourceId: source.id,
		title,
		publishedDate: decisionDate,
		originalLink: originalDocumentUrl,
	});

	return {
		id,
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate,
		decisionDate,
		authorityPublicationDate,
		platformPublicationDate,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title, publishedDate: decisionDate }),
		tags: extractTags({
			title,
			text: [summary, item.itemType, ...dispositionTags].filter(Boolean).join(' '),
			tags: [item.itemType, ...dispositionTags],
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({ sourceDetailUrl, documentUrl }),
		originalLink: originalDocumentUrl,
		fetchedAt: checkedAt,
	};
}

// ─── CNIL Enforcement Decisions ────────────────────────────────────────────────

async function fetchCnilEnforcementDecisions(source, checkedAt) {
	const articles = [];
	const seen = new Set();

	// Primary source: the sanctions listing page (table of all restricted committee decisions)
	const listingHtml = await fetchHtml(source.feedUrl, {
		headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)' },
	});

	const listingItems = extractCnilSanctionTableItems(listingHtml);
	console.log(`  CNIL sanctions listing: ${listingItems.length} items found`);

	for (const item of listingItems) {
		if (seen.has(item.detailUrl)) continue;
		seen.add(item.detailUrl);

		await wait(800);

		let detailHtml = null;
		try {
			detailHtml = await fetchHtml(item.detailUrl, {
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)' },
			});
		} catch {
			console.warn(`  CNIL: failed to fetch detail page ${item.detailUrl}`);
		}

		const builtArticles = buildCnilArticles({ source, item, detailHtml, checkedAt });
		for (const article of builtArticles) {
			articles.push(article);
		}
	}

	// Supplementary: tag page(s) for decisions not yet in the sanctions table
	for (const tagUrl of source.tagPageUrls ?? []) {
		let page = 0;
		let tagPageUrl = tagUrl;

		while (tagPageUrl) {
			const tagHtml = await fetchHtml(tagPageUrl, {
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)' },
			});

			const tagItems = extractCnilTagPageItems(tagHtml);
			for (const tagItem of tagItems) {
				if (seen.has(tagItem.detailUrl)) continue;
				seen.add(tagItem.detailUrl);

				await wait(800);

				let detailHtml = null;
				try {
					detailHtml = await fetchHtml(tagItem.detailUrl, {
						headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)' },
					});
				} catch {
					console.warn(`  CNIL: failed to fetch tag-page detail ${tagItem.detailUrl}`);
				}

				const builtArticles = buildCnilArticles({ source, item: tagItem, detailHtml, checkedAt });
				for (const article of builtArticles) {
					articles.push(article);
				}
			}

			// Follow pagination — CNIL uses ?page=N
			page += 1;
			const nextLink = extractMatch(tagHtml, /href="([^"]*\?page=\d+)"[^>]*rel="next"/i)
				?? extractMatch(tagHtml, /<a[^>]+href="([^"]*\?page=\d+)"[^>]*>\s*(?:Next|›|»)/i);
			tagPageUrl = nextLink ? absolutizeUrl('https://www.cnil.fr', nextLink) : null;

			if (page > 30) break; // safety limit
		}
	}

	console.log(`  CNIL total: ${articles.length} enforcement decisions`);
	return articles;
}

/**
 * Parse the CNIL sanctions listing table at
 * /en/investigation-powers-cnil/sanctions-issued-cnil
 *
 * The page contains a structured table with columns like:
 *   Date | Organisation | Type | Main breach/theme | Decision adopted
 * Each row links to a detail page.
 */
function extractCnilSanctionTableItems(html) {
	// CNIL uses a table or structured listing — extract rows with links
	const items = [];

	// Pattern 1: table rows with links
	const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
	for (const row of rows) {
		const rowHtml = row[1];
		const href = extractMatch(rowHtml, /href="([^"]+)"/i);
		if (!href || href.includes('#') || href === '/') continue;

		const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cleanHtmlText(m[1]));
		if (cells.length < 2) continue;

		const detailUrl = absolutizeUrl('https://www.cnil.fr', href);
		// Skip non-decision links (navigation, header links, etc.)
		if (!detailUrl.includes('cnil.fr/en/') && !detailUrl.includes('cnil.fr/fr/')) continue;

		items.push({
			detailUrl,
			organisation: cells[1] ?? cells[0] ?? '',
			dateText: cells[0] ?? '',
			breachTheme: cells.length >= 4 ? cells[3] : '',
			decisionType: cells.length >= 5 ? cells[4] : '',
		});
	}

	// Pattern 2: if the page uses article/card layout instead of a table
	if (items.length === 0) {
		const links = [...html.matchAll(/<a[^>]+href="(\/en\/[^"]*(?:sanction|fine|decision|enforcement)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
		for (const link of links) {
			const detailUrl = absolutizeUrl('https://www.cnil.fr', link[1]);
			const title = cleanHtmlText(link[2]);
			if (!title || title.length < 5) continue;
			items.push({
				detailUrl,
				organisation: title,
				dateText: '',
				breachTheme: '',
				decisionType: '',
			});
		}
	}

	return items;
}

/**
 * Parse the CNIL tag page (e.g. /en/tag/Sanctions) for linked sanction articles.
 */
function extractCnilTagPageItems(html) {
	const items = [];
	// Tag pages typically list articles as linked cards or teasers
	const links = [...html.matchAll(/<a[^>]+href="(\/en\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
	const seen = new Set();

	for (const link of links) {
		const href = link[1];
		const title = cleanHtmlText(link[2]);
		if (!title || title.length < 10) continue;
		// Filter to enforcement-relevant pages
		if (!/sanction|fine|formal.?notice|enforcement|decision|penalty/i.test(title) && !/sanction|fine|penalty/i.test(href)) continue;
		const detailUrl = absolutizeUrl('https://www.cnil.fr', href);
		if (seen.has(detailUrl)) continue;
		seen.add(detailUrl);

		items.push({
			detailUrl,
			organisation: title,
			dateText: '',
			breachTheme: '',
			decisionType: '',
		});
	}

	return items;
}

function buildCnilArticles({ source, item, detailHtml, checkedAt }) {
	// Try to extract title from detail page, fall back to listing data
	const pageTitle = detailHtml
		? (extractMatch(detailHtml, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || item.organisation)
		: item.organisation;
	const parentTitle = cleanHtmlText(pageTitle);
	if (!parentTitle || parentTitle.length < 3) return [];

	// Extract decision date from the detail page or listing
	const decisionDate = extractCnilDecisionDate(detailHtml, item.dateText);
	if (!decisionDate) return [];

	// Build summary from detail page content
	const summary = detailHtml ? buildCnilSummary(detailHtml) : summarizeText(parentTitle, 320);

	// Extract one or more official deliberation links from the detail page
	const deliberations = detailHtml ? extractCnilDeliberationLinks(detailHtml) : [];
	if (deliberations.length === 0) {
		return [];
	}

	// Extract fine amount if present
	const fineAmount = extractCnilFineAmount(detailHtml ?? parentTitle);
	const extraTags = [];
	if (fineAmount) extraTags.push(`fine-${fineAmount}`);
	if (item.breachTheme) extraTags.push(...item.breachTheme.toLowerCase().split(/[,;]+/).map((s) => s.trim()).filter(Boolean));

	return deliberations.map((deliberation) => {
		const title = deliberation.title || parentTitle;
		const documentUrl = deliberation.documentUrl;
		const id = buildArticleId({
			sourceId: source.id,
			title,
			publishedDate: decisionDate,
			originalLink: documentUrl ?? item.detailUrl,
		});
		const deliberationTags = deliberation.caseReference ? [deliberation.caseReference] : [];

		return {
			id,
			title,
			source: source.name,
			sourceId: source.id,
			sourceUrl: source.siteUrl,
			publishedDate: decisionDate,
			decisionDate,
			authorityPublicationDate: decisionDate,
			platformPublicationDate: decisionDate,
			summary,
			category: 'decisions',
			dedupKey: buildDedupKey({ title, publishedDate: decisionDate }),
			tags: extractTags({
				title,
				text: [summary, item.breachTheme, item.decisionType, parentTitle].filter(Boolean).join(' '),
				tags: [...extraTags, ...deliberationTags],
				defaultTags: source.defaultTags,
			}),
			...buildDocumentFields({
				sourceDetailUrl: item.detailUrl,
				documentUrl,
			}),
			originalLink: documentUrl ?? item.detailUrl,
			fetchedAt: checkedAt,
		};
	});
}

function extractCnilDecisionDate(detailHtml, listingDateText) {
	if (detailHtml) {
		// Pattern: "Deliberation of restricted committee No SAN-YYYY-NNN of DD Month YYYY"
		const deliberationDate = extractMatch(detailHtml, /(?:Deliberation|Délibération)[^<]*?(\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4})/i);
		if (deliberationDate) {
			const parsed = normalizeDate(deliberationDate, null);
			if (parsed) return parsed;
		}

		// Pattern: date in meta tags
		const metaDate = extractMatch(detailHtml, /<meta[^>]+(?:article:published_time|datePublished)[^>]+content="([^"]+)"/i);
		if (metaDate) {
			const parsed = normalizeDate(metaDate, null);
			if (parsed) return parsed;
		}

		// Pattern: standalone date near top of page
		const standaloneDate = extractStandaloneDate(detailHtml);
		if (standaloneDate) {
			const parsed = normalizeDate(standaloneDate, null);
			if (parsed) return parsed;
		}
	}

	// Fall back to the listing date text
	if (listingDateText) {
		return normalizeDate(listingDateText, null);
	}

	return null;
}

function extractCnilDeliberationLinks(html) {
	const sectionHtml =
		extractMatch(html, /<h2[^>]*>\s*(?:Deliberations|Délibérations)\s*<\/h2>([\s\S]*?)(?:<h2|$)/i)
		|| html;
	const links = [...sectionHtml.matchAll(/<a[^>]+href="([^"]+legifrance[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
		.map((match) => {
			const documentUrl = absolutizeUrl('https://www.cnil.fr', match[1]);
			const rawTitle = cleanHtmlText(match[2]);
			const title = rawTitle
				.replace(/\s*[-–]\s*L[ée]gifrance\s*$/i, '')
				.replace(/\s*\(in French\)\s*$/i, '')
				.trim();
			const caseReference = extractMatch(title, /\b((?:SAN|MED|MEDP|RCS)-\d{4}-\d{2,4})\b/i).toUpperCase();

			return {
				documentUrl,
				title,
				caseReference: caseReference || '',
			};
		})
		.filter((entry) => entry.documentUrl && entry.title);

	const seen = new Set();
	return links.filter((entry) => {
		if (seen.has(entry.documentUrl)) {
			return false;
		}
		seen.add(entry.documentUrl);
		return true;
	});
}

function buildCnilSummary(html) {
	// Extract the lead paragraph or article body
	const lead = cleanHtmlText(
		extractMatch(html, /<div[^>]+class="[^"]*(?:field--name-body|text-long|article-body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
		|| extractMatch(html, /<article[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i)
		|| '',
	).trim();
	return lead ? summarizeText(lead, 340) : '';
}

function extractCnilFineAmount(text) {
	const match = text?.match(/€\s*([\d,. ]+)\s*(million|billion)?/i)
		?? text?.match(/([\d,. ]+)\s*(?:million|billion)?\s*euro/i);
	if (!match) return null;
	const amount = match[1].replace(/\s/g, '').replace(/,/g, '');
	const unit = match[2]?.toLowerCase() ?? '';
	if (unit === 'million') return `${amount}m-eur`;
	if (unit === 'billion') return `${amount}b-eur`;
	return `${amount}-eur`;
}

function extractOpcCanadaListingItems(html) {
	const items = [];
	const listHtml =
		extractMatch(html, /<div class="opc-big-list">([\s\S]*?)<\/div>\s*(?:<nav|<div class="pagedetails"|$)/i)
		|| html;
	const titleMatches = [...listHtml.matchAll(/<h2 class="item-title">\s*<a[^>]+href="([^"]+)">([\s\S]*?)<\/a>\s*<\/h2>/gi)];

	for (const [index, match] of titleMatches.entries()) {
		const blockStart = listHtml.lastIndexOf('<div class="item">', match.index ?? 0);
		const blockEnd = titleMatches[index + 1]?.index ?? listHtml.length;
		const block = listHtml.slice(blockStart >= 0 ? blockStart : match.index ?? 0, blockEnd);
		const itemType = cleanHtmlText(
			extractMatch(block, /<span class="item-type">\s*<strong>([\s\S]*?)<\/strong>\s*<\/span>/i),
		);
		const detailHref = match[1] ?? '';
		const title = cleanHtmlText(match[2] ?? '');
		const firstDate = extractMatch(block, /<time class="item-date" datetime="([^"]+)"/i);
		const findingsDate = extractMatch(block, /Date of findings:\s*<time class="item-date" datetime="([^"]+)"/i);
		const platformPublicationDate = normalizeDate(firstDate, null);
		const decisionDate = normalizeDate(findingsDate, platformPublicationDate);

		if (!title || !detailHref || !platformPublicationDate) {
			continue;
		}

		items.push({
			title,
			itemType,
			detailUrl: absolutizeUrl('https://www.priv.gc.ca', detailHref),
			platformPublicationDate,
			decisionDate,
		});
	}

	return items;
}

function buildOpcCanadaSummary(detailHtml, fallbackTitle) {
	const primaryCandidates = [
		extractMatch(detailHtml, /<h3[^>]*>\s*Takeaways\s*<\/h3>\s*<p>([\s\S]*?)<\/p>/i),
		extractMatch(detailHtml, /<h3[^>]*>\s*Overview\s*<\/h3>\s*<ol[^>]*>[\s\S]*?<li[^>]*>([\s\S]*?)<\/li>/i),
		extractMatch(detailHtml, /<h2[^>]*>\s*Summary of Investigation\s*<\/h2>\s*<p>([\s\S]*?)<\/p>/i),
	]
		.map((value) => cleanHtmlText(value))
		.filter(Boolean);

	if (primaryCandidates.length > 0) {
		return summarizeText(primaryCandidates[0], 340);
	}

	const mainContent = extractMatch(
		detailHtml,
		/<section class="col-md-12" aria-label="Main content">([\s\S]*?)<\/section>/i,
	);
	const paragraphs = [...mainContent.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
		.map((match) => cleanHtmlText(match[1]))
		.filter(Boolean);
	const usefulParagraphs = paragraphs.filter((paragraph) => isUsefulOpcCanadaSummaryParagraph(paragraph));
	const summaryText = (usefulParagraphs.length > 0 ? usefulParagraphs : paragraphs).slice(0, 2).join(' ');

	return summarizeText(summaryText || fallbackTitle, 340);
}

function isUsefulOpcCanadaSummaryParagraph(paragraph) {
	const normalized = paragraph.toLowerCase();
	return (
		paragraph.length >= 40
		&& !normalized.includes('made public the following')
		&& !normalized.startsWith('for more information:')
		&& !normalized.startsWith('dear ')
		&& !normalized.startsWith('yours sincerely')
	);
}

function extractOpcCanadaDispositionTags(detailHtml) {
	const outcomeText = cleanHtmlText(
		extractMatch(detailHtml, /<h3[^>]*>\s*Conclusion\s*<\/h3>([\s\S]*?)(?:<aside|<h2|<\/section>)/i)
		|| extractMatch(detailHtml, /<h2[^>]*>\s*Outcome\s*<\/h2>([\s\S]*?)(?:<h2|<hr|<\/section>)/i)
		|| '',
	).toLowerCase();
	const knownDispositions = [
		'well-founded and conditionally resolved',
		'well-founded and resolved',
		'not well-founded',
		'well-founded',
		'resolved',
		'settled',
		'early resolved',
		'discontinued',
		'no jurisdiction',
	];

	return knownDispositions.filter((value) => outcomeText.includes(value));
}

function extractOpcCanadaDocumentUrl(detailHtml) {
	const mainContent =
		extractMatch(detailHtml, /<section class="col-md-12" aria-label="Main content">([\s\S]*?)<\/section>/i)
		|| detailHtml;
	const contentBeforeFootnotes = mainContent.split(/<aside\b/i)[0] ?? mainContent;
	const candidates = collectMatches(contentBeforeFootnotes, /href="([^"]+)"/gi)
		.map((href) => absolutizeUrl('https://www.priv.gc.ca', href))
		.filter((href) => isOpcCanadaPdfUrl(href));

	return candidates[0] ?? null;
}

function isOpcCanadaPdfUrl(url) {
	if (!/\.pdf(?:$|[?#])/i.test(url)) {
		return false;
	}

	try {
		const parsed = new URL(url);
		return /(?:^|\.)priv\.gc\.ca$/i.test(parsed.hostname);
	} catch {
		return false;
	}
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function buildDocumentFields({ sourceDetailUrl = null, documentUrl = null }) {
	return {
		sourceDetailUrl,
		documentUrl,
		localDocumentUrl: null,
		documentContentType: null,
		documentSizeBytes: null,
		documentSha256: null,
		documentDownloadedAt: null,
		documentDownloadError: null,
	};
}

async function fetchHtml(url, init = {}) {
	const response = await fetch(url, buildFetchOptions(init));
	return handleFetchResponse(response, url, 'text');
}

async function fetchJson(url, init = {}) {
	const response = await fetch(url, buildFetchOptions(init));
	return handleFetchResponse(response, url, 'json');
}

async function fetchIcoDetailHtml(url, source) {
	const init = {
		headers: {
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-GB,en;q=0.9',
			Referer: source.feedUrl,
		},
	};

	try {
		return await fetchHtml(url, init);
	} catch (error) {
		if (!(error instanceof Error) || !/\b403\b/.test(error.message)) {
			throw error;
		}

		await wait(500);
		try {
			return await fetchHtml(url, init);
		} catch {
			return null;
		}
	}
}

async function fetchIcoSearchPage(source, page) {
	const init = {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-GB,en;q=0.9',
			Referer: source.feedUrl,
		},
		body: JSON.stringify({
			rootPageId: source.rootPageId,
			pageNumber: page,
			order: 'newest',
			filters: [
				{
					key: 'entype',
					values: source.enforcementTypes,
				},
			],
		}),
	};

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await fetchJson(source.searchEndpoint, init);
		} catch (error) {
			if (!(error instanceof Error) || !/\b403\b/.test(error.message) || attempt === 2) {
				throw error;
			}

			await wait(1000 * (attempt + 1));
		}
	}

	throw new Error(`ICO search did not return page ${page}.`);
}

function buildFetchOptions(init = {}) {
	return {
		...init,
		headers: {
			'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)',
			Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
			...(init.headers ?? {}),
		},
	};
}

async function handleFetchResponse(response, url, responseType) {
	if (!response.ok) {
		throw new Error(`Official decision source returned ${response.status} for ${url}`);
	}

	return responseType === 'json' ? response.json() : response.text();
}

function extractDpcListingItems(html) {
	const items = [];
	const seen = new Set();
	const pattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

	for (const match of html.matchAll(pattern)) {
		const href = absolutizeUrl('https://www.dataprotection.ie', match[1]);
		const title = cleanHtmlText(match[2]);

		if (!href.includes('/decisions') && !href.includes('/decisions-made-under-data-protection-act-2018/')) {
			continue;
		}

		if (!/inquiry|decision|operations limited|council|commissioner|platforms|university|garda/i.test(title)) {
			continue;
		}

		if (seen.has(href)) {
			continue;
		}

		seen.add(href);
		items.push({ href, title });
	}

	return items;
}

function extractEdpsListingItems(html) {
	return html
		.split('<div class="views-row">')
		.slice(1)
		.map((block) => {
			const dateMatch = block.match(
				/<div class="edpsweb-publication-date">\s*<div>([^<]+)<\/div>\s*<div>([^<]+)<\/div>\s*<div>([^<]+)<\/div>/i,
			);
			const detailHref = extractMatch(block, /<h3[^>]*>\s*<a[^>]+href="([^"]+)"/i);
			const title = cleanHtmlText(extractMatch(block, /<h3[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i));
			const summary = cleanHtmlText(
				extractMatch(
					block,
					/<div class="clearfix text-formatted field field--name-field-edpsweb-body[\s\S]*?<p>([\s\S]*?)<\/p>/i,
				),
			);
			const documentHref =
				extractMatch(block, /<a class="file-download[^"]*"[^>]+href="([^"]+)"/i) ||
				extractMatch(block, /data-url="([^"]+\.pdf)"/i);
			const topicsSection = block.match(
				/<div class="field__label">Topics<\/div>[\s\S]*?<div class='field__items'>([\s\S]*?)<\/div>\s*<\/div>/i,
			)?.[1];
			const topics = topicsSection
				? [...topicsSection.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/gi)]
						.map((match) => cleanHtmlText(match[1]))
						.filter(Boolean)
				: [];

			const publicationDate = dateMatch
				? `${cleanHtmlText(dateMatch[1])} ${cleanHtmlText(dateMatch[2])} ${cleanHtmlText(dateMatch[3])}`
				: '';

			return {
				title,
				summary,
				publicationDate,
				detailUrl: detailHref ? absolutizeUrl('https://www.edps.europa.eu', detailHref) : '',
				documentUrl: documentHref ? absolutizeUrl('https://www.edps.europa.eu', documentHref) : '',
				topics,
			};
		})
		.filter((item) => item.title && item.summary && item.publicationDate);
}

function extractOdpcDeterminationItems(html) {
	return [...html.matchAll(/<tr data-row_id="[^"]+"[\s\S]*?<\/tr>/gi)]
		.map((match) => {
			const row = match[0];
			const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((cellMatch) => cleanHtmlText(cellMatch[1]));
			const documentHref = extractMatch(row, /href="([^"]+)"/i);
			const publicationDate = deriveDateFromUploadUrl(documentHref);

			return {
				complaintReference: cells[0] ?? '',
				parties: cells[1] ?? '',
				documentUrl: documentHref ? absolutizeUrl('https://www.odpc.go.ke', documentHref) : '',
				publicationDate,
			};
		})
		.filter((item) => item.complaintReference && item.parties && item.documentUrl);
}

function buildDpcSummary(html) {
	const intro = extractParagraphAfterDate(html);
	const findings = extractSectionList(html, 'Summary of Findings');
	const correctiveMeasures = extractSectionList(html, 'Corrective Measures');
	const findingsText = findings.length > 0 ? `Findings: ${findings.join(' ')}` : '';
	const measuresText = correctiveMeasures.length > 0 ? `Corrective measures: ${correctiveMeasures.join(' ')}` : '';

	return summarizeText([intro, findingsText, measuresText].filter(Boolean).join(' '), 340);
}

function buildPdpcSummary(detailHtml, fallbackSummary) {
	const body = cleanHtmlText(extractMatch(detailHtml, /<div class="rte">([\s\S]*?)<\/div>/i))
		.split(/click here/i)[0]
		.trim();
	const summary = body || cleanHtmlText(fallbackSummary);
	return summary ? summarizeText(summary, 340) : '';
}

function buildIcoSummary(detailHtml, fallbackSummary) {
	const body = cleanHtmlText(extractMatch(detailHtml, /<div class="rich-text">[\s\S]*?<p>([\s\S]*?)<\/p>/i)).trim();
	const summary = body || cleanHtmlText(fallbackSummary);
	return summary ? summarizeText(summary, 340) : '';
}

function extractIcoDocumentUrl(html) {
	const candidates = [
		...collectMatches(html, /<further-Reading[^>]+x-href="([^"]+)"/gi),
		...collectMatches(html, /href="([^"]+)"/gi),
	]
		.map((href) => absolutizeUrl('https://ico.org.uk', href))
		.filter(Boolean);
	const bestMatch = candidates.find((href) => isLikelyPdfAssetUrl(href));
	return bestMatch ?? null;
}

function isLikelyPdfAssetUrl(url) {
	if (!url) {
		return false;
	}

	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname.toLowerCase();
		if (/\.pdf$/.test(pathname)) {
			return true;
		}

		return /^\/media\d?\//.test(pathname) && /\.pdf(?:$|[/?#])/.test(`${pathname}${parsed.search}`);
	} catch {
		return false;
	}
}

function extractLabeledStrongText(html, label) {
	return cleanHtmlText(
		extractMatch(
			html,
			new RegExp(`<span>${escapeRegExp(label)}<\\/span>\\s*<strong[^>]*>([\\s\\S]*?)<\\/strong>`, 'i'),
		),
	);
}

function extractIcoMetaDate(metadata = '') {
	return cleanHtmlText(String(metadata).split(',')[0] ?? '');
}

function extractIcoMetadataParts(metadata = '') {
	return String(metadata)
		.split(',')
		.slice(1)
		.map((part) => cleanHtmlText(part))
		.filter(Boolean);
}

function isRelevantEdpsItem(text) {
	if (
		/how the edps conducts investigations|factsheet|investigation policy|rules on the hearing|ongoing investigation/i.test(
			text,
		)
	) {
		return false;
	}

	return /decision|supervisory opinion|adopted a decision|case \d{4}-\d+|closure of enforcement proceedings/i.test(
		text,
	);
}

function isRelevantIcoItem(text) {
	if (
		/freedom of information|foia|environmental information regulations|\beir\b|official information request/i.test(
			text,
		) &&
		!/uk gdpr|gdpr|data protection|personal data|subject access|\bsar\b|privacy and electronic communications|\bpecr\b/i.test(
			text,
		)
	) {
		return false;
	}

	return /uk gdpr|gdpr|data protection|personal data|subject access|\bsar\b|privacy and electronic communications|\bpecr\b|direct marketing|monetary penalt|reprimand|enforcement notice/i.test(
		text,
	);
}

function deriveDateFromUploadUrl(url) {
	const match = String(url ?? '').match(/\/uploads\/(\d{4})\/(\d{2})\//i);
	if (!match) {
		return '';
	}

	return `${match[1]}-${match[2]}-01`;
}

function getDecisionRetentionCutoff(checkedAt) {
	const cutoff = new Date(checkedAt);
	cutoff.setUTCDate(cutoff.getUTCDate() - DECISION_RETENTION_DAYS);
	return cutoff;
}

function extractParagraphAfterDate(html) {
	const match = html.match(/Date of [Dd]ecision:[^<]*<\/[^>]+>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
	if (match) {
		return cleanHtmlText(match[1]);
	}

	const paragraphMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
	return cleanHtmlText(paragraphMatch?.[1] ?? '');
}

function extractSectionList(html, heading) {
	const sectionPattern = new RegExp(
		`${escapeRegExp(heading)}[\\s\\S]*?(<ul[\\s\\S]*?<\\/ul>|<ol[\\s\\S]*?<\\/ol>)`,
		'i',
	);
	const section = html.match(sectionPattern)?.[1];
	if (!section) {
		return [];
	}

	return [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
		.map((match) => cleanHtmlText(match[1]))
		.filter(Boolean);
}

function extractLinkedDocument(html, labelPattern) {
	const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
	for (const [, href, label] of links) {
		if (labelPattern.test(cleanHtmlText(label))) {
			return absolutizeUrl('https://www.dataprotection.ie', href);
		}
	}

	return null;
}

function extractDpcDocumentUrl(html) {
	const pdfLinks = [...html.matchAll(/<a[^>]+href="([^"]+\.pdf(?:\?[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/gi)].map(
		(match) => ({
			href: match[1],
			label: cleanHtmlText(match[2]),
			index: match.index ?? 0,
		}),
	);

	if (pdfLinks.length === 0) {
		return null;
	}

	const rankedLinks = pdfLinks
		.map((link) => ({
			...link,
			score: scoreDpcPdfLink(html, link),
		}))
		.sort((left, right) => right.score - left.score || left.index - right.index);

	const bestLink = rankedLinks[0];
	if (rankedLinks.length > 1 && bestLink.score <= 0) {
		return null;
	}

	return absolutizeUrl('https://www.dataprotection.ie', bestLink.href);
}

function scoreDpcPdfLink(html, link) {
	const context = cleanHtmlText(html.slice(Math.max(0, link.index - 400), Math.min(html.length, link.index + 800)));
	let score = 0;

	if (/full decision|complete summary/i.test(link.label)) {
		score += 100;
	}
	if (/decision|summary|inquiry|enquiry|investigation|commission/i.test(link.label)) {
		score += 25;
	}
	if (/\.pdf\b|pdf/i.test(link.label)) {
		score += 10;
	}
	if (/\/sites\/default\/files\//i.test(link.href)) {
		score += 15;
	}
	if (/full decision|complete summary|can be downloaded|downloaded at this link|available here/i.test(context)) {
		score += 40;
	}
	if (/cookie|policy|statement|accessibility|annual report|brochure/i.test(link.label)) {
		score -= 100;
	}

	return score;
}

function extractStandaloneDate(html) {
	const titleMatch = html.match(/<h1[^>]*>[\s\S]*?<\/h1>\s*([^<]{6,40})/i);
	if (!titleMatch) {
		return '';
	}

	const text = cleanHtmlText(titleMatch[1]);
	return /\d{1,2}(st|nd|rd|th)?\s+[A-Za-zÀ-ÿ]+\s+\d{4}/.test(text) ? text : '';
}

function extractMatch(value, pattern) {
	return value.match(pattern)?.[1] ?? '';
}

function collectMatches(value, pattern) {
	return [...String(value ?? '').matchAll(pattern)]
		.map((match) => match[1] ?? '')
		.filter(Boolean);
}

function cleanHtmlText(value) {
	return String(value ?? '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function absolutizeUrl(baseUrl, href) {
	return new URL(href, baseUrl).toString();
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wait(milliseconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

// =============================================================================
// AEPD — Agencia Española de Protección de Datos (Spain)
// =============================================================================

const AEPD_BASE_URL = 'https://www.aepd.es';
const AEPD_DECISIONS_URL = `${AEPD_BASE_URL}/informes-y-resoluciones/resoluciones`;
const AEPD_PS_FILTER = 'f%5B0%5D=tipo_procedimiento%3AProcedimiento%20sancionador%20%28PS%29';
const AEPD_PS_FILTER_VARIANT = 'f%5B0%5D=tipo_procedimiento%3AProcedimiento%20Sancionador%20%28PS%29';
const AEPD_PAGE_SIZE = 10;
const AEPD_RATE_LIMIT_MS = 1500;

const AEPD_SPANISH_MONTHS = {
	enero: '01', febrero: '02', marzo: '03', abril: '04',
	mayo: '05', junio: '06', julio: '07', agosto: '08',
	septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

async function fetchAepdEnforcementDecisions(source, checkedAt) {
	const articles = [];

	// Fetch both PS label variants (pre-2018 and post-2018 label eras)
	for (const filter of [AEPD_PS_FILTER, AEPD_PS_FILTER_VARIANT]) {
		let page = 0;
		let consecutiveEmpty = 0;

		while (consecutiveEmpty < 2) {
			const url = `${AEPD_DECISIONS_URL}?${filter}&page=${page}`;
			let html;

			try {
				html = await fetchHtml(url);
			} catch (error) {
				console.log(`  [aepd] page ${page} fetch error: ${error.message}`);
				consecutiveEmpty++;
				page++;
				continue;
			}

			const items = extractAepdListingItems(html);

			if (items.length === 0) {
				consecutiveEmpty++;
				page++;
				continue;
			}

			consecutiveEmpty = 0;

			for (const item of items) {
				const article = buildAepdArticle({ source, item, checkedAt });
				if (article) {
					articles.push(article);
				}
			}

			if (page % 50 === 0) {
				console.log(`  [aepd] page ${page}: ${articles.length} articles so far`);
			}

			page++;
			await wait(AEPD_RATE_LIMIT_MS);
		}
	}

	// Deduplicate across the two filter variants (some decisions may appear in both)
	const seen = new Set();
	const deduped = [];
	for (const article of articles) {
		if (!seen.has(article.dedupKey)) {
			seen.add(article.dedupKey);
			deduped.push(article);
		}
	}

	console.log(`  [aepd] total: ${deduped.length} unique enforcement decisions (${articles.length} before dedup)`);
	return deduped;
}

function extractAepdListingItems(html) {
	const items = [];

	// AEPD listing items have a link to the PDF document and surrounding metadata
	// Pattern: <a href="/documento/{case-id}.pdf">{CASE-ID}</a> followed by snippet text and date
	const pattern = /<a[^>]+href="(\/documento\/([^"]+)\.pdf)"[^>]*>\s*([\s\S]*?)\s*<\/a>/gi;

	for (const match of html.matchAll(pattern)) {
		const pdfPath = match[1];
		const caseId = match[2];
		const linkText = cleanHtmlText(match[3]);

		// Skip non-decision links (navigation, headers, etc.)
		if (!caseId || caseId.length < 5) continue;

		// Extract the surrounding context for date and snippet
		const matchIndex = match.index ?? 0;
		const context = html.substring(matchIndex, Math.min(html.length, matchIndex + 2000));

		// Extract signing date: "Fecha de firma:\nDD de Month de YYYY"
		const dateMatch = context.match(/Fecha de firma:\s*(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ]+)\s+de\s+(\d{4})/i);
		let decisionDate = null;
		if (dateMatch) {
			const day = dateMatch[1].padStart(2, '0');
			const monthName = dateMatch[2].toLowerCase();
			const year = dateMatch[3];
			const month = AEPD_SPANISH_MONTHS[monthName];
			if (month) {
				decisionDate = `${year}-${month}-${day}`;
			}
		}

		// Extract expediente number
		const expedienteMatch = context.match(/Expediente\s*[Nn][\s.º:]*\s*(EXP\d+)/i);
		const expediente = expedienteMatch ? expedienteMatch[1] : null;

		// Extract text snippet (the paragraph after the link)
		const snippetMatch = context.match(/\n\n(1\s*\/\s*\d+\s+[\s\S]{20,300}?)(?:\n\n|Ver documento)/);
		const snippet = snippetMatch ? cleanHtmlText(snippetMatch[1]) : '';

		items.push({
			caseId: linkText || caseId.toUpperCase(),
			pdfUrl: `${AEPD_BASE_URL}${pdfPath}`,
			decisionDate,
			expediente,
			snippet,
		});
	}

	return items;
}

function buildAepdArticle({ source, item, checkedAt }) {
	const title = `AEPD ${item.caseId}`;
	const decisionDate = item.decisionDate;
	const summary = buildAepdSummary(item);

	if (!decisionDate) {
		return null;
	}

	const id = buildArticleId({
		sourceId: source.id,
		title,
		publishedDate: decisionDate,
		originalLink: item.pdfUrl,
	});

	const textForTags = [item.caseId, item.expediente, item.snippet].filter(Boolean).join(' ');

	return {
		id,
		title,
		source: source.name,
		sourceId: source.id,
		sourceUrl: source.siteUrl,
		publishedDate: decisionDate,
		decisionDate,
		authorityPublicationDate: decisionDate,
		platformPublicationDate: null,
		summary,
		category: 'decisions',
		dedupKey: buildDedupKey({ title: item.caseId, publishedDate: decisionDate }),
		tags: extractTags({
			title,
			text: textForTags,
			tags: item.expediente ? [item.expediente] : [],
			defaultTags: source.defaultTags,
		}),
		...buildDocumentFields({ sourceDetailUrl: item.pdfUrl, documentUrl: item.pdfUrl }),
		originalLink: item.pdfUrl,
		caseReference: item.caseId,
		expedienteNumber: item.expediente,
		fetchedAt: checkedAt,
	};
}

function buildAepdSummary(item) {
	const parts = [];
	if (item.caseId) parts.push(`Case: ${item.caseId}`);
	if (item.expediente) parts.push(`Expediente: ${item.expediente}`);
	if (item.snippet) parts.push(item.snippet);
	return summarizeText(parts.join('. '), 340);
}
