/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

type ImageMap = {
  controller: string;
  invoker: string;
  standalone: string;
};

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string[], allowFailure = false): string {
  const proc = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);

  if (proc.exitCode !== 0 && !allowFailure) {
    if (stdout.trim()) console.log(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
    die(`${cmd.join(" ")} failed with exit code ${proc.exitCode}`);
  }

  return stdout;
}

function runStreaming(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    die(`${cmd.join(" ")} failed with exit code ${proc.exitCode}`);
  }
}

function env(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function normalizedRegistry(): string {
  return env("DOCKER_REGISTRY", "registry.hub.docker.com/apache").replace(/\/+$/, "");
}

function buildTag(): string {
  const tag = env("TAG");
  if (!tag) die("TAG is required");
  return tag;
}

function images(): ImageMap {
  const registry = normalizedRegistry();
  const tag = buildTag();
  return {
    controller: `${registry}/${env("CONTROLLER_IMAGE", "openserverless-wsk-controller")}:${tag}`,
    invoker: `${registry}/${env("INVOKER_IMAGE", "openserverless-wsk-invoker")}:${tag}`,
    standalone: `${registry}/${env("STANDALONE_IMAGE", "openserverless-wsk-standalone")}:${tag}`,
  };
}

function opsrootPath(): string {
  return env("OPSROOT_JSON", join(homedir(), ".ops/0.1.0/olaris/opsroot.json"));
}

function updateOpsroot(dryRun = false): void {
  const file = opsrootPath();
  if (!existsSync(file)) die(`opsroot.json not found: ${file}`);

  const data = JSON.parse(readFileSync(file, "utf8"));
  data.config ??= {};
  data.config.images ??= {};

  const img = images();
  const before = JSON.stringify(data.config.images, null, 2);
  data.config.images.standalone = img.standalone;
  data.config.images.controller = img.controller;
  data.config.images.invoker = img.invoker;
  const after = JSON.stringify(data.config.images, null, 2);

  if (before === after) {
    console.log(`opsroot unchanged: ${file}`);
    return;
  }

  console.log(`updating ${file}`);
  console.log(`  standalone: ${img.standalone}`);
  console.log(`  controller:  ${img.controller}`);
  console.log(`  invoker:     ${img.invoker}`);

  if (dryRun) return;

  const backup = `${file}.bak.${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  writeFileSync(backup, readFileSync(file));
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`backup: ${backup}`);
}

function dockerImageExists(image: string): boolean {
  const proc = Bun.spawnSync(["docker", "image", "inspect", image], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

function kindNode(): string {
  return env("KIND_NODE", "openserverless-control-plane");
}

function loadKind(): void {
  const node = kindNode();
  const img = images();

  for (const image of [img.controller, img.invoker, img.standalone]) {
    if (!dockerImageExists(image)) die(`local Docker image not found: ${image}`);
    console.log(`loading ${image} into ${node}`);
    runStreaming([
      "bash",
      "-lc",
      `docker save ${shellQuote(image)} | docker exec -i ${shellQuote(node)} ctr --namespace=k8s.io images import -`,
    ]);
  }
}

function kubectlExists(kind: string, name: string): boolean {
  const ns = env("KUBE_NAMESPACE", "openserverless");
  const proc = Bun.spawnSync(["kubectl", "-n", ns, "get", kind, name], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

function rollout(): void {
  const ns = env("KUBE_NAMESPACE", "openserverless");
  const img = images();

  if (kubectlExists("statefulset", "controller")) {
    runStreaming([
      "kubectl",
      "-n",
      ns,
      "set",
      "image",
      "statefulset/controller",
      `controller=${img.controller}`,
    ]);
    runStreaming(["kubectl", "-n", ns, "rollout", "status", "statefulset/controller", "--timeout=180s"]);
  } else {
    console.log(`statefulset/controller not found in namespace ${ns}`);
  }

  if (kubectlExists("statefulset", "invoker")) {
    runStreaming([
      "kubectl",
      "-n",
      ns,
      "set",
      "image",
      "statefulset/invoker",
      `invoker=${img.invoker}`,
    ]);
    runStreaming(["kubectl", "-n", ns, "rollout", "status", "statefulset/invoker", "--timeout=180s"]);
  } else {
    console.log(`statefulset/invoker not found in namespace ${ns}; skipping`);
  }
}

function status(): void {
  const ns = env("KUBE_NAMESPACE", "openserverless");
  const img = images();
  console.log("expected images:");
  console.log(`  controller: ${img.controller}`);
  console.log(`  invoker:    ${img.invoker}`);
  console.log(`  standalone: ${img.standalone}`);

  console.log("\nkind images:");
  const crictl = run([
    "bash",
    "-lc",
    `docker exec ${shellQuote(kindNode())} crictl images 2>/dev/null | rg 'openserverless-wsk-(controller|invoker|standalone)' || true`,
  ], true);
  console.log(crictl.trim() || "  none");

  console.log("\npods:");
  const pods = run([
    "bash",
    "-lc",
    `kubectl -n ${shellQuote(ns)} get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\\t"}{range .spec.containers[*]}{.image}{" "}{end}{"\\n"}{end}' 2>/dev/null | sort || true`,
  ], true);
  console.log(pods.trim() || "  none");
}

function help(): void {
  console.log(`Usage: bun scripts/kind-local.ts <command>

Commands:
  update-opsroot      Update OPSROOT_JSON with local OpenWhisk images
  load-kind           Import local OpenWhisk images into the kind node
  rollout             Update controller/invoker StatefulSets when present
  deploy-kind         update-opsroot, load-kind, rollout, status
  status              Show expected images, kind images, and pod images
  help                Show this help

Environment:
  TAG                 Image tag to use
  DOCKER_REGISTRY     Default: registry.hub.docker.com/apache
  OPSROOT_JSON        Default: ~/.ops/0.1.0/olaris/opsroot.json
  KIND_NODE           Default: openserverless-control-plane
  KUBE_NAMESPACE      Default: openserverless
`);
}

const command = process.argv[2] || "help";

switch (command) {
  case "update-opsroot":
    updateOpsroot();
    break;
  case "load-kind":
    loadKind();
    break;
  case "rollout":
    rollout();
    break;
  case "deploy-kind":
    updateOpsroot();
    loadKind();
    rollout();
    status();
    break;
  case "status":
    status();
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    help();
    die(`unknown command: ${command}`);
}
