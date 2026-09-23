# LinkLingo backend

## Provider routing

Text generation uses OpenRouter with `OPENROUTER_API_KEY` unique to each environment.
`OPENROUTER_MODEL` defaults to `google/gemini-3.5-flash-lite`;
`OPENROUTER_ANALYST_MODEL` is set in `porter.dev.yaml`; unset, it falls back
to `DEFAULT_ANALYST_MODEL` in `src/services/openrouter.ts`.
Existing structured outputs, token metrics and `geminiMs` response fields remain
compatible with installed miniapps. This app does not use public web search.
