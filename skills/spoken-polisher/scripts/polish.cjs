#!/usr/bin/env node
// 口语化润色 CLI — 复用浏览器插件的 polish-core.js，真实调用 Claude / DeepSeek / ChatGPT。
//
// 用法:
//   node polish.cjs [--provider claude|deepseek|chatgpt] [--model <name>] [--dry-run] <text>
//   echo "一段文字" | node polish.cjs --provider deepseek
//
// API key 从环境变量读取（按所选 provider）:
//   ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// 没有 key 或加 --dry-run 时，只打印将要发送的 prompt 和长度限制，不发请求。

const path = require("path");

const core = require(path.resolve(__dirname, "../../../extension/polish-core.js"));

const ENV_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY"
};

const PROVIDER_ALIASES = {
  claude: "anthropic",
  anthropic: "anthropic",
  deepseek: "deepseek",
  chatgpt: "openai",
  gpt: "openai",
  openai: "openai"
};

function parseArgs(argv) {
  const args = { provider: null, model: null, dryRun: false, textParts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--provider" || a === "--api") {
      args.provider = argv[++i];
    } else if (a === "--model") {
      args.model = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else {
      args.textParts.push(a);
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

function resolveProvider(raw) {
  if (raw) {
    const provider = PROVIDER_ALIASES[String(raw).toLowerCase()];
    if (!provider) {
      process.stderr.write(`不支持的 provider：${raw}（可选 claude / deepseek / chatgpt）\n`);
      process.exit(1);
    }
    return provider;
  }
  // 没指定时，挑第一个配了环境变量 key 的；都没配就默认 anthropic（走 dry-run）。
  for (const p of Object.keys(ENV_KEYS)) {
    if (process.env[ENV_KEYS[p]]) return p;
  }
  return "anthropic";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let text = args.textParts.join(" ").trim();
  if (!text && !process.stdin.isTTY) {
    text = await readStdin();
  }
  if (!text) {
    process.stderr.write("Usage: node polish.cjs [--provider claude|deepseek|chatgpt] [--model <name>] [--dry-run] <text>\n");
    process.exit(1);
  }

  const provider = resolveProvider(args.provider);
  const apiKey = process.env[ENV_KEYS[provider]] || "";
  const policy = core.getLengthPolicy(text);

  if (args.dryRun || !apiKey) {
    if (!apiKey && !args.dryRun) {
      process.stderr.write(`[dry-run] 未设置 ${ENV_KEYS[provider]}，只打印 prompt 不发请求。\n\n`);
    }
    process.stdout.write(core.buildPrompt(text));
    process.stdout.write(`\n\nLength policy: original=${policy.originalChars}, hard_max=${policy.hardMax}\n`);
    return;
  }

  const settings = {
    provider,
    [core.PROVIDERS[provider].keyField]: apiKey,
    models: args.model ? { [provider]: args.model } : {}
  };

  async function callProvider(request) {
    const response = await fetch(request.url, request.options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && payload.error && (payload.error.message || payload.error.type);
      throw new Error(message || `API 请求失败：HTTP ${response.status}`);
    }
    const output = core.extractText(provider, payload);
    if (!output) {
      throw new Error("模型没有返回可用文本。");
    }
    return output;
  }

  const output = await callProvider(core.buildProviderRequest(provider, text, settings));

  // 用户最终原则：内容一定要生产出来——超限/段落规则都不拦截输出（提示词引导，不强制）
  process.stdout.write(output + "\n");
}

main().catch((error) => {
  process.stderr.write(`出错了：${error.message}\n`);
  process.exit(1);
});
