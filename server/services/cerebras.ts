import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { AIService, ChatMessage } from '../types';

const cerebras = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY || '',
});

export const cerebrasService: AIService = {
  name: 'Cerebras',
  async chat(messages: ChatMessage[]) {
    try {
      const chatCompletion = await cerebras.chat.completions.create({
        messages: messages as any,
        model: 'gpt-oss-120b',
        stream: true,
        max_completion_tokens: 2048,
        temperature: 0.2,
        top_p: 1
      });
      
      return (async function*() {
        for await (const chunk of chatCompletion) {
          yield (chunk as any).choices[0]?.delta?.content || ''
        }
      })();
    } catch (err: any) {
      console.error(`[Cerebras] Error: ${err.message}`, err.status, err.body);
      throw err;
    }
  }
}