/**
 * Deploys with the deployer's values from the gitignored deploy.env (see
 * deploy.env.example), so wrangler.jsonc stays free of any one deployment.
 * Writes them over wrangler.jsonc into wrangler.deploy.json, applies remote
 * migrations, then runs `wrangler deploy`. Extra arguments go to `wrangler
 * deploy`; with --dry-run, migrations are skipped.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";

const appDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const envFile = `${appDir}deploy.env`;
const deployConfig = `${appDir}wrangler.deploy.json`;

// Variables already in the environment win over the file.
if (NodeFS.existsSync(envFile)) process.loadEnvFile(envFile);
const env = (name: string) => process.env[name]?.trim() || undefined;

const missing = ["PUBLIC_ORIGIN", "OWNER_EMAILS", "EMAIL_FROM", "D1_DATABASE_ID"].filter(
  (name) => env(name) === undefined,
);
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")} in deploy.env (see deploy.env.example).`);
  process.exit(1);
}
const publicOrigin = new URL(env("PUBLIC_ORIGIN")!);
if (publicOrigin.protocol !== "https:") {
  console.error("PUBLIC_ORIGIN must be an https:// origin, such as https://docs.example.com.");
  process.exit(1);
}

// JSON with comments and trailing commas is a valid JavaScript expression.
const config = NodeVM.runInNewContext(
  `(${NodeFS.readFileSync(`${appDir}wrangler.jsonc`, "utf8")})`,
);
config.routes = [{ pattern: publicOrigin.host, custom_domain: true }];
config.d1_databases = config.d1_databases.map((database: { binding: string }) =>
  database.binding === "DB" ? { ...database, database_id: env("D1_DATABASE_ID") } : database,
);
config.vars = {
  ...config.vars,
  OWNER_EMAILS: env("OWNER_EMAILS"),
  EMAIL_FROM: env("EMAIL_FROM"),
  PUBLIC_ORIGIN: publicOrigin.origin,
};
NodeFS.writeFileSync(deployConfig, `${JSON.stringify(config, null, 2)}\n`);

const args = process.argv.slice(2);
const wrangler = (...command: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("wrangler", [...command, "--config", deployConfig], {
    cwd: appDir,
    stdio: "inherit",
  });
if (!args.includes("--dry-run")) wrangler("d1", "migrations", "apply", "DB", "--remote");
wrangler("deploy", ...args);
