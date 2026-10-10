function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`期望${String(expected)}，实际${String(actual)}`);
  }
}

Deno.test('本地 Deno 启动入口只启动一次并授予 runtime KV 最小写权限', async () => {
  const script = await Deno.readTextFile('tools/start-deno-service.ps1');
  const config = JSON.parse(await Deno.readTextFile('deno.json')) as {
    tasks: Record<string, string>;
  };

  equal(script.includes("'run'"), true);
  equal(script.includes("'serve'"), false);
  equal(script.includes("'--unstable-kv'"), true);
  equal(script.includes("'--allow-write=.runtime'"), true);
  equal(script.includes('$env:PORT = $Port'), true);
  equal(config.tasks.start.includes('--allow-write=.runtime'), true);
  equal(config.tasks.dev.includes('--allow-write=.runtime'), true);
});
