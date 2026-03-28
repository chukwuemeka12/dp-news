import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const articleCollection = defineCollection({
	loader: glob({
		base: './src/content/articles',
		pattern: '**/*.json',
	}),
	schema: z.object({
		id: z.string(),
		title: z.string(),
		source: z.string(),
		sourceId: z.string(),
		sourceUrl: z.string().url(),
		publishedDate: z.string(),
		decisionDate: z.string().nullable(),
		authorityPublicationDate: z.string().nullable(),
		platformPublicationDate: z.string().nullable(),
		summary: z.string(),
		category: z.enum(['decisions', 'laws', 'guidance', 'standards', 'appointments']),
		dedupKey: z.string(),
		tags: z.array(z.string()),
		originalLink: z.string().url(),
		fetchedAt: z.string(),
	}),
});

const systemCollection = defineCollection({
	loader: glob({
		base: './src/content/system',
		pattern: '**/*.json',
	}),
	schema: z.object({
		generatedAt: z.string(),
		retentionDays: z.number(),
		maxArticles: z.number(),
		totals: z.object({
			articles: z.number(),
			healthySources: z.number(),
			totalSources: z.number(),
			byCategory: z.object({
				decisions: z.number(),
				laws: z.number(),
				guidance: z.number(),
				standards: z.number(),
				appointments: z.number(),
			}),
		}),
		sources: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				kind: z.string(),
				endpoint: z.string().url(),
				siteUrl: z.string().url(),
				defaultCategory: z.string(),
				description: z.string(),
				staleAfterHours: z.number(),
				checkedAt: z.string().nullable(),
				lastSuccessAt: z.string().nullable(),
				latestItemAt: z.string().nullable(),
				itemCount: z.number(),
				healthy: z.boolean(),
				error: z.string().nullable(),
			}),
		),
	}),
});

export const collections = {
	articles: articleCollection,
	system: systemCollection,
};
