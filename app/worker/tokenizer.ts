import { Tokenizer } from "@huggingface/tokenizers";
import tokenizerConfigRaw from "./tokenizer/bge-small-en-v1.5/tokenizer_config.json?raw";
import tokenizerJsonRaw from "./tokenizer/bge-small-en-v1.5/tokenizer.json?raw";

/** The embedding model's own WordPiece tokenizer; see tokenizer/bge-small-en-v1.5/NOTICE.md. */
export const TOKENIZER_NAME = "BAAI/bge-small-en-v1.5";
/** The model's sequence length, [CLS] and [SEP] included. */
export const MODEL_MAX_TOKENS = 512;

let instance: Tokenizer | undefined;

/** Lazily built singleton; the first call parses the 711 KB vocabulary. */
export function getTokenizer(): Tokenizer {
  instance ??= new Tokenizer(JSON.parse(tokenizerJsonRaw), JSON.parse(tokenizerConfigRaw));
  return instance;
}

/** Model input length of `text`: [CLS] + WordPiece tokens + [SEP]. Never truncated. */
export function countModelTokens(text: string): number {
  return getTokenizer().encode(text, { add_special_tokens: true }).ids.length;
}
