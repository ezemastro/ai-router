import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { ChatMessage } from '../types';

const cerebras = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY || '',
});

export const cerebrasService = {
  name: 'Cerebras',
  async chat(messages: ChatMessage[]) {
    const chatCompletion = await cerebras.chat.completions.create({
      messages: messages as any,
      model: 'llama3.1-8b',
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
  }
}