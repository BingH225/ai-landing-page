/**
 * LandingPageService
 * Generates AI-powered landing pages and publishes them as Shopify Pages.
 * Approach: Generate HTML body directly — no theme modifications needed.
 *
 * Content includes: headline, subheadline, CTA, body text, features (up to 6),
 * testimonials, urgency text, and SEO metadata.
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

export interface AudienceParams {
  audience?: string;
  channel?: string;
  interest?: string;
  promo?: string;
}

// ─── Zod Schema ───────────────────────────────────────────────────────────────

const LandingPageContentSchema = z.object({
  headline: z.string().max(200),
  subheadline: z.string().max(400),
  ctaText: z.string().max(60),
  bodyText: z.string().max(1200),
  heroImageAlt: z.string().max(200),
  seoTitle: z.string().max(120),
  seoDescription: z.string().max(300),
  urgencyText: z.string().max(200),
  features: z
    .array(
      z.object({
        icon: z.string().max(10),
        title: z.string().max(100),
        description: z.string().max(180),
      })
    )
    .min(1)
    .max(6),
  testimonials: z
    .array(
      z.object({
        name: z.string().max(80),
        role: z.string().max(100),
        quote: z.string().max(400),
        rating: z.number().int().min(1).max(5),
      })
    )
    .min(2)
    .max(4),
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStars(rating: number): string {
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

// ─── Proxy Fallback ───────────────────────────────────────────────────────────

interface ProxyEntry {
  label: string;
  client: OpenAI;
}

function buildProxyList(): ProxyEntry[] {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in environment variables.");
  }

  const entries: ProxyEntry[] = [];

  // Primary URL
  const primary = process.env.OPENAI_BASE_URL?.trim();
  if (primary) {
    entries.push({
      label: primary,
      client: new OpenAI({ apiKey, baseURL: primary }),
    });
  }

  // Fallback URLs (comma-separated)
  const fallbacks = process.env.OPENAI_FALLBACK_URLS?.trim();
  if (fallbacks) {
    for (const url of fallbacks.split(",").map((u) => u.trim()).filter(Boolean)) {
      entries.push({
        label: url,
        client: new OpenAI({ apiKey, baseURL: url }),
      });
    }
  }

  // If no URLs configured at all, use official OpenAI
  if (entries.length === 0) {
    entries.push({
      label: "api.openai.com (official)",
      client: new OpenAI({ apiKey }),
    });
  }

  return entries;
}

// ─── Service Class ────────────────────────────────────────────────────────────

export class LandingPageService {
  private proxies: ProxyEntry[];

  constructor() {
    this.proxies = buildProxyList();
    console.log(
      `[LandingPageService] Initialized with ${this.proxies.length} proxy endpoint(s): ${this.proxies.map((p) => p.label).join(", ")}`
    );
  }

  // ── 1. Generate AI Content (with proxy fallback) ────────────────────────────

  async generateContent(input: LandingPageInput, audienceParams?: AudienceParams): Promise<LandingPageContent> {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    console.log(`[LandingPageService] Using model: ${model}`);
    if (audienceParams) {
      console.log(`[LandingPageService] Audience params:`, audienceParams);
    }

    const systemPrompt = `You are an elite e-commerce copywriter and conversion rate optimization expert.
Generate landing page content that is persuasive, modern, and designed for maximum conversions.
Output ONLY valid JSON matching this schema exactly (no markdown, no extra text):
{
  "headline": "string (max 120 chars, power words, emotional hook)",
  "subheadline": "string (max 250 chars, expand on the headline promise)",
  "ctaText": "string (max 40 chars, action-oriented, urgent)",
  "bodyText": "string (max 800 chars, benefit-focused narrative)",
  "heroImageAlt": "string (max 120 chars)",
  "seoTitle": "string (max 70 chars, keyword-rich page title for SEO)",
  "seoDescription": "string (max 160 chars, compelling meta description for search engines)",
  "urgencyText": "string (max 120 chars, creates FOMO or time-limited offer feel)",
  "features": [
    { "icon": "single emoji", "title": "string (max 60 chars)", "description": "string (max 180 chars)" }
  ] (exactly 4-6 items, each with a unique benefit),
  "testimonials": [
    { "name": "string (max 40 chars, realistic name)", "role": "string (max 60 chars)", "quote": "string (max 200 chars)", "rating": number (4 or 5) }
  ] (exactly 3 items, realistic and specific)
}

Guidelines:
- Use power words: "Transform", "Unlock", "Exclusive", "Premium", "Revolutionary"
- Features should have a single relevant emoji as the icon
- Testimonials should sound authentic and specific, not generic
- Urgency text should create a sense of scarcity or time pressure
- SEO title should be optimized for search with target keywords
- All copy should be in the same language as the product name`;

    // Build audience-aware context
    const audienceContext: string[] = [];
    if (audienceParams?.audience) {
      audienceContext.push(`Target audience: ${audienceParams.audience}. Tailor the tone, scenarios, and language specifically for this audience.`);
    }
    if (audienceParams?.channel) {
      const channelMap: Record<string, string> = {
        social: "This user came from social media — use punchy, emotional, shareable copy with strong hooks.",
        google: "This user came from search — use benefit-focused, factual copy that answers their intent.",
        email: "This user came from an email campaign — use warm, personal, exclusive-feeling copy.",
      };
      audienceContext.push(channelMap[audienceParams.channel] || `Traffic source: ${audienceParams.channel}. Adjust the copy style accordingly.`);
    }
    if (audienceParams?.interest) {
      audienceContext.push(`User interest: ${audienceParams.interest}. Emphasize use cases and scenarios related to this interest.`);
    }
    if (audienceParams?.promo) {
      audienceContext.push(`Active promotion: ${audienceParams.promo}. Work this promotion into the urgency text and CTA.`);
    }

    const audienceSection = audienceContext.length > 0
      ? `\n\nPersonalization context:\n${audienceContext.join("\n")}`
      : "";

    const userPrompt = `Create high-conversion landing page copy for:
Product: ${input.productName}
Key Selling Points: ${input.sellingPoints}${audienceSection}

Write in a persuasive, modern marketing style. Make every word count. Output only valid JSON.`;

    const errors: string[] = [];

    for (const proxy of this.proxies) {
      try {
        console.log(`[LandingPageService] Trying proxy: ${proxy.label}`);

        const completion = await proxy.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_completion_tokens: 1500,
          response_format: { type: "json_object" },
        });

        const raw = completion.choices[0]?.message?.content ?? "{}";
        console.log(`[LandingPageService] ✅ Success via proxy: ${proxy.label}`);

        try {
          const parsed = JSON.parse(raw);
          return LandingPageContentSchema.parse(parsed);
        } catch (parseErr) {
          console.error("[LandingPageService] AI returned invalid JSON:", raw);
          throw new Error(`AI returned invalid JSON: ${parseErr}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // If it's a parse/validation error or an API-level error (not connection), don't retry
        if (msg.includes("invalid JSON") || msg.includes("400") || msg.includes("401") || msg.includes("403")) {
          throw err;
        }
        console.warn(`[LandingPageService] ❌ Proxy failed (${proxy.label}): ${msg}`);
        errors.push(`${proxy.label}: ${msg}`);
      }
    }

    throw new Error(
      `All ${this.proxies.length} proxy endpoints failed:\n${errors.join("\n")}`
    );
  }

  // ── 2. Build Styled HTML Body ───────────────────────────────────────────────

  buildPageHtml(content: LandingPageContent, imageUrl?: string): string {
    const featuresHtml = content.features
      .map(
        (f) => `
      <div style="flex:1 1 280px;max-width:360px;background:#ffffff;border-radius:16px;padding:32px 28px;box-shadow:0 4px 24px rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.04);transition:transform .2s,box-shadow .2s;">
        <div style="font-size:36px;margin-bottom:16px;">${f.icon}</div>
        <h3 style="margin:0 0 10px;font-size:18px;font-weight:700;color:#111;">${escapeHtml(f.title)}</h3>
        <p style="margin:0;color:#666;line-height:1.7;font-size:15px;">${escapeHtml(f.description)}</p>
      </div>`
      )
      .join("");

    const testimonialsHtml = content.testimonials
      .map(
        (t) => `
      <div style="flex:1 1 280px;max-width:360px;background:#ffffff;border-radius:16px;padding:32px 28px;box-shadow:0 2px 16px rgba(0,0,0,.05);border:1px solid rgba(0,0,0,.04);">
        <div style="color:#f59e0b;font-size:18px;letter-spacing:2px;margin-bottom:12px;">${renderStars(t.rating)}</div>
        <p style="margin:0 0 20px;color:#333;font-size:15px;line-height:1.75;font-style:italic;">"${escapeHtml(t.quote)}"</p>
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;">${t.name.charAt(0).toUpperCase()}</div>
          <div>
            <p style="margin:0;font-weight:700;font-size:14px;color:#111;">${escapeHtml(t.name)}</p>
            <p style="margin:0;font-size:13px;color:#888;">${escapeHtml(t.role)}</p>
          </div>
        </div>
      </div>`
      )
      .join("");

    const heroImageHtml = imageUrl
      ? `<img src="${imageUrl}" alt="${escapeHtml(content.heroImageAlt)}" style="width:100%;max-height:520px;object-fit:cover;border-radius:20px;margin-bottom:48px;box-shadow:0 8px 40px rgba(0,0,0,.12);">`
      : "";

    return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;max-width:900px;margin:0 auto;padding:60px 24px;color:#111;">

  <!-- Urgency Banner -->
  <div style="text-align:center;margin-bottom:40px;padding:14px 24px;background:linear-gradient(90deg,#ff6b6b,#ee5a24);border-radius:12px;color:#fff;">
    <p style="margin:0;font-size:15px;font-weight:700;letter-spacing:.3px;">🔥 ${escapeHtml(content.urgencyText)}</p>
  </div>

  <!-- Hero Image -->
  ${heroImageHtml}

  <!-- Hero Copy -->
  <div style="text-align:center;margin-bottom:64px;">
    <h1 style="font-size:clamp(32px,5vw,56px);font-weight:800;margin:0 0 20px;line-height:1.12;letter-spacing:-1px;background:linear-gradient(135deg,#111 0%,#555 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${escapeHtml(content.headline)}</h1>
    <p style="font-size:20px;color:#555;max-width:640px;margin:0 auto 36px;line-height:1.7;">${escapeHtml(content.subheadline)}</p>
    <a href="#buy" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:18px 48px;border-radius:12px;font-size:17px;font-weight:700;text-decoration:none;letter-spacing:.3px;box-shadow:0 4px 20px rgba(102,126,234,.4);transition:transform .2s,box-shadow .2s;">${escapeHtml(content.ctaText)}</a>
  </div>

  <!-- Body Text -->
  <p style="font-size:18px;line-height:1.85;color:#444;margin-bottom:72px;text-align:center;max-width:720px;margin-left:auto;margin-right:auto;">${escapeHtml(content.bodyText)}</p>

  <!-- Features -->
  <div style="margin-bottom:72px;">
    <h2 style="font-size:32px;font-weight:800;margin-bottom:12px;text-align:center;color:#111;">Why Choose Us</h2>
    <p style="text-align:center;color:#888;font-size:16px;margin-bottom:36px;">Everything you need, nothing you don't.</p>
    <div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:center;">
      ${featuresHtml}
    </div>
  </div>

  <!-- Testimonials -->
  <div style="margin-bottom:72px;">
    <h2 style="font-size:32px;font-weight:800;margin-bottom:12px;text-align:center;color:#111;">What Our Customers Say</h2>
    <p style="text-align:center;color:#888;font-size:16px;margin-bottom:36px;">Real people, real results.</p>
    <div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:center;">
      ${testimonialsHtml}
    </div>
  </div>

  <!-- CTA Banner -->
  <div style="text-align:center;padding:56px 36px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:24px;color:#fff;box-shadow:0 8px 40px rgba(102,126,234,.3);">
    <h2 style="margin:0 0 14px;font-size:32px;font-weight:800;">${escapeHtml(content.headline)}</h2>
    <p style="margin:0 0 12px;opacity:.9;font-size:17px;line-height:1.6;max-width:560px;margin-left:auto;margin-right:auto;">${escapeHtml(content.subheadline)}</p>
    <p style="margin:0 0 28px;font-size:14px;opacity:.8;font-weight:600;">🔥 ${escapeHtml(content.urgencyText)}</p>
    <a id="buy" href="#" style="display:inline-block;background:#fff;color:#764ba2;padding:18px 48px;border-radius:12px;font-size:17px;font-weight:800;text-decoration:none;box-shadow:0 4px 16px rgba(0,0,0,.15);transition:transform .2s;">${escapeHtml(content.ctaText)}</a>
  </div>

  <!-- SEO Hidden Metadata (for accessibility & structured data) -->
  <div style="display:none;" aria-hidden="true">
    <meta name="title" content="${escapeHtml(content.seoTitle)}">
    <meta name="description" content="${escapeHtml(content.seoDescription)}">
  </div>

</div>`;
  }

  // ── 3. Create Shopify Page ──────────────────────────────────────────────────

  async createPage(
    admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
    productName: string,
    htmlBody: string,
    seoTitle?: string,
    seoDescription?: string
  ): Promise<{ handle: string }> {
    const title = `${productName} - AI Landing Page`;

    const pageInput: Record<string, unknown> = {
      title,
      body: htmlBody,
      isPublished: true,
    };

    // Add SEO metadata if available
    if (seoTitle || seoDescription) {
      pageInput.metafields = [
        ...(seoTitle
          ? [{
            namespace: "global",
            key: "title_tag",
            value: seoTitle,
            type: "single_line_text_field",
          }]
          : []),
        ...(seoDescription
          ? [{
            namespace: "global",
            key: "description_tag",
            value: seoDescription,
            type: "single_line_text_field",
          }]
          : []),
      ];
    }

    const response = await withRetry(() =>
      admin.graphql(PAGE_CREATE, {
        variables: { page: pageInput },
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

    console.log("[LandingPageService] Building HTML...");
    const htmlBody = this.buildPageHtml(content, input.imageUrl);

    const { handle } = await this.createPage(
      admin,
      input.productName,
      htmlBody,
      content.seoTitle,
      content.seoDescription
    );

    return {
      pageHandle: handle,
      previewUrl: `https://${shopDomain}/pages/${handle}`,
    };
  }

  // ── 5. Generate standalone HTML (for App Proxy) ─────────────────────────────

  async generateHtmlOnly(
    input: LandingPageInput,
    audienceParams?: AudienceParams
  ): Promise<string> {
    console.log("[LandingPageService] Generating personalized AI content (proxy)...");
    const content = await this.generateContent(input, audienceParams);

    const bodyHtml = this.buildPageHtml(content, input.imageUrl);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(content.seoTitle)}</title>
  <meta name="description" content="${escapeHtml(content.seoDescription)}">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; background: #fafafa; color: #111; }
    a:hover { opacity: 0.9; transform: translateY(-1px); }
    div[style*="flex"] > div:hover { transform: translateY(-4px); box-shadow: 0 8px 32px rgba(0,0,0,.1) !important; }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
  }
}
