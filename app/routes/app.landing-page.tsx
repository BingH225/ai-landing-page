import {
    Page,
    Layout,
    Card,
    TextField,
    Button,
    Banner,
    BlockStack,
    InlineStack,
    Text,
    Spinner,
    Divider,
    Icon,
    Badge,
    Box,
} from "@shopify/polaris";
import { WandIcon } from "@shopify/polaris-icons";
import {
    Form,
    useActionData,
    useNavigation,
    useSubmit,
} from "@remix-run/react";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { LandingPageService } from "../services/landingPage.server";
import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActionResult {
    success: boolean;
    previewUrl?: string;
    pageHandle?: string;
    templateSuffix?: string;
    error?: string;
}

// ─── Server Action ────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);

    const formData = await request.formData();
    const productName = String(formData.get("productName") ?? "").trim();
    const sellingPoints = String(formData.get("sellingPoints") ?? "").trim();
    const imageUrl = String(formData.get("imageUrl") ?? "").trim() || undefined;

    if (!productName || !sellingPoints) {
        return json<ActionResult>({
            success: false,
            error: "Please fill in both the product name and selling points.",
        });
    }

    const shopDomain = session.shop;

    try {
        const service = new LandingPageService();
        const result = await service.generate(admin, shopDomain, session.accessToken!, {
            productName,
            sellingPoints,
            imageUrl,
        });

        return json<ActionResult>({
            success: true,
            previewUrl: result.previewUrl,
            pageHandle: result.pageHandle,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[LandingPage Route] Error:", message);
        return json<ActionResult>({ success: false, error: message });
    }
};

// ─── UI Component ─────────────────────────────────────────────────────────────

export default function LandingPageRoute() {
    const actionData = useActionData<typeof action>();
    const navigation = useNavigation();
    const submit = useSubmit();

    const isGenerating = navigation.state === "submitting";

    const [productName, setProductName] = useState("");
    const [sellingPoints, setSellingPoints] = useState("");
    const [imageUrl, setImageUrl] = useState("");

    const handleSubmit = () => {
        const formData = new FormData();
        formData.append("productName", productName);
        formData.append("sellingPoints", sellingPoints);
        formData.append("imageUrl", imageUrl);
        submit(formData, { method: "post" });
    };

    return (
        <Page
            title="AI Landing Page Generator"
            subtitle="Instantly create high-converting landing pages powered by AI"
            primaryAction={
                <Button
                    variant="primary"
                    icon={WandIcon}
                    loading={isGenerating}
                    onClick={handleSubmit}
                    disabled={!productName || !sellingPoints}
                >
                    {isGenerating ? "Generating..." : "Generate Landing Page"}
                </Button>
            }
        >
            <Layout>
                {/* Success Banner */}
                {actionData?.success && actionData.previewUrl && (
                    <Layout.Section>
                        <Banner
                            title="🎉 Landing page created successfully!"
                            tone="success"
                            action={{
                                content: "View Landing Page",
                                url: actionData.previewUrl,
                                external: true,
                            }}
                        >
                            <BlockStack gap="200">
                                <Text as="p" variant="bodyMd">
                                    Your AI-generated landing page is now live.
                                </Text>
                                <InlineStack gap="200" align="start">
                                    <Badge tone="success">Live</Badge>
                                </InlineStack>
                                <Text as="p" variant="bodySm" tone="subdued">
                                    URL:{" "}
                                    <a
                                        href={actionData.previewUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ wordBreak: "break-all" }}
                                    >
                                        {actionData.previewUrl}
                                    </a>
                                </Text>
                            </BlockStack>
                        </Banner>
                    </Layout.Section>
                )}

                {/* Error Banner */}
                {actionData?.success === false && actionData.error && (
                    <Layout.Section>
                        <Banner title="Generation failed" tone="critical">
                            <Text as="p" variant="bodyMd">
                                {actionData.error}
                            </Text>
                        </Banner>
                    </Layout.Section>
                )}

                {/* Main Form */}
                <Layout.Section>
                    <Card>
                        <BlockStack gap="500">
                            <BlockStack gap="200">
                                <Text as="h2" variant="headingMd">
                                    Product Information
                                </Text>
                                <Text as="p" variant="bodyMd" tone="subdued">
                                    Tell us about your product. Our AI will craft compelling copy
                                    and structure a beautiful landing page tailored for
                                    conversions.
                                </Text>
                            </BlockStack>

                            <Divider />

                            <Form method="post">
                                <BlockStack gap="400">
                                    <TextField
                                        label="Product Name"
                                        name="productName"
                                        id="productName"
                                        value={productName}
                                        onChange={setProductName}
                                        placeholder="e.g. UltraBoost Pro Wireless Earbuds"
                                        autoComplete="off"
                                        helpText="The name of the product to feature on the landing page."
                                        disabled={isGenerating}
                                    />

                                    <TextField
                                        label="Key Selling Points"
                                        name="sellingPoints"
                                        id="sellingPoints"
                                        value={sellingPoints}
                                        onChange={setSellingPoints}
                                        placeholder="e.g. 30-hour battery, noise cancellation, IPX5 waterproof, premium sound"
                                        multiline={4}
                                        autoComplete="off"
                                        helpText="List the most compelling features or benefits. Separate them with commas."
                                        disabled={isGenerating}
                                    />

                                    <TextField
                                        label="Product Image URL (optional)"
                                        name="imageUrl"
                                        id="imageUrl"
                                        value={imageUrl}
                                        onChange={setImageUrl}
                                        placeholder="https://example.com/product-image.jpg"
                                        autoComplete="off"
                                        helpText="Public URL of a product image to upload to Shopify CDN. Leave blank to skip."
                                        disabled={isGenerating}
                                    />
                                </BlockStack>
                            </Form>
                        </BlockStack>
                    </Card>
                </Layout.Section>

                {/* How It Works */}
                <Layout.Section variant="oneThird">
                    <Card>
                        <BlockStack gap="400">
                            <Text as="h2" variant="headingMd">
                                How It Works
                            </Text>
                            <BlockStack gap="300">
                                {[
                                    {
                                        step: "1",
                                        title: "AI Content Generation",
                                        desc: "AI crafts headlines, body copy, CTAs, testimonials, and feature highlights tailored to your product.",
                                    },
                                    {
                                        step: "2",
                                        title: "Page Creation",
                                        desc: "A beautifully styled landing page with urgency banners, testimonials, and SEO metadata is created.",
                                    },
                                    {
                                        step: "3",
                                        title: "Page Published",
                                        desc: "A Shopify Page is created and linked to the new template. Your landing page is instantly live.",
                                    },
                                ].map((item) => (
                                    <InlineStack key={item.step} gap="300" align="start">
                                        <Box
                                            background="bg-fill-brand"
                                            borderRadius="full"
                                            padding="150"
                                            minWidth="28px"
                                        >
                                            <Text
                                                as="span"
                                                variant="bodyMd"
                                                fontWeight="bold"
                                                alignment="center"
                                            >
                                                {item.step}
                                            </Text>
                                        </Box>
                                        <BlockStack gap="100">
                                            <Text as="p" variant="bodyMd" fontWeight="semibold">
                                                {item.title}
                                            </Text>
                                            <Text as="p" variant="bodySm" tone="subdued">
                                                {item.desc}
                                            </Text>
                                        </BlockStack>
                                    </InlineStack>
                                ))}
                            </BlockStack>
                        </BlockStack>
                    </Card>

                    {/* Loading state card */}
                    {isGenerating && (
                        <Box paddingBlockStart="400">
                            <Card>
                                <BlockStack gap="300" align="center">
                                    <Spinner accessibilityLabel="Generating landing page" size="large" />
                                    <Text as="p" variant="bodyMd" alignment="center">
                                        AI is crafting your landing page...
                                    </Text>
                                    <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                                        This may take 10–30 seconds
                                    </Text>
                                </BlockStack>
                            </Card>
                        </Box>
                    )}
                </Layout.Section>
            </Layout>
        </Page>
    );
}
