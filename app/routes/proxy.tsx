import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { LandingPageService } from "../services/landingPage.server";
import type { AudienceParams } from "../services/landingPage.server";

/**
 * App Proxy route: /tools/landing
 *
 * Generates personalized landing page HTML based on URL parameters.
 * Accessed via: https://store.myshopify.com/tools/landing?product=...&points=...&audience=...
 *
 * Required params: product, points
 * Optional params: audience, channel, interest, promo, image
 */

function errorPage(title: string, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #fafafa; margin: 0; }
    .card { text-align: center; background: #fff; padding: 48px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); max-width: 480px; }
    h1 { font-size: 24px; margin: 0 0 12px; color: #111; }
    p { font-size: 16px; color: #666; line-height: 1.6; margin: 0; }
    code { background: #f3f4f6; padding: 2px 8px; border-radius: 4px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
    // Authenticate the app proxy request
    const { session } = await authenticate.public.appProxy(request);

    if (!session) {
        return new Response(
            errorPage("Unauthorized", "This app is not installed on this store."),
            { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
    }

    // Parse URL parameters
    const url = new URL(request.url);
    const product = url.searchParams.get("product")?.trim();
    const points = url.searchParams.get("points")?.trim();
    const image = url.searchParams.get("image")?.trim() || undefined;

    // Validate required params
    if (!product || !points) {
        const missing = [];
        if (!product) missing.push("product");
        if (!points) missing.push("points");

        return new Response(
            errorPage(
                "Missing Parameters",
                `Required parameters: <code>product</code>, <code>points</code>.<br><br>
        Example: <code>?product=Earbuds&points=noise cancellation,waterproof</code><br><br>
        Missing: <code>${missing.join(", ")}</code>`
            ),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
    }

    // Parse audience params
    const audienceParams: AudienceParams = {};
    const audience = url.searchParams.get("audience")?.trim();
    const channel = url.searchParams.get("channel")?.trim();
    const interest = url.searchParams.get("interest")?.trim();
    const promo = url.searchParams.get("promo")?.trim();

    if (audience) audienceParams.audience = audience;
    if (channel) audienceParams.channel = channel;
    if (interest) audienceParams.interest = interest;
    if (promo) audienceParams.promo = promo;

    try {
        const service = new LandingPageService();
        const html = await service.generateHtmlOnly(
            { productName: product, sellingPoints: points, imageUrl: image },
            Object.keys(audienceParams).length > 0 ? audienceParams : undefined
        );

        return new Response(html, {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[ProxyLanding] Error:", message);

        return new Response(
            errorPage(
                "Generation Failed",
                `Something went wrong while generating your page. Please try again.<br><br>
        <small style="color:#999">${message.slice(0, 200)}</small>`
            ),
            { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
    }
};
