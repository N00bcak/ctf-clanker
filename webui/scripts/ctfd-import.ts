import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { competitionUrl, crawlCtfd, importBundle } from "../server/src/import/ctfd.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    url: { type: "string" }, account: { type: "string" }, out: { type: "string" },
    profile: { type: "string" }, clanker: { type: "string", default: "http://127.0.0.1:8787" },
    ids: { type: "string" }, categories: { type: "string" },
    headed: { type: "boolean" }, start: { type: "boolean" }, "include-solved": { type: "boolean" },
    help: { type: "boolean" }
} });
const command = positionals[0];
if (values.help || !command) {
    console.log(`CTFd → Clanker
  login --url URL [--profile DIR]
  crawl --url URL --account TEAM_OR_USER --out DIR [--ids 1,2] [--categories web,crypto]
  import --out DIR [--clanker URL] [--start]
  run --url URL --account TEAM_OR_USER --out DIR [--clanker URL] [--start]

crawl/run reuse the login profile; --headed shows the browser. Defaults: unsolved, local drafts.
Use --include-solved to include solved challenges. WEBUI_AUTH_TOKEN authenticates to clanker.
Profiles default to ~/.local/share/ctf-clanker/browsers/<competition hash>; keep them outside bundles.`);
} else {
    try {
        if (!["login", "crawl", "import", "run"].includes(command)) throw new Error("unknown command; use --help");
        if (command !== "login" && !values.out) throw new Error("--out is required");
        if (command !== "import") {
            if (!values.url) throw new Error("--url is required");
            if (command !== "login" && !values.account) throw new Error("--account is required (stable team/user scope)");
            const url = competitionUrl(values.url);
            const { createHash } = await import("node:crypto");
            const profile = path.resolve(values.profile ?? path.join(os.homedir(), ".local/share/ctf-clanker/browsers", createHash("sha256").update(url).digest("hex").slice(0, 16)));
            const out = values.out ? path.resolve(values.out) : undefined;
            if (out && (profile === out || profile.startsWith(out + path.sep) || out.startsWith(profile + path.sep))) {
                throw new Error("browser profile and bundle must be separate directories");
            }
            await fs.mkdir(profile, { recursive: true, mode: 0o700 });
            await fs.chmod(profile, 0o700);
            const context = await chromium.launchPersistentContext(profile, { headless: command !== "login" && !values.headed });
            try {
                const page = context.pages()[0] ?? await context.newPage();
                if (command === "login") {
                    await page.goto(`${url}/login`);
                    const terminal = createInterface({ input: process.stdin, output: process.stdout });
                    try { await terminal.question("Complete login in the browser, then press Enter here to save the session. "); }
                    finally { terminal.close(); }
                } else {
                    const report = await crawlCtfd(page, {
                        baseUrl: url, account: values.account!, out: out!,
                        ids: values.ids?.split(","), categories: values.categories?.split(","), includeSolved: values["include-solved"]
                    });
                    console.log(`Collected ${report.entries.filter((entry) => entry.state === "complete").length} challenges; report: ${path.join(out!, "report.json")}`);
                    if (report.entries.some((entry) => entry.state === "incomplete")) process.exitCode = 1;
                }
            } finally { await context.close(); }
        }
        if (command === "import" || command === "run") {
            const report = await importBundle(path.resolve(values.out!), values.clanker!, values.start, process.env.WEBUI_AUTH_TOKEN);
            console.log(JSON.stringify(report.entries.map(({ id, state, reason, taskId, taskUrl, started }) => ({ id, state, reason, taskId, taskUrl, started })), null, 2));
            if (report.entries.some((entry) => entry.state === "incomplete" || (entry.state === "complete" && entry.reason))) process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[URL]") : "import failed");
        process.exitCode = 1;
    }
}
