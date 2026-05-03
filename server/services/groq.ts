import { Groq } from 'groq-sdk';
import type { AIService, ChatMessage } from '../types';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '',
});

export const groqService: AIService = {
  name: 'Groq',
  async chat(messages: ChatMessage[]) {
    const chatCompletion = await groq.chat.completions.create({
      messages,
      "model": "llama-3.3-70b-versatile",
      "temperature": 1,
      "max_completion_tokens": 1024,
      "top_p": 1,
      "stream": true,
      "stop": null
    });
    
    return (async function*() {
      for await (const chunk of chatCompletion) {
        yield chunk.choices[0]?.delta?.content || ''
      }
    })();
  }
}

