import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import solc from "solc";

const CONTRACTS_DIR = resolve("contracts");
const ARTIFACTS_DIR = join(CONTRACTS_DIR, "artifacts");
const NODE_MODULES = resolve("node_modules");

interface SolcOutput {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<
    string,
    Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>
  >;
}

function collectSources(dir: string): Record<string, { content: string }> {
  const sources: Record<string, { content: string }> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && path !== ARTIFACTS_DIR) {
      Object.assign(sources, collectSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      sources[relative(CONTRACTS_DIR, path)] = {
        content: readFileSync(path, "utf8"),
      };
    }
  }
  return sources;
}

function findImport(path: string): { contents: string } | { error: string } {
  try {
    return { contents: readFileSync(join(NODE_MODULES, path), "utf8") };
  } catch {
    return { error: `import not found: ${path}` };
  }
}

const input = {
  language: "Solidity",
  sources: collectSources(CONTRACTS_DIR),
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImport }),
) as SolcOutput;

const errors = output.errors?.filter((e) => e.severity === "error") ?? [];
for (const warning of output.errors?.filter((e) => e.severity !== "error") ??
  []) {
  console.warn(warning.formattedMessage);
}
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

mkdirSync(ARTIFACTS_DIR, { recursive: true });
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  if (!(file in input.sources)) continue;
  for (const [name, contract] of Object.entries(contracts)) {
    const bytecode = contract.evm.bytecode.object;
    if (!bytecode) continue;
    writeFileSync(
      join(ARTIFACTS_DIR, `${name}.json`),
      `${JSON.stringify({ contractName: name, abi: contract.abi, bytecode: `0x${bytecode}` }, null, 2)}\n`,
    );
    console.log(`compiled ${file}:${name} (${bytecode.length / 2} bytes)`);
  }
}
