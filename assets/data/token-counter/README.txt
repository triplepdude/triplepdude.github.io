OpenAI tokenizer data for the Token Counter (/token-counter/)
============================================================

Files:    o200k_base.bin.gz   (199,998 tokens; used by GPT-5, GPT-4.1, GPT-4o, o-series)
          cl100k_base.bin.gz  (100,256 tokens; used by GPT-4, GPT-3.5 Turbo, text-embedding-3)

Source:   gpt-tokenizer 4.0.0, files data/o200k_base.tiktoken and
          data/cl100k_base.tiktoken, unmodified apart from the format change below.
          https://registry.npmjs.org/gpt-tokenizer/-/gpt-tokenizer-4.0.0.tgz
          https://github.com/niieani/gpt-tokenizer
          sha256 of the .tiktoken files:
            o200k_base   446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d
            cl100k_base  223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7
          The same rank tables are published by OpenAI with tiktoken
          (https://github.com/openai/tiktoken); they were checked to be identical
          to the tables tiktoken 0.14.0 downloads.

License:  MIT. gpt-tokenizer: LICENSE-gpt-tokenizer.txt (Copyright (c) 2023-2024
          Bazyli Brzoska). tiktoken: LICENSE-tiktoken.txt (Copyright (c) 2022
          OpenAI, Shantanu Jain).

Format change: a .tiktoken file has one "<base64 token bytes> <rank>" line per
token. The ranks run 0..N-1 without gaps, so each .bin file stores, in rank
order, one length byte followed by that many raw token bytes, and is then
compressed with `gzip -9 -n`. The page decompresses it with the browser's
DecompressionStream and does the byte-pair encoding itself (in a Web Worker).
