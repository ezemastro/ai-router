import { OpenRouter } from "@openrouter/sdk";
import type { AIService, ChatMessage } from "../types";

const openrouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || '',
});
 
export const openrouterService: AIService = {
  name: 'OpenRouter',
  async chat(messages: ChatMessage[]) {
    const stream = await openrouter.chat.send({
      chatRequest: {
        model: "z-ai/glm-4.5-air:free",
        messages,
        stream: true
      }
    });
    
    return (async function*() {
      for await (const chunk of stream) {
        yield chunk.choices[0]?.delta?.content || ''
      }
    })();
  }
}