/**
 * LandingPageService
 * Handles all server-side logic for AI-powered landing page generation:
 *  1. Query the active theme
 *  2. Generate structured content via OpenAI
 *  3. Upload images to Shopify CDN via fileCreate
 *  4. Write OS 2.0 JSON template via themeFilesUpsert
 *  5. Create a Shopify Page resource linked to the template
 */

import OpenAI from "openai";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LandingPageInput {
  productName: string;
  sellingPoints: string;
  imageUrl?: string; // optional external image URL to upload
}

export interface LandingPageResult {
  pageHandle: string;
  previewUrl: string;
  templateSuffix: string;
}

// Zod schema for AI-generated content
const LandingPageContentSchema = z.object({
  headline: z.string().max(100),
  subheadline: z.string().max(200),
  ctaText: z.string().max(30),
  bodyText: z.string().max(500),
  heroImageAlt: z.string().max(100),
  features: z.array(
    z.object({
      title: z.string().max(50),
      description: z.string().max(150),
    })
  ).max(3),
});

type LandingPageContent = z.infer<typeof LandingPageContentSchema>;

// ─── GraphQL Mutations ────────────────────────────────────────────────────────

const GET_ACTIVE_THEME = `#graphql
  query GetActiveTheme {
    themes(first: 5, roles: [MAIN]) {
      nodes {
        id
        name
        role
      }
    }
  }
`;

const THEME_FILES_UPSERT = `#graphql
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles {
        filename
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        ... on MediaImage {
          id
          image {
            url
          }
        }
        ... on GenericFile {
          id
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PAGE_CREATE = `#graphql
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        handle
        title
        templateSuffix
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Leaky Bucket retry wrapper for Shopify GraphQL calls.
 * Retries on THROTTLED errors with exponential back-off.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelayMs = 1000
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("throttled") && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[LandingPageService] Throttled, retrying in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
      } else {
        throw err;
      }
    }
  }
}

// ─── Service Class ────────────────────────────────────────────────────────────

export class LandingPageService {
  private openai: OpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set in environment variables.");
    }
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // Support third-party OpenAI-compatible APIs (e.g. proxies, OpenRouter, etc.)
      ...(process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : {}),
    });
  }

  // ── 1. Get Active Theme ID ─────────────────────────────────────────────────

  async getActiveThemeId(admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> }): Promise<string> {
    const response = await withRetry(() => admin.graphql(GET_ACTIVE_THEME));
    const json = await response.json() as {
      data: {
        themes: {
          nodes: Array<{ id: string; name: string; role: string }>;
        };
      };
    };

    const themes = json.data?.themes?.nodes ?? [];
    const mainTheme = themes.find((t) => t.role === "MAIN") ?? themes[0];

    if (!mainTheme) {
      throw new Error("No active theme found in this store.");
    }

    console.log(`[LandingPageService] Active theme: ${mainTheme.name} (${mainTheme.id})`);
    return mainTheme.id;
  }

  // ── 2. Generate AI Content ─────────────────────────────────────────────────

  async generateContent(input: LandingPageInput): Promise<LandingPageContent> {
    const systemPrompt = `You are an expert e-commerce copywriter specializing in high-conversion landing pages.
Output ONLY valid JSON matching this schema exactly (no markdown, no extra text):
{
  "headline": "string (max 100 chars)",
  "subheadline": "string (max 200 chars)",
  "ctaText": "string (max 30 chars)",
  "bodyText": "string (max 500 chars)",
  "heroImageAlt": "string (max 100 chars)",
  "features": [
    { "title": "string (max 50 chars)", "description": "string (max 150 chars)" }
  ] (exactly 3 items)
}`;

    const userPrompt = `Create landing page copy for:
Product: ${input.productName}
Selling Points: ${input.sellingPoints}

Write in a persuasive, modern marketing style. Output only valid JSON.`;

    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 800,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";

    try {
      const parsed = JSON.parse(raw);
      return LandingPageContentSchema.parse(parsed);
    } catch (e) {
      throw new Error(`AI returned invalid JSON schema: ${e}`);
    }
  }

  // ── 3. Upload Image to Shopify CDN ─────────────────────────────────────────

  async uploadImageToShopify(
    admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
    imageUrl: string,
    altText: string
  ): Promise<string> {
    const response = await withRetry(() =>
      admin.graphql(FILE_CREATE, {
        variables: {
          files: [
            {
              originalSource: imageUrl,
              alt: altText,
              contentType: "IMAGE",
            },
          ],
        },
      })
    );

    const json = await response.json() as {
      data: {
        fileCreate: {
          files: Array<{ id?: string; image?: { url: string }; url?: string }>;
          userErrors: Array<{ field: string; message: string }>;
        };
      };
    };

    const errors = json.data?.fileCreate?.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`fileCreate errors: ${JSON.stringify(errors)}`);
    }

    const file = json.data?.fileCreate?.files?.[0];
    const cdnUrl = (file as { image?: { url: string }; url?: string })?.image?.url ?? (file as { url?: string })?.url;

    if (!cdnUrl) {
      throw new Error("Image upload succeeded but no CDN URL was returned.");
    }

    console.log(`[LandingPageService] Image uploaded to: ${cdnUrl}`);
    return cdnUrl;
  }

  // ── 4. Build OS 2.0 JSON Template ─────────────────────────────────────────

  private buildTemplateJson(content: LandingPageContent, imageUrl?: string): string {
    const sections: Record<string, unknown> = {
      "ai-hero-banner": {
        type: "image-with-text",
        settings: {
          heading: content.headline,
          text: content.subheadline,
          button_label: content.ctaText,
          ...(imageUrl ? { image: imageUrl } : {}),
        },
      },
      "ai-body-text": {
        type: "rich-text",
        settings: {
          heading: "",
          text: `<p>${content.bodyText}</p>`,
        },
      },
      "ai-features": {
        type: "multicolumn",
        settings: {
          title: "Why Choose Us",
        },
        blocks: content.features.reduce(
          (acc, feature, idx) => {
            acc[`feature-${idx}`] = {
              type: "column",
              settings: {
                title: feature.title,
                text: feature.description,
              },
            };
            return acc;
          },
          {} as Record<string, unknown>
        ),
        block_order: content.features.map((_, idx) => `feature-${idx}`),
      },
    };

    return JSON.stringify(
      {
        sections,
        order: ["ai-hero-banner", "ai-body-text", "ai-features"],
      },
      null,
      2
    );
  }

  // ── 5. Deploy Theme Template via REST Asset API ──────────────────────────
  // Note: themeFilesUpsert GraphQL requires a Shopify exemption.
  // The REST Asset API has no such requirement and works for development stores.

  async deployThemeTemplate(
    shop: string,
    accessToken: string,
    themeId: string,
    templateSuffix: string,
    content: LandingPageContent,
    imageUrl?: string
  ): Promise<void> {
    const templateJson = this.buildTemplateJson(content, imageUrl);
    const assetKey = `templates/page.${templateSuffix}.json`;

    // Extract numeric ID from GQL GID: "gid://shopify/OnlineStoreTheme/186086293783" → "186086293783"
    const numericThemeId = themeId.split("/").pop();
    if (!numericThemeId) throw new Error(`Invalid theme GID: ${themeId}`);

    const url = `https://${shop}/admin/api/2026-04/themes/${numericThemeId}/assets.json`;

    const response = await withRetry(async () => {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          asset: {
            key: assetKey,
            value: templateJson,
          },
        }),
      });
      if (res.status === 429) throw new Error("throttled");
      return res;
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`REST Asset API error ${response.status}: ${body}`);
    }

    console.log(`[LandingPageService] Theme asset created via REST: ${assetKey}`);
  }

  // ── 6. Create Page Resource ────────────────────────────────────────────────

  async createPage(
    admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
    productName: string,
    templateSuffix: string
  ): Promise<{ handle: string }> {
    const title = `${productName} - AI Landing Page`;

    const response = await withRetry(() =>
      admin.graphql(PAGE_CREATE, {
        variables: {
          page: {
            title,
            templateSuffix,
            isPublished: true,
          },
        },
      })
    );

    const json = await response.json() as {
      data: {
        pageCreate: {
          page: { id: string; handle: string; title: string; templateSuffix: string };
          userErrors: Array<{ field: string; message: string }>;
        };
      };
    };

    const errors = json.data?.pageCreate?.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`pageCreate errors: ${JSON.stringify(errors)}`);
    }

    const page = json.data?.pageCreate?.page;
    console.log(`[LandingPageService] Page created: /pages/${page.handle}`);
    return { handle: page.handle };
  }

  // ── 7. Orchestrate: Full Landing Page Generation ──────────────────────────

  async generate(
    admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
    shopDomain: string,
    accessToken: string,
    input: LandingPageInput
  ): Promise<LandingPageResult> {
    // Sanitize product name → URL-safe suffix
    const templateSuffix = `ai-${input.productName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)}`;

    // 1. Get theme
    const themeId = await this.getActiveThemeId(admin);

    // 2. Generate AI content
    console.log("[LandingPageService] Generating AI content...");
    const content = await this.generateContent(input);

    // 3. Upload image (if provided)
    let shopifyImageUrl: string | undefined;
    if (input.imageUrl) {
      shopifyImageUrl = await this.uploadImageToShopify(admin, input.imageUrl, content.heroImageAlt);
    }

    // 4. Deploy theme template via REST Asset API
    await this.deployThemeTemplate(shopDomain, accessToken, themeId, templateSuffix, content, shopifyImageUrl);

    // 5. Create page resource
    const { handle } = await this.createPage(admin, input.productName, templateSuffix);

    return {
      pageHandle: handle,
      previewUrl: `https://${shopDomain}/pages/${handle}`,
      templateSuffix,
    };
  }
}
