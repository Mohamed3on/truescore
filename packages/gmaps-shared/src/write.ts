// One model call written whole, or streamed when the caller wants it as it's
// written: `onText` / `onPartial` then get the text or object so far, each time
// it grows. Both packages' summaries and the server's Thread Ask make their
// calls here, so a streamed one can't drift from the whole one it stands in for.
import { generateText, NoObjectGeneratedError, Output, streamText, type DeepPartial, type FlexibleSchema, type LanguageModel, type LanguageModelUsage, type Prompt } from 'ai';

type Call = { model: LanguageModel; providerOptions?: Record<string, Record<string, any>>; maxOutputTokens?: number; abortSignal?: AbortSignal } & Prompt;

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

// A reply that isn't the schema's shape throws NoObjectGeneratedError, either
// way. With `salvage`, a reply cut off at the token cap keeps what made it out
// of its text rather than lose the whole object.
export async function writeObject<T, S = T>({ schema, ...call }: Call & { schema: FlexibleSchema<T> }, onPartial?: (partial: DeepPartial<T>) => void, salvage?: (text: string) => S): Promise<{ object: T | S; usage: LanguageModelUsage | undefined }> {
  const output = Output.object({ schema });
  try {
    if (!onPartial) {
      const whole = await generateText({ ...call, output });
      return { object: whole.output, usage: whole.usage };
    }
    // As in writeText, a failed call reaches only onError.
    let failure: unknown;
    const stream = streamText({ ...call, output, onError: ({ error }) => { failure = error; } });
    for await (const partial of stream.partialOutputStream) onPartial(partial);
    if (failure) throw failure;
    return { object: await stream.output, usage: await stream.usage };
  } catch (e) {
    if (salvage && NoObjectGeneratedError.isInstance(e) && e.text) return { object: salvage(e.text), usage: e.usage };
    throw e;
  }
}
