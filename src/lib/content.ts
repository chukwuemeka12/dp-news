import { getCollection, type CollectionEntry } from 'astro:content';

export type ArticleEntry = CollectionEntry<'articles'>;
export type StatusEntry = CollectionEntry<'system'>['data'];
export type ArticleDateEntry = {
	key: 'decisionDate' | 'authorityPublicationDate' | 'platformPublicationDate';
	label: string;
	date: string;
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	timeZone: 'UTC',
});

export async function getSortedArticles() {
	const articles = await getCollection('articles');

	return articles.sort(
		(left, right) =>
			getPrimaryArticleTimestamp(right.data) - getPrimaryArticleTimestamp(left.data),
	);
}

export async function getArticlesByCategory(category: ArticleEntry['data']['category']) {
	const articles = await getSortedArticles();
	return articles.filter((article) => article.data.category === category);
}

export async function getStatusSnapshot() {
	const statuses = await getCollection('system');
	return statuses.find((entry) => entry.id === 'status')?.data ?? null;
}

export function formatDisplayDate(date: string) {
	const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date;
	return dateFormatter.format(new Date(safeDate));
}

export function getArticleDateEntries(article: ArticleEntry['data']) {
	const rawEntries: ArticleDateEntry[] = [
		{ key: 'decisionDate', label: 'Decision', date: article.decisionDate ?? '' },
		{
			key: 'authorityPublicationDate',
			label: 'Authority',
			date: article.authorityPublicationDate ?? '',
		},
		{
			key: 'platformPublicationDate',
			label: 'Platform',
			date: article.platformPublicationDate ?? '',
		},
	].filter((entry) => entry.date);

	if (!rawEntries.length) {
		return [];
	}

	const decisionDate = rawEntries.find((entry) => entry.key === 'decisionDate')?.date;
	const authorityDate = rawEntries.find((entry) => entry.key === 'authorityPublicationDate')?.date;
	const platformDate = rawEntries.find((entry) => entry.key === 'platformPublicationDate')?.date;

	const collapsedEntries: ArticleDateEntry[] = [];

	if (decisionDate) {
		collapsedEntries.push({
			key: 'decisionDate',
			label: 'Decision',
			date: decisionDate,
		});
	}

	if (authorityDate && platformDate && authorityDate === platformDate) {
		collapsedEntries.push({
			key: 'authorityPublicationDate',
			label: 'Authority / platform',
			date: authorityDate,
		});
		return collapsedEntries;
	}

	if (authorityDate) {
		collapsedEntries.push({
			key: 'authorityPublicationDate',
			label: 'Authority',
			date: authorityDate,
		});
	}

	if (platformDate) {
		collapsedEntries.push({
			key: 'platformPublicationDate',
			label: 'Platform',
			date: platformDate,
		});
	}

	return collapsedEntries;
}

export function getPrimaryArticleDate(article: ArticleEntry['data']) {
	return (
		article.platformPublicationDate ??
		article.authorityPublicationDate ??
		article.decisionDate ??
		article.publishedDate
	);
}

export function getPrimaryArticleDateLabel(article: ArticleEntry['data']) {
	if (article.platformPublicationDate && article.authorityPublicationDate === article.platformPublicationDate) {
		return 'Authority / platform';
	}

	if (article.platformPublicationDate) {
		return 'Platform';
	}

	if (article.authorityPublicationDate) {
		return 'Authority';
	}

	if (article.decisionDate) {
		return 'Decision';
	}

	return 'Date';
}

export function isSourceFresh(source: StatusEntry['sources'][number]) {
	if (!source.lastSuccessAt) {
		return false;
	}

	const stalenessMs = source.staleAfterHours * 60 * 60 * 1000;
	return Date.now() - new Date(source.lastSuccessAt).getTime() <= stalenessMs;
}

export function formatTimestamp(value: string | null) {
	if (!value) {
		return 'No successful fetch yet';
	}

	return new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC',
	}).format(new Date(value));
}

function getPrimaryArticleTimestamp(article: ArticleEntry['data']) {
	return new Date(getPrimaryArticleDate(article)).getTime();
}
