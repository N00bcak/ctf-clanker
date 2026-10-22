import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import {
    assertTaskPermissions,
    defaultPermissions,
    permissionsFingerprint,
    readPermissions,
    reconcileTaskPermissions,
    saveTaskPermissions,
    supportedNetworkModes,
    validatePermissions,
    writePermissions,
    type TaskPermissions
} from "../server/src/tasks/permissions";
import { testConfig } from "./helpers";

describe("task permissions", () => {
    it("supports offline networking only for local Docker runtimes", () => {
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "permissions" }, config, db);
        const permissions = defaultPermissions(config);
        permissions.network = { mode: "none", enforcement: "docker-none", allow: [] };
        expect(supportedNetworkModes(task)).toEqual(["open", "none"]);
        expect(() => assertTaskPermissions(task, permissions, config)).not.toThrow();
        for (const remoteTask of [{ ...task, codexRuntime: "host" as const }, { ...task, backend: "digitalocean" as const, codexRuntime: "droplet" as const }]) {
            expect(supportedNetworkModes(remoteTask)).toEqual(["open"]);
            expect(() => assertTaskPermissions(remoteTask, permissions, config)).toThrow(/unsupported/);
        }
    });

    it.each([
        null,
        { version: 2, network: { mode: "open", enforcement: "open-warning", allow: [] }, mounts: [] },
        { version: 1, network: { mode: "invalid", enforcement: "open-warning", allow: [] }, mounts: [] },
        { version: 1, network: { mode: "open", enforcement: "invalid", allow: [] }, mounts: [] },
        { version: 1, network: { mode: "open", enforcement: "open-warning", allow: [3] }, mounts: [] },
        { version: 1, network: { mode: "open", enforcement: "open-warning", allow: [] }, mounts: null },
        { version: 1, network: { mode: "open", enforcement: "open-warning", allow: [] }, mounts: [null] }
    ])("rejects malformed permission documents %#", (value) => {
        expect(() => validatePermissions(value as unknown as TaskPermissions, testConfig())).toThrow();
    });

    it("rejects mount paths that traverse outside extras or resolve into denied host paths", () => {
        const config = testConfig();
        const root = config.paths.cacheDir;
        const denied = path.join(root, "denied");
        fs.mkdirSync(denied);
        config.security.denyHostMounts = [denied];
        const link = path.join(root, "allowed-name");
        fs.symlinkSync(denied, link);
        const permissions = defaultPermissions(config);
        permissions.mounts = [{ label: "data", source: link, target: "/mnt/extra/data", mode: "ro" }];
        expect(() => validatePermissions(permissions, config)).toThrow(/denied/);
        permissions.mounts[0]!.source = root;
        permissions.mounts[0]!.target = "/mnt/extra/../../root/.codex";
        expect(() => validatePermissions(permissions, config)).toThrow(/extra mounts/);
    });

    it("fingerprints all permission values independently of object and list ordering", () => {
        const permissions = defaultPermissions(testConfig());
        permissions.network.allow = ["b.example", "a.example"];
        const reordered: TaskPermissions = {
            mounts: [],
            network: { allow: ["a.example", "b.example"], enforcement: "open-warning", mode: "open" },
            version: 1
        };
        expect(permissionsFingerprint(permissions)).toBe(permissionsFingerprint(reordered));
        const changed = structuredClone(permissions);
        changed.network.allow.push("c.example");
        expect(permissionsFingerprint(permissions)).not.toBe(permissionsFingerprint(changed));
        changed.mounts = [{ label: "data", source: "/tmp/a", target: "/mnt/extra/data", mode: "ro" }];
        const firstMountFingerprint = permissionsFingerprint(changed);
        changed.mounts[0]!.mode = "rw";
        expect(permissionsFingerprint(changed)).not.toBe(firstMountFingerprint);
    });

    it("saves permission and task manifests together with database metadata", () => {
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "save" }, config, db);
        const taskPath = path.join(path.dirname(task.storagePath), "task.yaml");
        const originalManifest = YAML.parse(fs.readFileSync(taskPath, "utf8"));
        fs.writeFileSync(taskPath, YAML.stringify({ ...originalManifest, custom: "preserved" }));
        const permissions = defaultPermissions(config);
        permissions.network = { mode: "none", enforcement: "docker-none", allow: [] };

        const updated = saveTaskPermissions(task, permissions, config, db);

        expect(updated.networkMode).toBe("none");
        expect(db.getTask(task.id)?.networkEnforcement).toBe("docker-none");
        expect(readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), config)).toEqual(permissions);
        expect(YAML.parse(fs.readFileSync(taskPath, "utf8"))).toMatchObject({ custom: "preserved", networkMode: "none", networkEnforcement: "docker-none" });
    });

    it("restores exact manifest bytes and database state when persistence fails", () => {
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "rollback" }, config, db);
        const root = path.dirname(task.storagePath);
        const permissionsPath = path.join(root, "permissions.yaml");
        const taskPath = path.join(root, "task.yaml");
        const originalPermissions = fs.readFileSync(permissionsPath, "utf8");
        const originalTask = fs.readFileSync(taskPath, "utf8");
        const updateNetwork = db.updateTaskNetwork.bind(db);
        vi.spyOn(db, "updateTaskNetwork").mockImplementation((...args) => {
            updateNetwork(...args);
            throw new Error("database persistence failed");
        });
        const permissions = defaultPermissions(config);
        permissions.network = { mode: "none", enforcement: "docker-none", allow: [] };

        expect(() => saveTaskPermissions(task, permissions, config, db)).toThrow("database persistence failed");

        expect(fs.readFileSync(permissionsPath, "utf8")).toBe(originalPermissions);
        expect(fs.readFileSync(taskPath, "utf8")).toBe(originalTask);
        expect(db.getTask(task.id)?.networkMode).toBe("open");
        expect(fs.readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(false);
    });

    it("reconciles legacy metadata from saved permissions without rewriting the permission manifest", () => {
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "reconcile" }, config, db);
        const root = path.dirname(task.storagePath);
        const permissionsPath = path.join(root, "permissions.yaml");
        const permissions = defaultPermissions(config);
        permissions.network = { mode: "none", enforcement: "docker-none", allow: [] };
        writePermissions(permissionsPath, permissions, config);
        fs.appendFileSync(permissionsPath, "# Keep this operator comment.\n");
        const savedManifest = fs.readFileSync(permissionsPath, "utf8");

        const updated = reconcileTaskPermissions(task, config, db);

        expect(updated.networkMode).toBe("none");
        expect(fs.readFileSync(permissionsPath, "utf8")).toBe(savedManifest);
        expect(YAML.parse(fs.readFileSync(path.join(root, "task.yaml"), "utf8"))).toMatchObject({ networkMode: "none", networkEnforcement: "docker-none" });
    });
});
