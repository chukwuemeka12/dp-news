import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
export const ARTICLES_DIR = path.join(PROJECT_ROOT, 'src/content/articles');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const DEFAULT_DOCUMENTS_DIR =
	process.env.DP_NEWS_DOCUMENTS_DIR ?? path.join(PUBLIC_DIR, 'decision-documents');
export const DEFAULT_DOCUMENT_STATE_FILE =
	process.env.DP_NEWS_DOCUMENT_STATE_FILE ?? path.join(os.homedir(), '.dp-news', 'document-manifest.json');
export const MANAGED_NAMESPACE = 'official-decisions';

export async function loadArticles(articlesDir = ARTICLES_DIR) {
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

export function looksLikePdfUrl(url) {
	try {
		return new URL(String(url ?? '')).pathname.toLowerCase().endsWith('.pdf');
	} catch {
		return String(url ?? '').toLowerCase().includes('.pdf');
	}
}

export function buildManagedDocumentRelativePath(article) {
	return path.join(MANAGED_NAMESPACE, article.sourceId, `${article.id}.pdf`);
}

export function buildManagedDocumentPath(documentsDir, article) {
	return path.join(documentsDir, buildManagedDocumentRelativePath(article));
}

export function deriveLocalDocumentUrl(localPath, publicDir = PUBLIC_DIR) {
	const relativePath = path.relative(publicDir, localPath);
	if (!relativePath || relativePath.startsWith('..')) {
		return null;
	}

	return `/${relativePath.split(path.sep).join('/')}`;
}

export function isPdfBuffer(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
		return false;
	}

	return buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

export async function describeLocalDocument(localPath) {
	try {
		const buffer = await fs.readFile(localPath);
		const stats = await fs.stat(localPath);
		return {
			localPath,
			sizeBytes: stats.size,
			sha256: createSha256(buffer),
			modifiedAt: stats.mtime.toISOString(),
		};
	} catch {
		return null;
	}
}

export async function writeManagedDocument(localPath, buffer) {
	await fs.mkdir(path.dirname(localPath), { recursive: true });
	const tempPath = `${localPath}.tmp-${process.pid}`;
	await fs.writeFile(tempPath, buffer);
	await fs.rename(tempPath, localPath);
}

export async function listManagedDocumentRelativePaths(documentsDir) {
	const rootDir = path.join(documentsDir, MANAGED_NAMESPACE);
	return walkRelativePaths(rootDir, documentsDir);
}

export async function pruneManagedDocuments(documentsDir, keepRelativePaths) {
	const existingRelativePaths = await listManagedDocumentRelativePaths(documentsDir);

	for (const relativePath of existingRelativePaths) {
		if (keepRelativePaths.has(relativePath)) {
			continue;
		}

		await fs.unlink(path.join(documentsDir, relativePath));
	}

	await removeEmptyDirectories(path.join(documentsDir, MANAGED_NAMESPACE));
}

function createSha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function walkRelativePaths(rootDir, baseDir) {
	try {
		const entries = await fs.readdir(rootDir, { withFileTypes: true });
		const results = [];

		for (const entry of entries) {
			const entryPath = path.join(rootDir, entry.name);
			if (entry.isDirectory()) {
				const nested = await walkRelativePaths(entryPath, baseDir);
				results.push(...nested);
				continue;
			}

			if (entry.isFile()) {
				results.push(path.relative(baseDir, entryPath));
			}
		}

		return results;
	} catch {
		return [];
	}
}

async function removeEmptyDirectories(rootDir) {
	try {
		const entries = await fs.readdir(rootDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			await removeEmptyDirectories(path.join(rootDir, entry.name));
		}

		const remainingEntries = await fs.readdir(rootDir);
		if (remainingEntries.length === 0) {
			await fs.rmdir(rootDir);
		}
	} catch {
		// Directory already absent or not removable; ignore during cleanup.
	}
}
