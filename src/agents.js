// Known AI agents and crawlers, matched by user-agent substring.
// kind:
//   live          fetches made while a person is in a conversation (the ones Wake gives sessions to)
//   search        crawlers that build an AI search index
//   training      crawlers that collect training data
//   search-engine classic search engines; they must never see session codes
// Order matters: the first match wins.
export const AGENTS = [
  // `wake verify` says who it is instead of borrowing an assistant's name, and is treated like a live agent.
  { match: 'Wake-Verify', name: 'Wake verify', vendor: 'Wake', kind: 'live' },
  { match: 'ChatGPT-User', name: 'ChatGPT', vendor: 'OpenAI', kind: 'live' },
  { match: 'Claude-User', name: 'Claude', vendor: 'Anthropic', kind: 'live' },
  { match: 'Perplexity-User', name: 'Perplexity', vendor: 'Perplexity', kind: 'live' },
  { match: 'MistralAI-User', name: 'Le Chat', vendor: 'Mistral', kind: 'live' },
  { match: 'Meta-ExternalFetcher', name: 'Meta AI', vendor: 'Meta', kind: 'live' },
  { match: 'DuckAssistBot', name: 'DuckAssist', vendor: 'DuckDuckGo', kind: 'live' },

  { match: 'OAI-SearchBot', name: 'OpenAI search', vendor: 'OpenAI', kind: 'search' },
  { match: 'Claude-SearchBot', name: 'Claude search', vendor: 'Anthropic', kind: 'search' },
  { match: 'PerplexityBot', name: 'Perplexity search', vendor: 'Perplexity', kind: 'search' },
  { match: 'YouBot', name: 'You.com', vendor: 'You.com', kind: 'search' },

  { match: 'GPTBot', name: 'GPTBot', vendor: 'OpenAI', kind: 'training' },
  { match: 'ClaudeBot', name: 'ClaudeBot', vendor: 'Anthropic', kind: 'training' },
  { match: 'anthropic-ai', name: 'anthropic-ai', vendor: 'Anthropic', kind: 'training' },
  { match: 'CCBot', name: 'Common Crawl', vendor: 'Common Crawl', kind: 'training' },
  { match: 'Bytespider', name: 'Bytespider', vendor: 'ByteDance', kind: 'training' },
  { match: 'Meta-ExternalAgent', name: 'Meta crawler', vendor: 'Meta', kind: 'training' },
  { match: 'Amazonbot', name: 'Amazonbot', vendor: 'Amazon', kind: 'training' },
  { match: 'cohere-ai', name: 'Cohere', vendor: 'Cohere', kind: 'training' },

  { match: 'Googlebot', name: 'Googlebot', vendor: 'Google', kind: 'search-engine' },
  { match: 'bingbot', name: 'Bingbot', vendor: 'Microsoft', kind: 'search-engine' },
  { match: 'DuckDuckBot', name: 'DuckDuckBot', vendor: 'DuckDuckGo', kind: 'search-engine' },
  { match: 'YandexBot', name: 'YandexBot', vendor: 'Yandex', kind: 'search-engine' },
  { match: 'Baiduspider', name: 'Baiduspider', vendor: 'Baidu', kind: 'search-engine' },
  { match: 'Applebot', name: 'Applebot', vendor: 'Apple', kind: 'search-engine' },
];

/**
 * Classify a user-agent string. Extra entries from the site config are checked first.
 * Returns null for ordinary browsers.
 * Note: this trusts the user-agent. Production deployments should also verify
 * published IP ranges (or Web Bot Auth signatures) before trusting a claimed agent.
 */
export function classifyAgent(ua, extra = []) {
  if (!ua) return null;
  const lower = ua.toLowerCase();
  for (const a of [...extra, ...AGENTS]) {
    if (lower.includes(a.match.toLowerCase())) return { name: a.name, vendor: a.vendor, kind: a.kind };
  }
  return null;
}
