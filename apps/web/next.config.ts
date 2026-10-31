import path from "node:path";
import type { NextConfig } from "next";

const root = path.join(import.meta.dirname, "../..");

// The workspace packages are NodeNext ESM: relative imports say ".js" and mean the ".ts" source.
const stripJsExt = path.join(import.meta.dirname, "build/strip-js-ext.cjs");

const config: NextConfig = {
  transpilePackages: ["@claim/core", "@claim/listing", "@claim/resolver", "@claim/llm", "@claim/paypal", "@claim/closer"],
  // The Agent Toolkit is CommonJS with its own axios and zod; Node loads it as is rather than the bundler.
  serverExternalPackages: ["@paypal/agent-toolkit"],
  outputFileTracingRoot: root,
  devIndicators: false,
  turbopack: {
    root,
    rules: { "*.ts": { loaders: [stripJsExt], as: "*.ts" } },
  },
  webpack(config) {
    config.resolve ??= {};
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return config;
  },
};

export default config;
