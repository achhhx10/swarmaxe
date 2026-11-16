#!/usr/bin/env bun
/**
 * adapter-selftest.ts — teste la voie in-process de l'adaptateur, pas le CLI.
 *
 * Le doctor historiquement validait `swarm tool ...` (repli CLI). Si la voie
 * rapide cassait, rien ne le voyait avant qu'un worker appelle un outil.
 *
 * Ce test importe le wrapper reel (~/.config/opencode/swarm-v1/legacy.ts),
 * l'instancie comme le fait le service, et execute des outils en lecture.
 * Il verifie aussi que le chargement in-process reussit (et non un repli
 * silencieux vers le CLI, qui serait lent).
 *
 * Sortie : "SELFTEST OK" + une ligne par outil, ou "SELFTEST FAIL: ...".
 */

const T0 = Date.now();

const HOME = process.env.HOME ?? "";
const legacy: any = (await import(`${HOME}/.config/opencode/swarmaxe-v1/legacy.ts`)).default;
const PROJECT = process.env.SWARMAXE_PROJECT ?? `${HOME}/Desktop`;
const plugin: any = await legacy({ directory: PROJECT, client: {} });
const tools = plugin?.tool ?? {};

const ctx: any = {
  sessionID: "ses_selftest",
  messageID: "msg_selftest",
  agent: "build",
  directory: PROJECT,
  worktree: PROJECT,
  abort: new AbortController().signal,
  metadata() {},
  ask: async () => {},
};

const cases: Array<[string, any, (t: string) => boolean]> = [
  ["hive_cells", { limit: 1 }, (t) => t.includes("cell-") || t.trim() === "[]"],
  ["hive_ready", {}, (t) => t.length > 0],
  ["hivemind_get", { id: "mem-baeb56e58dd1ac24" }, (t) => t.includes("mem-baeb56e58dd1ac24")],
  ["swarmmail_health", {}, (t) => t.includes("healthy")],
];

let failed = 0;
const lines: string[] = [];

for (const [name, args, ok] of cases) {
  const tool = tools[name];
  if (!tool?.execute) {
    lines.push(`FAIL ${name}: outil absent`);
    failed++;
    continue;
  }
  const s = Date.now();
  try {
    const r: any = await Promise.race([
      tool.execute(args, ctx),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout 30s")), 30_000)),
    ]);
    const text = typeof r === "string" ? r : JSON.stringify(r);
    const ms = Date.now() - s;
    if (!ok(text)) {
      lines.push(`FAIL ${name}: sortie inattendue (${text.slice(0, 80)})`);
      failed++;
    } else {
      lines.push(`ok   ${name} ${ms}ms`);
    }
  } catch (e: any) {
    lines.push(`FAIL ${name}: ${String(e?.message ?? e).slice(0, 120)}`);
    failed++;
  }
}

// Mesure de la voie rapide : 10 lectures DB pures, apres un appel de chauffe.
// Les appels qui passent par Ollama (hivemind_find) ou ouvrent la base pour la
// premiere fois sont exclus du calcul.
await Promise.race([
  tools.hive_cells.execute({ limit: 1 }, ctx),
  new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout 30s")), 30_000)),
]);
const samples: number[] = [];
for (let i = 0; i < 10; i++) {
  const s = Date.now();
  await Promise.race([
    tools.hive_cells.execute({ limit: 1 }, ctx),
    new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout 8s")), 8_000)),
  ]);
  samples.push(Date.now() - s);
}
samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length / 2)];
if (p50 > 500) {
  lines.push(`FAIL voie rapide inactive ? p50 ${p50}ms sur hive_cells (attendu < 500ms)`);
  failed++;
} else {
  lines.push(`ok   voie rapide: p50 ${p50}ms sur 10 lectures`);
}

const total = Date.now() - T0;
const avg = Math.round(total / (cases.length + samples.length + 1));

console.log(lines.join("\n"));
if (failed > 0) {
  console.log(`SELFTEST FAIL: ${failed} probleme(s), total ${total}ms`);
  process.exit(1);
}
console.log(`SELFTEST OK: ${cases.length} outils verifies, p50 ${p50}ms, total ${total}ms`);
// L'instance du plugin laisse des handles ouverts (timers internes) : on sort
// explicitement pour que le doctor ne reste pas bloque.
process.exit(0);
