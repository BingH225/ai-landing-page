/**
 * LandingPageService
 * Generates AI-powered landing pages and publishes them as Shopify Pages.
 * Approach: Generate HTML body directly — no theme modifications needed.
 */

import OpenAI from "openai";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LandingPageInput {
  productName: string;
  sellingPoints: string;
  imageUrl?: string;
}

export interface LandingPageResult {
  pageHandle: string;
  previewUrl: string;
}

// Zod schema for AI-generated content
const LandingPageContentSchema = z.object({
  headline: z.string().max(120),
  subheadline: z.string().max(250),
  ctaText: z.string().max(40),
  bodyText: z.string().max(600),
  heroImageAlt: z.string().max(120),
  features: z
    .array(
      z.object({
        title: z.string().max(60),
        description: z.string().max(180),
      })
    )
    .max(3),
});

type LandingPageContent = z.infer<typeof LandingPageContentSchema>;

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const PAGE_CREATE = `#graphql
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        handle
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
        console.warn(
          `[LandingPageService] Throttled, retrying in ${delay}ms (attempt ${attempt + 1})`
        );
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
      ...(process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : {}),
    });
  }

  // ── 1. Generate AI Content ──────────────────────────────────────────────────

  async generateContent(input: LandingPageInput): Promise<LandingPageContent> {
    const systemPrompt = `You are an expert e-commerce copywriter specializing in high-conversion landing pages.
Output ONLY valid JSON matching this schema exactly (no markdown, no extra text):
{
  "headline": "string (max 120 chars)",
  "subheadline": "string (max 250 chars)",
  "ctaText": "string (max 40 chars)",
  "bodyText": "string (max 600 chars)",
  "heroImageAlt": "string (max 120 chars)",
  "features": [
    { "title": "string (max 60 chars)", "description": "string (max 180 chars)" }
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
      max_tokens: 900,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";

    try {
      const parsed = JSON.parse(raw);
      return LandingPageContentSchema.parse(parsed);
    } catch (e) {
      throw new Error(`AI returned invalid JSON: ${e}`);
    }
  }

  // ── 2. Build Styled HTML Body ───────────────────────────────────────────────

  private buildPageHtml(content: LandingPageContent, imageUrl?: string): string {
    const featuresHtml = content.features
      .map(
        (f) => `
      <div style="flex:1;min-width:220px;background:#f9fafb;border-radius:12px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <h3 style="margin:0 0 10px;font-size:18px;font-weight:700;color:#111;">${f.title}</h3>
        <p style="margin:0;color:#555;line-height:1.7;font-size:15px;">${f.description}</p>
      </div>`
      )
      .join("");

    const heroImageHtml = imageUrl
      ? `<img src="${imageUrl}" alt="${content.heroImageAlt}" style="width:100%;max-height:520px;object-fit:cover;border-radius:16px;margin-bottom:48px;">`
      : "";

    return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;max-width:860px;margin:0 auto;padding:48px 24px;color:#111;">

  <!-- Hero Image -->
  ${heroImageHtml}

  <!-- Hero Copy -->
  <div style="text-align:center;margin-bottom:56px;">
    <h1 style="font-size:clamp(28px,5vw,54px);font-weight:800;margin:0 0 20px;line-height:1.15;letter-spacing:-0.5px;">${content.headline}</h1>
    <p style="font-size:19px;color:#555;max-width:620px;margin:0 auto 32px;line-height:1.75;">${content.subheadline}</p>
    <a href="#buy" style="display:inline-block;background:#111;color:#fff;padding:16px 40px;border-radius:10px;font-size:16px;font-weight:700;text-decoration:none;letter-spacing:.2px;transition:opacity .2s;">${content.ctaText}</a>
  </div>

  <!-- Body Text -->
  <p style="font-size:17px;line-height:1.85;color:#333;margin-bottom:56px;text-align:center;max-width:720px;margin-left:auto;margin-right:auto;">${content.bodyText}</p>

  <!-- Features -->
  <h2 style="font-size:30px;font-weight:700;margin-bottom:28px;text-align:center;">Why Choose Us</h2>
  <div style="display:flex;flex-wrap:wrap;gap:20px;margin-bottom:56px;justify-content:center;">
    ${featuresHtml}
  </div>

  <!-- CTA Banner -->
  <div style="text-align:center;padding:48px 32px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:20px;color:#fff;">
    <h2 style="margin:0 0 14px;font-size:30px;font-weight:800;">${content.headline}</h2>
    <p style="margin:0 0 28px;opacity:.9;font-size:17px;line-height:1.6;">${content.subheadline}</p>
    <a id="buy" href="#" style="display:inline-block;background:#fff;color:#764ba2;padding:16px 40px;border-radius:10px;font-size:16px;font-weight:800;text-decoration:none;">${content.ctaText}</a>
  </div>

</div>`;
  }

  // ── 3. Create Shopify Page ──────────────────────────────────────────────────

  async createPage(
    admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
    productName: string,
    htmlBody: string
  ): Promise<{ handle: string }> {
    const title = `${productName} - AI Landing Page`;

    const response = await withRetry(() =>
      admin.graphql(PAGE_CREATE, {
        variables: {
          page: {
            title,
            body: htmlBody,
            isPublished: true,
          },
        },
      })
    );

    const json = (await response.json()) as {
      data: {
        pageCreate: {
          page: { id: string; handle: string; title: string };
          userErrors: Array<{ field: string; message: string }>;
        };
      };
    };

    const errors = json.data?.pageCreate?.userErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`pageCreate errors: ${JSON.stringify(errors)}`);
    }

    const page = json.data?.pageCreate?.page;
    if (!page) throw new Error("pageCreate returned no page.");

    console.log(`[LandingPageService] Page created: /pages/${page.handle}`);
    return { handle: page.handle };
  }

  // ── 4. Orchestrate ──────────────────────────────────────────────────────────

  async generate(
    admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
    shopDomain: string,
    _accessToken: string,
    input: LandingPageInput
  ): Promise<LandingPageResult> {
    console.log("[LandingPageService] Generating AI content...");
    const content = await this.generateContent(input);

    const htmlBody = this.buildPageHtml(content, input.imageUrl);

    const { handle } = await this.createPage(admin, input.productName, htmlBody);

    return {
      pageHandle: handle,
      previewUrl: `https://${shopDomain}/pages/${handle}`,
    };
  }
}
