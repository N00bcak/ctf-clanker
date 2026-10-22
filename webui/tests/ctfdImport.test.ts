import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { crawlCtfd, importBundle } from "../server/src/import/ctfd";
import { WebuiDatabase } from "../server/src/db";
import { buildServer } from "../server/src/main";
import { testConfig, tempDir } from "./helpers";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });

describe("CTFd bundle folder names", () => {
    const baseUrl = "https://ctfd.fixture.invalid";
    const checksum = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

    function fixture(challenges: Array<{ id: number; name: string; listName?: string; files?: string[] }>) {
        const out = tempDir();
        close.push(() => fs.rm(out, { recursive: true, force: true }));
        const failures = new Set<string>();
        const downloads = new Map<string, number>();
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const pathname = new URL(String(input)).pathname;
            downloads.set(pathname, (downloads.get(pathname) ?? 0) + 1);
            return new Response(failures.has(pathname) ? null : new Uint8Array(Buffer.from(pathname)), {
                status: failures.has(pathname) ? 503 : 200
            });
        });
        close.push(async () => { fetchMock.mockRestore(); });
        const page = {
            goto: async () => {}, url: () => `${baseUrl}/challenges`,
            context: () => ({ cookies: async () => [] }),
            evaluate: async (_callback: unknown, url: string) => {
                const id = Number(new URL(url).pathname.split("/").pop());
                const challenge = challenges.find((item) => item.id === id);
                return { status: 200, redirected: false, body: { success: true, data: challenge
                    ? { ...challenge, description: "Fixture challenge", files: challenge.files ?? [`/files/${id}/handout.bin`] }
                    : challenges.map((item) => ({ id: item.id, name: item.listName ?? item.name })) } };
            }
        } as unknown as Page;
        return { out, failures, downloads, run: (ids?: string[]) => crawlCtfd(page, { baseUrl, account: "team:fixture", out, ids }) };
    }

    it("uses readable detail names in files, manifest paths and prompts while retaining source IDs", async () => {
        const site = fixture([
            { id: 1, name: "Off by One", listName: "Open challenge" },
            { id: 7, name: "Soundcheck at 1:59" }
        ]);
        const report = await site.run();
        expect(report.folders).toEqual({ "1": "off-by-one", "7": "soundcheck-at-1-59" });
        for (const entry of report.entries) {
            expect(entry.state).toBe("complete");
            const attachment = entry.challenge!.attachments[0];
            expect(attachment.source).toBe(`files/${report.folders![String(entry.id)]}/0-handout.bin`);
            expect(attachment.path).toBe(`attachments/${report.folders![String(entry.id)]}/0-handout.bin`);
            expect(entry.challenge!.prompt).toContain(attachment.path);
            expect(entry.challenge!.source.challengeId).toBe(String(entry.id));
            expect(await fs.readFile(path.join(site.out, attachment.source), "utf8")).toBe(`/files/${entry.id}/handout.bin`);
        }
        const manifest = JSON.parse(await fs.readFile(path.join(site.out, "manifest.json"), "utf8"));
        expect(manifest.challenges).toEqual(report.entries.map((entry) => entry.challenge));
    });

    it("keeps normalized duplicates, suffix collisions and unsafe names in separate safe folders", async () => {
        const site = fixture([
            { id: 1, name: "../Café ☕ //" }, { id: 2, name: "CAFE" }, { id: 3, name: "Cafe 2" },
            { id: 4, name: "CON" }, { id: 5, name: "挑战" }, { id: 6, name: "..." },
            { id: 7, name: `${"a".repeat(100)} first` }, { id: 8, name: `${"a".repeat(100)} second` }
        ]);
        const report = await site.run();
        const folders = Object.values(report.folders!);
        expect(folders.slice(0, 6)).toEqual(["cafe", "cafe-2", "cafe-2-3", "challenge-con", "challenge", "challenge-6"]);
        expect(new Set(folders).size).toBe(folders.length);
        for (const entry of report.entries) {
            expect(entry.state).toBe("complete");
            expect(report.folders![String(entry.id)]).toMatch(/^[a-z0-9][a-z0-9-]{0,99}$/);
            expect(await fs.readFile(path.join(site.out, entry.challenge!.attachments[0].source), "utf8"))
                .toBe(`/files/${entry.id}/handout.bin`);
        }
    });

    it("does not overwrite an existing folder, including a case-insensitive collision", async () => {
        const site = fixture([{ id: 1, name: "Off by One" }, { id: 2, name: "Off by One" }]);
        const existing = path.join(site.out, "files", "OFF-BY-ONE");
        await fs.mkdir(existing, { recursive: true });
        await fs.writeFile(path.join(existing, "0-handout.bin"), "preserve me");
        // Force the collision suffix itself to collide with an existing directory.
        await fs.mkdir(path.join(site.out, "files", "off-by-one-1"));
        const report = await site.run();
        expect(report.folders).toEqual({ "1": "off-by-one-1-1", "2": "off-by-one-2" });
        expect(await fs.readFile(path.join(existing, "0-handout.bin"), "utf8")).toBe("preserve me");
    });

    it("persists names before the first download and keeps them after renaming, reordering and filtering", async () => {
        const challenges = [{ id: 1, name: "Same Name" }, { id: 2, name: "Same Name" }];
        const site = fixture(challenges);
        site.failures.add("/files/1/handout.bin");
        site.failures.add("/files/2/handout.bin");
        const partial = await site.run();
        expect(partial.entries.map((entry) => entry.state)).toEqual(["incomplete", "incomplete"]);
        expect(partial.entries.map((entry) => entry.files)).toEqual([[], []]);
        expect(JSON.parse(await fs.readFile(path.join(site.out, "report.json"), "utf8")).folders)
            .toEqual({ "1": "same-name", "2": "same-name-2" });
        challenges.reverse();
        challenges[0].name = "Renamed";
        site.failures.clear();
        const resumed = await site.run(["2"]);
        expect(resumed.entries).toHaveLength(1);
        expect(resumed.entries[0].state).toBe("complete");
        expect(resumed.folders).toEqual({ "1": "same-name", "2": "same-name-2" });
        expect(resumed.entries[0].challenge!.attachments[0].source).toBe("files/same-name-2/0-handout.bin");
    });

    it("keeps folder ownership across filtered crawls without importing excluded challenges", async () => {
        const site = fixture([{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }]);
        const original = await site.run();
        await site.run(["2"]);
        const manifest = JSON.parse(await fs.readFile(path.join(site.out, "manifest.json"), "utf8"));
        expect(manifest.challenges.map((challenge: { source: { challengeId: string } }) => challenge.source.challengeId)).toEqual(["2"]);
        const resumed = await site.run(["1"]);
        expect(resumed.entries).toHaveLength(1);
        expect(resumed.folders).toEqual(original.folders);
        expect(resumed.entries[0].challenge).toEqual(original.entries[0].challenge);
    });

    it("retains unvisited ownership if a crawl is interrupted after its first checkpoint", async () => {
        const site = fixture([{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }]);
        const original = await site.run();
        const interrupted = JSON.parse(await fs.readFile(path.join(site.out, "report.json"), "utf8"));
        interrupted.entries = [{ id: 1, name: "Alpha", state: "incomplete" }];
        await fs.writeFile(path.join(site.out, "report.json"), JSON.stringify(interrupted));
        const resumed = await site.run(["2"]);
        expect(resumed.entries[0].challenge).toEqual(original.entries[1].challenge);
    });

    it.each(["complete", "incomplete"] as const)("retains legacy numeric paths for a %s report", async (state) => {
        const site = fixture([{ id: 1, name: "Off by One", files: ["/files/1/handout.bin", "/files/1/extra.bin"] }]);
        const report = JSON.parse(JSON.stringify(await site.run())) as Awaited<ReturnType<typeof crawlCtfd>>;
        const entry = report.entries[0];
        await fs.rename(path.join(site.out, "files", report.folders!["1"]), path.join(site.out, "files", "1"));
        for (const file of [...entry.files!, ...entry.challenge!.attachments]) {
            file.source = file.source.replace("files/off-by-one/", "files/1/");
            file.path = file.path.replace("attachments/off-by-one/", "attachments/1/");
        }
        const challenge = entry.challenge!;
        challenge.prompt = challenge.prompt.replaceAll("attachments/off-by-one/", "attachments/1/");
        challenge.source.contentHash = checksum(JSON.stringify({ prompt: challenge.prompt, files: challenge.attachments.map(({ path: name, sha256 }) => ({ name, sha256 })) }));
        const expectedHash = challenge.source.contentHash;
        delete report.folders;
        entry.state = state;
        if (state === "complete") delete entry.files; // Older reports can carry paths only in the completed challenge.
        else { delete entry.challenge; entry.files!.splice(1); }
        await fs.writeFile(path.join(site.out, "report.json"), JSON.stringify(report));
        const resumed = await site.run();
        expect(resumed.entries[0].state).toBe("complete");
        expect(resumed.folders!["1"]).toBe("1");
        expect(resumed.entries[0].challenge!.attachments.map((file) => file.source)).toEqual(["files/1/0-handout.bin", "files/1/1-extra.bin"]);
        expect(resumed.entries[0].challenge!.source.contentHash).toBe(expectedHash);
        expect(site.downloads.get("/files/1/handout.bin")).toBe(state === "incomplete" ? 1 : 2);
        expect(site.downloads.get("/files/1/extra.bin")).toBe(2);
    });

    it.each(["../outside", "/absolute", "bad\\folder", "safe-but-mismatched"])("rejects unsafe or inconsistent recorded folder %s", async (folder) => {
        const site = fixture([{ id: 1, name: "Off by One" }]);
        await fs.writeFile(path.join(site.out, "report.json"), JSON.stringify({ version: 1, competition: baseUrl, account: "team:fixture", folders: { "1": folder }, entries: [{
            id: 1, name: "Old name", state: "incomplete",
            files: [{ source: "files/../outside/handout.bin", path: "attachments/mismatch/handout.bin", sha256: "", size: 0 }]
        }] }));
        const report = await site.run();
        expect(report.entries[0].state).toBe("complete");
        expect(report.folders!["1"]).toBe("off-by-one");
        expect(report.entries[0].challenge!.attachments[0].source).toBe("files/off-by-one/0-handout.bin");
    });
});

// Real Chromium tests are opt-in so npm ci + npm test needs no browser download.
describe.skipIf(process.env.CTFD_BROWSER_TEST !== "1")("CTFd browser import", () => {
    async function browser(): Promise<Browser> {
        const instance = await chromium.launch();
        close.push(() => instance.close());
        return instance;
    }

    async function platform() {
        let failSecondFile = true;
        let custom = false;
        const downloads = new Map<string, number>();
        const server = http.createServer((request, response) => {
            const url = new URL(request.url!, "http://localhost");
            if (url.pathname === "/login") {
                response.setHeader("set-cookie", "session=fixture; HttpOnly; Path=/");
                response.end("Logged in"); return;
            }
            if (!request.headers.cookie?.includes("session=fixture")) {
                response.writeHead(302, { location: "/login" }); response.end(); return;
            }
            if (url.pathname === "/challenges") {
                response.setHeader("content-type", "text/html");
                response.end(`<button challenge-id="1" data-category="web" onclick="document.querySelector('#challenge-window').style.display='block'">Custom</button>
                    <div id="challenge-window" role="dialog" style="display:none"><h2 class="challenge-name">Custom</h2><div class="challenge-category">web</div><div class="challenge-desc"><pre>print('flag')</pre></div><div class="challenge-connection-info">nc localhost 9999</div><div class="challenge-files"><a href="/files/one/handout.bin">Download</a></div></div>`); return;
            }
            if (url.pathname.startsWith("/files/")) {
                downloads.set(url.pathname, (downloads.get(url.pathname) ?? 0) + 1);
                if (url.pathname === "/files/two/handout.bin" && failSecondFile) { response.writeHead(503); response.end(); return; }
                response.end(Buffer.from([0, 255, 42])); return;
            }
            if (custom) { response.writeHead(404); response.end(); return; }
            response.setHeader("content-type", "application/json");
            if (url.pathname === "/api/v1/challenges") {
                response.end(JSON.stringify({ success: true, data: [
                    { id: 1, name: "Files", category: "web" }, { id: 2, name: "Solved", solved_by_me: true },
                    { id: 3, name: "Locked", type: "hidden" }, { id: 4, name: "Other", category: "crypto" }
                ] })); return;
            }
            response.end(JSON.stringify({ success: true, data: {
                id: Number(url.pathname.split("/").pop()), name: "Files", category: url.pathname.endsWith("/4") ? "crypto" : "web",
                description: "Keep formatting:\n```python\nprint('hello')\n```", connection_info: "nc example.test 1337",
                hints: [{ content: "visible hint" }, { id: 8, cost: 100 }], tags: [{ value: "test" }],
                files: ["/files/one/handout.bin?token=PRIVATE", "/files/two/handout.bin?token=PRIVATE"]
            } }));
        });
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        close.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
        return {
            url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
            downloads, recover: () => { failSecondFile = false; }, custom: () => { custom = true; failSecondFile = false; }
        };
    }

    it("resumes incomplete authenticated downloads, imports once, and preserves bytes", async () => {
        const site = await platform();
        const page = await (await browser()).newPage();
        await page.goto(`${site.url}/login`);
        const out = tempDir();
        const options = { baseUrl: site.url, account: "team:1", out, categories: ["web"] };
        const partial = await crawlCtfd(page, options);
        expect(partial.entries[0].state).toBe("incomplete");
        expect(partial.entries[0].files).toHaveLength(1);
        expect(partial.entries[0].files![0].source).toBe("files/files/0-handout.bin");
        expect(partial.entries.filter((entry) => entry.state === "skipped")).toHaveLength(3);
        site.recover();
        const complete = await crawlCtfd(page, options);
        expect(complete.entries[0].state).toBe("complete");
        expect(site.downloads.get("/files/one/handout.bin")).toBe(1);
        const challenge = complete.entries[0].challenge!;
        expect(challenge.attachments[0].path).toBe("attachments/files/0-handout.bin");
        expect(challenge.attachments[0].path).not.toBe(challenge.attachments[1].path);
        expect(challenge.prompt).toContain("```python\nprint('hello')\n```");
        expect(challenge.prompt).toContain("visible hint");
        expect(await fs.readFile(path.join(out, "report.json"), "utf8")).not.toContain("PRIVATE");
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const { app } = await buildServer({ config, db });
        close.push(async () => { await app.close(); db.db.close(); });
        const clanker = await app.listen({ host: "127.0.0.1", port: 0 });
        const imported = await importBundle(out, clanker);
        expect(imported.entries[0].reason).toBeUndefined();
        const repeated = await importBundle(out, clanker);
        expect(repeated.entries[0].taskId).toBe(imported.entries[0].taskId);
        expect(db.listTasks()).toHaveLength(1);
        const task = db.listTasks()[0];
        expect(task.status).toBe("draft");
        expect(await fs.readFile(path.join(task.storagePath, challenge.attachments[0].path))).toEqual(Buffer.from([0, 255, 42]));
        await fs.writeFile(path.join(out, challenge.attachments[0].source), "corrupt");
        const corrupt = await importBundle(out, clanker);
        expect(corrupt.entries[0].reason).toContain("checksum");
        expect(db.listTasks()).toHaveLength(1);
    }, 30000);

    it("reports an expired session before producing an importable bundle", async () => {
        const site = await platform();
        const page = await (await browser()).newPage();
        const out = tempDir();
        await expect(crawlCtfd(page, { baseUrl: site.url, account: "user:1", out })).rejects.toThrow("login required");
        await expect(fs.stat(path.join(out, "manifest.json"))).rejects.toThrow();
    });

    it("uses visible modal fallback and enforces download bounds", async () => {
        const site = await platform(); site.custom();
        const page = await (await browser()).newPage();
        await page.goto(`${site.url}/login`);
        const report = await crawlCtfd(page, { baseUrl: site.url, account: "user:1", out: tempDir(), ids: ["1"] });
        expect(report.entries[0].state).toBe("complete");
        expect(report.entries[0].challenge?.prompt).toContain("<pre>print('flag')</pre>");
        const bounded = await crawlCtfd(page, { baseUrl: site.url, account: "user:1", out: tempDir(), maxFileBytes: 2 });
        expect(bounded.entries[0].state).toBe("incomplete");
        expect(bounded.entries[0].reason).toContain("limit");
    }, 30000);

    it.skipIf(!process.env.CTFD_TEST_URL)("imports from a seeded CTFd 3.8.1 instance through its real login", async () => {
        const page = await (await browser()).newPage();
        const baseUrl = process.env.CTFD_TEST_URL!;
        await page.goto(`${baseUrl}/login`);
        await page.locator('input[name="name"]').fill("import-test");
        await page.locator('input[name="password"]').fill("local-fixture-password");
        await Promise.all([page.waitForURL("**/challenges"), page.locator('input[type="submit"], button[type="submit"]').click()]);
        const out = tempDir();
        const report = await crawlCtfd(page, { baseUrl, account: "user:import-test", out });
        expect(report.entries.filter((entry) => entry.state === "complete")).toHaveLength(1);
        const challenge = report.entries.find((entry) => entry.state === "complete")!.challenge!;
        expect(challenge.prompt).toContain("CTFd integration fixture");
        expect(await fs.readFile(path.join(out, challenge.attachments[0].source))).toEqual(Buffer.from([0, 255, 42]));
        const config = testConfig();
        config.codex.credentialMode = "host-codex-cli";
        const db = new WebuiDatabase(config);
        let runs = 0;
        const { app } = await buildServer({ config, db, hostCodex: { async run() { runs++; return '{"outcome":"solved","summary":"fixture","flag":"test{ok}"}'; } } });
        close.push(async () => { await app.close(); db.db.close(); });
        const clanker = await app.listen({ host: "127.0.0.1", port: 0 });
        await importBundle(out, clanker);
        await importBundle(out, clanker);
        expect(db.listTasks()).toHaveLength(1);
        expect(db.listTasks()[0].status).toBe("draft");
        await importBundle(out, clanker, true);
        await vi.waitFor(() => expect(runs).toBe(1));
        await vi.waitFor(() => expect(db.listTasks()[0].workStatus).toBe("done"));
        await importBundle(out, clanker, true);
        expect(runs).toBe(1);
    }, 30000);
});
