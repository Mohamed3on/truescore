// One model call written whole, or streamed when the caller wants it as it's
// written: `onText` / `onPartial` then get the text or object so far, each time
// it grows. Both packages' summaries make their calls here, so a streamed one
// can't drift from the whole one it stands in for.
import { generateObject, generateText, streamObject, streamText, type DeepPartial, type FlexibleSchema, type LanguageModel, type LanguageModelUsage } from 'ai';

type Call = { model: LanguageModel; prompt: string; providerOptions?: Record<string, Record<string, any>>; maxOutputTokens?: number };

export async function writeText(call: Call, onText?: (text: string) => void): Promise<{ text: string; usage: LanguageModelUsage }> {
  if (!onText) return generateText(call);
  // A failed call reaches only onError; the stream itself just ends.
  let failure: unknown;
  let text = '';
  const stream = streamText({ ...call, onError: ({ error }) => { failure = error; } });
  for await (const delta of stream.textStream) onText((text += delta));
  if (failure) throw failure;
  return { text, usage: await stream.usage };
}

// A reply that isn't the schema's shape throws NoObjectGeneratedError, with
// its text for salvage, either way.
export async function writeObject<T>(call: Call & { schema: FlexibleSchema<T> }, onPartial?: (partial: DeepPartial<T>) => void): Promise<{ object: T; usage: LanguageModelUsage }> {
  if (!onPartial) return generateObject(call);
  const stream = streamObject(call);
  // The SDK's output types are conditional on T, which a generic leaves unresolved.
  for await (const partial of stream.partialObjectStream) onPartial(partial as DeepPartial<T>);
  return { object: (await stream.object) as T, usage: await stream.usage };
}
