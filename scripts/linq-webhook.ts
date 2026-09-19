// Turns our Linq webhook subscription on/off for local testing.
//   npx tsx scripts/linq-webhook.ts on            # point it at the running ngrok tunnel and activate
//   npx tsx scripts/linq-webhook.ts on <https-url> # use a specific public URL instead
//   npx tsx scripts/linq-webhook.ts off           # stop Linq from sending events
//   npx tsx scripts/linq-webhook.ts status        # show where it points and whether it is active
// Needs LINQ_API_KEY and LINQ_WEBHOOK_SUBSCRIPTION_ID in .env.
// Note: Linq updates subscriptions with PUT (PATCH returns 405, despite the docs).
import { env } from "../src/config/env";

const WEBHOOK_PATH = "/webhooks/linq";
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

interface Subscription {
  id: string;
  is_active: boolean;
  target_url: string;
  subscribed_events: string[];
  phone_numbers: string[] | null;
}

function subscriptionUrl(): string {
  const id = process.env.LINQ_WEBHOOK_SUBSCRIPTION_ID ?? "";
  if (!id) throw new Error("LINQ_WEBHOOK_SUBSCRIPTION_ID must be set in .env");
  if (!env.LINQ_API_KEY) throw new Error("LINQ_API_KEY must be set in .env");
  return `${env.LINQ_BASE_URL}/webhook-subscriptions/${encodeURIComponent(id)}`;
}

async function linq(method: "GET" | "PUT", body?: object): Promise<Subscription> {
  const res = await fetch(subscriptionUrl(), {
    method,
    headers: { Authorization: `Bearer ${env.LINQ_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Linq ${method} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Subscription;
}

async function detectNgrokUrl(): Promise<string> {
  let data: { tunnels?: Array<{ public_url?: string; config?: { addr?: string } }> };
  try {
    data = (await (await fetch(NGROK_API)).json()) as typeof data;
  } catch {
    throw new Error("ngrok isn't running (start it with: ngrok http 3000), or pass the URL: on <https-url>");
  }
  const tunnel = data.tunnels?.find((t) => t.public_url?.startsWith("https://"));
  if (!tunnel?.public_url) throw new Error("ngrok is running but has no https tunnel");
  return tunnel.public_url;
}

function toWebhookUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol !== "https:") throw new Error(`webhook URL must be https: ${base}`);
  url.pathname = WEBHOOK_PATH;
  url.search = "";
  return url.toString();
}

async function checkReachable(webhookUrl: string): Promise<void> {
  const health = new URL("/health", webhookUrl).toString();
  try {
    const res = await fetch(health, { headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      console.log(`✓ server reachable at ${health}`);
      return;
    }
    console.warn(`! ${health} answered HTTP ${res.status}. Is \`npm run dev\` running?`);
  } catch {
    console.warn(`! could not reach ${health}. Is \`npm run dev\` running?`);
  }
}

function show(sub: Subscription): void {
  console.log(`${sub.is_active ? "ON " : "OFF"}  ${sub.target_url}`);
  console.log(`     events: ${sub.subscribed_events.join(", ")}   numbers: ${sub.phone_numbers?.join(", ") ?? "all"}`);
}

async function main(): Promise<void> {
  const [command, urlArg] = process.argv.slice(2);

  if (command === "on") {
    const webhookUrl = toWebhookUrl(urlArg ?? (await detectNgrokUrl()));
    await checkReachable(webhookUrl);
    show(await linq("PUT", { target_url: webhookUrl, is_active: true }));
  } else if (command === "off") {
    show(await linq("PUT", { is_active: false }));
  } else if (command === "status") {
    show(await linq("GET"));
  } else {
    console.error("usage: npx tsx scripts/linq-webhook.ts on [https-url] | off | status");
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
