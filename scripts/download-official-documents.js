import fs from 'node:fs/promises';
import path from 'node:path';

import { SOURCE_CONFIG } from '../src/data/source-config.js';
import {
	ARTICLES_DIR,
	DEFAULT_DOCUMENTS_DIR,
	DEFAULT_DOCUMENT_STATE_FILE,
	PUBLIC_DIR,
	buildManagedDocumentPath,
	buildManagedDocumentRelativePath,
	describeLocalDocument,
	deriveLocalDocumentUrl,
	isPdfBuffer,
	loadArticles,
	looksLikePdfUrl,
	pruneManagedDocuments,
	writeManagedDocument,
} from './lib/document-storage.js';

const officialSourceIds = new Set(
	SOURCE_CONFIG.filter((source) => source.kind === 'official-decisions').map((source) => source.id),
);

const options = parseArgs(process.argv.slice(2));
const manifest = await loadManifest(options.stateFile);
const articles = (await loadArticles(options.articlesDir))
	.filter((article) => officialSourceIds.has(article.sourceId))
	.filter((article) => !options.sourceId || article.sourceId === options.sourceId)
	.filter((article) => !options.articleId || article.id === options.articleId)
	.sort((left, right) => new Date(right.publishedDate).getTime() - new Date(left.publishedDate).getTime())
	.slice(0, options.limit ?? Infinity);
const canPrune = !options.dryRun && !options.articleId && !options.sourceId && options.limit === null;

const keepRelativePaths = new Set();
const activeArticleIds = new Set(articles.map((article) => article.id));
const results = [];
const totalArticles = articles.length;

for (const [index, article] of articles.entries()) {
	const resolvedDocumentUrl = resolveDocumentUrl(article);
	if (!resolvedDocumentUrl) {
		delete manifest.items[article.id];
		if (!options.dryRun) {
			await persistArticleMetadata(article, {
				documentUrl: article.documentUrl ?? null,
				localDocumentUrl: null,
				documentContentType: null,
				documentSizeBytes: null,
				documentSha256: null,
				documentDownloadedAt: null,
				documentDownloadError: null,
			});
		}
		results.push({
			articleId: article.id,
			sourceId: article.sourceId,
			outcome: 'no_document_url',
		});
		logProgress(index, article, 'skipped (no document URL)');
		if (!options.dryRun) {
			await saveManifest(options.stateFile, manifest);
		}
		continue;
	}

	const relativePath = buildManagedDocumentRelativePath(article);
	const localPath = buildManagedDocumentPath(options.documentsDir, article);
	const localDocumentUrl = deriveLocalDocumentUrl(localPath, options.publicDir);
	const manifestEntry = manifest.items[article.id];
	const existingDocument = await describeLocalDocument(localPath);
	const manifestBase = {
		articleId: article.id,
		sourceId: article.sourceId,
		title: article.title,
		documentUrl: resolvedDocumentUrl,
		sourceDetailUrl: article.sourceDetailUrl ?? article.sourceUrl ?? null,
		relativePath,
		localPath,
		localDocumentUrl,
	};

	keepRelativePaths.add(relativePath);

	if (
		existingDocument &&
		!options.force &&
		(!manifestEntry || manifestEntry.documentUrl === resolvedDocumentUrl)
	) {
		const nextEntry = {
			...manifestBase,
			documentContentType: manifestEntry?.documentContentType ?? inferContentType(resolvedDocumentUrl),
			documentSizeBytes: existingDocument.sizeBytes,
			documentSha256: existingDocument.sha256,
			documentDownloadedAt: manifestEntry?.documentDownloadedAt ?? existingDocument.modifiedAt,
			documentDownloadError: null,
		};
		manifest.items[article.id] = nextEntry;
		if (!options.dryRun) {
			await persistArticleMetadata(article, extractArticleDocumentPatch(nextEntry));
		}
		results.push({
			articleId: article.id,
			sourceId: article.sourceId,
			outcome: 'already_downloaded',
			relativePath,
		});
		logProgress(index, article, 'already downloaded');
		if (!options.dryRun) {
			await saveManifest(options.stateFile, manifest);
		}
		continue;
	}

	if (options.dryRun) {
		results.push({
			articleId: article.id,
			sourceId: article.sourceId,
			outcome: existingDocument ? 'would_refresh' : 'would_download',
			relativePath,
		});
		logProgress(index, article, existingDocument ? 'would refresh' : 'would download');
		continue;
	}

	try {
		logProgress(index, article, 'downloading');
		const response = await fetch(resolvedDocumentUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; dp-news-fetcher/0.0.1)',
				Accept: 'application/pdf,*/*;q=0.8',
			},
		});

		if (!response.ok) {
			throw new Error(`Document source returned ${response.status}`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		if (!isPdfBuffer(buffer)) {
			throw new Error('Downloaded file did not validate as a PDF.');
		}

		await writeManagedDocument(localPath, buffer);
		const storedDocument = await describeLocalDocument(localPath);
		const nextEntry = {
			...manifestBase,
			documentContentType: response.headers.get('content-type') ?? inferContentType(resolvedDocumentUrl),
			documentSizeBytes: storedDocument?.sizeBytes ?? buffer.length,
			documentSha256: storedDocument?.sha256 ?? null,
			documentDownloadedAt: new Date().toISOString(),
			documentDownloadError: null,
		};
		manifest.items[article.id] = nextEntry;
		await persistArticleMetadata(article, extractArticleDocumentPatch(nextEntry));
		results.push({
			articleId: article.id,
			sourceId: article.sourceId,
			outcome: 'downloaded',
			relativePath,
		});
		logProgress(index, article, 'downloaded');
	} catch (error) {
		const nextEntry = {
			...manifestBase,
			documentContentType: manifestEntry?.documentContentType ?? null,
			documentSizeBytes: manifestEntry?.documentSizeBytes ?? null,
			documentSha256: manifestEntry?.documentSha256 ?? null,
			documentDownloadedAt: manifestEntry?.documentDownloadedAt ?? null,
			documentDownloadError: error instanceof Error ? error.message : 'Unknown download error',
		};
		manifest.items[article.id] = nextEntry;
		await persistArticleMetadata(article, extractArticleDocumentPatch(nextEntry));
		results.push({
			articleId: article.id,
			sourceId: article.sourceId,
			outcome: 'failed',
			error: error instanceof Error ? error.message : 'Unknown download error',
		});
		logProgress(
			index,
			article,
			`failed (${error instanceof Error ? error.message : 'Unknown download error'})`,
		);
	}

	await saveManifest(options.stateFile, manifest);
}

if (canPrune) {
	for (const articleId of Object.keys(manifest.items)) {
		if (activeArticleIds.has(articleId)) {
			continue;
		}

		delete manifest.items[articleId];
	}

	await pruneManagedDocuments(options.documentsDir, keepRelativePaths);
	await saveManifest(options.stateFile, manifest);
}

printSummary(results, options);

if (results.some((result) => result.outcome === 'failed')) {
	process.exit(1);
}

function parseArgs(argv) {
	const parsed = {
		articleId: null,
		articlesDir: ARTICLES_DIR,
		documentsDir: DEFAULT_DOCUMENTS_DIR,
		dryRun: false,
		force: false,
		limit: null,
		publicDir: PUBLIC_DIR,
		sourceId: null,
		stateFile: DEFAULT_DOCUMENT_STATE_FILE,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--article-id') {
			parsed.articleId = argv[++index];
			continue;
		}
		if (arg === '--articles-dir') {
			parsed.articlesDir = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--documents-dir') {
			parsed.documentsDir = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--dry-run') {
			parsed.dryRun = true;
			continue;
		}
		if (arg === '--force') {
			parsed.force = true;
			continue;
		}
		if (arg === '--limit') {
			parsed.limit = Number.parseInt(argv[++index], 10);
			continue;
		}
		if (arg === '--public-dir') {
			parsed.publicDir = path.resolve(argv[++index]);
			continue;
		}
		if (arg === '--source-id') {
			parsed.sourceId = argv[++index];
			continue;
		}
		if (arg === '--state-file') {
			parsed.stateFile = path.resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return parsed;
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

function resolveDocumentUrl(article) {
	if (article.documentUrl) {
		return article.documentUrl;
	}

	return looksLikePdfUrl(article.originalLink) ? article.originalLink : null;
}

function inferContentType(url) {
	return looksLikePdfUrl(url) ? 'application/pdf' : null;
}

async function persistArticleMetadata(article, patch) {
	const nextArticle = {
		...article,
		...patch,
	};
	delete nextArticle.filePath;
	await fs.writeFile(article.filePath, `${JSON.stringify(nextArticle, null, 2)}\n`, 'utf8');
}

function extractArticleDocumentPatch(entry) {
	return {
		sourceDetailUrl: entry.sourceDetailUrl ?? null,
		documentUrl: entry.documentUrl ?? null,
		localDocumentUrl: entry.localDocumentUrl ?? null,
		documentContentType: entry.documentContentType ?? null,
		documentSizeBytes: entry.documentSizeBytes ?? null,
		documentSha256: entry.documentSha256 ?? null,
		documentDownloadedAt: entry.documentDownloadedAt ?? null,
		documentDownloadError: entry.documentDownloadError ?? null,
	};
}

function printSummary(results, options) {
	const counts = results.reduce((accumulator, result) => {
		accumulator[result.outcome] = (accumulator[result.outcome] ?? 0) + 1;
		return accumulator;
	}, {});

	console.log(
		[
			`Processed ${results.length} official decision article${results.length === 1 ? '' : 's'}.`,
			`Mode: ${options.dryRun ? 'dry-run' : 'download'}.`,
			`Documents dir: ${options.documentsDir}`,
			`State file: ${options.stateFile}`,
		].join('\n'),
	);

	for (const [outcome, count] of Object.entries(counts).sort((left, right) => left[0].localeCompare(right[0]))) {
		console.log(`- ${outcome}: ${count}`);
	}
}

function logProgress(index, article, message) {
	console.log(`[${index + 1}/${totalArticles}] ${article.sourceId} ${article.id}: ${message}`);
}
