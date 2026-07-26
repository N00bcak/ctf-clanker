import { describe, expect, it } from "vitest";
import { detectDockerRuntime, docker } from "../server/src/providers/docker";

const runDockerSmoke = process.env.MECHA_WEBUI_LIVE_DOCKER === "1";
const runDigitalOceanSmoke = process.env.MECHA_WEBUI_LIVE_DO === "1"
    && Boolean(process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN);

describe.skipIf(!runDockerSmoke)("live Docker smoke", () => {
    it("detects Docker and the local runner image", async () => {
        const runtime = await detectDockerRuntime();
        expect(runtime.ok, runtime.detail).toBe(true);

        await expect(docker(["image", "inspect", "mecha-codex-runner:base"])).resolves.toEqual(expect.objectContaining({
            stdout: expect.any(String)
        }));
    });
});

describe.skipIf(!runDigitalOceanSmoke)("live DigitalOcean smoke", () => {
    it("authenticates against the account API without provisioning resources", async () => {
        const token = process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN;
        const response = await fetch("https://api.digitalocean.com/v2/account", {
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json"
            }
        });

        expect(response.ok, await response.text()).toBe(true);
    });
});
