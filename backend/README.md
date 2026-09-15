# LinkLingo backend

## Provider routing

Text generation uses OpenRouter with `OPENROUTER_API_KEY` unique to each environment.
`OPENROUTER_MODEL` defaults to `google/gemini-3.5-flash-lite`;
`OPENROUTER_ANALYST_MODEL` defaults to `google/gemini-3.1-pro-preview`.
Existing structured outputs, token metrics and `geminiMs` response fields remain
compatible with installed miniapps. This app does not use public web search.
