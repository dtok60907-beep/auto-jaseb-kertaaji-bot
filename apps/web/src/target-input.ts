export function parseTargetInput(value: string): readonly string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of value.split(/[\n,]+/)) {
    const target = raw.trim();
    const key = target.toLocaleLowerCase("en-US");
    if (!target || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}
