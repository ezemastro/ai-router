import { cerebrasService } from "./services/cerebras";
import { groqService } from "./services/groq";
import { openrouterService } from "./services/openrouter";
import type { AIService, ChatMessage } from "./types";
const port = Number(process.env.PORT ?? 3000);

function getContentType(path: string) {
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

let services: AIService[] = [
  groqService,
  cerebrasService,
  openrouterService
];
let currentServiceIndex = 0;

function getNextService() {
  const service = services[currentServiceIndex];
  currentServiceIndex = (currentServiceIndex + 1) % services.length;
  return service;
}

export function setServices(newServices: AIService[]) {
  services = newServices;
  currentServiceIndex = 0;
}

export async function handleRequest(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  // Serve minimal static frontend from ./public when running under Bun
  if (req.method === "GET") {
    if (pathname === "/" || pathname.startsWith("/static/")) {
      if (typeof Bun !== "undefined") {
        const rel = pathname === "/" ? "/index.html" : pathname.replace(/^\/static/, "");
        const filePath = `./public${rel}`;
        try {
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": getContentType(filePath) },
          });
        } catch (e) {
          return new Response("Not found", { status: 404 });
        }
      }
    }
  }
  if (pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST" && pathname === "/chat") {
    const { messages } = (await req.json()) as { messages: ChatMessage[] };
    const service = getNextService();

    const stream = await service?.chat(messages);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

// Start server when run directly
if (typeof Bun !== "undefined") {
  Bun.serve({
    port,
    fetch: handleRequest,
  });

  console.log(`Server listening on http://localhost:${port}`);
}