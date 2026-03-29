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

const officialDecisionSources = SOURCE_CONFIG.filter((source) => source.kind === 'official-decisions');
const EDPS_PAGE_LIMIT = 3;
const PDPC_PAGE_LIMIT = 40;

let articlesMap = await loadArticlesMap();
let statusSnapshot = await loadStatusSnapshot();

for (const source of officialDecisionSources) {
	const checkedAt = new Date().toISOString();

	try {
		removeArticlesBySourceId(articlesMap, source.id);

		const articles = await fetchOfficialDecisionSource(source, checkedAt);
		for (const article of articles) {
			upsertArticle(articlesMap, article);
		}

		statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
			checkedAt,
			lastSuccessAt: checkedAt,
			latestItemAt: getLatestTimestamp(
				articles.map((item) => item.platformPublicationDate ?? item.authorityPublicationDate ?? item.decisionDate),
			),
			itemCount: articles.length,
			healthy: articles.length > 0,
			error: articles.length > 0 ? null : 'Decision source returned zero usable items.',
		});
	} catch (error) {
		statusSnapshot = updateSourceStatus(statusSnapshot, source.id, {
			checkedAt,
			healthy: false,
			error: error instanceof Error ? error.message : 'Unknown official decisions error',
		});
	}
}

await persistSnapshot(articlesMap, statusSnapshot);

async function fetchOfficialDecisionSource(source, checkedAt) {
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

	throw new Error(`Unsupported official decisions extractor: ${source.extractor}`);
}

async function fetchDpcPublishedDecisions(source, checkedAt) {
	const listingHtml = await fetchHtml(source.feedUrl);
	const listingItems = extractDpcListingItems(listingHtml).slice(0, 40);
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
	const cutoffDate = getDecisionRetentionCutoff(checkedAt);

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

			if (new Date(decisionDate) < cutoffDate) {
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

		if (!pageHasCurrentItem) {
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
	const originalDocumentUrl =
		extractLinkedDocument(detailHtml, /full decision/i) ??
		extractLinkedDocument(detailHtml, /complete summary/i) ??
		item.href;

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
		originalLink: originalDocumentUrl,
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
	const originalDocumentUrl = pdfHref ? absolutizeUrl('https://www.pdpc.gov.sg', pdfHref) : detailUrl;
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
		originalLink: item.documentUrl,
		fetchedAt: checkedAt,
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

function extractStandaloneDate(html) {
	const titleMatch = html.match(/<h1[^>]*>[\s\S]*?<\/h1>\s*([^<]{6,40})/i);
	if (!titleMatch) {
		return '';
	}

	const text = cleanHtmlText(titleMatch[1]);
	return /\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}/.test(text) ? text : '';
}

function extractMatch(value, pattern) {
	return value.match(pattern)?.[1] ?? '';
}

function cleanHtmlText(value) {
	return String(value ?? '')
		.replace(/<[^>]+>/g, ' ')
		replace(/&nbsp;/g, ' ')
		replace(/&amp;/g, '&')
		replace(/&quot;/g, '"')
		replace(/&#39;/g, "'")
		replace(/\s+/g, ' ')
		.trim();
}

function absolutizeUrl(baseUrl, href) {
	return new URL(href, baseUrl).toString();
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
