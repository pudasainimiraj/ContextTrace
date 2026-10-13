# Vendored tokenizer files

Files in this directory are copied verbatim from the Hugging Face model repository
[BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5), revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`,
on 2026-10-13. They are licensed under the MIT License by the Beijing Academy of Artificial
Intelligence (see the model card).

| File | Source | SHA-256 |
| --- | --- | --- |
| tokenizer.json | https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/tokenizer.json | d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66 |
| tokenizer_config.json | https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/tokenizer_config.json | 9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3 |

The Worker counts passage tokens with these files so that `passages.token_count` is the
exact input length the `@cf/baai/bge-small-en-v1.5` model sees. Changing them changes
`TRANSFORM_VERSION` in `app/worker/transform.ts`.
